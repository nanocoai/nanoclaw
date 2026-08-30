import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GroupResticPassword,
  type GroupKms,
  type WrappedEnvelopeStore,
  groupEncryptionContext,
} from "./group-restic-password.js";

class MemoryObjects implements WrappedEnvelopeStore {
  readonly values = new Map<string, { body: Uint8Array; etag: string }>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async put(key: string, body: Uint8Array) {
    if (this.values.has(key)) return "precondition-failed" as const;
    this.values.set(key, { body, etag: String(this.values.size + 1) });
    return "ok" as const;
  }
}

class MemoryKms implements GroupKms {
  aliases = new Map<string, string>();
  contexts: { operation: string; value: Record<string, string> }[] = [];
  creates = 0;
  async describeKey(alias: string) {
    return this.aliases.get(alias) ?? null;
  }
  async createKey(tags: Record<string, string>) {
    this.creates += 1;
    expect(tags).toEqual({
      NanoCoAgentGroup: "true",
      NanoCoAgentGroupId: "group-a",
    });
    return `key-${this.creates}`;
  }
  async createAlias(alias: string, keyId: string) {
    this.aliases.set(alias, keyId);
  }
  async encrypt(
    keyId: string,
    plaintext: Uint8Array,
    encryptionContext: Record<string, string>,
  ) {
    this.contexts.push({
      operation: `encrypt:${keyId}`,
      value: encryptionContext,
    });
    return new Uint8Array(plaintext).map((byte) => byte ^ 0xa5);
  }
  async decrypt(
    keyId: string,
    ciphertext: Uint8Array,
    encryptionContext: Record<string, string>,
  ) {
    this.contexts.push({
      operation: `decrypt:${keyId}`,
      value: encryptionContext,
    });
    return new Uint8Array(ciphertext).map((byte) => byte ^ 0xa5);
  }
}

describe("GroupResticPassword", () => {
  it("creates one alias, stores two durable wrapped secrets, and materializes separate 0600 files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nanoco-kms-"));
    const kms = new MemoryKms();
    const objects = new MemoryObjects();
    const password = new GroupResticPassword({ root, kms, envelopes: objects });
    const [files] = await Promise.all([
      password.ensure("group-a"),
      password.ensure("group-a"),
    ]);
    expect(kms.aliases.get("alias/nanoco-k8s/agent-group/group-a")).toBe(
      "key-1",
    );
    expect(kms.creates).toBe(1);
    expect(objects.values.size).toBe(2);
    expect(files.gocryptfs).not.toBe(files.restic);
    expect((await stat(files.gocryptfs)).mode & 0o077).toBe(0);
    expect((await stat(files.restic)).mode & 0o077).toBe(0);
    expect((await readFile(files.gocryptfs)).length).toBeGreaterThan(0);
    expect(
      (await readFile(files.gocryptfs)).equals(await readFile(files.restic)),
    ).toBe(false);
    expect(kms.contexts.map(({ value }) => value)).toContainEqual(
      groupEncryptionContext("group-a", "gocryptfs"),
    );
    expect(kms.contexts.map(({ value }) => value)).toContainEqual(
      groupEncryptionContext("group-a", "restic"),
    );
  });

  it("does not disguise an alias authorization failure as a race", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nanoco-kms-"));
    const kms = new MemoryKms();
    kms.createAlias = async () => {
      throw Object.assign(new Error("alias denied"), {
        name: "AccessDeniedException",
      });
    };
    await expect(
      new GroupResticPassword({
        root,
        kms,
        envelopes: new MemoryObjects(),
      }).ensure("group-a"),
    ).rejects.toThrow("alias denied");
  });
});
