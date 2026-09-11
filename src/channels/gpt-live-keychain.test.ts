/**
 * Key resolution for the gpt-live channel: `.env` first, then the macOS
 * Keychain item named in `.env`, never both. The Keychain reader is a stub
 * here — the real one shells out to `security`, which a unit test must not.
 */
import { describe, expect, it } from 'vitest';

import { resolveOpenAiKey } from './gpt-live-keychain.js';

describe('resolveOpenAiKey', () => {
  it('prefers the key in .env and never touches the Keychain', () => {
    let calls = 0;
    const r = resolveOpenAiKey({ OPENAI_API_KEY: 'sk-env', GPT_LIVE_KEYCHAIN_SERVICE: 'nanoclaw-openai' }, () => {
      calls += 1;
      return 'sk-keychain';
    });
    expect(r).toEqual({ key: 'sk-env', source: 'env' });
    expect(calls).toBe(0);
  });

  it('reads the named Keychain item for the named account', () => {
    const calls: Array<[string, string]> = [];
    const r = resolveOpenAiKey(
      { GPT_LIVE_KEYCHAIN_SERVICE: 'nanoclaw-openai', GPT_LIVE_KEYCHAIN_ACCOUNT: 'ethan' },
      (service, account) => {
        calls.push([service, account]);
        return 'sk-keychain\n';
      },
    );
    expect(r).toEqual({ key: 'sk-keychain\n', source: 'keychain' });
    expect(calls).toEqual([['nanoclaw-openai', 'ethan']]);
  });

  it('is null when nothing is configured, the item is empty, or the lookup fails', () => {
    expect(resolveOpenAiKey({}, () => 'unused')).toBeNull();
    expect(resolveOpenAiKey({ GPT_LIVE_KEYCHAIN_SERVICE: 's' }, () => '')).toBeNull();
    expect(
      resolveOpenAiKey({ GPT_LIVE_KEYCHAIN_SERVICE: 's' }, () => {
        throw new Error('security: The specified item could not be found in the keychain.');
      }),
    ).toBeNull();
  });
});
