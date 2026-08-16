import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CONTRACT_ROOT = '/tmp/nanoclaw-setup-templates-contract';

// The contract test drives the REAL dispatch pipeline; point its filesystem
// at a scratch root so stamping never touches the checkout.
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-setup-templates-contract/groups',
  DATA_DIR: '/tmp/nanoclaw-setup-templates-contract/data',
  TEMPLATES_DIR: '/tmp/nanoclaw-setup-templates-contract/templates',
}));

vi.mock('../src/container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/container-restart.js', () => ({
  restartAgentGroupContainers: vi.fn().mockReturnValue(0),
}));

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, initTestDb, runMigrations } from '../src/db/index.js';
import { MCP_SCHEMA_URL, PLUGIN_SCHEMA_URL } from '../src/templates/manifest.js';
import { NANOCLAW_EXTENSION_NS } from '../src/templates/extension.js';
import { dispatch } from '../src/cli/dispatch.js';
// Side-effect import: registers the `groups-*` commands for the contract test.
import '../src/cli/resources/groups.js';
import type { AgentGroup } from '../src/types.js';
import {
  applyTemplatePick,
  clearTemplatePick,
  copyTemplate,
  installTemplateAgent,
  listTemplatesFromDir,
  type TemplateReplacePlan,
} from './templates.js';

describe('setup template library', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-templates-'));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('finds nested templates by plugin.json and copies one without git metadata', () => {
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    fs.mkdirSync(path.join(source, 'sales', 'sdr'), { recursive: true });
    fs.writeFileSync(path.join(source, 'sales', 'sdr', 'plugin.json'), '{"name":"sdr"}');
    // A context/instructions.md INSIDE a plugin (the NanoClaw extension dir)
    // must not trip the legacy detection.
    fs.mkdirSync(path.join(source, 'sales', 'sdr', 'ai.nanoco.nanoclaw', 'context'), { recursive: true });
    fs.writeFileSync(
      path.join(source, 'sales', 'sdr', 'ai.nanoco.nanoclaw', 'context', 'instructions.md'),
      'Sell well.',
    );
    fs.mkdirSync(path.join(source, 'sales', 'sdr', '.git'), { recursive: true });
    fs.writeFileSync(path.join(source, 'sales', 'sdr', '.git', 'config'), 'ignored');

    expect(listTemplatesFromDir(source)).toEqual([{ ref: 'sales/sdr', name: 'sdr' }]);

    copyTemplate(source, 'sales/sdr', destination);
    expect(fs.readFileSync(path.join(destination, 'sales', 'sdr', 'plugin.json'), 'utf8')).toBe('{"name":"sdr"}');
    expect(fs.existsSync(path.join(destination, 'sales', 'sdr', '.git'))).toBe(false);
    expect(() => copyTemplate(source, '../escape', destination)).toThrow('escapes the templates directory');
  });

  it('emits the migration error for a pre-plugin template layout', () => {
    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, 'sales', 'sdr', 'context'), { recursive: true });
    fs.writeFileSync(path.join(source, 'sales', 'sdr', 'context', 'instructions.md'), 'Sell well.');

    expect(() => listTemplatesFromDir(source)).toThrow(/predate the plugin format.*sales\/sdr.*Re-fetch/s);
  });

  it('creates through ncl and applies the provider', async () => {
    const created: AgentGroup = {
      id: 'ag-new',
      name: 'SDR',
      folder: 'sdr',
      agent_provider: null,
      created_at: '2026-01-02T00:00:00.000Z',
    };
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const result = await installTemplateAgent({
      ref: 'sales/sdr',
      name: 'SDR',
      timezone: 'Asia/Jerusalem',
      provider: 'codex',
      runNcl: async (command, args) => {
        calls.push({ command, args });
        if (command === 'groups-create') return created;
        return {};
      },
      confirmReplace: async () => {
        throw new Error('no plan expected on a fresh stamp');
      },
    });

    expect(result).toEqual({ status: 'installed', group: created });
    expect(calls).toEqual([
      {
        command: 'groups-create',
        args: { template: 'sales/sdr', name: 'SDR', timezone: 'Asia/Jerusalem' },
      },
      {
        command: 'groups-config-update',
        args: { id: 'ag-new', provider: 'codex' },
      },
    ]);
  });

  it('confirms the dry-run plan, applies with --yes, and restarts the group', async () => {
    const stamped: AgentGroup = {
      id: 'ag-old',
      name: 'SDR',
      folder: 'sdr',
      agent_provider: null,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const plan = {
      applied: false,
      group: stamped,
      changes: [
        { surface: 'skill', name: 'widget', action: 'update', customized: true },
        { surface: 'persona', name: 'instructions.prepend.md', action: 'unchanged' },
      ],
      note: 'DRY RUN',
    };
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    let confirmed: TemplateReplacePlan | undefined;
    // No operator name: the create call must omit it entirely so the CLI's
    // fallback to the template's own agentName stays reachable.
    const result = await installTemplateAgent({
      ref: 'sales/sdr',
      runNcl: async (command, args) => {
        calls.push({ command, args });
        if (command === 'groups-create') return args.yes ? { ...plan, applied: true } : plan;
        return {};
      },
      confirmReplace: async (p) => {
        confirmed = p;
        return true;
      },
    });

    expect(result).toEqual({ status: 'updated', group: stamped });
    expect(confirmed?.changes).toEqual(plan.changes);
    expect(calls).toEqual([
      { command: 'groups-create', args: { template: 'sales/sdr' } },
      { command: 'groups-create', args: { template: 'sales/sdr', id: 'ag-old', yes: true } },
      { command: 'groups-restart', args: { id: 'ag-old' } },
    ]);
  });

  // Declining the reset keeps the customized group untouched but still
  // returns it, so the wizard wires it as-is instead of orphaning it. No
  // apply, no provider update, no restart — declining means zero mutations.
  it('keeps the group untouched (and usable) when the update plan is declined', async () => {
    const stamped: AgentGroup = {
      id: 'ag-old',
      name: 'SDR',
      folder: 'sdr',
      agent_provider: null,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const calls: string[] = [];
    const result = await installTemplateAgent({
      ref: 'sales/sdr',
      name: 'SDR',
      provider: 'claude',
      runNcl: async (command) => {
        calls.push(command);
        return { applied: false, group: stamped, changes: [], note: 'DRY RUN' };
      },
      confirmReplace: async () => false,
    });

    expect(result).toEqual({ status: 'kept', group: stamped });
    expect(calls).toEqual(['groups-create']);
  });

  it('keeps setup and ncl on the same template stamper', () => {
    const setup = fs.readFileSync(path.join(process.cwd(), 'setup', 'templates.ts'), 'utf8');
    const wiring = fs.readFileSync(path.join(process.cwd(), 'scripts', 'init-first-agent.ts'), 'utf8');
    const groups = fs.readFileSync(path.join(process.cwd(), 'src/cli/resources/groups.ts'), 'utf8');
    expect(setup).toContain("options.runNcl('groups-create'");
    expect(groups).toContain('createAgentFromTemplate(ref');
    expect(wiring).toContain('getAgentGroup(args.agentGroupId)');
  });

  it('keeps a deferred template agent selectable by the later wiring skill', () => {
    const skill = fs.readFileSync(
      path.join(process.cwd(), '.claude', 'skills', 'init-first-agent', 'SKILL.md'),
      'utf8',
    );
    expect(skill).toContain('ncl groups list --json');
    expect(skill).toContain('ncl wirings list --json');
    expect(skill).toContain('--agent-group-id "${AGENT_GROUP_ID}"');
  });
});

// The pick must round-trip through BOTH carriers (process.env for this run,
// .env for the next) — a rerun over a partial install resumes from the .env
// copy. Runs against a scratch cwd so the checkout's .env is never touched.
describe('template pick persistence', () => {
  it('applyTemplatePick and clearTemplatePick round-trip both carriers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-pick-'));
    const prevCwd = process.cwd();
    const prevEnv = process.env.NANOCLAW_TEMPLATE_PATH;
    process.chdir(root);
    try {
      applyTemplatePick('sales/sdr');
      expect(process.env.NANOCLAW_TEMPLATE_PATH).toBe('sales/sdr');
      expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toMatch(/^NANOCLAW_TEMPLATE_PATH=sales\/sdr$/m);

      clearTemplatePick();
      expect(process.env.NANOCLAW_TEMPLATE_PATH).toBeUndefined();
      expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toMatch(/^NANOCLAW_TEMPLATE_PATH=$/m);
    } finally {
      process.chdir(prevCwd);
      if (prevEnv === undefined) delete process.env.NANOCLAW_TEMPLATE_PATH;
      else process.env.NANOCLAW_TEMPLATE_PATH = prevEnv;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('setup templates ncl contract (real dispatch)', () => {
  beforeEach(() => {
    fs.rmSync(CONTRACT_ROOT, { recursive: true, force: true });
    const tpl = path.join(CONTRACT_ROOT, 'templates', 'sales', 'sdr');
    fs.mkdirSync(path.join(tpl, NANOCLAW_EXTENSION_NS, 'context'), { recursive: true });
    fs.writeFileSync(path.join(tpl, 'plugin.json'), JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'sdr' }));
    fs.writeFileSync(path.join(tpl, NANOCLAW_EXTENSION_NS, 'context', 'instructions.md'), 'You are an SDR agent.\n');
    fs.writeFileSync(
      path.join(tpl, 'mcp.json'),
      JSON.stringify({
        $schema: MCP_SCHEMA_URL,
        mcpServers: { docs: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' } },
      }),
    );
    runMigrations(initTestDb());
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(CONTRACT_ROOT, { recursive: true, force: true });
  });

  const runNcl = async (command: string, args: Record<string, unknown>): Promise<unknown> => {
    const res = await dispatch({ id: 'contract', command, args }, { caller: 'host' });
    if (!res.ok) throw new Error(res.error.message);
    return res.data;
  };

  // The parsers' real contract: whatever `groups create --template` actually
  // returns through dispatch — fresh group row on first stamp, dry-run plan on
  // a rerun — must parse. Mock fixtures elsewhere in this file cannot drift
  // past this test.
  it('parses the real create result and the real rerun update plan', async () => {
    const fresh = await installTemplateAgent({
      ref: 'sales/sdr',
      name: 'SDR',
      runNcl,
      confirmReplace: async () => {
        throw new Error('no plan expected on first stamp');
      },
    });
    if (fresh.status !== 'installed') throw new Error(`expected installed, got ${fresh.status}`);
    expect(fresh.group.folder).toBe('sdr');

    let plan: TemplateReplacePlan | undefined;
    const rerun = await installTemplateAgent({
      ref: 'sales/sdr',
      name: 'SDR',
      runNcl,
      confirmReplace: async (p) => {
        plan = p;
        return true;
      },
    });
    expect(rerun).toMatchObject({ status: 'updated', group: { id: fresh.group.id } });
    expect(plan?.group.id).toBe(fresh.group.id);
    expect(plan?.changes.length).toBeGreaterThan(0);
  });
});
