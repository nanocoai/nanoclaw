/**
 * Regression test for the codex-fallback auth hole: the host deliberately
 * never loads .env into process.env (src/env.ts), but the codex provider
 * config used to read OPENAI_API_KEY & co. from process.env only — so a
 * service-managed host passed NO auth to the container and every fallback
 * turn failed, for every agent group. resolveCodexEnv must consult the
 * parsed .env file too.
 */
import { describe, it, expect } from 'vitest';

import { resolveCodexEnv } from './codex.js';

describe('resolveCodexEnv', () => {
  it('falls back to .env file values when process.env lacks the keys', () => {
    const env = resolveCodexEnv({}, { OPENAI_API_KEY: 'file-key', CODEX_MODEL: 'gpt-5.4' });
    expect(env.OPENAI_API_KEY).toBe('file-key');
    expect(env.CODEX_MODEL).toBe('gpt-5.4');
  });

  it('prefers process.env when both define a key', () => {
    const env = resolveCodexEnv({ OPENAI_API_KEY: 'proc-key' }, { OPENAI_API_KEY: 'file-key' });
    expect(env.OPENAI_API_KEY).toBe('proc-key');
  });

  it('omits keys defined in neither source', () => {
    const env = resolveCodexEnv({}, {});
    expect(env).toEqual({});
  });

  it('ignores empty-string values', () => {
    const env = resolveCodexEnv({ OPENAI_API_KEY: '' }, { OPENAI_API_KEY: 'file-key' });
    expect(env.OPENAI_API_KEY).toBe('file-key');
  });
});
