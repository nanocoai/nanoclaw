import { describe, expect, it } from "vitest";
import {
  RoleBackedS3SnapshotStore,
  type SnapshotObjectStore,
} from "./s3-snapshot-store.js";

const id = "a".repeat(64);

class MemoryObjects implements SnapshotObjectStore {
  readonly values = new Map<string, { body: Uint8Array; etag: string }>();
  async get(key: string) {
    const value = this.values.get(key);
    return value ? { body: value.body, etag: value.etag } : null;
  }
  async put(
    key: string,
    body: Uint8Array,
    condition?: { ifMatch?: string; ifNoneMatch?: "*" },
  ) {
    const previous = this.values.get(key);
    if (condition?.ifNoneMatch === "*" && previous)
      return "precondition-failed" as const;
    if (
      condition?.ifMatch &&
      (!previous || previous.etag !== condition.ifMatch)
    )
      return "precondition-failed" as const;
    this.values.set(key, { body, etag: String(this.values.size + 1) });
    return "ok" as const;
  }
}

describe("RoleBackedS3SnapshotStore", () => {
  it("writes immutable candidates before a first HEAD and rejects a stale CAS", async () => {
    const objects = new MemoryObjects();
    const store = new RoleBackedS3SnapshotStore({
      bucket: "snapshots.example",
      objects,
    });
    const candidate = {
      groupId: "group-a",
      snapshotId: id,
      base: null,
      completedAt: "2026-08-18T00:00:00.000Z",
    };
    expect(await store.publish(candidate, null)).toEqual({
      published: true,
      head: { groupId: "group-a", snapshotId: id, epoch: 1 },
    });
    expect((await store.candidate("group-a", id))?.snapshotId).toBe(id);
    const next = {
      groupId: "group-a",
      snapshotId: "c".repeat(64),
      base: { groupId: "group-a", snapshotId: id, epoch: 1 },
      completedAt: "2026-08-18T00:01:00.000Z",
    };
    objects.values.set("restic/group-a/HEAD", {
      body: new TextEncoder().encode(
        JSON.stringify({
          groupId: "group-a",
          snapshotId: "b".repeat(64),
          epoch: 2,
        }),
      ),
      etag: "newer",
    });
    expect((await store.publish(next, next.base)).published).toBe(false);
  });
});
