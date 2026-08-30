import type {
  WorkspaceCustodian,
  WorkspaceHead,
} from "./workspace-custodian.js";

type CustodianBoundary = Pick<
  WorkspaceCustodian,
  "status" | "restore" | "checkpoint"
>;

/** Bridges the real group/session lifecycle to the workspace custodian. */
export class WorkspaceRuntime {
  readonly #custodian: CustodianBoundary;
  readonly #active = new Map<string, number>();
  readonly #draining = new Set<string>();
  readonly #operations = new Map<string, Promise<void>>();

  constructor(custodian: CustodianBoundary) {
    this.#custodian = custodian;
  }

  /** Restore the exact current HEAD before the first writer is admitted. */
  async sessionStarted(groupId: string): Promise<void> {
    return this.#serialize(groupId, async () => {
      if (this.#draining.has(groupId))
        throw new Error(`workspace ${groupId} is draining`);
      const count = this.#active.get(groupId) ?? 0;
      if (count === 0) {
        let status = await this.#custodian.status(groupId);
        // A publication left pending by a crashed run must be flushed to a
        // terminal state before a new writer mutates the tree; otherwise the
        // final checkpoint re-publishes the prior candidate and never backs up
        // this session's writes.
        if (status.phase === "publishing") {
          await this.#custodian.checkpoint(groupId);
          status = await this.#custodian.status(groupId);
        }
        if (status.phase === "conflicted") {
          throw new Error(
            `workspace ${groupId} is not ready for a session (${status.phase})`,
          );
        } else if (status.phase === "failed") {
          // An interrupted restore is recoverable — the custodian persists
          // 'restoring' precisely so a restart can retry it. Only a failed
          // checkpoint is terminal here.
          if (status.operation === "restore" && status.head)
            await this.#custodian.restore(groupId, status.head, {
              discardLocal: true,
            });
          else
            throw new Error(
              `workspace ${groupId} is not ready for a session (${status.phase})`,
            );
        } else if (status.head && !sameHead(status.base, status.head)) {
          await this.#custodian.restore(groupId, status.head);
        }
      }
      this.#active.set(groupId, count + 1);
    });
  }

  /** Adopt an already-running session without restoring or creating a writer. */
  async sessionAdopted(groupId: string): Promise<void> {
    return this.#serialize(groupId, async () => {
      if (this.#draining.has(groupId))
        throw new Error(`workspace ${groupId} is draining`);
      this.#active.set(groupId, (this.#active.get(groupId) ?? 0) + 1);
    });
  }

  /** Roll back a reservation when prepare/start fails before a writer exists. */
  async sessionAborted(groupId: string): Promise<void> {
    return this.#serialize(groupId, async () => {
      const count = this.#active.get(groupId) ?? 0;
      if (count <= 1) this.#active.delete(groupId);
      else this.#active.set(groupId, count - 1);
    });
  }

  /** Fail closed when teardown could not prove that the writer stopped. */
  async sessionUncertain(groupId: string): Promise<void> {
    return this.#serialize(groupId, async () => {
      this.#draining.add(groupId);
    });
  }

  /** Checkpoint only after this group's final local writer has stopped. */
  async sessionStopped(groupId: string): Promise<void> {
    return this.#serialize(groupId, async () => {
      const count = this.#active.get(groupId) ?? 0;
      if (count <= 0)
        throw new Error(`workspace ${groupId} has no active sessions`);
      if (count > 1) {
        this.#active.set(groupId, count - 1);
        return;
      }
      this.#active.delete(groupId);
      await this.#custodian.checkpoint(groupId);
    });
  }

  /**
   * Gate new work, stop every session in the group, and wait for each
   * finalization callback to call sessionStopped. A single kill is not enough:
   * a pending wake can otherwise race the checkpoint and reopen the replica.
   */
  async drain(
    groupId: string,
    sessions: () => Promise<readonly string[]>,
    stop: (sessionId: string) => Promise<void>,
  ): Promise<void> {
    if (this.#draining.has(groupId))
      throw new Error(`workspace ${groupId} is already draining`);
    this.#draining.add(groupId);
    try {
      for (;;) {
        const current = await sessions();
        if (current.length === 0) return;
        await Promise.all(current.map((sessionId) => stop(sessionId)));
        const remaining = await sessions();
        if (remaining.length > 0)
          throw new Error(
            `workspace ${groupId} drain left ${remaining.length} active sessions`,
          );
      }
    } finally {
      this.#draining.delete(groupId);
    }
  }

  async #serialize(
    groupId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.#operations.get(groupId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(operation)
      .finally(() => {
        if (this.#operations.get(groupId) === current)
          this.#operations.delete(groupId);
      });
    this.#operations.set(groupId, current);
    return current;
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
