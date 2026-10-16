/**
 * Registration guard: import only the real barrel and assert every provider
 * the skill documents is registered. Goes red when a barrel line is deleted
 * or a provider module stops evaluating.
 */
import { describe, expect, it } from 'bun:test';

import { getTtsProvider, listTtsProviders } from './index.js';

describe('tts barrel', () => {
  it('registers espeak, openai and elevenlabs', () => {
    expect(listTtsProviders()).toEqual(expect.arrayContaining(['espeak', 'openai', 'elevenlabs']));
  });

  it('names the registered providers when asked for an unknown one', () => {
    expect(() => getTtsProvider('nope')).toThrow(/Registered: .*espeak/);
  });
});
