import path from "node:path";
import { access, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { readEnvFile } from "../env.js";
import {
  GroupResticPassword,
  createRoleBackedGroupKms,
  type WrappedEnvelopeStore,
} from "./group-restic-password.js";
import {
  createRoleBackedS3SnapshotStore,
  createRoleBackedSnapshotObjectStore,
} from "./s3-snapshot-store.js";
import { WorkspaceCustodian } from "./workspace-custodian.js";
import { WorkspaceRuntime } from "./workspace-runtime.js";

type Quiescer = (groupId: string) => Promise<void>;
let installedQuiescer: Quiescer | undefined;

const WORKSPACE_S3_KEYS = [
  "NANOCLAW_WORKSPACE_S3_BUCKET",
  "NANOCLAW_WORKSPACE_S3_ENDPOINT",
  "NANOCLAW_WORKSPACE_S3_PREFIX",
  "NANOCLAW_WORKSPACE_S3_REGION",
] as const;

/**
 * WHICH FABRIC THIS WORKSPACE PLANE TALKS TO, declared rather than sniffed.
 *
 * Unset means AWS and every existing deployment is unchanged: the endpoint must
 * be the regional AWS HTTPS endpoint and must agree with the region, exactly as
 * before. `mock` is a governed child saying "my whole fabric is my own" — its
 * object store and KMS are the facades its stamp provisions beside it, because
 * reaching the parent's would mean holding the parent's credentials across the
 * seal that makes a child a tenancy boundary.
 *
 * It is a DECLARATION, never an inference from the endpoint's shape: a
 * deployment that meant to address AWS and typed the wrong host must still be
 * refused, and it is — the mock arm below only accepts an in-cluster service
 * name, so this can widen the accepted endpoint to a facade and never to the
 * internet.
 */
const WORKSPACE_FABRIC_KEY = "NANOCLAW_WORKSPACE_S3_FABRIC";
/** `https://<service>.<ns>.svc[.cluster.local][:port]` — in-cluster only. */
const IN_CLUSTER_ENDPOINT =
  /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.svc(?:\.cluster\.local)?(?::\d{2,5})?$/;

/**
 * The wrapping-key endpoint. Required under a mock fabric and meaningless
 * without one: on AWS the SDK resolves KMS for the region, as it always has.
 */
const WORKSPACE_KMS_ENDPOINT_KEY = "NANOCLAW_WORKSPACE_KMS_ENDPOINT";

export function workspaceKmsEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  file = readEnvFile([WORKSPACE_KMS_ENDPOINT_KEY]),
): string | undefined {
  return (
    env[WORKSPACE_KMS_ENDPOINT_KEY]?.trim() ||
    file[WORKSPACE_KMS_ENDPOINT_KEY]?.trim() ||
    undefined
  );
}

export type WorkspaceFabric = "aws" | "mock";

export function workspaceFabric(
  env: NodeJS.ProcessEnv = process.env,
  file = readEnvFile([WORKSPACE_FABRIC_KEY]),
): WorkspaceFabric {
  const raw = (
    env[WORKSPACE_FABRIC_KEY]?.trim() ||
    file[WORKSPACE_FABRIC_KEY]?.trim() ||
    ""
  ).toLowerCase();
  // Unknown values fall to `aws`: a typo must tighten to the strict arm, never
  // silently unlock the facade one.
  return raw === "mock" ? "mock" : "aws";
}

export function workspaceS3Settings(
  env: NodeJS.ProcessEnv = process.env,
  file = readEnvFile([...WORKSPACE_S3_KEYS]),
): Record<(typeof WORKSPACE_S3_KEYS)[number], string> {
  return Object.fromEntries(
    WORKSPACE_S3_KEYS.map((key) => [key, env[key]?.trim() || file[key]?.trim() || ""]),
  ) as Record<(typeof WORKSPACE_S3_KEYS)[number], string>;
}

/** The Kata runtime must install the FUSE-unmount barrier before use. */
export function installWorkspaceQuiescer(quiescer: Quiescer): void {
  installedQuiescer = quiescer;
}

/**
 * The other half of the same silence. `pod-session-driver` REQUIRES this skill
 * too, so a container-tier recipe installs the custodian, the S3 receipt store,
 * and the KMS envelopes — and then the tier gate never calls `fromEnv`, so not
 * one of them is ever constructed. Nothing throws, nothing warns, and the box
 * looks exactly like a box whose checkpoints work. The gate logs this string
 * beside the mounter's so both dormant halves are named, not just the visible
 * one.
 */
export const WORKSPACE_CHECKPOINTS_DORMANT_ON_CONTAINER_TIER =
  "fenced-workspace-checkpoints is composed but DORMANT: HostWorkspaceRuntime is built only when " +
  "NANOCLAW_RUNTIME_TIER='vm', so this deployment takes no restic checkpoint, advances no S3 " +
  "head, and unwraps no KMS envelope — an agent group's work does not survive its pod. Durable " +
  "workspaces under runc are stage 3 of engineering/k8s/native/isolation-tiers-plan.";

export class HostWorkspaceRuntime {
  readonly #runtime: WorkspaceRuntime;
  readonly #passwords: GroupResticPassword;
  readonly #snapshots: { head(groupId: string): Promise<unknown> };
  readonly #contentRoot: string;
  readonly #initializing = new Map<string, Promise<void>>();
  readonly #preparing = new Map<string, Promise<void>>();

  private constructor(
    runtime: WorkspaceRuntime,
    passwords: GroupResticPassword,
    snapshots: { head(groupId: string): Promise<unknown> },
    contentRoot: string,
  ) {
    this.#runtime = runtime;
    this.#passwords = passwords;
    this.#snapshots = snapshots;
    this.#contentRoot = contentRoot;
  }

  static async fromEnv(
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<HostWorkspaceRuntime> {
    const values = workspaceS3Settings(env);
    const present = WORKSPACE_S3_KEYS.filter((key) => values[key]).length;
    if (present !== WORKSPACE_S3_KEYS.length)
      throw new Error(
        `workspace S3 configuration is incomplete (${present}/${WORKSPACE_S3_KEYS.length})`,
      );
    const fabric = workspaceFabric(env);
    if (fabric === "mock") {
      // A child's own fabric. Still validated, and deliberately narrow: an
      // in-cluster service name only, so this arm can never address the
      // internet — and never AWS, which is the point of the boundary.
      if (!IN_CLUSTER_ENDPOINT.test(values.NANOCLAW_WORKSPACE_S3_ENDPOINT))
        throw new Error(
          `workspace S3 endpoint must be an in-cluster https service when ${WORKSPACE_FABRIC_KEY}=mock`,
        );
      const kmsEndpoint = workspaceKmsEndpoint(env);
      if (!kmsEndpoint)
        throw new Error(
          `${WORKSPACE_KMS_ENDPOINT_KEY} is required when ${WORKSPACE_FABRIC_KEY}=mock: a mock fabric holds its own wrapping keys`,
        );
      if (!IN_CLUSTER_ENDPOINT.test(kmsEndpoint))
        throw new Error(
          `${WORKSPACE_KMS_ENDPOINT_KEY} must be an in-cluster https service when ${WORKSPACE_FABRIC_KEY}=mock`,
        );
    } else if (
      !/^https:\/\/s3\.[a-z]{2}(?:-gov)?-[a-z]+-\d\.amazonaws\.com$/.test(
        values.NANOCLAW_WORKSPACE_S3_ENDPOINT,
      )
    )
      throw new Error(
        "workspace S3 endpoint must be the regional AWS HTTPS endpoint",
      );
    // The endpoint is sliced into the restic repository URL while the SDK
    // clients use the region; on AWS require them to agree so restic and the SDK
    // can never address the same bucket through two different regions. Under a
    // mock fabric that invariant is kept a stronger way: BOTH sides are handed
    // the same endpoint below, so there is no second address to disagree with,
    // and the region degrades to what it is there — a signing input.
    if (
      fabric === "aws" &&
      values.NANOCLAW_WORKSPACE_S3_ENDPOINT !==
        `https://s3.${values.NANOCLAW_WORKSPACE_S3_REGION}.amazonaws.com`
    )
      throw new Error(
        "workspace S3 endpoint must match the configured region",
      );
    const metadataRoot = path.resolve(
      env.NANOCLAW_WORKSPACE_METADATA_ROOT?.trim() ||
        path.join(process.cwd(), "data", "workspace-state"),
    );
    // The custodian must write ciphertext and passfiles under the SAME root the
    // pod driver mounts from — NANOCLAW_WORKSPACE_REPLICA_ROOT, read env-then-.env
    // exactly as configuredWorkspaceReplicaRoot() does — or the two drift and
    // the pod mounts a tree the custodian never populates (or checkpoints the
    // wrong one). CONTENT_ROOT stays a fallback for callers that set it.
    const replicaRootFile = readEnvFile(["NANOCLAW_WORKSPACE_REPLICA_ROOT"]);
    const contentRoot = path.resolve(
      env.NANOCLAW_WORKSPACE_REPLICA_ROOT?.trim() ||
        replicaRootFile.NANOCLAW_WORKSPACE_REPLICA_ROOT?.trim() ||
        env.NANOCLAW_WORKSPACE_CONTENT_ROOT?.trim() ||
        path.join(process.cwd(), "data", "workspace-replicas"),
    );
    if (metadataRoot === contentRoot)
      throw new Error("workspace metadata and content roots must differ");
    // Under a mock fabric every AWS client is pointed at the facades the child's
    // stamp provisions beside it; on AWS both stay undefined and the SDK
    // resolves the regional endpoints exactly as before.
    const objectEndpoint =
      fabric === "mock" ? values.NANOCLAW_WORKSPACE_S3_ENDPOINT : undefined;
    const kmsEndpoint = fabric === "mock" ? workspaceKmsEndpoint(env) : undefined;
    const objects = await createRoleBackedSnapshotObjectStore({
      bucket: values.NANOCLAW_WORKSPACE_S3_BUCKET,
      region: values.NANOCLAW_WORKSPACE_S3_REGION,
      endpoint: objectEndpoint,
    });
    const snapshots = await createRoleBackedS3SnapshotStore({
      bucket: values.NANOCLAW_WORKSPACE_S3_BUCKET,
      prefix: values.NANOCLAW_WORKSPACE_S3_PREFIX,
      region: values.NANOCLAW_WORKSPACE_S3_REGION,
      endpoint: objectEndpoint,
      objects,
    });
    const kms = await createRoleBackedGroupKms(
      values.NANOCLAW_WORKSPACE_S3_REGION,
      kmsEndpoint,
    );
    const passwords = new GroupResticPassword({
      root: contentRoot,
      kms,
      envelopes: objects as WrappedEnvelopeStore,
      prefix: values.NANOCLAW_WORKSPACE_S3_PREFIX,
    });
    const custodian = new WorkspaceCustodian({
      root: metadataRoot,
      workspace: (groupId) => path.join(contentRoot, groupId, "cipher"),
      repository: (groupId) =>
        `s3:${values.NANOCLAW_WORKSPACE_S3_ENDPOINT.slice("https://".length)}/${values.NANOCLAW_WORKSPACE_S3_BUCKET}/${values.NANOCLAW_WORKSPACE_S3_PREFIX}/${groupId}`,
      passwordFile: (groupId) =>
        path.join(contentRoot, groupId, "secrets", "restic.pass"),
      snapshots,
      quiesce: async (groupId) => {
        if (!installedQuiescer)
          throw new Error(
            `workspace ${groupId} has no installed FUSE quiescer`,
          );
        await installedQuiescer(groupId);
      },
    });
    return new HostWorkspaceRuntime(
      new WorkspaceRuntime(custodian),
      passwords,
      snapshots,
      contentRoot,
    );
  }

  async started(groupId: string): Promise<void> {
    const current = this.#preparing.get(groupId);
    if (current) {
      await current;
    } else {
      const preparation = this.#prepare(groupId).finally(() =>
        this.#preparing.delete(groupId),
      );
      this.#preparing.set(groupId, preparation);
      await preparation;
    }
    await this.#runtime.sessionStarted(groupId);
  }
  async adopted(groupId: string): Promise<void> {
    await this.#passwords.ensure(groupId);
    await this.#runtime.sessionAdopted(groupId);
  }
  async aborted(groupId: string): Promise<void> {
    await this.#runtime.sessionAborted(groupId);
  }
  async uncertain(groupId: string): Promise<void> {
    await this.#runtime.sessionUncertain(groupId);
  }
  async stopped(groupId: string): Promise<void> {
    await this.#runtime.sessionStopped(groupId);
  }

  async #prepare(groupId: string): Promise<void> {
    const paths = await this.#passwords.ensure(groupId);
    const head = await this.#snapshots.head(groupId);
    await this.#initialize(groupId, paths.gocryptfs, head);
  }

  async #initialize(
    groupId: string,
    passwordFile: string,
    head: unknown,
  ): Promise<void> {
    if (head) return;
    const current = this.#initializing.get(groupId);
    if (current) return current;
    const operation = initializeCipherTree({
      cipher: path.join(this.#contentRoot, groupId, "cipher"),
      passwordFile,
      run: runGocryptfs,
    }).finally(() => this.#initializing.delete(groupId));
    this.#initializing.set(groupId, operation);
    return operation;
  }
}

export async function initializeCipherTree(options: {
  cipher: string;
  passwordFile: string;
  run: (argv: string[]) => Promise<{ code: number; stderr: string }>;
}): Promise<void> {
  await mkdir(options.cipher, { recursive: true, mode: 0o700 });
  try {
    await access(path.join(options.cipher, "gocryptfs.conf"));
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const result = await options.run([
    "gocryptfs",
    "-init",
    "-q",
    "-passfile",
    options.passwordFile,
    options.cipher,
  ]);
  if (result.code !== 0)
    throw new Error(
      `gocryptfs initialization failed: ${result.stderr.trim().split("\n").slice(-1)[0] || "no output"}`,
    );
}

async function runGocryptfs(
  argv: string[],
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}
