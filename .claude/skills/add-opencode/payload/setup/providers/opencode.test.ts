import { describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ check: vi.fn(), auth: vi.fn() }));
vi.mock('../../scripts/opencode-auth.js', () => ({
  checkOpenCodeInstall: calls.check,
  runOpenCodeSetupAuth: calls.auth,
}));
import './index.js';
import { getSetupProvider } from './registry.js';

describe('installed OpenCode setup registration', () => {
  it('loads from the real barrel and authenticates only after its install check', async () => {
    const entry = getSetupProvider('opencode');
    expect(entry).toMatchObject({ value: 'opencode', label: 'OpenCode', hint: 'Open-source provider router' });
    await entry!.runAuth!();
    expect(calls.check).toHaveBeenCalledTimes(1);
    expect(calls.auth).toHaveBeenCalledTimes(1);
    expect(calls.check.mock.invocationCallOrder[0]).toBeLessThan(calls.auth.mock.invocationCallOrder[0]);
    await entry!.runInstallCheck!();
    expect(calls.check).toHaveBeenCalledTimes(2);
  });

  it('does not authenticate an incomplete installation', async () => {
    calls.auth.mockClear();
    calls.check.mockRejectedValueOnce(new Error('incomplete payload'));
    await expect(getSetupProvider('opencode')!.runAuth!()).rejects.toThrow('incomplete payload');
    expect(calls.auth).not.toHaveBeenCalled();
  });
});
