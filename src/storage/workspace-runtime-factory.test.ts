import { describe, expect, it } from "vitest";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HostWorkspaceRuntime,
  WORKSPACE_CHECKPOINTS_DORMANT_ON_CONTAINER_TIER,
  initializeCipherTree,
  workspaceFabric,
  workspaceS3Settings,
} from "./workspace-runtime-factory.js";

describe("container-tier dormancy notice", () => {
  // Same fence as the mounter's: a container-tier box says this and nothing
  // else about the custodian, so the notice must name the skill, the setting
  // that would wake it, and the durability it is not providing.
  it("names the skill, the tier setting, and the checkpoint that is never taken", () => {
    expect(WORKSPACE_CHECKPOINTS_DORMANT_ON_CONTAINER_TIER).toContain(
      "fenced-workspace-checkpoints",
    );
    expect(WORKSPACE_CHECKPOINTS_DORMANT_ON_CONTAINER_TIER).toContain("DORMANT");
    expect(WORKSPACE_CHECKPOINTS_DORMANT_ON_CONTAINER_TIER).toContain(
      "NANOCLAW_RUNTIME_TIER='vm'",
    );
    expect(WORKSPACE_CHECKPOINTS_DORMANT_ON_CONTAINER_TIER).toContain("restic");
    expect(WORKSPACE_CHECKPOINTS_DORMANT_ON_CONTAINER_TIER).toContain(
      "isolation-tiers-plan",
    );
  });
});

describe("workspaceS3Settings", () => {
  it("uses the non-secret coordinates written to the host .env", () => {
    expect(
      workspaceS3Settings({}, {
        NANOCLAW_WORKSPACE_S3_BUCKET: "nanoco-agent-workspace",
        NANOCLAW_WORKSPACE_S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
        NANOCLAW_WORKSPACE_S3_PREFIX: "restic",
        NANOCLAW_WORKSPACE_S3_REGION: "us-east-1",
      }),
    ).toEqual({
      NANOCLAW_WORKSPACE_S3_BUCKET: "nanoco-agent-workspace",
      NANOCLAW_WORKSPACE_S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
      NANOCLAW_WORKSPACE_S3_PREFIX: "restic",
      NANOCLAW_WORKSPACE_S3_REGION: "us-east-1",
    });
  });
});

describe("initializeCipherTree", () => {
  it("initializes once and never hands a guest the init operation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nanoco-cipher-"));
    const cipher = path.join(root, "cipher");
    const calls: string[][] = [];
    const run = async (argv: string[]) => {
      calls.push(argv);
      await writeFile(path.join(cipher, "gocryptfs.conf"), "config");
      return { code: 0, stderr: "" };
    };
    await initializeCipherTree({
      cipher,
      passwordFile: path.join(root, "gocryptfs.pass"),
      run,
    });
    await initializeCipherTree({
      cipher,
      passwordFile: path.join(root, "gocryptfs.pass"),
      run,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "gocryptfs",
      "-init",
      "-q",
      "-passfile",
      path.join(root, "gocryptfs.pass"),
      cipher,
    ]);
    await access(path.join(cipher, "gocryptfs.conf"));
  });
});

describe("workspaceFabric", () => {
  // A typo must tighten, never unlock: anything that is not exactly `mock`
  // resolves to `aws`, whose endpoint rules are the strict ones.
  it("declares aws unless the value is exactly mock", () => {
    expect(workspaceFabric({}, {})).toBe("aws");
    expect(workspaceFabric({ NANOCLAW_WORKSPACE_S3_FABRIC: "mock" }, {})).toBe("mock");
    expect(workspaceFabric({ NANOCLAW_WORKSPACE_S3_FABRIC: " MOCK " }, {})).toBe("mock");
    expect(workspaceFabric({ NANOCLAW_WORKSPACE_S3_FABRIC: "mocck" }, {})).toBe("aws");
    expect(workspaceFabric({ NANOCLAW_WORKSPACE_S3_FABRIC: "" }, {})).toBe("aws");
  });

  it("reads the .env file, which is the seam the box configures through", () => {
    expect(workspaceFabric({}, { NANOCLAW_WORKSPACE_S3_FABRIC: "mock" })).toBe("mock");
  });
});

describe("HostWorkspaceRuntime.fromEnv endpoint rules", () => {
  const AWS = {
    NANOCLAW_WORKSPACE_S3_BUCKET: "nanoco-agent-workspace",
    NANOCLAW_WORKSPACE_S3_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
    NANOCLAW_WORKSPACE_S3_PREFIX: "restic",
    NANOCLAW_WORKSPACE_S3_REGION: "us-east-1",
  };
  const FACADE = "https://backlot.system.svc.cluster.local:9086";
  const KMS_FACADE = "https://backlot.system.svc.cluster.local:9087";

  // The defect this whole change exists for (PR #323 finding #20): a governed
  // child's fabric is its own, and an undeclared facade endpoint was refused
  // here before any session could wake.
  it("still refuses a facade endpoint when no fabric is declared", async () => {
    await expect(
      HostWorkspaceRuntime.fromEnv({
        ...AWS,
        NANOCLAW_WORKSPACE_S3_ENDPOINT: FACADE,
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/regional AWS HTTPS endpoint/);
  });

  it("refuses an internet endpoint even when the fabric is mock", async () => {
    await expect(
      HostWorkspaceRuntime.fromEnv({
        ...AWS,
        NANOCLAW_WORKSPACE_S3_FABRIC: "mock",
        NANOCLAW_WORKSPACE_S3_ENDPOINT: "https://backlot.example.com:9086",
        NANOCLAW_WORKSPACE_KMS_ENDPOINT: KMS_FACADE,
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/in-cluster https service/);
  });

  it("refuses a mock fabric that names no wrapping-key endpoint", async () => {
    await expect(
      HostWorkspaceRuntime.fromEnv({
        ...AWS,
        NANOCLAW_WORKSPACE_S3_FABRIC: "mock",
        NANOCLAW_WORKSPACE_S3_ENDPOINT: FACADE,
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/NANOCLAW_WORKSPACE_KMS_ENDPOINT is required/);
  });

  it("refuses an internet wrapping-key endpoint under a mock fabric", async () => {
    await expect(
      HostWorkspaceRuntime.fromEnv({
        ...AWS,
        NANOCLAW_WORKSPACE_S3_FABRIC: "mock",
        NANOCLAW_WORKSPACE_S3_ENDPOINT: FACADE,
        NANOCLAW_WORKSPACE_KMS_ENDPOINT: "https://kms.us-east-1.amazonaws.com",
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/NANOCLAW_WORKSPACE_KMS_ENDPOINT must be an in-cluster/);
  });

  // On AWS the region must still agree with the endpoint; under a mock fabric
  // that check is retired because both clients are handed the same endpoint.
  it("keeps the aws region-agreement rule", async () => {
    await expect(
      HostWorkspaceRuntime.fromEnv({
        ...AWS,
        NANOCLAW_WORKSPACE_S3_REGION: "eu-west-1",
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/must match the configured region/);
  });

  it("does not apply the region-agreement rule to a mock fabric", async () => {
    // Reaches PAST both endpoint gates: the failure it stops at is the roots
    // check, which proves the endpoint rules accepted the facade pair.
    await expect(
      HostWorkspaceRuntime.fromEnv({
        ...AWS,
        NANOCLAW_WORKSPACE_S3_FABRIC: "mock",
        NANOCLAW_WORKSPACE_S3_ENDPOINT: FACADE,
        NANOCLAW_WORKSPACE_KMS_ENDPOINT: KMS_FACADE,
        NANOCLAW_WORKSPACE_METADATA_ROOT: "/tmp/nanoco-ws-same",
        NANOCLAW_WORKSPACE_REPLICA_ROOT: "/tmp/nanoco-ws-same",
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/metadata and content roots must differ/);
  });
});
