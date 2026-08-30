import { describe, expect, it } from "vitest";
import { WorkspaceRuntime } from "./workspace-runtime.js";
import type { WorkspaceHead, WorkspaceStatus } from "./workspace-custodian.js";

const head: WorkspaceHead = {
  groupId: "group-a",
  snapshotId: "a".repeat(64),
  epoch: 1,
};

describe("WorkspaceRuntime", () => {
  it("restores exact HEAD once and checkpoints after the final session", async () => {
    const events: string[] = [];
    const runtime = new WorkspaceRuntime({
      async status() {
        events.push("status");
        return { phase: "ready", base: null, head } satisfies WorkspaceStatus;
      },
      async restore(groupId, value) {
        events.push(`restore:${groupId}:${value.snapshotId}`);
      },
      async checkpoint(groupId) {
        events.push(`checkpoint:${groupId}`);
        return { published: true, head };
      },
    });
    await runtime.sessionStarted("group-a");
    await runtime.sessionStarted("group-a");
    await runtime.sessionStopped("group-a");
    expect(events).toEqual(["status", `restore:group-a:${head.snapshotId}`]);
    await runtime.sessionStopped("group-a");
    expect(events).toEqual([
      "status",
      `restore:group-a:${head.snapshotId}`,
      "checkpoint:group-a",
    ]);
  });

  it("gates wakes while draining and waits for all session stops", async () => {
    const runtime = new WorkspaceRuntime({
      async status() {
        return {
          phase: "ready",
          base: null,
          head: null,
        } satisfies WorkspaceStatus;
      },
      async restore() {},
      async checkpoint() {
        return { published: true, head };
      },
    });
    await runtime.sessionStarted("group-a");
    const stopped: string[] = [];
    let listed = ["s1"];
    await runtime.drain(
      "group-a",
      async () => listed,
      async (sessionId) => {
        stopped.push(sessionId);
        listed = [];
        await runtime.sessionStopped("group-a");
      },
    );
    expect(stopped).toEqual(["s1"]);
    await expect(runtime.sessionStarted("group-a")).resolves.toBeUndefined();
  });

  it("serializes concurrent first starts and supports adoption/abort", async () => {
    let statusCalls = 0;
    let checkpoints = 0;
    const runtime = new WorkspaceRuntime({
      async status() {
        statusCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          phase: "ready",
          base: null,
          head: null,
        } satisfies WorkspaceStatus;
      },
      async restore() {},
      async checkpoint() {
        checkpoints += 1;
        return { published: true, head };
      },
    });
    await Promise.all([
      runtime.sessionStarted("group-a"),
      runtime.sessionStarted("group-a"),
    ]);
    expect(statusCalls).toBe(1);
    await runtime.sessionStopped("group-a");
    await runtime.sessionStopped("group-a");
    expect(checkpoints).toBe(1);
    await runtime.sessionAdopted("group-a");
    await runtime.sessionAborted("group-a");
    expect(checkpoints).toBe(1);
  });

  it("blocks new writers when a stop could not prove teardown", async () => {
    let checkpoints = 0;
    const runtime = new WorkspaceRuntime({
      async status() {
        return {
          phase: "ready",
          base: null,
          head: null,
        } satisfies WorkspaceStatus;
      },
      async restore() {},
      async checkpoint() {
        checkpoints += 1;
        return { published: true, head };
      },
    });
    await runtime.sessionStarted("group-a");
    await runtime.sessionUncertain("group-a");
    await expect(runtime.sessionStarted("group-a")).rejects.toThrow("draining");
    expect(checkpoints).toBe(0);
  });
});
