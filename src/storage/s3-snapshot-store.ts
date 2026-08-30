import type {
  PublishResult,
  S3SnapshotStore,
  SnapshotCandidate,
  WorkspaceHead,
} from "./workspace-custodian.js";

type PutCondition = { ifMatch?: string; ifNoneMatch?: "*" };

/** The smallest S3 surface the receipt store needs. */
export interface SnapshotObjectStore {
  get(key: string): Promise<{ body: Uint8Array; etag: string } | null>;
  put(
    key: string,
    body: Uint8Array,
    condition?: PutCondition,
  ): Promise<"ok" | "precondition-failed">;
}

export type S3SnapshotStoreOptions = {
  bucket: string;
  prefix?: string;
  objects: SnapshotObjectStore;
};

/**
 * S3-backed receipt store. Candidate objects are write-once; HEAD is replaced
 * with an S3 conditional PUT using the ETag read immediately before it. AWS
 * authentication is deliberately outside this class: the role-backed
 * adapter below uses the SDK default provider chain, so no credential reaches
 * the custodian or an agent pod.
 */
export class RoleBackedS3SnapshotStore implements S3SnapshotStore {
  readonly #prefix: string;
  readonly #objects: SnapshotObjectStore;

  constructor(options: S3SnapshotStoreOptions) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket))
      throw new Error("invalid workspace snapshot bucket");
    this.#prefix = cleanPrefix(options.prefix ?? "restic");
    this.#objects = options.objects;
  }

  async head(groupId: string): Promise<WorkspaceHead | null> {
    return this.#readJson(this.#headKey(groupId), (value) =>
      asHead(value, groupId),
    );
  }

  async candidate(
    groupId: string,
    snapshotId: string,
  ): Promise<SnapshotCandidate | null> {
    validateGroupId(groupId);
    validateSnapshotId(snapshotId);
    return this.#readJson(this.#candidateKey(groupId, snapshotId), (value) =>
      asCandidate(value, groupId),
    );
  }

  async publish(
    candidate: SnapshotCandidate,
    expectedHead: WorkspaceHead | null,
  ): Promise<PublishResult> {
    validateCandidate(candidate);
    if (expectedHead && !sameHead(expectedHead, candidate.base))
      throw new Error(
        "candidate base does not match the expected workspace head",
      );

    // Receipt first: a HEAD can never point at an object that is not durable.
    const receiptKey = this.#candidateKey(
      candidate.groupId,
      candidate.snapshotId,
    );
    const receipt = new TextEncoder().encode(JSON.stringify(candidate) + "\n");
    const receiptResult = await this.#objects.put(receiptKey, receipt, {
      ifNoneMatch: "*",
    });
    if (receiptResult === "precondition-failed") {
      const existing = await this.#readJson(receiptKey, (value) =>
        asCandidate(value, candidate.groupId),
      );
      if (!existing || JSON.stringify(existing) !== JSON.stringify(candidate))
        throw new Error(
          "immutable workspace candidate already contains different bytes",
        );
    }

    const head = {
      groupId: candidate.groupId,
      snapshotId: candidate.snapshotId,
      epoch: (candidate.base?.epoch ?? 0) + 1,
    };
    const headKey = this.#headKey(candidate.groupId);
    // Read body and ETag together. An ETag by itself does not prove that the
    // current body is the expected HEAD for this candidate.
    const previous = await this.#objects.get(headKey);
    if (expectedHead === null) {
      if (previous)
        return {
          published: false,
          current: asHead(
            JSON.parse(new TextDecoder().decode(previous.body)),
            candidate.groupId,
          ),
        };
      const result = await this.#objects.put(headKey, bytes(head), {
        ifNoneMatch: "*",
      });
      if (result === "ok") return { published: true, head };
    } else {
      if (!previous)
        throw new Error(
          `workspace HEAD disappeared during conditional publish: ${candidate.groupId}`,
        );
      const current = asHead(
        JSON.parse(new TextDecoder().decode(previous.body)),
        candidate.groupId,
      );
      if (!sameHead(current, expectedHead))
        return { published: false, current };
      const result = await this.#objects.put(headKey, bytes(head), {
        ifMatch: previous.etag,
      });
      if (result === "ok") return { published: true, head };
    }
    const current = await this.#objects.get(headKey);
    if (!current)
      throw new Error(
        `workspace HEAD disappeared during conditional publish: ${candidate.groupId}`,
      );
    return {
      published: false,
      current: asHead(
        JSON.parse(new TextDecoder().decode(current.body)),
        candidate.groupId,
      ),
    };
  }

  #headKey(groupId: string): string {
    validateGroupId(groupId);
    return `${this.#prefix}/${groupId}/HEAD`;
  }

  #candidateKey(groupId: string, snapshotId: string): string {
    validateGroupId(groupId);
    validateSnapshotId(snapshotId);
    return `${this.#prefix}/${groupId}/candidates/${snapshotId}.json`;
  }

  async #readJson<T>(
    key: string,
    parse: (value: unknown) => T,
  ): Promise<T | null> {
    const object = await this.#objects.get(key);
    if (!object) return null;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(object.body));
    } catch (error) {
      throw new Error(`invalid snapshot receipt at ${key}`, { cause: error });
    }
    return parse(value);
  }
}

/**
 * Factory for the real host path. The AWS SDK is loaded only in the host
 * process; agents receive neither this dependency's credentials nor its env.
 */
export async function createRoleBackedS3SnapshotStore(
  options: Omit<S3SnapshotStoreOptions, "objects"> & {
    region: string;
    endpoint?: string;
    objects?: SnapshotObjectStore;
  },
): Promise<RoleBackedS3SnapshotStore> {
  return new RoleBackedS3SnapshotStore({
    ...options,
    objects:
      options.objects ?? (await createRoleBackedSnapshotObjectStore(options)),
  });
}

/**
 * Shared role-backed object adapter for receipt and wrapped-secret objects.
 *
 * `endpoint` is how a child environment keeps its own objects. Unset — every
 * deployment that talks to AWS — the SDK resolves the regional endpoint itself,
 * byte-identically to before this option existed. Set, it addresses the fabric
 * the caller was configured with: a governed child's own S3 facade, because a
 * child must never reach the parent's bucket. That would hand it the parent's
 * credentials through the very seal that makes it a tenancy boundary.
 * `forcePathStyle` rides with it — a facade serves `{endpoint}/{bucket}/{key}`
 * and has no virtual-host bucket parsing.
 */
export async function createRoleBackedSnapshotObjectStore(options: {
  bucket: string;
  region: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}): Promise<SnapshotObjectStore> {
  const sdk = await import("@aws-sdk/client-s3");
  const client = new sdk.S3Client({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
  });
  const objects: SnapshotObjectStore = {
    async get(key) {
      try {
        const result = await client.send(
          new sdk.GetObjectCommand({ Bucket: options.bucket, Key: key }),
        );
        if (!result.Body || !result.ETag) return null;
        return {
          body: await result.Body.transformToByteArray(),
          etag: result.ETag,
        };
      } catch (error) {
        if (status(error) === 404) return null;
        throw error;
      }
    },
    async put(key, body, condition) {
      try {
        await client.send(
          new sdk.PutObjectCommand({
            Bucket: options.bucket,
            Key: key,
            Body: body,
            ContentType: "application/json",
            IfMatch: condition?.ifMatch,
            IfNoneMatch: condition?.ifNoneMatch,
          }),
        );
        return "ok";
      } catch (error) {
        // 412 loses a sequential conditional PUT; 409 ConditionalRequestConflict
        // loses a concurrent one. Both mean "a peer won the CAS", which is the
        // result the fencing callers handle — not a fault to rethrow.
        if (status(error) === 412 || status(error) === 409)
          return "precondition-failed";
        throw error;
      }
    },
  };
  return objects;
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value) + "\n");
}

function cleanPrefix(prefix: string): string {
  const value = prefix.replace(/^\/+|\/+$/g, "");
  if (!value || value.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(value))
    throw new Error("invalid workspace snapshot prefix");
  return value;
}

function validateGroupId(value: string): void {
  // No dot: the group id becomes a KMS alias (alias/nanoco-k8s/agent-group/<id>)
  // whose charset excludes '.', so every workspace validator must agree with
  // that binding constraint rather than fail deep at passfile provisioning.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))
    throw new Error(`invalid workspace group ID: ${value}`);
}

function validateSnapshotId(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error("restic snapshot ID must be the exact 64-character ID");
}

function asHead(value: unknown, groupId: string): WorkspaceHead {
  const head = value as Partial<WorkspaceHead>;
  if (
    head.groupId !== groupId ||
    typeof head.snapshotId !== "string" ||
    typeof head.epoch !== "number"
  )
    throw new Error("invalid workspace HEAD receipt");
  validateSnapshotId(head.snapshotId);
  if (!Number.isSafeInteger(head.epoch) || head.epoch < 1)
    throw new Error("invalid workspace HEAD epoch");
  return head as WorkspaceHead;
}

function asCandidate(value: unknown, groupId: string): SnapshotCandidate {
  const candidate = value as Partial<SnapshotCandidate>;
  if (
    candidate.groupId !== groupId ||
    typeof candidate.snapshotId !== "string" ||
    !candidate.completedAt
  )
    throw new Error("invalid workspace candidate receipt");
  validateSnapshotId(candidate.snapshotId);
  if (candidate.base) asHead(candidate.base, groupId);
  if (new Date(candidate.completedAt).toISOString() !== candidate.completedAt)
    throw new Error("invalid candidate time");
  return candidate as SnapshotCandidate;
}

function validateCandidate(candidate: SnapshotCandidate): void {
  validateGroupId(candidate.groupId);
  validateSnapshotId(candidate.snapshotId);
  if (candidate.base) asHead(candidate.base, candidate.groupId);
  if (new Date(candidate.completedAt).toISOString() !== candidate.completedAt)
    throw new Error("invalid candidate time");
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

function status(error: unknown): number | undefined {
  const value = error as {
    $metadata?: { httpStatusCode?: number };
    statusCode?: number;
  };
  return value.$metadata?.httpStatusCode ?? value.statusCode;
}
