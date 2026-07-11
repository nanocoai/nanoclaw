/**
 * Tests for `createNewAgentGroup` provider inheritance.
 *
 * Bug: channel-registered "Connect new agent" always created the group with
 * the built-in default provider (claude). On a single-provider install where
 * claude isn't authenticated (e.g. codex-only), the new agent's first turn
 * died with `401 No credentials configured for api.anthropic.com`.
 *
 * Fix (mirrors create_agent's parent-inheritance intent): with no parent to
 * inherit from, derive a default from the install's existing container configs.
 * If every config that declares a provider declares the SAME non-default one,
 * adopt it; otherwise (none, or mixed) keep the claude default — no behavior
 * change for multi-provider or Claude installs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetAllContainerConfigs = vi.fn();
const mockUpdateScalars = vi.fn();
const mockInitGroupFilesystem = vi.fn();

vi.mock('../../db/container-configs.js', () => ({
  getAllContainerConfigs: () => mockGetAllContainerConfigs(),
  updateContainerConfigScalars: (...a: unknown[]) => mockUpdateScalars(...a),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => ({ id, name: id, folder: id, agent_provider: null, created_at: '' }),
  getAgentGroupByFolder: () => undefined,
  getAllAgentGroups: () => [],
  createAgentGroup: vi.fn(),
}));
vi.mock('../../group-init.js', () => ({
  initGroupFilesystem: (...a: unknown[]) => mockInitGroupFilesystem(...a),
}));

beforeEach(() => {
  mockGetAllContainerConfigs.mockReset();
  mockUpdateScalars.mockReset();
  mockInitGroupFilesystem.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

describe('createNewAgentGroup provider inheritance', () => {
  it('single-provider install → new channel agent inherits that provider', async () => {
    // Every existing group runs codex (built-in claude leaves the column unset).
    mockGetAllContainerConfigs.mockReturnValue([{ provider: 'codex' }, { provider: 'codex' }]);

    const { createNewAgentGroup } = await import('./channel-approval.js');
    createNewAgentGroup('New Agent');

    expect(mockInitGroupFilesystem).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ provider: 'codex' }),
    );
    expect(mockUpdateScalars).toHaveBeenCalledWith(expect.any(String), { provider: 'codex' });
  });

  it('mixed-provider install → keeps the built-in claude default (provider unset)', async () => {
    mockGetAllContainerConfigs.mockReturnValue([{ provider: 'codex' }, { provider: 'opencode' }]);

    const { createNewAgentGroup } = await import('./channel-approval.js');
    createNewAgentGroup('New Agent');

    expect(mockInitGroupFilesystem).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ provider: undefined }),
    );
    expect(mockUpdateScalars).not.toHaveBeenCalled();
  });

  it('claude-only install (no providers set) → keeps the built-in claude default', async () => {
    // Existing groups all run the built-in default → provider column unset/empty.
    mockGetAllContainerConfigs.mockReturnValue([{ provider: null }, { provider: '' }]);

    const { createNewAgentGroup } = await import('./channel-approval.js');
    createNewAgentGroup('New Agent');

    expect(mockInitGroupFilesystem).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ provider: undefined }),
    );
    expect(mockUpdateScalars).not.toHaveBeenCalled();
  });
});
