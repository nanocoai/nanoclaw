/**
 * The sandbox lifecycle hooks: ordered, error-isolated, named for contract
 * tests, and refused on a seam mismatch — logged, listed, never thrown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { log } from '../log.js';
import { renderSeamRefusals, resetSeamRefusalsForTesting, seamRefusals } from '../seams.js';
import { assertSandboxHook } from './contract.js';
import {
  SANDBOX_HOOKS_SEAM,
  fireRemoteAccessChanged,
  fireSandboxBound,
  fireSandboxCreated,
  fireSandboxRemoved,
  onRemoteAccessChanged,
  onSandboxBound,
  onSandboxCreated,
  onSandboxRemoved,
  resetSandboxHooksForTesting,
  sandboxHookNames,
} from './hooks.js';

const group = { id: 'ag-1', name: 'one', folder: 'one' };
const seam = { seam: SANDBOX_HOOKS_SEAM };

beforeEach(() => {
  resetSandboxHooksForTesting();
  resetSeamRefusalsForTesting();
  vi.mocked(log.error).mockClear();
});
afterEach(() => {
  resetSandboxHooksForTesting();
  resetSeamRefusalsForTesting();
});

describe('sandbox hooks', () => {
  it('fires callbacks in registration order with the event arguments', async () => {
    const seen: string[] = [];
    onSandboxCreated('a', async (g) => void seen.push(`a:${g.folder}`), seam);
    onSandboxCreated('b', (g) => void seen.push(`b:${g.folder}`), seam);
    await fireSandboxCreated(group);
    expect(seen).toEqual(['a:one', 'b:one']);

    const bound: string[] = [];
    onSandboxBound('s', (g, surface) => void bound.push(`${g.id}/${surface.channelType}/${surface.surfaceId}`), seam);
    await fireSandboxBound(group, {
      channelType: 'chat',
      surfaceId: 'C1',
      sessionId: 'ag-1',
      messagingGroupId: 'mg-1',
    });
    expect(bound).toEqual(['ag-1/chat/C1']);

    const removed: string[] = [];
    onSandboxRemoved('r', (g) => void removed.push(g.id), seam);
    await fireSandboxRemoved(group);
    expect(removed).toEqual(['ag-1']);

    const states: boolean[] = [];
    onRemoteAccessChanged('ra', (state) => void states.push(state.enabled), seam);
    await fireRemoteAccessChanged({ enabled: true, name: 'box' });
    await fireRemoteAccessChanged({ enabled: false });
    expect(states).toEqual([true, false]);
  });

  it('a throwing callback is logged and the rest still run — a hook never fails the verb', async () => {
    const seen: string[] = [];
    onSandboxCreated(
      'boom',
      () => {
        throw new Error('listener broke');
      },
      seam,
    );
    onSandboxCreated('after', () => void seen.push('after'), seam);
    await expect(fireSandboxCreated(group)).resolves.toBeUndefined();
    expect(seen).toEqual(['after']);
    expect(log.error).toHaveBeenCalledWith(
      'Sandbox hook failed — continuing',
      expect.objectContaining({ hook: 'created', name: 'boom' }),
    );
  });

  it('unregister removes exactly that callback', async () => {
    const seen: string[] = [];
    const off = onSandboxCreated('a', () => void seen.push('a'), seam);
    onSandboxCreated('b', () => void seen.push('b'), seam);
    off();
    await fireSandboxCreated(group);
    expect(seen).toEqual(['b']);
    expect(sandboxHookNames('created')).toEqual(['b']);
  });

  it('names are visible to contract tests', () => {
    onSandboxRemoved('door', () => {}, seam);
    expect(() => assertSandboxHook('removed', 'door')).not.toThrow();
    expect(() => assertSandboxHook('removed', 'nobody')).toThrow("sandbox hook 'removed:nobody' is not registered");
  });

  it('a seam mismatch is refused: logged, listed for the operator, never registered, never thrown', async () => {
    const seen: string[] = [];
    const off = onSandboxCreated('old-module', () => void seen.push('old'), { seam: SANDBOX_HOOKS_SEAM + 1 });
    expect(typeof off).toBe('function');
    await fireSandboxCreated(group);
    expect(seen).toEqual([]);
    expect(sandboxHookNames('created')).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      'Registration refused: seam version mismatch',
      expect.objectContaining({ registry: 'sandbox-hooks', registrant: 'created:old-module' }),
    );
    expect(seamRefusals()).toEqual([
      { registry: 'sandbox-hooks', registrant: 'created:old-module', wanted: SANDBOX_HOOKS_SEAM, got: 2 },
    ]);
    expect(renderSeamRefusals()[0]).toContain("sandbox-hooks refused 'created:old-module'");
    // The contract helper names the refusal so a module's test reads the cause.
    expect(() => assertSandboxHook('created', 'old-module')).toThrow(/refused: seam 1 expected, 2 given/);
  });
});
