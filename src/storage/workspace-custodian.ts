import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export type WorkspaceHead = {
  groupId: string;
  snapshotId: string;
  epoch: number;
};

export type SnapshotCandidate = {
  groupId: string;
  snapshotId: string;
  base: WorkspaceHead | null;
  completedAt: string;
};

export type PublishResult =
  | { published: true; head: WorkspaceHead }
  | { published: false; current: WorkspaceHead };

type WorkspaceOperation = "checkpoint" | "restore";

type WorkspaceConflict = {
  local: SnapshotCandidate;
  remote: WorkspaceHead;
};

type WorkspaceStatusBase = {
  base: WorkspaceHead | null;
  head: WorkspaceHead | null;
};

export type WorkspaceStatus =
  | (WorkspaceStatusBase & {
      phase: "ready" | "checkpointing" | "publishing" | "restoring";
      conflict?: never;
      operation?: never;
      error?: never;
    })
  | (WorkspaceStatusBase & {
      phase: "conflicted";
      conflict: WorkspaceConflict;
      operation?: never;
      error?: never;
    })
  | (WorkspaceStatusBase & {
      phase: "failed";
      conflict?: never;
      operation: WorkspaceOperation;
      error: string;
    });

/**
 * S3 metadata boundary. The adapter must persist every candidate receipt as an
 * immutable object before atomically replacing the group's HEAD only when it
 * still equals expectedHead, and must serve those receipts back so a restarted
 * custodian can tell a publication that landed (and was built upon) from one
 * that lost its race. Authentication comes from the EC2 role today and the
 * Gateway later; credential values are deliberately absent from this API.
 */
export interface S3SnapshotStore {
  head(groupId: string): Promise<WorkspaceHead | null>;
  candidate(
    groupId: string,
    snapshotId: string,
  ): Promise<SnapshotCandidate | null>;
  publish(
    candidate: SnapshotCandidate,
    expectedHead: WorkspaceHead | null,
  ): Promise<PublishResult>;
}

export type RestoreOptions = {
  /** Adopt the given head over a conflicted or unpublished local candidate. */
  discardLocal?: boolean;
};

type RunResult = { code: number; stdout: string; stderr: string };
type Run = (
  argv: string[],
  options: { cwd: string; env: Record<string, string> },
) => Promise<RunResult>;

export interface WorkspaceCustodianOptions {
  /** Metadata root; replica state and operation locks live below this path. */
  root: string;
  /**
   * Authoritative local ciphertext path. Keep it separate from the metadata
   * root when the host already owns a content tree (for example
   * DATA_DIR/workspace-replicas/<groupId>/cipher). The old layout remains the
   * default for callers that have not supplied this PR144 option.
   */
  workspace?: (groupId: string) => string;
  repository(groupId: string): string;
  passwordFile(groupId: string): string;
  snapshots: S3SnapshotStore;
  /**
   * Runs before a checkpoint snapshots and before a restore replaces the
   * replica. It must stop local writers AND leave the host-visible ciphertext
   * consistent (guest gocryptfs writers flushed or unmounted) before resolving.
   */
  quiesce(groupId: string): Promise<void>;
  resticEnvironment?: Readonly<Record<string, string>>;
  run?: Run;
  now?: () => Date;
}

type ReplicaState =
  | { version: 1; state: "clean"; base: WorkspaceHead | null }
  | { version: 1; state: "publishing"; candidate: SnapshotCandidate }
  | {
      version: 1;
      state: "restoring";
      head: WorkspaceHead;
      base: WorkspaceHead | null;
    }
  | {
      version: 1;
      state: "conflicted";
      base: WorkspaceHead | null;
      local: SnapshotCandidate;
      remote: WorkspaceHead;
    };

type ActivePhase = "checkpointing" | "restoring";

// restic ≥0.17 (the image pins 0.18): "repository does not exist".
class ReplicaBlockedError extends Error {}

export class WorkspaceCustodian {
  readonly #root: string;
  readonly #phase = new Map<string, ActivePhase>();
  readonly #failure = new Map<
    string,
    { operation: WorkspaceOperation; error: string }
  >();
  readonly #run: Run;
  readonly #now: () => Date;

  constructor(private readonly options: WorkspaceCustodianOptions) {
    this.#root = path.resolve(options.root);
    if (this.#root === path.parse(this.#root).root)
      throw new Error("workspace root must not be a filesystem root");
    this.#run = options.run ?? run;
    this.#now = options.now ?? (() => new Date());
  }

  /** Call after the last local session for this group stops writing. */
  async checkpoint(groupId: string): Promise<PublishResult> {
    const paths = await this.#begin(groupId, "checkpointing");
    try {
      const replica = await this.#reconcile(groupId, paths.group);
      if (replica.state === "conflicted")
        throw new ReplicaBlockedError(
          `workspace ${groupId} has an unresolved conflict`,
        );
      if (replica.state === "restoring")
        throw new ReplicaBlockedError(
          `workspace ${groupId} has an interrupted restore; retry restore`,
        );

      let candidate: SnapshotCandidate;
      if (replica.state === "publishing") {
        candidate = replica.candidate;
      } else {
        if (!(await isDirectory(paths.cipher)))
          throw new Error(`ciphertext workspace is missing: ${groupId}`);
        await this.options.quiesce(groupId);
        const argv = [
          "restic",
          "backup",
          "--json",
          "--host",
          groupId,
          "--tag",
          `group:${groupId}`,
        ];
        if (replica.base) argv.push("--tag", `base:${replica.base.snapshotId}`);
        argv.push(".");
        const env = await this.#resticEnv(groupId, paths.group);
        let result = await this.#run(argv, { cwd: paths.cipher, env });
        if (result.code !== 0 && replica.base === null) {
          // Restic versions disagree on the missing-repository exit code. On
          // the first checkpoint only, init is the safe existence check: retry
          // the backup only when this process actually created the repository.
          const init = await this.#run(["restic", "init"], {
            cwd: paths.cipher,
            env,
          });
          if (init.code === 0)
            result = await this.#run(argv, { cwd: paths.cipher, env });
          // A FAILED bootstrap used to be swallowed here: the backup error was
          // rethrown below and the init error discarded, so a workspace that
          // could not create its repository reported "repository does not
          // exist" forever — true, unactionable, and pointing at the wrong
          // command. The bootstrap is the failure; say so.
          else throw commandError("init", init);
        }
        if (result.code !== 0) throw commandError("backup", result);
        candidate = {
          groupId,
          snapshotId: snapshotId(result.stdout),
          base: replica.base,
          completedAt: this.#now().toISOString(),
        };
        await writeReplicaState(paths.group, {
          version: 1,
          state: "publishing",
          candidate,
        });
      }

      const publication = await this.options.snapshots.publish(
        candidate,
        candidate.base,
      );
      validatePublication(publication, candidate);
      if (publication.published) {
        await writeReplicaState(paths.group, {
          version: 1,
          state: "clean",
          base: publication.head,
        });
      } else {
        await writeReplicaState(paths.group, {
          version: 1,
          state: "conflicted",
          base: candidate.base,
          local: candidate,
          remote: publication.current,
        });
      }
      this.#phase.delete(groupId);
      return publication;
    } catch (error) {
      if (error instanceof ReplicaBlockedError) this.#phase.delete(groupId);
      else this.#fail(groupId, "checkpoint", error);
      throw error;
    } finally {
      await releaseProcessLock(paths.group);
    }
  }

  /**
   * Call before the first local session uses this replica when S3 HEAD is
   * newer. Pass `discardLocal` to adopt `head` over a conflicted or
   * unpublished local candidate — the supported exit from a lost publication
   * race (the candidate's receipt stays durable in S3).
   */
  async restore(
    groupId: string,
    head: WorkspaceHead,
    options: RestoreOptions = {},
  ): Promise<void> {
    validateHead(head, groupId);
    const paths = await this.#begin(groupId, "restoring");
    let staging: string | undefined;
    try {
      const replica = await this.#reconcile(groupId, paths.group);
      if (
        (replica.state === "publishing" || replica.state === "conflicted") &&
        !options.discardLocal
      )
        throw new ReplicaBlockedError(
          `workspace ${groupId} has unpublished local changes`,
        );
      await this.options.quiesce(groupId);
      // Persist intent before mutating the cipher tree: a crash between
      // promote and the final state write must not leave a "clean" state whose
      // base no longer describes the on-disk content.
      await writeReplicaState(paths.group, {
        version: 1,
        state: "restoring",
        head,
        base: replicaBase(replica),
      });
      staging = await mkdtemp(path.join(paths.group, ".restore-"));
      const result = await this.#run(
        ["restic", "restore", "--json", head.snapshotId, "--target", staging],
        {
          cwd: paths.group,
          env: await this.#resticEnv(groupId, paths.group),
        },
      );
      if (result.code !== 0) throw commandError("restore", result);
      if ((await readdir(staging)).length === 0)
        throw new Error("restic restored an empty ciphertext tree");
      await promote(staging, paths.cipher, paths.group);
      staging = undefined;
      await writeReplicaState(paths.group, {
        version: 1,
        state: "clean",
        base: head,
      });
      this.#phase.delete(groupId);
    } catch (error) {
      if (error instanceof ReplicaBlockedError) this.#phase.delete(groupId);
      else this.#fail(groupId, "restore", error);
      throw error;
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
      await releaseProcessLock(paths.group);
    }
  }

  /**
   * Create the group's restic repository if it is not there yet. Idempotent:
   * an existing repository is a no-op, so this is safe on every startup.
   *
   * The repository used to be created only as a RESCUE inside `checkpoint()` —
   * run the backup, and if it failed on a first-ever checkpoint, try `init` and
   * retry. That made the bootstrap a side effect of a failure, which fails in
   * both directions: a workspace that had never checkpointed carried no
   * repository at all (so its first teardown could not flush, and the pod's
   * checkpoint finalizer had nothing to succeed against), while an `init` that
   * itself failed was discarded in favour of the backup's error — reporting
   * "repository does not exist" forever and naming the wrong command.
   *
   * Creating it up front, at startup, makes the repository an invariant of a
   * READY custodian instead of a hoped-for consequence of the first backup.
   */
  async ensureRepository(groupId: string): Promise<'created' | 'present'> {
    validateGroupId(groupId);
    const paths = this.#paths(groupId);
    await mkdir(paths.group, { recursive: true, mode: 0o700 });
    const env = await this.#resticEnv(groupId, paths.group);
    const probe = await this.#run(["restic", "cat", "config"], { cwd: paths.group, env });
    if (probe.code === 0) return 'present';
    const init = await this.#run(["restic", "init"], { cwd: paths.group, env });
    if (init.code !== 0) throw commandError("init", init);
    return 'created';
  }

  /** Read-only: reports state but never rewrites it — only the serialized
   * checkpoint/restore operations may persist replica transitions. */
  async status(groupId: string): Promise<WorkspaceStatus> {
    validateGroupId(groupId);
    const paths = this.#paths(groupId);
    const replica = await readReplicaState(paths.group, groupId, false);
    const head = await this.options.snapshots.head(groupId);
    if (head) validateHead(head, groupId);
    const phase = this.#phase.get(groupId);
    if (phase) return { phase, base: replicaBase(replica), head };
    const view =
      replica.state === "publishing"
        ? await this.#resolvePublishing(groupId, replica, head)
        : replica;
    const base = replicaBase(view);
    if (view.state === "conflicted") {
      return {
        phase: "conflicted",
        base,
        head,
        conflict: { local: view.local, remote: view.remote },
      };
    }
    const failure = this.#failure.get(groupId);
    if (failure) return { phase: "failed", base, head, ...failure };
    if (view.state === "restoring")
      return {
        phase: "failed",
        base,
        head,
        operation: "restore",
        error: `restore of ${view.head.snapshotId} was interrupted; retry restore`,
      };
    if (view.state === "publishing") return { phase: "publishing", base, head };
    return { phase: "ready", base, head };
  }

  async #begin(groupId: string, phase: ActivePhase) {
    validateGroupId(groupId);
    if (this.#phase.has(groupId))
      throw new Error(`workspace ${groupId} is busy`);
    // Claim before the first await so operations in this custodian cannot
    // race; the on-disk lock extends the claim across custodian processes.
    this.#phase.set(groupId, phase);
    this.#failure.delete(groupId);
    const paths = this.#paths(groupId);
    try {
      await mkdir(paths.group, { recursive: true, mode: 0o700 });
      await mkdir(path.dirname(paths.cipher), { recursive: true, mode: 0o700 });
      await acquireProcessLock(paths.group, groupId);
      try {
        await recoverStaleWork(paths.group, paths.cipher);
      } catch (error) {
        await releaseProcessLock(paths.group);
        throw error;
      }
    } catch (error) {
      if (error instanceof ReplicaBlockedError) this.#phase.delete(groupId);
      else
        this.#fail(
          groupId,
          phase === "checkpointing" ? "checkpoint" : "restore",
          error,
        );
      throw error;
    }
    return paths;
  }

  /** Mutating reconcile for checkpoint/restore, which hold the phase claim. */
  async #reconcile(groupId: string, groupDir: string): Promise<ReplicaState> {
    const replica = await readReplicaState(groupDir, groupId, true);
    if (replica.state !== "publishing") return replica;
    const head = await this.options.snapshots.head(groupId);
    if (head) validateHead(head, groupId);
    const resolved = await this.#resolvePublishing(groupId, replica, head);
    if (resolved !== replica) {
      await writeReplicaState(groupDir, resolved);
      this.#failure.delete(groupId);
    }
    return resolved;
  }

  /** Pure resolution of a pending publication against the store's head. */
  async #resolvePublishing(
    groupId: string,
    replica: Extract<ReplicaState, { state: "publishing" }>,
    head: WorkspaceHead | null,
  ): Promise<ReplicaState> {
    const candidate = replica.candidate;
    const publishedEpoch = (candidate.base?.epoch ?? 0) + 1;
    if (
      head &&
      head.snapshotId === candidate.snapshotId &&
      head.epoch === publishedEpoch
    )
      return { version: 1, state: "clean", base: head };
    // Head unchanged (or lost): the publication is still pending; retrying
    // publish is the way to surface store faults.
    if (sameHead(head, candidate.base) || !head) return replica;
    // The head moved past our base. Walk the receipt chain to learn whether it
    // moved *through* our candidate (publish landed, a peer built on top) or
    // past it (we lost the race).
    let cursor: WorkspaceHead = head;
    for (let hops = 0; cursor.epoch > publishedEpoch && hops < 100; hops += 1) {
      const receipt = await this.options.snapshots.candidate(
        groupId,
        cursor.snapshotId,
      );
      if (!receipt || receipt.snapshotId !== cursor.snapshotId) break;
      validateCandidate(receipt, groupId);
      if (!receipt.base || receipt.base.epoch !== cursor.epoch - 1) break;
      cursor = receipt.base;
    }
    if (
      cursor.epoch === publishedEpoch &&
      cursor.snapshotId === candidate.snapshotId
    )
      return {
        version: 1,
        state: "clean",
        base: {
          groupId,
          snapshotId: candidate.snapshotId,
          epoch: publishedEpoch,
        },
      };
    return {
      version: 1,
      state: "conflicted",
      base: candidate.base,
      local: candidate,
      remote: head,
    };
  }

  #paths(groupId: string) {
    const group = path.join(this.#root, groupId);
    const configured = this.options.workspace?.(groupId);
    if (configured !== undefined && !configured.trim())
      throw new Error(`workspace path is empty: ${groupId}`);
    return { group, cipher: path.resolve(configured ?? path.join(group, "cipher")) };
  }

  #fail(groupId: string, operation: WorkspaceOperation, error: unknown): void {
    this.#phase.delete(groupId);
    this.#failure.set(groupId, { operation, error: errorMessage(error) });
  }

  async #resticEnv(groupId: string, groupDir: string) {
    const repository = this.options.repository(groupId).trim();
    if (!repository) throw new Error("restic repository is required");
    const passwordFile = path.resolve(this.options.passwordFile(groupId));
    // stat, not lstat: Kubernetes Secret/projected volumes deliver the file
    // through a symlink; the permission bits that matter are the target's.
    const password = await stat(passwordFile);
    if (!password.isFile() || (password.mode & 0o077) !== 0)
      throw new Error("restic password file must be a 0600 regular file");
    const temp = path.join(groupDir, ".restic-tmp");
    await mkdir(temp, { recursive: true, mode: 0o700 });
    return {
      RESTIC_REPOSITORY: repository,
      RESTIC_PASSWORD_FILE: passwordFile,
      TMPDIR: temp,
      ...(this.options.resticEnvironment ?? {}),
    };
  }
}

async function run(
  argv: string[],
  options: { cwd: string; env: Record<string, string> },
): Promise<RunResult> {
  // Role/Gateway access does not require copying host AWS_* values into restic.
  const base: Record<string, string> = {};
  for (const key of ["PATH", "HOME"]) {
    const value = process.env[key];
    if (value) base[key] = value;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: { ...base, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function snapshotId(output: string): string {
  for (const line of output.trim().split("\n").reverse()) {
    let message: { message_type?: unknown; snapshot_id?: unknown };
    try {
      message = JSON.parse(line) as {
        message_type?: unknown;
        snapshot_id?: unknown;
      };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }
    if (
      message.message_type === "summary" &&
      typeof message.snapshot_id === "string"
    ) {
      validateSnapshotId(message.snapshot_id);
      return message.snapshot_id;
    }
  }
  throw new Error("successful restic backup returned no snapshot ID");
}

function validateGroupId(groupId: string): void {
  // No dot: the group id becomes a KMS alias whose charset excludes '.', so the
  // custodian agrees with that binding constraint (and with the mounter and
  // snapshot store) instead of accepting ids that fail later at KMS.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(groupId))
    throw new Error(`invalid workspace group ID: ${groupId}`);
}

function validateSnapshotId(id: string): void {
  if (!/^[a-f0-9]{64}$/.test(id))
    throw new Error("restic snapshot ID must be the exact 64-character ID");
}

function validateHead(head: WorkspaceHead, expectedGroupId?: string): void {
  validateGroupId(head.groupId);
  if (expectedGroupId && head.groupId !== expectedGroupId)
    throw new Error("head belongs to a different workspace group");
  validateSnapshotId(head.snapshotId);
  if (!Number.isSafeInteger(head.epoch) || head.epoch < 1)
    throw new Error("invalid workspace head epoch");
}

function validateCandidate(
  candidate: SnapshotCandidate,
  expectedGroupId?: string,
): void {
  validateGroupId(candidate.groupId);
  if (expectedGroupId && candidate.groupId !== expectedGroupId)
    throw new Error("candidate belongs to a different workspace group");
  validateSnapshotId(candidate.snapshotId);
  if (candidate.base) validateHead(candidate.base, candidate.groupId);
  if (new Date(candidate.completedAt).toISOString() !== candidate.completedAt)
    throw new Error("invalid candidate time");
}

function validatePublication(
  publication: PublishResult,
  candidate: SnapshotCandidate,
): void {
  validateCandidate(candidate);
  if (publication.published) {
    validateHead(publication.head, candidate.groupId);
    if (publication.head.snapshotId !== candidate.snapshotId)
      throw new Error("published head does not reference candidate");
    if (publication.head.epoch !== (candidate.base?.epoch ?? 0) + 1)
      throw new Error("published head has an invalid epoch");
  } else {
    validateHead(publication.current, candidate.groupId);
    if (sameHead(publication.current, candidate.base))
      throw new Error("snapshot store rejected an unchanged head");
  }
}

function sameHead(
  left: WorkspaceHead | null,
  right: WorkspaceHead | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.groupId === right.groupId &&
        left.snapshotId === right.snapshotId &&
        left.epoch === right.epoch;
}

function replicaBase(replica: ReplicaState): WorkspaceHead | null {
  return replica.state === "publishing" ? replica.candidate.base : replica.base;
}

/**
 * Reads `.replica.json`. A missing file is a fresh replica. A corrupt file
 * (torn write survivor, structural garbage) reads as a fresh replica too — S3
 * is the authority — and, when `repair` is set (checkpoint/restore, which hold
 * the phase claim), the corrupt bytes are quarantined as `.replica-invalid-*`
 * for forensics instead of wedging every operation forever. Only an explicit
 * future `version` keeps failing loudly.
 */
async function readReplicaState(
  groupDir: string,
  groupId: string,
  repair: boolean,
): Promise<ReplicaState> {
  let raw: string;
  try {
    raw = await readFile(path.join(groupDir, ".replica.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, state: "clean", base: null };
    throw new Error(
      `invalid replica state for ${groupId}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return quarantineReplicaState(groupDir, repair);
  }
  if (!value || typeof value !== "object")
    return quarantineReplicaState(groupDir, repair);
  const replica = value as Partial<ReplicaState>;
  if (replica.version !== 1)
    throw new Error(`unsupported replica state for ${groupId}`);
  try {
    if (replica.state === "clean") {
      if (replica.base) validateHead(replica.base, groupId);
    } else if (replica.state === "publishing") {
      validateCandidate(replica.candidate as SnapshotCandidate, groupId);
    } else if (replica.state === "restoring") {
      validateHead(replica.head as WorkspaceHead, groupId);
      if (replica.base) validateHead(replica.base, groupId);
    } else if (replica.state === "conflicted") {
      if (replica.base) validateHead(replica.base, groupId);
      validateCandidate(replica.local as SnapshotCandidate, groupId);
      validateHead(replica.remote as WorkspaceHead, groupId);
    } else {
      throw new Error(`invalid replica state for ${groupId}`);
    }
  } catch {
    return quarantineReplicaState(groupDir, repair);
  }
  return replica as ReplicaState;
}

async function quarantineReplicaState(
  groupDir: string,
  repair: boolean,
): Promise<ReplicaState> {
  if (repair) {
    const preserved = path.join(
      groupDir,
      `.replica-invalid-${process.pid}-${randomUUID()}.json`,
    );
    await rename(path.join(groupDir, ".replica.json"), preserved).catch(
      () => {},
    );
  }
  return { version: 1, state: "clean", base: null };
}

async function writeReplicaState(
  groupDir: string,
  state: ReplicaState,
): Promise<void> {
  const target = path.join(groupDir, ".replica.json");
  const temporary = path.join(
    groupDir,
    `.replica-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    // fsync data before the rename and the directory after it: crash recovery
    // is this file's whole purpose, so a power loss must not tear it.
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await syncDirectory(groupDir);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncDirectory(dir: string): Promise<void> {
  // Best-effort: some filesystems refuse directory fsync.
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* the rename itself is still atomic */
  }
}

/**
 * Sweeps crashed work, but never data: an interrupted promote can leave the
 * group's only cipher copy parked in `.previous-*`, so that is recovered —
 * renamed back into place — before anything is deleted.
 */
async function recoverStaleWork(
  groupDir: string,
  cipher: string,
): Promise<void> {
  const entries = await readdir(groupDir);
  const parked = entries.filter((entry) => entry.startsWith(".previous-"));
  if (parked.length > 0 && !(await isDirectory(cipher)))
    await rename(path.join(groupDir, parked.shift()!), cipher);
  const disposable = entries.filter(
    (entry) =>
      entry.startsWith(".restore-") || /^\.replica-.*\.tmp$/.test(entry),
  );
  for (const entry of [...disposable, ...parked]) {
    await rm(path.join(groupDir, entry), { recursive: true, force: true });
  }
}

const PROCESS_LOCK = ".op-lock";

/**
 * One custodian process per replica is a documented invariant; this lock
 * enforces it so a second process (deploy overlap, ops CLI) cannot sweep live
 * work.
 */
async function acquireProcessLock(
  groupDir: string,
  groupId: string,
): Promise<void> {
  const lock = path.join(groupDir, PROCESS_LOCK);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number.parseInt(
        await readFile(lock, "utf8").catch(() => ""),
        10,
      );
      if (holder !== process.pid && processAlive(holder))
        throw new ReplicaBlockedError(
          `workspace ${groupId} is locked by another custodian process (pid ${holder})`,
        );
      await rm(lock, { force: true });
    }
  }
  throw new ReplicaBlockedError(
    `workspace ${groupId} is locked by another custodian process`,
  );
}

async function releaseProcessLock(groupDir: string): Promise<void> {
  const lock = path.join(groupDir, PROCESS_LOCK);
  const holder = Number.parseInt(
    await readFile(lock, "utf8").catch(() => ""),
    10,
  );
  if (holder === process.pid) await rm(lock, { force: true });
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function isDirectory(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isDirectory();
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return false;
    throw error;
  }
}

async function promote(
  staging: string,
  current: string,
  groupDir: string,
): Promise<void> {
  const previous = path.join(
    groupDir,
    `.previous-${process.pid}-${randomUUID()}`,
  );
  const hadCurrent = await isDirectory(current);
  if (hadCurrent) await rename(current, previous);
  try {
    await rename(staging, current);
  } catch (error) {
    if (hadCurrent) await rename(previous, current);
    throw error;
  }
  if (hadCurrent) await rm(previous, { recursive: true, force: true });
}

function commandError(operation: string, result: RunResult): Error {
  const detail =
    (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-1)[0] ||
    "no output";
  return new Error(`restic ${operation} failed (${result.code}): ${detail}`);
}

function errorMessage(error: unknown): string {
  return (
    (error instanceof Error ? error.message : String(error)) ||
    "unknown workspace failure"
  );
}
