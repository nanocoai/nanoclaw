/**
 * Install-shape guard for `add-mnemon` (host tree, vitest).
 *
 * Two reach-ins, neither of which `tsc` can see:
 *
 *   1. The Dockerfile layer that puts the `mnemon` binary (a GitHub-release
 *      binary, not an npm package) and its optional `jq` dependency in the
 *      image. Drop it on an upgrade and containers start with "mnemon: command
 *      not found" — the runner logs it and carries on, so nothing else fails.
 *
 *   2. The host's spawn argv. The wiring that runs `mnemon setup` lives in the
 *      agent-runner entry module, and it is only reached because the composed
 *      argv names that module. This test derives the entry file *from the
 *      composed spec* and asserts the call is in whatever file the argv
 *      actually points at — so re-pointing the entry (or, as the original
 *      version of this skill did, wiring the setup into
 *      `container/entrypoint.sh`, which the spawn path overrides and never
 *      runs) goes red here instead of shipping an inert install.
 *
 * `container/agent-runner/src` ↔ `/app/src` is the read-only bind mount every
 * session is built on (`buildMounts` in src/container-runner.ts); if that ever
 * stopped holding, no session would start at all.
 *
 * The runtime half — that the entry module, when executed, really does invoke
 * the binary — is `container/agent-runner/src/mnemon/startup.test.ts` (Bun).
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import type { ContainerConfig } from './container-config.js';
import { composeSessionSpec } from './container-runner.js';
import type { VolumeMount } from './providers/provider-container-registry.js';
import type { AgentGroup, Session } from './types.js';

/** Repo root — the dir holding container/, wherever this file is copied to. */
function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'container', 'Dockerfile'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('container/Dockerfile not found walking up from ' + __dirname);
}

const ROOT = repoRoot();
const dockerfile = fs.readFileSync(path.join(ROOT, 'container', 'Dockerfile'), 'utf8');

describe('the agent image carries the mnemon binary', () => {
  it('declares a pinned MNEMON_VERSION and downloads that release', () => {
    expect(dockerfile).toMatch(/ARG\s+MNEMON_VERSION=\d+\.\d+\.\d+/);
    expect(dockerfile).toContain('mnemon-dev/mnemon/releases/download');
  });

  it('points the graph store at the host-backed .claude mount', () => {
    // Anything else is an in-container path that dies with the container.
    expect(dockerfile).toMatch(/ENV\s+MNEMON_DATA_DIR=\/home\/node\/\.claude\/mnemon/);
  });

  it("installs jq, the Stop hook's smart-silence dependency", () => {
    // Without it mnemon's stop.sh cannot read the last assistant message and
    // the "consider remembering this" nudge fires after every single turn.
    expect(dockerfile).toMatch(/install[^\n]*\bjq\b/);
  });

  it('keeps the version ARG below the expensive layers it would otherwise invalidate', () => {
    // The Dockerfile's own convention: "Most stable first, most frequently
    // bumped last." An ARG invalidates every layer below it, so a MNEMON_VERSION
    // bump must not sit above `bun install` or the pnpm global CLIs.
    const argAt = dockerfile.indexOf('ARG MNEMON_VERSION');
    const bunInstallAt = dockerfile.indexOf('bun install --frozen-lockfile');
    const cliToolsAt = dockerfile.indexOf('install-cli-tools.sh');
    expect(argAt).toBeGreaterThan(bunInstallAt);
    expect(argAt).toBeGreaterThan(cliToolsAt);
  });
});

const agentGroup = {
  id: 'agent-1',
  name: 'Agent One',
  folder: 'agent-one',
  agent_provider: null,
  created_at: '2026-07-22T00:00:00.000Z',
} as AgentGroup;

const session = {
  id: 'session-1',
  agent_group_id: 'agent-1',
  messaging_group_id: 'messaging-1',
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-07-22T00:00:00.000Z',
} as Session;

const containerConfig = {
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: [],
  skills: [],
} as unknown as ContainerConfig;

const mounts: VolumeMount[] = [
  {
    hostPath: '/install/data/v2-sessions/agent-1/session-1',
    containerPath: '/workspace',
    readonly: false,
    mountClass: 'group-state',
    scope: 'agent-1',
  },
  {
    hostPath: path.join(ROOT, 'container', 'agent-runner', 'src'),
    containerPath: '/app/src',
    readonly: true,
    mountClass: 'install-surface',
    scope: 'agent-1',
  },
];

describe('the setup call sits on the path the spawn argv executes', () => {
  const spec = composeSessionSpec({
    agentGroup,
    session,
    containerName: 'nanoclaw-v2-agent-one-1700000000000',
    mounts,
    containerConfig,
    mailboxEnvironment: { NANOCLAW_MAILBOX_BACKEND: 'sqlite' },
    contribution: {} as never,
    gateway: {} as never,
  });
  const agent = spec.containers.find((c) => c.role === 'agent');

  it('composes an agent container that runs a module out of the /app/src mount', () => {
    expect(agent).toBeDefined();
    expect(agent?.args?.[0]).toMatch(/^exec bun run \/app\/src\//);
  });

  it('finds the mnemon registration in the module that argv names', () => {
    const entry = /exec bun run (\S+)/.exec(agent?.args?.[0] ?? '')?.[1];
    expect(entry, 'spawn argv does not run a module').toBeDefined();

    const mount = agent?.mounts.find((m) => entry?.startsWith(m.containerPath + '/'));
    expect(mount, `no mount backs the entry module ${entry}`).toBeDefined();
    const hostEntry = path.join(mount!.hostPath, entry!.slice(mount!.containerPath.length + 1));

    expect(fs.existsSync(hostEntry), `${hostEntry} (host side of ${entry}) does not exist`).toBe(true);
    expect(
      fs.readFileSync(hostEntry, 'utf8'),
      `${hostEntry} is what the container executes, and it never calls ensureMnemonSetup()`,
    ).toContain('ensureMnemonSetup(');
  });
});
