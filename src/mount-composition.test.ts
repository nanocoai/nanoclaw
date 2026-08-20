/**
 * The composition half of the seam: does what `buildMounts` actually emits
 * survive the policy the drivers actually enforce?
 *
 * Nothing tested this. `container-runner.test.ts` drives a hand-built mount
 * fixture, and the conformance suite drives a hand-built spec — so both prove
 * that a *well-formed* spec is realized faithfully while saying nothing about
 * whether the spec the host composes is well-formed. That is a different
 * failure with the same symptom, and it is the one that has now bitten twice:
 * a mount classed for a root it does not live under is refused at `prepare`,
 * every spawn fails, and host-sweep retries the denial forever.
 *
 * So this case is deliberately end-to-end on the composition side: a real group
 * filesystem, the real `buildMounts`, the real `mountPolicy()` derived from this
 * install's own roots, and the real `validateSpec`. Nothing here restates what
 * the classes ought to be — a test that re-derived them from the same knowledge
 * that produced them could not detect a wrong one.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Composing the group's instructions needs the central DB and is not what is
// under test; every path it would write is created below instead.
vi.mock('./claude-md-compose.js', () => ({ composeGroupClaudeMd: vi.fn() }));
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { DATA_DIR, GROUPS_DIR, INSTALL_SLUG } from './config.js';
import type { ContainerConfig } from './container-config.js';
import { buildMounts, toMountSpecs } from './container-runner.js';
import { mountPolicy } from './drivers/index.js';
import { GROUP_FOLDER_LABEL, validateSpec, type SessionSpec } from './drivers/types.js';
import type { AgentGroup, Session } from './types.js';

const GROUP_ID = 'ag-mount-composition';
const FOLDER = 'mount-composition';
const SESSION_ID = 'sess-mount-composition';

const agentGroup = { id: GROUP_ID, name: 'Mount Composition', folder: FOLDER } as AgentGroup;
const session = { id: SESSION_ID, agent_group_id: GROUP_ID, agent_provider: null } as Session;
const containerConfig = {
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: [],
  skills: [],
} as unknown as ContainerConfig;

const groupDir = path.resolve(GROUPS_DIR, FOLDER);
const sessionDir = path.join(DATA_DIR, 'v2-sessions', GROUP_ID, SESSION_ID);
const claudeShared = path.join(DATA_DIR, 'v2-sessions', GROUP_ID, '.claude-shared');

/** Every optional mount is created, so the case covers the widest mount list. */
beforeAll(() => {
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(claudeShared, { recursive: true });
  fs.mkdirSync(path.join(groupDir, '.claude-fragments'), { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(groupDir, 'container.json'), '{}');
  fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), '# composed\n');
});

afterAll(() => {
  fs.rmSync(groupDir, { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'v2-sessions', GROUP_ID), { recursive: true, force: true });
});

async function composedMounts() {
  return buildMounts(agentGroup, session, containerConfig, 'claude', {});
}

function specFrom(mounts: Awaited<ReturnType<typeof composedMounts>>): SessionSpec {
  return {
    key: { installSlug: INSTALL_SLUG, agentGroupId: GROUP_ID, sessionId: SESSION_ID },
    // composeSessionSpec always stamps this, and the mount policy joins the
    // stamped-plugins pin through it — a spec without it is not one this host
    // can produce.
    labels: { [GROUP_FOLDER_LABEL]: FOLDER },
    containers: [{ role: 'agent', image: 'nanoclaw-agent:test', env: {}, mounts: toMountSpecs(mounts, GROUP_ID) }],
    network: 'shared-private',
    hardening: 'standard',
    resources: {},
    runtimeTier: 'container',
    stopGraceSeconds: 1,
  };
}

describe('buildMounts against the policy the drivers enforce', () => {
  it('emits the full mount list', async () => {
    const paths = (await composedMounts()).map((m) => m.containerPath);
    // If this list shrinks, the case below is proving less than it looks.
    expect(paths).toEqual(
      expect.arrayContaining([
        '/workspace',
        '/workspace/agent',
        '/workspace/agent/container.json',
        '/workspace/agent/plugins',
        '/workspace/agent/CLAUDE.md',
        '/workspace/agent/.claude-fragments',
        '/home/node/.claude',
        '/app/src',
      ]),
    );
  });

  it('classes every mount for a root it actually lives under', async () => {
    // The bug this exists to catch: a class whose pinning rule the path cannot
    // satisfy. It passes validation or it denies every session.
    const spec = specFrom(await composedMounts());
    expect(() => validateSpec(spec, mountPolicy())).not.toThrow();
  });

  it('scopes every group-state mount to this group', async () => {
    const specs = toMountSpecs(await composedMounts(), GROUP_ID);
    for (const mount of specs.filter((m) => m.class === 'group-state')) {
      expect(mount.groupScope).toBe(GROUP_ID);
      // Pinned to this group's subtrees, under one root or the other.
      const underGroup = mount.hostPath.startsWith(`${groupDir}/`) || mount.hostPath === groupDir;
      const underSessions = mount.hostPath.startsWith(path.join(DATA_DIR, 'v2-sessions', GROUP_ID));
      expect(underGroup || underSessions).toBe(true);
    }
  });

  it('classes shipped release surfaces, and only those, as install-surface', async () => {
    const specs = toMountSpecs(await composedMounts(), GROUP_ID);
    const surfaces = specs.filter((m) => m.class === 'install-surface');
    expect(surfaces.length).toBeGreaterThan(0);
    const pluginsDir = path.join(groupDir, 'plugins');
    for (const mount of surfaces) {
      expect(mount.mode).toBe('ro');
      // An enumerated allowlist, never a bare install-root prefix: the state
      // roots nest inside the project root, so a prefix check would admit the
      // central DB as a mountable surface. The one install surface that is not
      // under a surface root is the stamped plugins tree, pinned instead by the
      // group-folder label (see `stampedPluginsRoot`).
      const underSurfaceRoot = mountPolicy().surfaceRoots.some(
        (r) => mount.hostPath === r || mount.hostPath.startsWith(`${r}/`),
      );
      const underPlugins = mount.hostPath === pluginsDir || mount.hostPath.startsWith(`${pluginsDir}/`);
      expect(underSurfaceRoot || underPlugins, mount.hostPath).toBe(true);
    }
  });

  it('keeps the stamped plugins tree in the class that forces it read-only', async () => {
    // Whole-plugin stamping puts code the agent EXECUTES inside the group
    // folder. `group-state` would pin it to the group but leave read-only a
    // composition choice, and `allowlisted-extra` is permitted unconditionally
    // with no ro rule at all — either one turns the read-only pin on executed
    // plugin code into a single word in a mount literal.
    const byPath = new Map(toMountSpecs(await composedMounts(), GROUP_ID).map((m) => [m.containerPath, m]));
    const plugins = byPath.get('/workspace/agent/plugins');
    expect(plugins?.class).toBe('install-surface');
    expect(plugins?.mode).toBe('ro');
  });

  it('keeps the shipped surfaces in the class that forces them read-only', async () => {
    // Found by mutation: demoting one of these to 'allowlisted-extra' passed
    // every other case here, because that class is allowed unconditionally and
    // carries no ro rule. The runner source and the skills tree are the code the
    // agent executes; a writable mount of either is an escalation, so the class
    // itself has to be pinned, not just its pinning rule.
    const byPath = new Map(toMountSpecs(await composedMounts(), GROUP_ID).map((m) => [m.containerPath, m]));
    for (const containerPath of ['/app/src', '/app/CLAUDE.md']) {
      expect(byPath.get(containerPath)?.class, containerPath).toBe('install-surface');
      expect(byPath.get(containerPath)?.mode, containerPath).toBe('ro');
    }
  });

  it('puts no identity material on the agent', async () => {
    const specs = toMountSpecs(await composedMounts(), GROUP_ID);
    expect(specs.some((m) => m.class === 'identity-material')).toBe(false);
  });

  // Negative controls, so the acceptance case above cannot pass by validating
  // nothing. Each is a real mistake someone could make in composition.
  it('refuses a session directory belonging to another group', async () => {
    const spec = specFrom(await composedMounts());
    spec.containers[0].mounts.push({
      class: 'group-state',
      hostPath: path.join(DATA_DIR, 'v2-sessions', 'ag-someone-else', 'sess-x'),
      containerPath: '/workspace/other',
      mode: 'rw',
      groupScope: GROUP_ID,
    });
    expect(() => validateSpec(spec, mountPolicy())).toThrow(/denied-by-policy/);
  });

  it("refuses another group's plugins tree claimed as this session's install surface", async () => {
    // The pin grants exactly the folder the session's own label names, so it
    // cannot be turned into a way to mount any group's plugins anywhere.
    const spec = specFrom(await composedMounts());
    spec.containers[0].mounts.push({
      class: 'install-surface',
      hostPath: path.join(GROUPS_DIR, 'some-other-group', 'plugins'),
      containerPath: '/workspace/agent/plugins-other',
      mode: 'ro',
      groupScope: GROUP_ID,
    });
    expect(() => validateSpec(spec, mountPolicy())).toThrow(/denied-by-policy/);
  });

  it('refuses the central DB dressed up as a release surface', async () => {
    const spec = specFrom(await composedMounts());
    spec.containers[0].mounts.push({
      class: 'install-surface',
      hostPath: path.join(DATA_DIR, 'v2.db'),
      containerPath: '/app/v2.db',
      mode: 'ro',
      groupScope: GROUP_ID,
    });
    expect(() => validateSpec(spec, mountPolicy())).toThrow(/denied-by-policy/);
  });
});
