import { expect, it, vi } from 'vitest';

const logMocks = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: logMocks.warn, error: logMocks.error, fatal: vi.fn() },
}));

import { dispatchResponse, registerResponseHandler } from './response-registry.js';

it('sanitizes NanoCo handler failures while preserving unrelated diagnostics', async () => {
  const secret = 'Authorization: Bearer handler-secret; query=?private=value';
  const secretValue = 'approve?callback_secret=distinctive-action-secret';
  const questionId = `nanoco-ask-${'b'.repeat(32)}`;
  registerResponseHandler(async () => {
    throw new Error(secret);
  });

  await dispatchResponse({
    questionId,
    value: secretValue,
    userId: 'U1',
    channelType: 'slack',
    platformId: '',
    threadId: null,
  });

  expect(logMocks.error).toHaveBeenCalledWith('Response handler threw', {
    code: 'approval_handler_failed',
  });
  expect(logMocks.warn).toHaveBeenCalledWith('Unclaimed response', {
    code: 'approval_response_unclaimed',
  });
  const approvalLogs = JSON.stringify([logMocks.error.mock.calls, logMocks.warn.mock.calls]);
  expect(approvalLogs).not.toContain('handler-secret');
  expect(approvalLogs).not.toContain('private=value');
  expect(approvalLogs).not.toContain('distinctive-action-secret');

  logMocks.error.mockClear();
  logMocks.warn.mockClear();
  await dispatchResponse({
    questionId: 'legacy-question',
    value: 'approve',
    userId: 'U1',
    channelType: 'slack',
    platformId: '',
    threadId: null,
  });
  expect(logMocks.error).toHaveBeenCalledWith('Response handler threw', {
    questionId: 'legacy-question',
    err: expect.objectContaining({ message: secret }),
  });
  expect(logMocks.warn).toHaveBeenCalledWith('Unclaimed response', {
    questionId: 'legacy-question',
    value: 'approve',
  });
});
