import { describe, it, expect } from 'vitest';

import type { ResourceDef } from './crud.js';
import { listVerbs, renderVerbHelp, summaryLine } from './help-render.js';

const res: ResourceDef = {
  name: 'widget',
  plural: 'widgets',
  table: 'widgets',
  description: 'Test widgets.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    { name: 'name', type: 'string', description: 'Display name.', required: true, updatable: true },
    { name: 'size', type: 'string', description: 'Widget size.', enum: ['s', 'm', 'l'], default: 'm' },
  ],
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval' },
  customOperations: {
    ping: {
      access: 'open',
      description: 'Ping a widget.\nLonger prose that only deep help shows.',
      args: [
        { name: 'target', type: 'string', description: 'Where to ping.', required: true },
        { name: 'count', type: 'number', description: 'How many times.', default: 1 },
      ],
      examples: ['ncl widgets ping --target prod --count 3'],
      handler: async () => ({}),
    },
  },
};

describe('listVerbs', () => {
  it('lists enabled generics then custom verbs', () => {
    expect(listVerbs(res)).toEqual(['list', 'get', 'create', 'update', 'ping']);
  });
});

describe('renderVerbHelp — custom operation', () => {
  it('renders usage, full description, flags with tags, and examples', () => {
    const out = renderVerbHelp(res, 'ping')!;
    expect(out).toContain('ncl widgets ping');
    expect(out).toContain('Longer prose that only deep help shows.');
    expect(out).toContain('--target');
    expect(out).toContain('(required)');
    expect(out).toContain('--count');
    expect(out).toContain('default: 1');
    expect(out).toContain('Examples:');
    expect(out).toContain('ncl widgets ping --target prod --count 3');
  });

  it('tags non-open access on the usage line', () => {
    const gated: ResourceDef = {
      ...res,
      customOperations: { ping: { ...res.customOperations!.ping, access: 'approval' } },
    };
    expect(renderVerbHelp(gated, 'ping')).toContain('ncl widgets ping [approval]');
  });
});

describe('renderVerbHelp — generic verbs', () => {
  it('create renders non-generated columns as flags', () => {
    const out = renderVerbHelp(res, 'create')!;
    expect(out).toContain('ncl widgets create [approval]');
    expect(out).toContain('--name');
    expect(out).toContain('(required)');
    expect(out).toContain('--size');
    expect(out).toContain('values: s | m | l');
    expect(out).not.toContain('--id'); // generated
  });

  it('update renders only updatable columns and takes <id>', () => {
    const out = renderVerbHelp(res, 'update')!;
    expect(out).toContain('ncl widgets update <id> [approval]');
    expect(out).toContain('--name');
    expect(out).not.toContain('--size');
  });

  it('list renders filter flags plus --limit, never marked required', () => {
    const out = renderVerbHelp(res, 'list')!;
    expect(out).toContain('--limit');
    expect(out).toContain('--name');
    expect(out).not.toContain('(required)');
  });

  it('returns undefined for verbs the resource does not have', () => {
    expect(renderVerbHelp(res, 'delete')).toBeUndefined(); // not in operations
    expect(renderVerbHelp(res, 'bogus')).toBeUndefined();
  });
});

describe('summaryLine', () => {
  it('returns only the first line', () => {
    expect(summaryLine('Ping a widget.\nLonger prose.')).toBe('Ping a widget.');
  });
});
