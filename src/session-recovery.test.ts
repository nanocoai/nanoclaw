import { describe, expect, it } from 'vitest';

import {
  buildSessionRecoveryMessage,
  isSessionRecoveryError,
} from './session-recovery.js';

describe('session recovery helpers', () => {
  it('识别 Claude session 恢复失败错误', () => {
    expect(
      isSessionRecoveryError(
        'Claude Code returned an error result: No conversation found with session ID: abc',
      ),
    ).toBe(true);
    expect(isSessionRecoveryError('ENOENT: no such file or directory, open abc.jsonl')).toBe(true);
    expect(isSessionRecoveryError('session abc not found')).toBe(true);
    expect(isSessionRecoveryError('API Error: 500 overloaded')).toBe(false);
  });

  it('生成保留指针并交给用户决策的提示', () => {
    const text = buildSessionRecoveryMessage({
      sessionId: 'sess-123',
      error: 'No conversation found with session ID: sess-123',
    });

    expect(text).toContain('没有自动切换到新 session');
    expect(text).toContain('sess-123');
    expect(text).toContain('/new');
  });
});
