import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const GROUP_CONTEXT_KEY = "nanoco-agent-group";
export const PURPOSE_CONTEXT_KEY = "nanoco-purpose";
export type SecretPurpose = "gocryptfs" | "restic";

export interface GroupKms {
  describeKey(alias: string): Promise<string | null>;
  createKey(tags: Record<string, string>): Promise<string>;
  createAlias(alias: string, keyId: string): Promise<void>;
  encrypt(
    keyId: string,
    plaintext: Uint8Array,
    encryptionContext: Record<string, string>,
  ): Promise<Uint8Array>;
  decrypt(
    keyId: string,
    ciphertext: Uint8Array,
    encryptionContext: Record<string, string>,
  ): Promise<Uint8Array>;
}

export interface WrappedEnvelopeStore {
  get(key: string): Promise<{ body: Uint8Array; etag: string } | null>;
  put(
    key: string,
    body: Uint8Array,
    condition?: { ifNoneMatch?: "*" },
  ): Promise<"ok" | "precondition-failed">;
}

export type GroupResticPasswordOptions = {
  root: string;
  kms: GroupKms;
  envelopes: WrappedEnvelopeStore;
  prefix?: string;
};
type Envelope = {
  version: 1;
  groupId: string;
  purpose: SecretPurpose;
  keyId: string;
  ciphertext: string;
};

/** One CMK per group, with two purpose-bound wrapped secrets. */
export class GroupResticPassword {
  readonly #root: string;
  readonly #kms: GroupKms;
  readonly #envelopes: WrappedEnvelopeStore;
  readonly #prefix: string;
  readonly #ensures = new Map<
    string,
    Promise<{ gocryptfs: string; restic: string }>
  >();

  constructor(options: GroupResticPasswordOptions) {
    this.#root = path.resolve(options.root);
    if (this.#root === path.parse(this.#root).root)
      throw new Error("password root must not be a filesystem root");
    this.#kms = options.kms;
    this.#envelopes = options.envelopes;
    this.#prefix = cleanPrefix(options.prefix ?? "restic");
  }

  async ensure(
    groupId: string,
  ): Promise<{ gocryptfs: string; restic: string }> {
    const existing = this.#ensures.get(groupId);
    if (existing) return existing;
    // The two wrapped secrets are create-once and never rotated, so a fulfilled
    // unwrap is valid for the life of the process — keep it cached and only
    // evict on failure, instead of re-running KMS DescribeKey + 2 GET + 2
    // Decrypt + 2 file rewrites on every session wake and adoption.
    const operation = this.#ensure(groupId).catch((error) => {
      this.#ensures.delete(groupId);
      throw error;
    });
    this.#ensures.set(groupId, operation);
    return operation;
  }

  async #ensure(
    groupId: string,
  ): Promise<{ gocryptfs: string; restic: string }> {
    validateGroupId(groupId);
    const groupDir = path.join(this.#root, groupId, "secrets");
    await mkdir(groupDir, { recursive: true, mode: 0o700 });
    const alias = `alias/nanoco-k8s/agent-group/${groupId}`;
    await this.#key(alias, groupId);
    const paths = {} as { gocryptfs: string; restic: string };
    for (const purpose of ["gocryptfs", "restic"] as const) {
      const envelope = await this.#envelope(groupId, purpose, alias);
      const plaintext = await retryKms(() =>
        this.#kms.decrypt(
          envelope.keyId,
          Buffer.from(envelope.ciphertext, "base64"),
          context(groupId, purpose),
        ),
      );
      const file = path.join(groupDir, `${purpose}.pass`);
      await writePrivateFile(file, plaintext);
      paths[purpose] = file;
    }
    return paths;
  }

  async #key(alias: string, groupId: string): Promise<void> {
    const existing = await retryKms(() => this.#kms.describeKey(alias));
    if (existing) return;
    const created = await this.#kms.createKey({
      NanoCoAgentGroup: "true",
      NanoCoAgentGroupId: groupId,
    });
    try {
      await this.#kms.createAlias(alias, created);
    } catch (error) {
      if (!named(error, "AlreadyExistsException")) throw error;
    }
    const winner = await retryKms(async () => {
      const value = await this.#kms.describeKey(alias);
      if (!value)
        throw Object.assign(new Error("KMS alias is not visible yet"), {
          name: "NotFoundException",
        });
      return value;
    });
    if (!winner)
      throw new Error(
        `unable to establish KMS alias for agent group ${groupId}`,
      );
  }

  async #envelope(
    groupId: string,
    purpose: SecretPurpose,
    alias: string,
  ): Promise<Envelope> {
    const key = `${this.#prefix}/${groupId}/secrets/${purpose}.json`;
    const existing = await this.#envelopes.get(key);
    if (existing) return parseEnvelope(existing.body, groupId, purpose);
    const ciphertext = await retryKms(() =>
      this.#kms.encrypt(alias, printablePassword(), context(groupId, purpose)),
    );
    const envelope: Envelope = {
      version: 1,
      groupId,
      purpose,
      keyId: alias,
      ciphertext: Buffer.from(ciphertext).toString("base64"),
    };
    const result = await this.#envelopes.put(
      key,
      new TextEncoder().encode(JSON.stringify(envelope) + "\n"),
      { ifNoneMatch: "*" },
    );
    if (result === "precondition-failed") {
      const winner = await this.#envelopes.get(key);
      if (!winner)
        throw new Error(
          `wrapped ${purpose} secret disappeared during publication`,
        );
      return parseEnvelope(winner.body, groupId, purpose);
    }
    return envelope;
  }
}

export function groupEncryptionContext(
  groupId: string,
  purpose: SecretPurpose,
): Record<string, string> {
  validateGroupId(groupId);
  return { [GROUP_CONTEXT_KEY]: groupId, [PURPOSE_CONTEXT_KEY]: purpose };
}

/**
 * The role-backed KMS client.
 *
 * `endpoint` exists for the same reason the snapshot object store has one: a
 * governed child holds its OWN wrapping keys. Unset — every deployment that
 * talks to AWS — the SDK resolves the regional endpoint itself, byte-identically
 * to before this option existed. Set, it addresses the child's own KMS facade,
 * which holds real key material of its own and authenticates the encryption
 * context exactly as KMS does. A child reaching the parent's KMS would be the
 * same tenancy breach as reaching the parent's bucket.
 */
export async function createRoleBackedGroupKms(
  region: string,
  endpoint?: string,
  credentials?: { accessKeyId: string; secretAccessKey: string },
): Promise<GroupKms> {
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region))
    throw new Error("invalid KMS region");
  const sdk = await import("@aws-sdk/client-kms");
  const client = new sdk.KMSClient({
    region,
    ...(endpoint ? { endpoint } : {}),
    ...(credentials ? { credentials } : {}),
  });
  return {
    async describeKey(alias) {
      try {
        const result = await client.send(
          new sdk.DescribeKeyCommand({ KeyId: alias }),
        );
        return result.KeyMetadata?.KeyId ?? null;
      } catch (error) {
        if (status(error) === 404 || named(error, "NotFoundException"))
          return null;
        throw error;
      }
    },
    async createKey(tags) {
      const result = await client.send(
        new sdk.CreateKeyCommand({
          Description: "NanoCo agent-group workspace wrapping key",
          KeySpec: "SYMMETRIC_DEFAULT",
          KeyUsage: "ENCRYPT_DECRYPT",
          Origin: "AWS_KMS",
          MultiRegion: false,
          Tags: Object.entries(tags).map(([TagKey, TagValue]) => ({
            TagKey,
            TagValue,
          })),
        }),
      );
      if (!result.KeyMetadata?.KeyId)
        throw new Error("KMS did not return a key ID");
      return result.KeyMetadata.KeyId;
    },
    async createAlias(alias, keyId) {
      await client.send(
        new sdk.CreateAliasCommand({ AliasName: alias, TargetKeyId: keyId }),
      );
    },
    async encrypt(keyId, plaintext, encryptionContext) {
      const result = await client.send(
        new sdk.EncryptCommand({
          KeyId: keyId,
          Plaintext: plaintext,
          EncryptionContext: encryptionContext,
        }),
      );
      if (!result.CiphertextBlob)
        throw new Error("KMS did not return ciphertext");
      return result.CiphertextBlob;
    },
    async decrypt(keyId, ciphertext, encryptionContext) {
      const result = await client.send(
        new sdk.DecryptCommand({
          KeyId: keyId,
          CiphertextBlob: ciphertext,
          EncryptionContext: encryptionContext,
        }),
      );
      if (!result.Plaintext) throw new Error("KMS did not return plaintext");
      return result.Plaintext;
    },
  };
}

function context(
  groupId: string,
  purpose: SecretPurpose,
): Record<string, string> {
  return groupEncryptionContext(groupId, purpose);
}
function printablePassword(): Uint8Array {
  return Buffer.from(randomBytes(32).toString("base64url"), "utf8");
}

function parseEnvelope(
  body: Uint8Array,
  groupId: string,
  purpose: SecretPurpose,
): Envelope {
  let value: Partial<Envelope>;
  try {
    value = JSON.parse(new TextDecoder().decode(body)) as Partial<Envelope>;
  } catch (error) {
    throw new Error(`invalid wrapped ${purpose} password for ${groupId}`, {
      cause: error,
    });
  }
  if (
    value.version !== 1 ||
    value.groupId !== groupId ||
    value.purpose !== purpose ||
    typeof value.keyId !== "string" ||
    typeof value.ciphertext !== "string" ||
    !value.ciphertext
  )
    throw new Error(`invalid wrapped ${purpose} password for ${groupId}`);
  return value as Envelope;
}

async function writePrivateFile(
  file: string,
  contents: Uint8Array,
): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, contents, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
  if ((await stat(file)).mode & 0o077)
    throw new Error(`decrypted ${path.basename(file)} is not private`);
}

async function retryKms<T>(operation: () => Promise<T>): Promise<T> {
  const delays = [0, 50, 100, 200, 400];
  let last: unknown;
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await operation();
    } catch (error) {
      last = error;
      if (!retryableKms(error)) throw error;
    }
  }
  throw last;
}

function retryableKms(error: unknown): boolean {
  return (
    status(error) === 404 ||
    status(error) === 403 ||
    named(error, "NotFoundException") ||
    named(error, "AccessDeniedException")
  );
}
function status(error: unknown): number | undefined {
  const value = error as {
    $metadata?: { httpStatusCode?: number };
    statusCode?: number;
  };
  return value.$metadata?.httpStatusCode ?? value.statusCode;
}
function named(error: unknown, name: string): boolean {
  return (error as { name?: string }).name === name;
}
function cleanPrefix(prefix: string): string {
  const value = prefix.replace(/^\/+|\/+$/g, "");
  if (!value || value.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(value))
    throw new Error("invalid workspace snapshot prefix");
  return value;
}
function validateGroupId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))
    throw new Error(`invalid KMS agent group ID: ${value}`);
}
