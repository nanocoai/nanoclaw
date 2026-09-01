/**
 * Code mode, piece A: the flag round-trip, spawn-time entrypoint selection
 * (D22), and the D16 composition strip — capabilities stay, chat clothing
 * goes, and the chat path is byte-identical to before.
 */
import fs from 'fs';
import path from 'path';

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../project-doc-compose.js', () => ({ composeGroupProjectDoc: vi.fn(), DEFAULT_PROJECT_DOC: '' }));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { composeGroupProjectDoc } from '../project-doc-compose.js';
import { DATA_DIR, GROUPS_DIR, INSTALL_SLUG } from '../config.js';
import { configFromDb, type ContainerConfig } from '../container-config.js';
import { buildMounts, composeSessionSpec, toMountSpecs } from '../container-runner.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from '../db/container-configs.js';
import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { mountPolicy } from '../drivers/index.js';
import { GROUP_FOLDER_LABEL, validateSpec, type SessionSpec } from '../drivers/types.js';
import {
  BOUNDARY_DECISIONS_SUBDIR,
  MANAGED_SETTINGS_CONTAINER_PATH,
  MANAGED_SETTINGS_FILE,
  composeManagedSettings,
} from './permissions.js';
import {
  DEV_INSTRUCTION_FILE,
  DEV_SKILLS_STAMP_DIR,
  devInstructionMounts,
  devSkillMounts,
  devStampDir,
} from './compose.js';
import type { AgentGroup, Session } from '../types.js';
// Side-effect: registers the module:code-mode migration.
import './index.js';

const GROUP_ID = 'ag-code-mode-test';
const FOLDER = 'code-mode-test';
const agentGroup = { id: GROUP_ID, name: 'Code Mode Test', folder: FOLDER } as AgentGroup;
const session = { id: 'sess-code-mode', agent_group_id: GROUP_ID, agent_provider: null } as Session;

function cfg(codeMode: boolean | undefined, codePermissionMode?: 'auto' | 'bypass'): ContainerConfig {
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    agentGroupId: GROUP_ID,
    codeMode,
    codePermissionMode,
  };
}

const groupDir = path.join(GROUPS_DIR, FOLDER);
const sessDir = path.join(DATA_DIR, 'v2-sessions', GROUP_ID, session.id);

beforeAll(() => {
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(path.join(groupDir, 'container.json'), '{}\n');
  fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), '# composed');
  fs.mkdirSync(path.join(groupDir, '.claude-fragments'), { recursive: true });
  fs.mkdirSync(sessDir, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'v2-sessions', GROUP_ID, '.claude-shared'), { recursive: true });
});
afterAll(() => {
  fs.rmSync(groupDir, { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'v2-sessions', GROUP_ID), { recursive: true, force: true });
});

describe('the group flag', () => {
  beforeEach(async () => {
    const db = await initTestDb();
    await runMigrations(db);
    await db.run(
      'INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)',
      GROUP_ID,
      'Code Mode Test',
      FOLDER,
      new Date().toISOString(),
    );
  });
  afterEach(async () => {
    await closeDb();
  });

  it('round-trips through the module migration column and configFromDb', async () => {
    await ensureContainerConfig(GROUP_ID);
    await updateContainerConfigScalars(GROUP_ID, { code_mode: 1 });
    const row = (await getContainerConfig(GROUP_ID))!;
    expect(row.code_mode).toBe(1);
    expect(configFromDb(row, agentGroup).codeMode).toBe(true);

    await updateContainerConfigScalars(GROUP_ID, { code_mode: 0 });
    expect(configFromDb((await getContainerConfig(GROUP_ID))!, agentGroup).codeMode).toBeUndefined();
  });

  it('permission_mode round-trips, clears to NULL, and never reads mangled values', async () => {
    await ensureContainerConfig(GROUP_ID);
    expect(configFromDb((await getContainerConfig(GROUP_ID))!, agentGroup).codePermissionMode).toBeUndefined();

    await updateContainerConfigScalars(GROUP_ID, { permission_mode: 'bypass' });
    expect(configFromDb((await getContainerConfig(GROUP_ID))!, agentGroup).codePermissionMode).toBe('bypass');

    await updateContainerConfigScalars(GROUP_ID, { permission_mode: 'auto' });
    expect(configFromDb((await getContainerConfig(GROUP_ID))!, agentGroup).codePermissionMode).toBe('auto');

    // NULL = follow the deployment default again.
    await updateContainerConfigScalars(GROUP_ID, { permission_mode: null });
    expect((await getContainerConfig(GROUP_ID))!.permission_mode).toBeNull();
    expect(configFromDb((await getContainerConfig(GROUP_ID))!, agentGroup).codePermissionMode).toBeUndefined();

    // A hand-edited DB value must not silently pick a posture.
    await updateContainerConfigScalars(GROUP_ID, { permission_mode: 'yolo' });
    expect(configFromDb((await getContainerConfig(GROUP_ID))!, agentGroup).codePermissionMode).toBeUndefined();
  });
});

describe('spawn-time entrypoint selection (D22)', () => {
  function specFor(codeMode: boolean | undefined, codePermissionMode?: 'auto' | 'bypass') {
    // The spec's gateway-shaped input differs by deployment: this tree names
    // it `gateway` (a typed GatewayContribution), while the k8s session-sidecar
    // overlay replaces that field with an `egress` handle. Neither field
    // participates in entrypoint selection, so the fixture carries both and
    // casts: the assertions below stay meaningful in whichever tree runs them,
    // and the bake's composed typecheck stops being a tripwire for a field
    // this test does not exercise.
    const input = {
      agentGroup,
      session,
      containerName: 'ncl-code-mode-test',
      mounts: [],
      containerConfig: cfg(codeMode, codePermissionMode),
      contribution: {},
      gateway: {},
      mailboxEnvironment: { NANOCLAW_MAILBOX_BACKEND: 'sqlite' },
      egress: { agentEnvironment: {}, agentMounts: [], agentLabels: {}, agentNetworkArgs: [] },
    } as unknown as Parameters<typeof composeSessionSpec>[0];
    return composeSessionSpec(input);
  }

  it('every code knob actually REACHES the container, not just the settings list', () => {
    // Live regression: NANOCLAW_CODE_PERMISSION_MODE was added to the list
    // readEnvFile consults but never assigned into the spec's env, so the
    // runner defaulted to prompting and a detached agent wedged on a y/n.
    // Naming a knob and forwarding it are two edits; this pins the second.
    vi.stubEnv('NANOCLAW_CODE_IDLE_TTL_MS', '120000');
    vi.stubEnv('NANOCLAW_CODE_PERMISSION_MODE', 'bypass');
    vi.stubEnv('NANOCLAW_CODE_ENV', '{"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1"}');
    try {
      const code = specFor(true).containers.find((c) => c.role === 'agent')!;
      expect(code.env.NANOCLAW_CODE_IDLE_TTL_MS).toBe('120000');
      expect(code.env.NANOCLAW_CODE_PERMISSION_MODE).toBe('bypass');
      expect(code.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
      // Chat mode is untouched by every one of them.
      const chat = specFor(undefined).containers.find((c) => c.role === 'agent')!;
      expect(chat.env.NANOCLAW_CODE_PERMISSION_MODE).toBeUndefined();
      expect(chat.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a governed deployment defaults the gateway-managed sentinel; deployments and chat stay untouched', () => {
    // 2026-08-17 incident: the sentinel lived only in a manual restart's
    // process env; the first clean systemd restart dropped it and the CLI
    // died at "apiKeyHelper failed: did not return a value". The marker is a
    // fixed public constant — so it is platform behavior, not deployment
    // memory: NANOCO_GATEWAY_ADDRESS present => code-mode pods carry it.
    vi.stubEnv('NANOCO_GATEWAY_ADDRESS', 'gateway.system.svc:9443');
    try {
      // The sentinel rides the CONTRIBUTED lane now: the key name is
      // credential-shaped by necessity (the CLI looks it up by name), and that
      // lane is the seam's sanctioned channel for exactly this — composed env
      // would refuse the name outright. Realizations emit contributed env
      // last, so the container still sees ANTHROPIC_API_KEY.
      const code = specFor(true).containers.find((c) => c.role === 'agent')!;
      expect(code.contributedEnv?.ANTHROPIC_API_KEY).toBe('nanoco-gateway-managed');
      expect(code.env.ANTHROPIC_API_KEY).toBeUndefined();
      const chat = specFor(undefined).containers.find((c) => c.role === 'agent')!;
      expect(chat.contributedEnv?.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
    // No gateway declared => no sentinel invented (an ungoverned OSS box must
    // not feed the CLI a key that answers nothing).
    const bare = specFor(true).containers.find((c) => c.role === 'agent')!;
    expect(bare.contributedEnv?.ANTHROPIC_API_KEY).toBeUndefined();
    // The deployment's own value wins over the default — and a credential-
    // NAMED knob rides the contributed lane (the composed lane's key-name
    // check would deny the spawn; the governed POC sets the marker exactly
    // this way in its manifest env).
    vi.stubEnv('NANOCO_GATEWAY_ADDRESS', 'gateway.system.svc:9443');
    vi.stubEnv('NANOCLAW_CODE_ENV', '{"ANTHROPIC_API_KEY":"deployment-chosen"}');
    try {
      const code = specFor(true).containers.find((c) => c.role === 'agent')!;
      expect(code.contributedEnv?.ANTHROPIC_API_KEY).toBe('deployment-chosen');
      expect(code.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
    // A deployment redundantly pinning the marker itself keeps working, and
    // the whole spec still passes the seam's validation (the marker is the
    // one credential-named value with a public byte-exact value).
    vi.stubEnv('NANOCO_GATEWAY_ADDRESS', 'gateway.system.svc:9443');
    vi.stubEnv('NANOCLAW_CODE_ENV', '{"ANTHROPIC_API_KEY":"nanoco-gateway-managed"}');
    try {
      const code = specFor(true).containers.find((c) => c.role === 'agent')!;
      expect(code.contributedEnv?.ANTHROPIC_API_KEY).toBe('nanoco-gateway-managed');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('the per-group permission override REACHES the container and beats the deployment', () => {
    // The a9cf35db rule again: a knob that exists only in the DB configures
    // nothing until composition assigns it into the spec's env — and the T7
    // precedence (group > deployment) has to be visible AT the container,
    // where the runner actually reads it.
    vi.stubEnv('NANOCLAW_CODE_PERMISSION_MODE', 'bypass');
    try {
      const overridden = specFor(true, 'auto').containers.find((c) => c.role === 'agent')!;
      expect(overridden.env.NANOCLAW_CODE_PERMISSION_MODE).toBe('auto');
      const chat = specFor(undefined, 'auto').containers.find((c) => c.role === 'agent')!;
      expect(chat.env.NANOCLAW_CODE_PERMISSION_MODE).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
    // No deployment value at all: the group's own mode still arrives.
    const groupOnly = specFor(true, 'bypass').containers.find((c) => c.role === 'agent')!;
    expect(groupOnly.env.NANOCLAW_CODE_PERMISSION_MODE).toBe('bypass');
  });

  it('a code-mode group gets the code runner; a chat group is untouched', () => {
    const code = specFor(true).containers.find((c) => c.role === 'agent')!;
    const chat = specFor(undefined).containers.find((c) => c.role === 'agent')!;
    expect(code.args).toEqual(['exec bun run /app/src/code-runner/index.ts']);
    expect(chat.args).toEqual(['exec bun run /app/src/index.ts']);
    expect(code.command).toEqual(chat.command);
    expect(code.image).toBe(chat.image); // same unchanged image — the type IS the entrypoint
    expect(code.env.NANOCLAW_CONTAINER_JSON).toBe('/run/nanoclaw/group-config/container.json');
    expect(chat.env.NANOCLAW_CONTAINER_JSON).toBe('/run/nanoclaw/group-config/container.json');
  });
});

describe('the D16 strip', () => {
  it('code mode drops composed instructions and chat skills, keeps state and source', async () => {
    const paths = (await buildMounts(agentGroup, session, cfg(true), 'claude', {})).map((m) => m.containerPath);
    expect(paths).not.toContain('/workspace/agent/CLAUDE.md');
    expect(paths).not.toContain('/workspace/agent/.claude-fragments');
    expect(paths).not.toContain('/app/CLAUDE.md');
    expect(paths).not.toContain('/app/skills');
    // Capabilities stay: provider state (settings, credentials state), runner
    // source, and the session workspace still mount.
    expect(paths).toContain('/home/node/.claude');
    expect(paths).toContain('/app/src');
    expect(paths).toContain('/run/nanoclaw/group-config');
    expect(composeGroupProjectDoc).not.toHaveBeenCalled();
  });

  it('a chat group still composes and mounts its source contract', async () => {
    const paths = (await buildMounts(agentGroup, session, cfg(undefined), 'claude', {})).map((m) => m.containerPath);
    expect(paths).toContain('/workspace/agent/CLAUDE.md');
    expect(paths.includes('/app/CLAUDE.md')).toBe(fs.existsSync(path.join(process.cwd(), 'src', 'claude-md-compose.ts')));
    expect(paths).toContain('/app/skills');
    expect(paths).toContain('/home/node/.claude');
    expect(paths).toContain('/run/nanoclaw/group-config');
    expect(composeGroupProjectDoc).toHaveBeenCalled();
  });
});

describe('the dev-instruction surface (T2 composition minimum)', () => {
  const manualSource = path.join(process.cwd(), 'container', 'code-mode', 'CLAUDE.md');
  const workspaceDir = path.join(sessDir, 'group');

  beforeEach(() => {
    vi.mocked(composeGroupProjectDoc).mockClear();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('code mode stamps the manual and nested-RO-mounts it at the runner cwd', async () => {
    const mounts = await buildMounts(agentGroup, session, cfg(true), 'claude', {});
    const manual = mounts.find((m) => m.containerPath === '/workspace/group/CLAUDE.md')!;
    expect(manual).toBeDefined();
    expect(manual.readonly).toBe(true);
    expect(manual.mountClass).toBe('group-state');
    // Stamped in the sibling stamp dir, never anywhere under <sessDir>: the
    // session dir is the RW /workspace, and a stamp inside it would be
    // agent-editable through the back of this RO mount.
    expect(manual.hostPath).toBe(path.join(devStampDir(sessDir), DEV_INSTRUCTION_FILE));
    expect(fs.readFileSync(manual.hostPath, 'utf8')).toBe(fs.readFileSync(manualSource, 'utf8'));
    // The cwd's backing dir still gets created for the session.
    expect(fs.existsSync(workspaceDir)).toBe(true);
    // Still the one instruction surface: no chat composition on this path.
    expect(composeGroupProjectDoc).not.toHaveBeenCalled();
  });

  it('a cwd the host cannot write into costs neither the manual NOR the session', async () => {
    // Live regression (2026-08-16): every session whose /workspace/group was
    // created by a root container EACCES'd here and the spawn died — an
    // instruction file took down the agent it was meant to inform. With the
    // stamp outside the session dir entirely, that cwd cannot even cost the
    // manual anymore.
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.chmodSync(workspaceDir, 0o500);
    try {
      const mounts = await buildMounts(agentGroup, session, cfg(true), 'claude', {});
      expect(mounts.some((m) => m.containerPath === '/workspace')).toBe(true);
      expect(mounts.some((m) => m.containerPath === '/workspace/group/CLAUDE.md')).toBe(true);
    } finally {
      fs.chmodSync(workspaceDir, 0o700);
    }
  });

  it('an unwritable stamp root degrades to no manual rather than throwing', () => {
    // The stamp dir is a sibling of the session dir, so the failure that
    // costs the surface is the GROUP sessions dir refusing the mkdir.
    const roGroupDir = path.join(DATA_DIR, 'v2-sessions', 'ro-group-manual');
    fs.mkdirSync(roGroupDir, { recursive: true });
    fs.chmodSync(roGroupDir, 0o500);
    try {
      expect(devInstructionMounts(path.join(roGroupDir, 'sess'), GROUP_ID)).toEqual([]);
    } finally {
      fs.chmodSync(roGroupDir, 0o700);
      fs.rmSync(roGroupDir, { recursive: true, force: true });
    }
  });

  it('never stamps under the RW /workspace source — custody holds through the back door', () => {
    // Review-caught (2026-08-17): a stamp under <sessDir> is the same inode
    // RW at /workspace/... and RO at the nested mount, and on the k8s driver
    // the agent runs as the host uid and owns it — editing the "host-owned"
    // words in place. Every stamped surface must live outside <sessDir>.
    const mounts = devInstructionMounts(sessDir, GROUP_ID);
    expect(mounts.length).toBeGreaterThan(0);
    for (const mount of mounts) {
      expect(mount.hostPath.startsWith(`${sessDir}${path.sep}`)).toBe(false);
    }
  });

  it('survives the mount policy the drivers enforce at prepare', async () => {
    // The manual cannot ride as 'install-surface' (its install-tree source is
    // not in the enumerated surfaceRoots), which is exactly why it is stamped
    // into the session subtree. Prove the composed result passes the real
    // policy — the failure mode here is every code-mode spawn denied.
    const mounts = await buildMounts(agentGroup, session, cfg(true), 'claude', {});
    const spec: SessionSpec = {
      key: { installSlug: INSTALL_SLUG, agentGroupId: GROUP_ID, sessionId: session.id },
      // composeSessionSpec always stamps this, and the group-state pin joins the
      // group subtree through it — a spec without it is not one this host can produce.
      labels: { [GROUP_FOLDER_LABEL]: FOLDER },
      containers: [{ role: 'agent', image: 'nanoclaw-agent:test', env: {}, mounts: toMountSpecs(mounts, GROUP_ID) }],
      network: 'shared-private',
      hardening: 'standard',
      resources: {},
      runtimeTier: 'container',
      stopGraceSeconds: 1,
    };
    expect(() => validateSpec(spec, mountPolicy())).not.toThrow();
  });

  it('chat mode gets neither the mount nor the backing dir', async () => {
    const paths = (await buildMounts(agentGroup, session, cfg(undefined), 'claude', {})).map((m) => m.containerPath);
    expect(paths).not.toContain('/workspace/group/CLAUDE.md');
    expect(paths.some((p) => p.startsWith('/workspace/group/.claude/skills/'))).toBe(false);
    expect(fs.existsSync(workspaceDir)).toBe(false);
  });
});

describe('the managed permission settings (D17/T7)', () => {
  const stampedPath = path.join(sessDir, MANAGED_SETTINGS_FILE);

  afterEach(() => {
    fs.rmSync(stampedPath, { force: true });
  });

  it('code mode stamps the policy and nested-RO-mounts it at the admin tier', async () => {
    const mounts = await buildMounts(agentGroup, session, cfg(true), 'claude', {});
    const managed = mounts.find((m) => m.containerPath === MANAGED_SETTINGS_CONTAINER_PATH)!;
    expect(managed).toBeDefined();
    expect(managed.readonly).toBe(true);
    // 'group-state' pins hostPath + scope only, never containerPath — which is
    // exactly why the /etc target passes both drivers' mount policy.
    expect(managed.mountClass).toBe('group-state');
    expect(managed.hostPath).toBe(stampedPath);
    // No deployment env, no group override: the safe end.
    expect(JSON.parse(fs.readFileSync(stampedPath, 'utf8'))).toEqual(composeManagedSettings('auto'));
  });

  it("the stamp's own workspace spelling is RO-covered — the E-t7 write-through channel", async () => {
    // Same inode as the admin tier: without this cover a Bash redirect at the
    // /workspace path rewrote the policy the /etc mount exists to pin.
    const mounts = await buildMounts(agentGroup, session, cfg(true), 'claude', {});
    const cover = mounts.find((m) => m.containerPath === `/workspace/${MANAGED_SETTINGS_FILE}`)!;
    expect(cover).toBeDefined();
    expect(cover.readonly).toBe(true);
    expect(cover.hostPath).toBe(stampedPath);
  });

  it('the boundary decision dir mounts RO in the workspace — host-writes-only by kernel', async () => {
    const mounts = await buildMounts(agentGroup, session, cfg(true), 'claude', {});
    const decisions = mounts.find((m) => m.containerPath === `/workspace/${BOUNDARY_DECISIONS_SUBDIR}`)!;
    expect(decisions).toBeDefined();
    expect(decisions.readonly).toBe(true);
    expect(decisions.mountClass).toBe('group-state');
    expect(decisions.hostPath).toBe(path.join(sessDir, BOUNDARY_DECISIONS_SUBDIR));
    expect(fs.statSync(decisions.hostPath).isDirectory()).toBe(true);
    // Chat mode gets no decision channel at all.
    const chatPaths = (await buildMounts(agentGroup, session, cfg(undefined), 'claude', {})).map(
      (m) => m.containerPath,
    );
    expect(chatPaths).not.toContain(`/workspace/${BOUNDARY_DECISIONS_SUBDIR}`);
  });

  it("a bypass group's stamp carries the escape hatch, not the boundary rules", async () => {
    await buildMounts(agentGroup, session, cfg(true, 'bypass'), 'claude', {});
    expect(JSON.parse(fs.readFileSync(stampedPath, 'utf8'))).toEqual(composeManagedSettings('bypass'));
  });

  it('the group override beats a bypass deployment at the stamp too', async () => {
    vi.stubEnv('NANOCLAW_CODE_PERMISSION_MODE', 'bypass');
    try {
      await buildMounts(agentGroup, session, cfg(true, 'auto'), 'claude', {});
      expect(JSON.parse(fs.readFileSync(stampedPath, 'utf8'))).toEqual(composeManagedSettings('auto'));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('chat mode gets neither the stamp nor the mount', async () => {
    const paths = (await buildMounts(agentGroup, session, cfg(undefined), 'claude', {})).map((m) => m.containerPath);
    expect(paths).not.toContain(MANAGED_SETTINGS_CONTAINER_PATH);
    expect(fs.existsSync(stampedPath)).toBe(false);
  });

  it('survives the mount policy the drivers enforce at prepare', async () => {
    // The failure this guards: a policy file whose class pinning fails denies
    // every code-mode spawn — the posture must never cost the session.
    const mounts = await buildMounts(agentGroup, session, cfg(true), 'claude', {});
    const spec: SessionSpec = {
      key: { installSlug: INSTALL_SLUG, agentGroupId: GROUP_ID, sessionId: session.id },
      // composeSessionSpec always stamps this, and the group-state pin joins the
      // group subtree through it — a spec without it is not one this host can produce.
      labels: { [GROUP_FOLDER_LABEL]: FOLDER },
      containers: [{ role: 'agent', image: 'nanoclaw-agent:test', env: {}, mounts: toMountSpecs(mounts, GROUP_ID) }],
      network: 'shared-private',
      hardening: 'standard',
      resources: {},
      runtimeTier: 'container',
      stopGraceSeconds: 1,
    };
    expect(() => validateSpec(spec, mountPolicy())).not.toThrow();
  });
});

describe('the dev skill bundle', () => {
  const bundleSource = path.join(process.cwd(), 'container', 'code-mode', 'skills');
  const stampRoot = path.join(devStampDir(sessDir), DEV_SKILLS_STAMP_DIR);

  afterEach(() => {
    fs.rmSync(stampRoot, { recursive: true, force: true });
  });

  it('stamps each shipped skill outside the session dir and nested-RO-mounts it at the CLI discovery path', async () => {
    const mounts = await buildMounts(agentGroup, session, cfg(true), 'claude', {});
    for (const name of ['dev-toolchains', 'dev-git', 'dev-child-sync']) {
      const skill = mounts.find((m) => m.containerPath === `/workspace/group/.claude/skills/${name}`)!;
      expect(skill).toBeDefined();
      expect(skill.readonly).toBe(true);
      expect(skill.mountClass).toBe('group-state');
      // Stamped in the sibling stamp dir (<stampDir>/code-mode-skills/<name>):
      // NEVER into <sessDir>/group (the cycle-3 EACCES spawn-killer) and never
      // under <sessDir> at all (the RW-/workspace custody hole).
      expect(skill.hostPath).toBe(path.join(stampRoot, name));
      expect(skill.hostPath.startsWith(`${sessDir}${path.sep}`)).toBe(false);
      expect(fs.readFileSync(path.join(skill.hostPath, 'SKILL.md'), 'utf8')).toBe(
        fs.readFileSync(path.join(bundleSource, name, 'SKILL.md'), 'utf8'),
      );
    }
  });

  it('carries a skill dir whole — dev-child-sync ships its executable beside SKILL.md', async () => {
    // The cpSync stamp is recursive on purpose: the child-sync tool is an
    // adjacent file, and a stamp that copied only SKILL.md would mount a
    // manual pointing at a script that is not there.
    const mounts = await buildMounts(agentGroup, session, cfg(true), 'claude', {});
    const skill = mounts.find((m) => m.containerPath === '/workspace/group/.claude/skills/dev-child-sync')!;
    expect(skill).toBeDefined();
    expect(fs.readFileSync(path.join(skill.hostPath, 'child-sync.ts'), 'utf8')).toBe(
      fs.readFileSync(path.join(bundleSource, 'dev-child-sync', 'child-sync.ts'), 'utf8'),
    );
  });

  it('re-stamps fresh on every spawn — a stale file from a past boot does not survive', () => {
    fs.mkdirSync(path.join(stampRoot, 'dev-git'), { recursive: true });
    fs.writeFileSync(path.join(stampRoot, 'dev-git', 'stale.md'), 'from a previous boot');
    devSkillMounts(sessDir, GROUP_ID);
    expect(fs.existsSync(path.join(stampRoot, 'dev-git', 'stale.md'))).toBe(false);
    expect(fs.existsSync(path.join(stampRoot, 'dev-git', 'SKILL.md'))).toBe(true);
  });

  it('refuses a skill name outside the closed charset — that skill only, fail-closed', () => {
    // A fixture install tree under the test data root, NEVER the checked-in
    // one: an interrupted run must not leave a stray dir in the shipped
    // bundle for the release bake's runtimePaths copy to sweep up.
    const fixtureRoot = path.join(DATA_DIR, 'fixture-install');
    const fixtureSkills = path.join(fixtureRoot, 'container', 'code-mode', 'skills');
    fs.mkdirSync(path.join(fixtureSkills, 'Bad Name!'), { recursive: true });
    fs.cpSync(path.join(bundleSource, 'dev-git'), path.join(fixtureSkills, 'dev-git'), { recursive: true });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(fixtureRoot);
    try {
      const mounts = devSkillMounts(sessDir, GROUP_ID);
      expect(mounts.some((m) => m.containerPath.includes('Bad'))).toBe(false);
      // The well-named skills still mount.
      expect(mounts.map((m) => m.containerPath)).toContain('/workspace/group/.claude/skills/dev-git');
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('an unwritable stamp root costs the bundle, NEVER the session — and never throws', () => {
    const roGroupDir = path.join(DATA_DIR, 'v2-sessions', 'ro-group-skills');
    fs.mkdirSync(roGroupDir, { recursive: true });
    fs.chmodSync(roGroupDir, 0o500);
    try {
      expect(devSkillMounts(path.join(roGroupDir, 'sess'), GROUP_ID)).toEqual([]);
    } finally {
      fs.chmodSync(roGroupDir, 0o700);
      fs.rmSync(roGroupDir, { recursive: true, force: true });
    }
  });

  it('survives the mount policy the drivers enforce at prepare', async () => {
    // Same failure mode the manual's policy test guards: a class the stamped
    // path cannot satisfy would deny every code-mode spawn, forever, on retry.
    const mounts = await buildMounts(agentGroup, session, cfg(true), 'claude', {});
    expect(mounts.some((m) => m.containerPath === '/workspace/group/.claude/skills/dev-toolchains')).toBe(true);
    const spec: SessionSpec = {
      key: { installSlug: INSTALL_SLUG, agentGroupId: GROUP_ID, sessionId: session.id },
      // composeSessionSpec always stamps this, and the group-state pin joins the
      // group subtree through it — a spec without it is not one this host can produce.
      labels: { [GROUP_FOLDER_LABEL]: FOLDER },
      containers: [{ role: 'agent', image: 'nanoclaw-agent:test', env: {}, mounts: toMountSpecs(mounts, GROUP_ID) }],
      network: 'shared-private',
      hardening: 'standard',
      resources: {},
      runtimeTier: 'container',
      stopGraceSeconds: 1,
    };
    expect(() => validateSpec(spec, mountPolicy())).not.toThrow();
  });
});

describe('the dev-env materials mount (D4, the in-sandbox half)', () => {
  const materialsRoot = path.join(DATA_DIR, 'dev-env');
  const groupSlice = path.join(materialsRoot, GROUP_ID);

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(materialsRoot, { recursive: true, force: true });
  });

  async function mountsWithDevEnv(codeMode: boolean | undefined) {
    vi.stubEnv('NANOCLAW_DEV_ENV_DRIVER', 'k8s');
    return await buildMounts(agentGroup, session, cfg(codeMode), 'claude', {});
  }

  it("mounts the group's own slice read-only at the path envs-get prints", async () => {
    const mounts = await mountsWithDevEnv(true);
    const materials = mounts.find((m) => m.hostPath === groupSlice);

    expect(materials).toBeDefined();
    // hostPath === containerPath is the point: `ncl envs get` hands out a host
    // path, and it has to resolve to the same file from inside the sandbox.
    expect(materials!.containerPath).toBe(groupSlice);
    expect(materials!.readonly).toBe(true);
    expect(materials!.scope).toBe(GROUP_ID);
    // Composition creates the backing dir; a missing source is a mount of an
    // empty directory on Docker and a refused spec on the pod driver.
    expect(fs.existsSync(groupSlice)).toBe(true);
  });

  it('never mounts the materials root — that holds every other group’s children', async () => {
    const mounts = await mountsWithDevEnv(true);
    for (const mount of mounts) {
      expect(mount.hostPath).not.toBe(materialsRoot);
      const insideRoot = mount.hostPath.startsWith(`${materialsRoot}${path.sep}`);
      if (insideRoot) expect(mount.hostPath).toBe(groupSlice);
    }
  });

  it('is absent in chat mode, and absent entirely when dev-env is off', async () => {
    expect((await mountsWithDevEnv(undefined)).some((m) => m.hostPath === groupSlice)).toBe(false);
    vi.unstubAllEnvs();
    expect(
      (await buildMounts(agentGroup, session, cfg(true), 'claude', {})).some((m) => m.hostPath === groupSlice),
    ).toBe(false);
    // Nothing to mount, nothing created.
    expect(fs.existsSync(groupSlice)).toBe(false);
  });

  it('survives the mount policy the drivers enforce at prepare', async () => {
    // The failure this guards: a class whose pinning rule this path cannot
    // satisfy denies every code-mode spawn, forever, on retry.
    const mounts = await mountsWithDevEnv(true);
    const materials = mounts.find((m) => m.hostPath === groupSlice)!;
    expect(materials.mountClass).toBe('allowlisted-extra');
    const spec: SessionSpec = {
      key: { installSlug: INSTALL_SLUG, agentGroupId: GROUP_ID, sessionId: session.id },
      // composeSessionSpec always stamps this, and the group-state pin joins the
      // group subtree through it — a spec without it is not one this host can produce.
      labels: { [GROUP_FOLDER_LABEL]: FOLDER },
      containers: [{ role: 'agent', image: 'nanoclaw-agent:test', env: {}, mounts: toMountSpecs(mounts, GROUP_ID) }],
      network: 'shared-private',
      hardening: 'standard',
      resources: {},
      runtimeTier: 'container',
      stopGraceSeconds: 1,
    };
    expect(() => validateSpec(spec, mountPolicy())).not.toThrow();
  });
});
