/**
 * Wiring guards for the template-provisioning CLI surface:
 *
 *  - `ncl templates list/get` must be registered through the resource barrel
 *    (`src/cli/resources/index.ts`) — this file imports the real barrel, not
 *    `./templates.js` directly, so a deleted barrel line goes red.
 *  - `ncl groups create --spec` must reach `createAgentFromSpec` (digest-checked
 *    stamp with concrete config + provisioned user).
 *  - `ncl groups create --template --source <uri>` must pass the source
 *    override through to the template resolver.
 *  - The `ncl` client must resolve the `--spec-stdin` transport before it
 *    builds the request frame (structural — `main()` is not invocable here).
 *
 * Every dispatch() case runs with the host caller against a real migrated
 * central DB, the same code path an approved request takes.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-cli-templates/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-cli-templates/groups',
    TEMPLATES_DIR: '/tmp/nanoclaw-test-cli-templates/templates',
  };
});

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const TEST_DIR = '/tmp/nanoclaw-test-cli-templates';
const TEMPLATES_DIR = path.join(TEST_DIR, 'templates');

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { loadTemplateSnapshot } from '../../templates/snapshot.js';
import { dispatch } from '../dispatch.js';
// The real barrel — registers every `ncl` resource, including templates.
import './index.js';

function writeTemplate(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'ai.nanoco.nanoclaw', 'context'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name,
      version: '1.0.0',
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'ai.nanoco.nanoclaw', 'context', 'instructions.md'),
    `You are the ${name} agent.\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'mcp.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: { seed: { type: 'stdio', command: 'seed-mcp' } },
    }),
  );
  return dir;
}

function ok(resp: unknown): Record<string, unknown> {
  expect((resp as { ok: boolean }).ok).toBe(true);
  return (resp as { ok: true; data: Record<string, unknown> }).data;
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  writeTemplate(TEMPLATES_DIR, 'support');
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('ncl templates (registered via the resource barrel)', () => {
  it('lists folder-backed templates and returns full detail with digest + capabilities', async () => {
    const list = ok(await dispatch({ id: 'r-tl', command: 'templates-list', args: {} }, { caller: 'host' }));
    const names = (list.templates as { name: string }[]).map((t) => t.name);
    expect(names).toContain('support');

    const detail = ok(
      await dispatch({ id: 'r-tg', command: 'templates-get', args: { name: 'support' } }, { caller: 'host' }),
    );
    expect(detail.digest).toBe(loadTemplateSnapshot(path.join(TEMPLATES_DIR, 'support')).digest);
    expect(detail.mcpServers).toEqual(['seed']);
    expect(detail.provisioningCapabilities).toMatchObject({ createSpecStdin: true });
  });
});

describe('ncl groups create --spec', () => {
  it('stamps a digest-checked group with the exact concrete config + provisioned user', async () => {
    const digest = loadTemplateSnapshot(path.join(TEMPLATES_DIR, 'support')).digest;
    const spec = {
      version: 2,
      id: 'ag-spec-1',
      agentId: 'ag-spec-1',
      name: 'Governed Support',
      folder: 'governed-support',
      template: { ref: 'support', expectedDigest: digest },
      config: {
        mcpServers: { approved: { command: 'approved-mcp' } },
        cliScope: 'group',
        packagesApt: [],
        packagesNpm: [],
      },
      provisionedUserId: 'slack:U123',
    };

    const data = ok(
      await dispatch(
        { id: 'r-spec', command: 'groups-create', args: { spec: JSON.stringify(spec) } },
        { caller: 'host' },
      ),
    );
    expect(data.id).toBe('ag-spec-1');
    expect(data.provisioned_user_id).toBe('slack:U123');

    const row = (await getDb().get('SELECT provisioned_user_id FROM agent_groups WHERE id = ?', 'ag-spec-1')) as {
      provisioned_user_id: string | null;
    };
    expect(row.provisioned_user_id).toBe('slack:U123');

    const cfg = (await getContainerConfig('ag-spec-1'))!;
    expect(cfg.cli_scope).toBe('group');
    expect(JSON.parse(cfg.mcp_servers)).toMatchObject({
      approved: { command: 'approved-mcp', plugin: 'support' },
    });
  });

  it('rejects a stale digest and malformed JSON without creating anything', async () => {
    const stale = await dispatch(
      {
        id: 'r-stale',
        command: 'groups-create',
        args: {
          spec: JSON.stringify({
            version: 2,
            id: 'ag-stale',
            name: 'Stale',
            folder: 'stale',
            template: { ref: 'support', expectedDigest: 'sha256:stale' },
            config: { mcpServers: {}, cliScope: 'disabled', packagesApt: [], packagesNpm: [] },
          }),
        },
      },
      { caller: 'host' },
    );
    expect(stale.ok).toBe(false);
    expect((stale as { ok: false; error: { message: string } }).error.message).toMatch(/digest changed/i);

    const malformed = await dispatch(
      { id: 'r-mal', command: 'groups-create', args: { spec: '{nope' } },
      { caller: 'host' },
    );
    expect(malformed.ok).toBe(false);
    expect((malformed as { ok: false; error: { message: string } }).error.message).toMatch(/valid JSON/);

    const groups = await getDb().all("SELECT id FROM agent_groups WHERE id IN ('ag-stale')");
    expect(groups).toEqual([]);
  });
});

describe('ncl groups create --template --source', () => {
  it('resolves the template ref against the --source override, not the local bundle', async () => {
    // The template exists ONLY under the alternate library: if the handler
    // drops the source passthrough, resolution falls back to TEMPLATES_DIR
    // and the create fails.
    const altLib = path.join(TEST_DIR, 'alt-lib');
    writeTemplate(altLib, 'alt-agent');

    const data = ok(
      await dispatch(
        {
          id: 'r-src',
          command: 'groups-create',
          args: { template: 'alt-agent', name: 'Alt Agent', source: altLib },
        },
        { caller: 'host' },
      ),
    );
    expect(data.name).toBe('Alt Agent');
    const cfg = (await getContainerConfig(data.id as string))!;
    expect(JSON.parse(cfg.mcp_servers)).toMatchObject({
      seed: {
        command: 'seed-mcp',
        args: [],
        env: {},
        cwd: '${PLUGIN_ROOT}',
        plugin: 'alt-agent',
      },
    });
    expect(JSON.parse(cfg.mcp_servers).seed.pluginRoot).toMatch(/\/plugins\/alt-agent$/);
  });
});

describe('ncl client --spec-stdin wiring (structural)', () => {
  it('main() awaits resolveCreateSpecStdin(command, args) before building the request frame', () => {
    const clientPath = new URL('../client.ts', import.meta.url);
    const source = fs.readFileSync(clientPath, 'utf8');
    expect(source).toContain(`import { resolveCreateSpecStdin } from './stdin.js';`);

    const sf = ts.createSourceFile('client.ts', source, ts.ScriptTarget.ES2022, true);
    const main = sf.statements.find(
      (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'main',
    );
    expect(main?.body).toBeTruthy();
    const stmts = main!.body!.statements;

    const callIdx = stmts.findIndex(
      (s) =>
        ts.isExpressionStatement(s) &&
        ts.isAwaitExpression(s.expression) &&
        ts.isCallExpression(s.expression.expression) &&
        s.expression.expression.expression.getText(sf) === 'resolveCreateSpecStdin' &&
        s.expression.expression.arguments.map((a) => a.getText(sf)).join(',') === 'command,args',
    );
    const reqIdx = stmts.findIndex(
      (s) => ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => d.name.getText(sf) === 'req'),
    );

    // The stdin transport must resolve before the frame is built — a present
    // but misplaced call fails here.
    expect(callIdx).toBeGreaterThanOrEqual(0);
    expect(reqIdx).toBeGreaterThan(callIdx);
  });
});
