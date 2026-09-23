import { describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ check: vi.fn(), auth: vi.fn() }));
vi.mock('../../scripts/opencode-auth.js', () => ({
  checkOpenCodeInstall: calls.check,
  runOpenCodeSetupAuth: calls.auth,
}));
import './index.js';
import { getSetupProvider } from './registry.js';

describe('installed OpenCode setup registration', () => {
  it('loads the real barrel and keeps authentication separate from installation verification', async () => {
    const entry = getSetupProvider('opencode');
    expect(entry).toMatchObject({ value: 'opencode', label: 'OpenCode', hint: 'Open-source provider router' });
    await entry!.runAuth!();
    expect(calls.check).not.toHaveBeenCalled();
    expect(calls.auth).toHaveBeenCalledTimes(1);
    await entry!.runInstallCheck!();
    expect(calls.check).toHaveBeenCalledTimes(1);
  });

  it('reports an installation-check failure without invoking authentication', async () => {
    calls.auth.mockClear();
    calls.check.mockRejectedValueOnce(new Error('incomplete payload'));
    await expect(getSetupProvider('opencode')!.runInstallCheck!()).rejects.toThrow('incomplete payload');
    expect(calls.auth).not.toHaveBeenCalled();
  });
});
