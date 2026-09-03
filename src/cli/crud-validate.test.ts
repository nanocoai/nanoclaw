import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/connection.js', () => ({ getDb: vi.fn() }));
vi.mock('../db/container-configs.js', () => ({
  getContainerConfig: vi.fn(() => ({ cli_scope: 'group' })),
}));

import { registerResource, validateArgs } from './crud.js';
import { registerResourceHelpCommands } from './commands/help.js';
import { lookup } from './registry.js';
import type { CallerContext } from './frame.js';

// --- validateArgs unit ---

describe('validateArgs', () => {
  const defs = [
    { name: 'target', type: 'string' as const, description: 'Target.', required: true },
    { name: 'count', type: 'number' as const, description: 'Count.', default: 1 },
    { name: 'force', type: 'boolean' as const, description: 'Force.' },
    { name: 'meta', type: 'json' as const, description: 'Meta.' },
    { name: 'size', type: 'string' as const, description: 'Size.', enum: ['s', 'm', 'l'] },
  ];

  it('coerces types per declaration', () => {
    const out = validateArgs(defs, { target: 'x', count: '5', force: 'true', meta: '{"a":1}' });
    expect(out).toMatchObject({ target: 'x', count: 5, force: true, meta: { a: 1 } });
  });

  it('applies defaults for absent optional flags', () => {
    expect(validateArgs(defs, { target: 'x' }).count).toBe(1);
  });

  it('rejects a missing required flag', () => {
    expect(() => validateArgs(defs, {})).toThrow('--target is required');
  });

  it('rejects unknown flags', () => {
    expect(() => validateArgs(defs, { target: 'x', bogus: '1' })).toThrow('unknown flag --bogus');
  });

  it('tolerates dispatch-injected keys without declaration', () => {
    const out = validateArgs(defs, { target: 'x', id: 'ag-1', agent_group_id: 'ag-1', group: 'ag-1' });
    expect(out.id).toBe('ag-1');
  });

  it('rejects enum violations', () => {
    expect(() => validateArgs(defs, { target: 'x', size: 'xl' })).toThrow('--size must be one of: s, m, l');
  });

  it('rejects non-numeric values for number flags', () => {
    expect(() => validateArgs(defs, { target: 'x', count: 'many' })).toThrow('--count must be a number');
  });

  it('rejects a value-less flag on a non-boolean (client sends true)', () => {
    expect(() => validateArgs(defs, { target: true })).toThrow('--target requires a value');
  });

  it('accepts a value-less boolean flag', () => {
    expect(validateArgs(defs, { target: 'x', force: true }).force).toBe(true);
  });

  it('rejects invalid JSON', () => {
    expect(() => validateArgs(defs, { target: 'x', meta: '{nope' })).toThrow('--meta must be valid JSON');
  });
});

// --- registerResource wiring: strict where declared, lenient otherwise ---

registerResource({
  name: 'widget',
  plural: 'widgets',
  table: 'widgets',
  description: 'Test widgets.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    { name: 'name', type: 'string', description: 'Display name.', required: true, updatable: true },
  ],
  operations: {},
  customOperations: {
    ping: {
      access: 'open',
      description: 'Ping a widget.',
      args: [{ name: 'target', type: 'string', description: 'Where to ping.', required: true }],
      examples: ['ncl widgets ping --target prod'],
      handler: async (args) => ({ echo: args }),
    },
    legacy: {
      access: 'open',
      description: 'Legacy op without declared args.',
      handler: async (args) => ({ echo: args }),
    },
  },
});
registerResourceHelpCommands();

describe('strict validation wiring (declared args)', () => {
  const parse = lookup('widgets-ping')!.parseArgs;

  it('passes and coerces valid args', () => {
    expect(parse({ target: 'prod' })).toMatchObject({ target: 'prod' });
  });

  it('failure carries the verb usage block (error + fix in one round-trip)', () => {
    let message = '';
    try {
      parse({});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('--target is required');
    expect(message).toContain('ncl widgets ping'); // usage line
    expect(message).toContain('Flags:');
    expect(message).toContain('Examples:');
  });

  it('rejects unknown flags with the usage block', () => {
    expect(() => parse({ target: 'prod', bogus: '1' })).toThrow(/unknown flag --bogus[\s\S]*Flags:/);
  });

  it('normalizes dashed flags before validating', () => {
    // --target arrives as raw key "target"; a dashed alias like "tar-get" would
    // normalize to underscores — prove normalize runs before validate.
    expect(() => parse({ 'bogus-flag': '1', target: 'x' })).toThrow('unknown flag --bogus-flag');
  });
});

describe('lenient ops (no declared args) keep legacy behavior', () => {
  it('passes stray flags through untouched', () => {
    const parse = lookup('widgets-legacy')!.parseArgs;
    expect(parse({ anything: 'goes', 'dash-key': '1' })).toMatchObject({ anything: 'goes', dash_key: '1' });
  });
});

// --- resource help: deep verb view + group-scope auto-fill guard ---

describe('resource help command', () => {
  const helpCmd = lookup('widgets-help')!;
  const host: CallerContext = { caller: 'host' };
  const agent: CallerContext = {
    caller: 'agent',
    sessionId: 'sess-1',
    agentGroupId: 'ag-1',
    messagingGroupId: 'mg-1',
  };

  it('renders the resource overview with verb summaries', async () => {
    const out = (await helpCmd.handler(helpCmd.parseArgs({}), host)) as string;
    expect(out).toContain('widgets: Test widgets.');
    expect(out).toContain('ping — Ping a widget.');
    expect(out).toContain('help <verb>');
  });

  it('renders deep help for `help <verb>` (id from prefix fallback)', async () => {
    const out = (await helpCmd.handler(helpCmd.parseArgs({ id: 'ping' }), host)) as string;
    expect(out).toContain('ncl widgets ping');
    expect(out).toContain('--target');
    expect(out).toContain('Examples:');
  });

  it('errors on an unknown verb', async () => {
    await expect(helpCmd.handler(helpCmd.parseArgs({ id: 'bogus' }), host)).rejects.toThrow(
      'no verb "bogus" on widgets',
    );
  });

  it('treats an auto-filled agent group id as no verb (scoped agent, plain help)', async () => {
    // dispatch auto-fills id=ctx.agentGroupId on groups/destinations; the
    // handler must show the overview, not "no verb <uuid>".
    const out = (await helpCmd.handler(helpCmd.parseArgs({ id: 'ag-1' }), agent)) as string;
    expect(out).toContain('widgets: Test widgets.');
  });
});
