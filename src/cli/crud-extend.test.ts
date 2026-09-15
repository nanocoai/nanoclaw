/**
 * extendResource: a module adds sub-verbs to a resource it does not own —
 * before or after the resource registers — through the same registration
 * (help, guard, host-only) a resource's own custom operations get; a verb
 * that already exists, or a registration on the wrong seam, is refused and
 * logged, never overwritten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { log } from '../log.js';
import { resetSeamRefusalsForTesting, seamRefusals } from '../seams.js';
import { RESOURCE_EXTENSION_SEAM, extendResource, registerResource, type CustomOperation } from './crud.js';
import { dispatch } from './dispatch.js';
import type { CallerContext } from './frame.js';
import { lookup } from './registry.js';

const HOST: CallerContext = { caller: 'host' };
let n = 0;
const seam = { seam: RESOURCE_EXTENSION_SEAM };

function op(reply: string, extra: Partial<CustomOperation> = {}): CustomOperation {
  return { access: 'open', hostOnly: true, description: `${reply}.`, handler: async () => ({ reply }), ...extra };
}

function fresh(): string {
  n += 1;
  return `widgets${n}`;
}

beforeEach(() => {
  resetSeamRefusalsForTesting();
  vi.mocked(log.error).mockClear();
});
afterEach(() => resetSeamRefusalsForTesting());

describe('extendResource', () => {
  it('registers sub-verbs on a resource that already exists', async () => {
    const plural = fresh();
    registerResource({
      name: 'widget',
      plural,
      table: 't',
      description: 'w',
      idColumn: 'id',
      columns: [],
      operations: {},
    });
    extendResource(plural, { 'remote enable': op('enabled') }, seam);
    expect(lookup(`${plural}-remote-enable`)?.hostOnly).toBe(true);
    const res = await dispatch({ id: 'r1', command: `${plural}-remote-enable`, args: {} }, HOST);
    expect(res).toMatchObject({ ok: true, data: { reply: 'enabled' } });
  });

  it('queues sub-verbs until the resource registers', async () => {
    const plural = fresh();
    extendResource(plural, { status: op('queued') }, seam);
    expect(lookup(`${plural}-status`)).toBeUndefined();
    registerResource({
      name: 'widget',
      plural,
      table: 't',
      description: 'w',
      idColumn: 'id',
      columns: [],
      operations: {},
    });
    const res = await dispatch({ id: 'r1', command: `${plural}-status`, args: {} }, HOST);
    expect(res).toMatchObject({ ok: true, data: { reply: 'queued' } });
  });

  it('refuses a verb the resource already has — the original keeps answering', async () => {
    const plural = fresh();
    registerResource({
      name: 'widget',
      plural,
      table: 't',
      description: 'w',
      idColumn: 'id',
      columns: [],
      operations: {},
      customOperations: { status: op('original') },
    });
    extendResource(plural, { status: op('impostor'), extra: op('extra') }, seam);
    expect(log.error).toHaveBeenCalledWith(
      'Resource extension refused: verb already registered',
      expect.objectContaining({ resource: plural, verb: 'status' }),
    );
    const res = await dispatch({ id: 'r1', command: `${plural}-status`, args: {} }, HOST);
    expect(res).toMatchObject({ ok: true, data: { reply: 'original' } });
    // The rest of the same extension still lands.
    expect(lookup(`${plural}-extra`)).toBeDefined();
  });

  it('a queued verb that collides with the resource when it registers is refused, not fatal', async () => {
    const plural = fresh();
    extendResource(plural, { status: op('queued'), extra: op('extra') }, seam);
    expect(() =>
      registerResource({
        name: 'widget',
        plural,
        table: 't',
        description: 'w',
        idColumn: 'id',
        columns: [],
        operations: {},
        customOperations: { status: op('original') },
      }),
    ).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(
      'Resource extension refused: verb already registered',
      expect.objectContaining({ resource: plural, verb: 'status' }),
    );
    const res = await dispatch({ id: 'r1', command: `${plural}-status`, args: {} }, HOST);
    expect(res).toMatchObject({ ok: true, data: { reply: 'original' } });
    expect(lookup(`${plural}-extra`)).toBeDefined();
  });

  it('refuses the whole extension on a seam mismatch, and says so', () => {
    const plural = fresh();
    registerResource({
      name: 'widget',
      plural,
      table: 't',
      description: 'w',
      idColumn: 'id',
      columns: [],
      operations: {},
    });
    extendResource(plural, { status: op('old') }, { seam: RESOURCE_EXTENSION_SEAM + 1 });
    expect(lookup(`${plural}-status`)).toBeUndefined();
    expect(seamRefusals()).toMatchObject([{ registry: 'resource-extension', registrant: `${plural} status` }]);
  });
});
