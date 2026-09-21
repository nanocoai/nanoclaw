import { afterEach, expect, it, vi } from 'vitest';

const edge = vi.hoisted(() => ({ confirm: vi.fn(async () => false), assist: vi.fn(async () => true) }));
vi.mock('./claude-handoff.js', () => ({ offerClaudeOnFailure: edge.assist }));
vi.mock('../logs.js', () => ({ abort: vi.fn() }));
vi.mock('./diagnostics.js', () => ({ emit: vi.fn() }));
vi.mock('@clack/prompts', () => ({
  confirm: edge.confirm,
  isCancel: () => false,
  cancel: vi.fn(),
  log: { error: vi.fn(), message: vi.fn() },
}));
import { fail } from './runner.js';

afterEach(() => vi.restoreAllMocks());

it('offers verification after assistance without claiming that a repair happened', async () => {
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('test exit');
  });
  await expect(fail('auth', 'Authentication failed')).rejects.toThrow('test exit');
  expect(edge.assist).toHaveBeenCalledOnce();
  expect(edge.confirm).toHaveBeenCalledWith({
    message: 'Retry the auth step to check whether the problem is resolved?',
    initialValue: true,
  });
});
