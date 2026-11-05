import { afterEach, expect, it, vi } from 'vitest';

const edge = vi.hoisted(() => ({
  confirm: vi.fn(async () => false),
  assist: vi.fn(async () => true),
  emit: vi.fn(),
}));
vi.mock('./claude-handoff.js', () => ({ offerClaudeOnFailure: edge.assist }));
vi.mock('../logs.js', () => ({ abort: vi.fn() }));
vi.mock('./diagnostics.js', () => ({ emit: edge.emit }));
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

it('sends only the fixed reason code, never the message', async () => {
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('test exit');
  });
  edge.emit.mockClear();
  await expect(
    fail('init-first-agent', "Couldn't wire Ada to /Users/someone/nanoclaw", undefined, { code: 'wire_failed' }),
  ).rejects.toThrow('test exit');
  expect(edge.emit).toHaveBeenCalledWith('setup_aborted', { step: 'init-first-agent', reason_code: 'wire_failed' });

  edge.emit.mockClear();
  await expect(fail('auth', 'Authentication failed')).rejects.toThrow('test exit');
  expect(edge.emit).toHaveBeenCalledWith('setup_aborted', { step: 'auth', reason_code: 'unspecified' });

  edge.emit.mockClear();
  await expect(
    fail('add-acme-internal', "Couldn't install acme-internal.", undefined, {
      code: 'install_error',
      diagnosticStep: 'add-unknown',
    }),
  ).rejects.toThrow('test exit');
  expect(edge.emit).toHaveBeenCalledWith('setup_aborted', { step: 'add-unknown', reason_code: 'install_error' });
});
