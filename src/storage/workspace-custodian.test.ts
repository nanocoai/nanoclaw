import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  WorkspaceCustodian,
  type PublishResult,
  type S3SnapshotStore,
  type SnapshotCandidate,
  type WorkspaceCustodianOptions,
  type WorkspaceHead,
} from "./workspace-custodian.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

describe("workspace custodian contract", () => {
  it("uses the explicit content path without relocating it under metadata", async () => {
    const replica = await workspace("finance", false);
    const contentRoot = await mkdtemp(path.join(os.tmpdir(), "workspace-content-"));
    roots.push(contentRoot);
    const content = path.join(contentRoot, "workspace-replicas", "finance", "cipher");
    await mkdir(content, { recursive: true });
    await writeFile(path.join(content, "gocryptfs.conf"), "cipher-config");
    const commands: { argv: string[]; cwd: string }[] = [];
    const custodian = new WorkspaceCustodian({
      root: replica.root,
      workspace: (groupId) => path.join(contentRoot, "workspace-replicas", groupId, "cipher"),
      repository: () => "s3:s3.amazonaws.com/workspaces/finance",
      passwordFile: () => replica.password,
      snapshots: memoryStore().store,
      quiesce: async () => {},
      run: async (argv, options) => {
        commands.push({ argv, cwd: options.cwd });
        if (argv[1] === "backup") return { code: 0, stdout: JSON.stringify({ message_type: "summary", snapshot_id: "d".repeat(64) }), stderr: "" };
        return { code: 0, stdout: "{}", stderr: "" };
      },
    });
    await custodian.checkpoint("finance");
    expect(commands.find(({ argv }) => argv[1] === "backup")?.cwd).toBe(content);
    expect(await stat(content)).toBeTruthy();
    await expect(stat(path.join(replica.root, "finance", "cipher"))).rejects.toThrow();
  });

  it("restores an explicit content path whose parent does not exist yet", async () => {
    const replica = await workspace("finance", false);
    const contentRoot = await mkdtemp(path.join(os.tmpdir(), "workspace-content-"));
    roots.push(contentRoot);
    const content = path.join(contentRoot, "workspace-replicas", "finance", "cipher");
    const head: WorkspaceHead = { groupId: "finance", snapshotId: "d".repeat(64), epoch: 1 };
    const custodian = new WorkspaceCustodian({
      root: replica.root,
      workspace: () => content,
      repository: () => "s3:s3.amazonaws.com/workspaces/finance",
      passwordFile: () => replica.password,
      snapshots: memoryStore(head).store,
      quiesce: async () => {},
      run: async (argv) => {
        const target = argv[argv.indexOf("--target") + 1];
        await mkdir(target, { recursive: true });
        await writeFile(path.join(target, "gocryptfs.conf"), `restored:${argv[3]}`);
        return { code: 0, stdout: "{}\n", stderr: "" };
      },
    });

    await custodian.restore("finance", head);

    expect(await readFile(path.join(content, "gocryptfs.conf"), "utf8")).toBe(`restored:${head.snapshotId}`);
    await expect(stat(path.join(replica.groupDir, "cipher"))).rejects.toThrow();
  });

  it("stores candidate receipts durably, retries publication, restores exact heads, and passes no AWS variables", async () => {
    const { root, password } = await workspace("finance");
    const group = "finance";
    const snapshots = memoryStore();
    const commands: string[][] = [];
    const events: string[] = [];
    let backupId = "a".repeat(64);
    let failBackup = false;
    let failRestore = false;
    let expectedPassword = password;
    const options: WorkspaceCustodianOptions = {
      root,
      repository: (id) => `s3:s3.amazonaws.com/workspaces/${id}`,
      passwordFile: () => password,
      snapshots: snapshots.store,
      quiesce: async () => {
        events.push("quiesce");
      },
      now: () => new Date("2026-08-16T12:00:00.000Z"),
      run: async (argv, runOptions) => {
        commands.push(argv);
        events.push(argv[1]);
        expect(runOptions.env.RESTIC_PASSWORD_FILE).toBe(expectedPassword);
        expect(
          Object.keys(runOptions.env).some((key) => key.startsWith("AWS_")),
        ).toBe(false);
        if (argv[1] === "backup") {
          return failBackup
            ? { code: 1, stdout: "", stderr: "interrupted" }
            : {
                code: 0,
                stdout: `${JSON.stringify({ message_type: "summary", snapshot_id: backupId })}\n`,
                stderr: "",
              };
        }
        if (failRestore)
          return { code: 1, stdout: "", stderr: "restore interrupted" };
        const target = argv[argv.indexOf("--target") + 1];
        await mkdir(target, { recursive: true });
        await writeFile(
          path.join(target, "gocryptfs.conf"),
          `restored:${argv[3]}`,
        );
        return { code: 0, stdout: "{}\n", stderr: "" };
      },
    };
    const custodian = new WorkspaceCustodian(options);

    const first = await custodian.checkpoint(group);
    expect(first).toEqual({
      published: true,
      head: { groupId: group, snapshotId: backupId, epoch: 1 },
    });
    const firstHead = publishedHead(first);
    expect(events.indexOf("quiesce")).toBeLessThan(events.indexOf("backup"));
    expect(snapshots.candidates.get(backupId)).toEqual({
      groupId: group,
      snapshotId: backupId,
      base: null,
      completedAt: "2026-08-16T12:00:00.000Z",
    });
    expect(await custodian.status(group)).toEqual({
      phase: "ready",
      base: firstHead,
      head: firstHead,
    });

    backupId = "b".repeat(64);
    snapshots.fail = true;
    const backupCount = commands.filter((argv) => argv[1] === "backup").length;
    await expect(custodian.checkpoint(group)).rejects.toThrow("S3 unavailable");
    expect(snapshots.candidates.has(backupId)).toBe(true);
    expect(await custodian.status(group)).toMatchObject({
      phase: "failed",
      operation: "checkpoint",
    });
    snapshots.fail = false;
    const retry = await custodian.checkpoint(group);
    expect(retry).toEqual({
      published: true,
      head: { groupId: group, snapshotId: backupId, epoch: 2 },
    });
    const retryHead = publishedHead(retry);
    expect(commands.filter((argv) => argv[1] === "backup")).toHaveLength(
      backupCount + 1,
    );

    failBackup = true;
    await expect(custodian.checkpoint(group)).rejects.toThrow("interrupted");
    expect(snapshots.current()).toEqual(retryHead);
    failBackup = false;

    const replacement = await workspace(group, false);
    expectedPassword = replacement.password;
    const restored = new WorkspaceCustodian({
      ...options,
      root: replacement.root,
      passwordFile: () => replacement.password,
    });
    await restored.restore(group, retryHead);
    expect(
      await readFile(
        path.join(replacement.groupDir, "cipher", "gocryptfs.conf"),
        "utf8",
      ),
    ).toBe(`restored:${backupId}`);
    const restore = commands.filter((argv) => argv[1] === "restore").at(-1)!;
    expect(restore).toContain(backupId);
    expect(restore).not.toContain("latest");

    await writeFile(
      path.join(replacement.groupDir, "cipher", "gocryptfs.conf"),
      "changed",
    );
    await restored.restore(group, retryHead);
    expect(
      await readFile(
        path.join(replacement.groupDir, "cipher", "gocryptfs.conf"),
        "utf8",
      ),
    ).toBe(`restored:${backupId}`);
    failRestore = true;
    await expect(restored.restore(group, retryHead)).rejects.toThrow(
      "restore interrupted",
    );
    expect(await restored.status(group)).toMatchObject({
      phase: "failed",
      operation: "restore",
      error: "restic restore failed (1): restore interrupted",
    });
  });

  it("serializes checkpoints of one local replica and reclaims crashed work", async () => {
    const { root, groupDir, password } = await workspace("finance");
    await mkdir(path.join(groupDir, ".restore-crashed"));
    await mkdir(path.join(groupDir, ".previous-crashed"));
    await writeFile(path.join(groupDir, ".replica-crashed.tmp"), "partial");
    const snapshots = memoryStore();
    const snapshotId = "c".repeat(64);
    let release!: () => void;
    const running = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const entered = new Promise<void>((resolve) => (started = resolve));
    const custodian = new WorkspaceCustodian({
      root,
      repository: () => "s3:s3.amazonaws.com/workspaces/finance",
      passwordFile: () => password,
      snapshots: snapshots.store,
      quiesce: async () => {},
      run: async () => {
        started();
        await running;
        return {
          code: 0,
          stdout: `${JSON.stringify({ message_type: "summary", snapshot_id: snapshotId })}\n`,
          stderr: "",
        };
      },
    });

    const first = custodian.checkpoint("finance");
    await entered;
    await expect(custodian.checkpoint("finance")).rejects.toThrow("busy");
    release();
    await expect(first).resolves.toMatchObject({ published: true });

    const entries = await readdir(groupDir);
    expect(entries).not.toContain(".restore-crashed");
    expect(entries).not.toContain(".previous-crashed");
    expect(entries).not.toContain(".replica-crashed.tmp");
    expect(entries).toContain("cipher");
  });

  it("publishes exactly one head when two replicas race from the same base", async () => {
    const group = "finance";
    const base: WorkspaceHead = {
      groupId: group,
      snapshotId: "d".repeat(64),
      epoch: 7,
    };
    const snapshots = memoryStore(base, 2);
    const replicaA = await workspace(group, false);
    const replicaB = await workspace(group, false);
    const makeCustodian = (replica: typeof replicaA, snapshotId: string) =>
      new WorkspaceCustodian({
        root: replica.root,
        repository: () => "s3:s3.amazonaws.com/workspaces/finance",
        passwordFile: () => replica.password,
        snapshots: snapshots.store,
        quiesce: async () => {},
        run: async (argv) => {
          if (argv[1] === "backup") {
            return {
              code: 0,
              stdout: `${JSON.stringify({ message_type: "summary", snapshot_id: snapshotId })}\n`,
              stderr: "",
            };
          }
          const target = argv[argv.indexOf("--target") + 1];
          await mkdir(target, { recursive: true });
          await writeFile(path.join(target, "gocryptfs.conf"), "base");
          return { code: 0, stdout: "{}\n", stderr: "" };
        },
      });
    const a = makeCustodian(replicaA, "a".repeat(64));
    const b = makeCustodian(replicaB, "b".repeat(64));
    await Promise.all([a.restore(group, base), b.restore(group, base)]);

    const results = await Promise.all([
      a.checkpoint(group),
      b.checkpoint(group),
    ]);
    const winner = results.find(
      (result): result is Extract<PublishResult, { published: true }> =>
        result.published,
    )!;
    const loser = results.find(
      (result): result is Extract<PublishResult, { published: false }> =>
        !result.published,
    )!;
    expect(winner.head.epoch).toBe(8);
    expect(loser.current).toEqual(winner.head);
    expect(snapshots.candidates).toHaveLength(2);
    expect(
      [...snapshots.candidates.values()].every(
        (candidate) => candidate.base?.snapshotId === base.snapshotId,
      ),
    ).toBe(true);

    const statuses = await Promise.all([a.status(group), b.status(group)]);
    expect(statuses.map((status) => status.phase).sort()).toEqual([
      "conflicted",
      "ready",
    ]);
    const conflicted = statuses.find(
      (status) => status.phase === "conflicted",
    )!;
    expect(conflicted).toMatchObject({
      base,
      head: winner.head,
      conflict: { remote: winner.head },
    });
    const losingCustodian = results[0].published ? b : a;
    await expect(losingCustodian.restore(group, winner.head)).rejects.toThrow(
      "unpublished local changes",
    );
    // The explicit conflict exit: adopt the remote head, drop the local
    // candidate (its receipt stays durable in S3).
    await losingCustodian.restore(group, winner.head, { discardLocal: true });
    expect(await losingCustodian.status(group)).toMatchObject({
      phase: "ready",
      base: winner.head,
    });
  });
});

describe("workspace custodian recovery contract", () => {
  it("keeps status() read-only while a publication is pending", async () => {
    const replica = await workspace("finance");
    const candidate: SnapshotCandidate = {
      groupId: "finance",
      snapshotId: "a".repeat(64),
      base: null,
      completedAt: "2026-08-16T12:00:00.000Z",
    };
    await writeState(replica.groupDir, {
      version: 1,
      state: "publishing",
      candidate,
    });
    const snapshots = memoryStore({
      groupId: "finance",
      snapshotId: "e".repeat(64),
      epoch: 1,
    });
    const { custodian } = replicaCustodian(replica, snapshots);
    const status = await custodian.status("finance");
    expect(status.phase).toBe("conflicted");
    // The poll reported the conflict but must not have persisted it: only the
    // serialized checkpoint/restore operations may rewrite replica state.
    const disk = JSON.parse(
      await readFile(path.join(replica.groupDir, ".replica.json"), "utf8"),
    ) as { state: string };
    expect(disk.state).toBe("publishing");
  });

  it("recognizes a published-then-superseded candidate instead of fabricating a conflict", async () => {
    const group = "finance";
    const replica = await workspace(group);
    const base: WorkspaceHead = {
      groupId: group,
      snapshotId: "d".repeat(64),
      epoch: 7,
    };
    const ourHead: WorkspaceHead = {
      groupId: group,
      snapshotId: "a".repeat(64),
      epoch: 8,
    };
    const peerHead: WorkspaceHead = {
      groupId: group,
      snapshotId: "b".repeat(64),
      epoch: 9,
    };
    const ours: SnapshotCandidate = {
      groupId: group,
      snapshotId: ourHead.snapshotId,
      base,
      completedAt: "2026-08-16T12:00:00.000Z",
    };
    const theirs: SnapshotCandidate = {
      groupId: group,
      snapshotId: peerHead.snapshotId,
      base: ourHead,
      completedAt: "2026-08-16T12:00:00.000Z",
    };
    // Crash left us "publishing", but the publish landed and a peer built on it.
    await writeState(replica.groupDir, {
      version: 1,
      state: "publishing",
      candidate: ours,
    });
    const snapshots = memoryStore(peerHead);
    snapshots.candidates.set(ours.snapshotId, ours);
    snapshots.candidates.set(theirs.snapshotId, theirs);
    const { custodian } = replicaCustodian(replica, snapshots);
    expect(await custodian.status(group)).toMatchObject({
      phase: "ready",
      base: ourHead,
      head: peerHead,
    });
    await custodian.restore(group, peerHead);
    expect(await custodian.status(group)).toMatchObject({
      phase: "ready",
      base: peerHead,
    });
  });

  it("recovers a cipher tree parked in .previous-* by an interrupted promote", async () => {
    const replica = await workspace("finance", false);
    await mkdir(path.join(replica.groupDir, ".previous-4242-crashed"));
    await writeFile(
      path.join(replica.groupDir, ".previous-4242-crashed", "gocryptfs.conf"),
      "parked-cipher",
    );
    const { custodian } = replicaCustodian(replica, memoryStore());
    const publication = await custodian.checkpoint("finance");
    expect(publication.published).toBe(true);
    expect(
      await readFile(
        path.join(replica.groupDir, "cipher", "gocryptfs.conf"),
        "utf8",
      ),
    ).toBe("parked-cipher");
  });

  it("quarantines a corrupt replica state file instead of failing forever", async () => {
    const replica = await workspace("finance");
    await writeFile(path.join(replica.groupDir, ".replica.json"), "");
    const { custodian } = replicaCustodian(replica, memoryStore());
    expect((await custodian.status("finance")).phase).toBe("ready");
    const publication = await custodian.checkpoint("finance");
    expect(publication.published).toBe(true);
    const entries = await readdir(replica.groupDir);
    expect(entries.some((entry) => entry.startsWith(".replica-invalid-"))).toBe(
      true,
    );
    // Structurally invalid state (valid JSON) must not surface a raw TypeError.
    await writeState(replica.groupDir, { version: 1, state: "publishing" });
    expect((await custodian.status("finance")).phase).toBe("ready");
  });

  it("initializes a missing restic repository before the first backup", async () => {
    const replica = await workspace("finance");
    const snapshots = memoryStore();
    const commands: string[][] = [];
    let repositoryExists = false;
    const custodian = new WorkspaceCustodian({
      root: replica.root,
      repository: () => "s3:s3.amazonaws.com/workspaces/finance",
      passwordFile: () => replica.password,
      snapshots: snapshots.store,
      quiesce: async () => {},
      run: async (argv) => {
        commands.push(argv);
        if (argv[1] === "init") {
          repositoryExists = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (!repositoryExists) {
          return {
            code: 1,
            stdout: "",
            stderr: "Fatal: repository does not exist: unable to open config",
          };
        }
        return { code: 0, stdout: summaryLine("f".repeat(64)), stderr: "" };
      },
    });
    const publication = await custodian.checkpoint("finance");
    expect(publication.published).toBe(true);
    expect(commands.map((argv) => argv[1])).toEqual([
      "backup",
      "init",
      "backup",
    ]);
  });

  it("names the PROBE error when the repository exists but cannot be opened (ensureRepository)", async () => {
    // nancy-v3, 2026-08-30: three custodian generations crash-looped on
    // "restic init failed … already initialized" while the cat-config probe's
    // own failure was never printed once. The init is only the existence arm;
    // when it says the repository exists, the probe error is the finding.
    const replica = await workspace("finance");
    const custodian = new WorkspaceCustodian({
      root: replica.root,
      repository: () => "s3:s3.amazonaws.com/workspaces/finance",
      passwordFile: () => replica.password,
      snapshots: memoryStore().store,
      quiesce: async () => {},
      run: async (argv) => {
        if (argv[1] === "cat")
          return { code: 1, stdout: "", stderr: "Fatal: ListObjectsV2 blocked: 403 upstream" };
        if (argv[1] === "init")
          return { code: 1, stdout: "", stderr: "Fatal: create key in repository failed: repository master key and config already initialized" };
        return { code: 0, stdout: "{}", stderr: "" };
      },
    });
    await expect(custodian.ensureRepository("finance")).rejects.toThrow(
      /cat config failed \(1\): Fatal: ListObjectsV2 blocked: 403 upstream; the repository exists/,
    );
  });

  it("names the BACKUP error when the first checkpoint fails against an existing repository", async () => {
    const replica = await workspace("finance");
    const custodian = new WorkspaceCustodian({
      root: replica.root,
      repository: () => "s3:s3.amazonaws.com/workspaces/finance",
      passwordFile: () => replica.password,
      snapshots: memoryStore().store,
      quiesce: async () => {},
      run: async (argv) => {
        if (argv[1] === "backup")
          return { code: 1, stdout: "", stderr: "Fatal: wrong password or no key found" };
        if (argv[1] === "init")
          return { code: 1, stdout: "", stderr: "Fatal: repository master key and config already initialized" };
        return { code: 0, stdout: "{}", stderr: "" };
      },
    });
    await expect(custodian.checkpoint("finance")).rejects.toThrow(
      /backup failed \(1\): Fatal: wrong password or no key found; the repository exists/,
    );
  });

  it("quiesces local writers before restore replaces the replica", async () => {
    const head: WorkspaceHead = {
      groupId: "finance",
      snapshotId: "c".repeat(64),
      epoch: 3,
    };
    const replica = await workspace("finance");
    const { custodian, events } = replicaCustodian(replica, memoryStore(head));
    await custodian.restore("finance", head);
    expect(events.indexOf("quiesce")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("quiesce")).toBeLessThan(events.indexOf("restore"));
  });

  it("surfaces an interrupted restore and completes it on retry", async () => {
    const head: WorkspaceHead = {
      groupId: "finance",
      snapshotId: "c".repeat(64),
      epoch: 3,
    };
    const replica = await workspace("finance");
    await writeState(replica.groupDir, {
      version: 1,
      state: "restoring",
      head,
      base: null,
    });
    const { custodian } = replicaCustodian(replica, memoryStore(head));
    await expect(custodian.checkpoint("finance")).rejects.toThrow(
      "interrupted restore",
    );
    expect(await custodian.status("finance")).toMatchObject({
      phase: "failed",
      operation: "restore",
    });
    await custodian.restore("finance", head);
    expect(await custodian.status("finance")).toMatchObject({
      phase: "ready",
      base: head,
    });
    expect(
      await readFile(
        path.join(replica.groupDir, "cipher", "gocryptfs.conf"),
        "utf8",
      ),
    ).toBe(`restored:${head.snapshotId}`);
  });

  it("accepts a password file behind a symlink, as Kubernetes Secret mounts deliver it", async () => {
    const replica = await workspace("finance");
    const link = path.join(replica.root, "restic.pass.link");
    await symlink(replica.password, link);
    const { custodian } = replicaCustodian(replica, memoryStore(), () => link);
    const publication = await custodian.checkpoint("finance");
    expect(publication.published).toBe(true);
  });

  it("locks the replica against other custodian processes and reclaims dead locks", async () => {
    const replica = await workspace("finance");
    const lock = path.join(replica.groupDir, ".op-lock");
    // pid 1 is always alive and is never us.
    await writeFile(lock, "1\n");
    const { custodian } = replicaCustodian(replica, memoryStore());
    await expect(custodian.checkpoint("finance")).rejects.toThrow(
      "another custodian process",
    );
    const dead = spawnSync(process.execPath, ["--version"], {
      stdio: "ignore",
    }).pid;
    await writeFile(lock, `${dead}\n`);
    const publication = await custodian.checkpoint("finance");
    expect(publication.published).toBe(true);
  });
});

function publishedHead(result: PublishResult): WorkspaceHead {
  if (!result.published) throw new Error("expected a published checkpoint");
  return result.head;
}

function summaryLine(snapshotId: string): string {
  return `${JSON.stringify({ message_type: "summary", snapshot_id: snapshotId })}\n`;
}

async function writeState(groupDir: string, state: unknown): Promise<void> {
  await writeFile(
    path.join(groupDir, ".replica.json"),
    `${JSON.stringify(state)}\n`,
  );
}

function replicaCustodian(
  replica: { root: string; password: string },
  snapshots: ReturnType<typeof memoryStore>,
  passwordFile?: (groupId: string) => string,
) {
  const commands: string[][] = [];
  const events: string[] = [];
  const custodian = new WorkspaceCustodian({
    root: replica.root,
    repository: () => "s3:s3.amazonaws.com/workspaces/finance",
    passwordFile: passwordFile ?? (() => replica.password),
    snapshots: snapshots.store,
    quiesce: async () => {
      events.push("quiesce");
    },
    now: () => new Date("2026-08-16T12:00:00.000Z"),
    run: async (argv) => {
      commands.push(argv);
      events.push(argv[1]);
      if (argv[1] === "backup") {
        return { code: 0, stdout: summaryLine("f".repeat(64)), stderr: "" };
      }
      if (argv[1] === "restore") {
        const target = argv[argv.indexOf("--target") + 1];
        await mkdir(target, { recursive: true });
        await writeFile(
          path.join(target, "gocryptfs.conf"),
          `restored:${argv[3]}`,
        );
      }
      return { code: 0, stdout: "{}\n", stderr: "" };
    },
  });
  return { custodian, commands, events };
}

async function workspace(group: string, withCipher = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-custodian-"));
  roots.push(root);
  const groupDir = path.join(root, group);
  await mkdir(groupDir, { recursive: true });
  if (withCipher) {
    await mkdir(path.join(groupDir, "cipher"));
    await writeFile(
      path.join(groupDir, "cipher", "gocryptfs.conf"),
      "cipher-config",
    );
  }
  const password = path.join(root, "restic.pass");
  await writeFile(password, "different-test-secret", { mode: 0o600 });
  await chmod(password, 0o600);
  return { root, groupDir, password };
}

function memoryStore(initial: WorkspaceHead | null = null, waitFor = 0) {
  let head = initial;
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  const candidates = new Map<string, SnapshotCandidate>();
  const state = {
    fail: false,
    candidates,
    current: () => head,
    store: {
      head: async () => head,
      candidate: async (groupId: string, snapshotId: string) => {
        const receipt = candidates.get(snapshotId);
        return receipt && receipt.groupId === groupId ? receipt : null;
      },
      publish: async (
        candidate: SnapshotCandidate,
        expected: WorkspaceHead | null,
      ): Promise<PublishResult> => {
        candidates.set(candidate.snapshotId, candidate);
        if (state.fail) throw new Error("S3 unavailable");
        if (waitFor) {
          arrivals += 1;
          if (arrivals === waitFor) release();
          await barrier;
        }
        if (!sameHead(head, expected)) {
          if (!head) throw new Error("test store has no conflicting head");
          return { published: false, current: head };
        }
        head = {
          groupId: candidate.groupId,
          snapshotId: candidate.snapshotId,
          epoch: (expected?.epoch ?? 0) + 1,
        };
        return { published: true, head };
      },
    } satisfies S3SnapshotStore,
  };
  return state;
}

function sameHead(left: WorkspaceHead | null, right: WorkspaceHead | null) {
  return left === null || right === null
    ? left === right
    : left.groupId === right.groupId &&
        left.snapshotId === right.snapshotId &&
        left.epoch === right.epoch;
}
