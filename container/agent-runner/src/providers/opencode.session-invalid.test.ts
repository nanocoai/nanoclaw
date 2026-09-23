import { describe, it, expect } from 'bun:test';

import { OpenCodeProvider, isUnusableHistoryError } from './opencode.js';

/**
 * A session whose stored history the model refuses is dead, not slow. The
 * runner only drops a continuation when the provider says the session is
 * invalid, so without this the same rejected payload is rebuilt every turn and
 * the session never answers again.
 */

// Gemini's rejection, verbatim from a live 400.
const TURN_ORDERING =
  'Please ensure that function call turn comes immediately after a user turn or after a function response turn.';

describe('isUnusableHistoryError', () => {
  it('matches the turn-ordering rejection', () => {
    expect(isUnusableHistoryError(new Error(TURN_ORDERING))).toBe(true);
    // Wording varies between the two phrasings Google has shipped.
    expect(isUnusableHistoryError(new Error('function call turn must come immediately after a user turn'))).toBe(true);
    // Non-Error inputs reach this path too (rejected strings, thrown objects).
    expect(isUnusableHistoryError(TURN_ORDERING)).toBe(true);
  });

  it('does NOT match unrelated failures', () => {
    // Narrowness is the point: a good continuation carries the user's whole
    // in-context history, so only a provably unrecoverable history may clear it.
    expect(isUnusableHistoryError(new Error('400 Bad Request: invalid argument'))).toBe(false);
    expect(isUnusableHistoryError(new Error('rate limit exceeded'))).toBe(false);
    expect(isUnusableHistoryError(new Error('function calling is not supported by this model'))).toBe(false);
    expect(isUnusableHistoryError(undefined)).toBe(false);
  });
});

describe('OpenCodeProvider.isSessionInvalid', () => {
  const provider = new OpenCodeProvider();

  it('reports an unusable history as invalid so the runner starts fresh', () => {
    expect(provider.isSessionInvalid(new Error(TURN_ORDERING))).toBe(true);
  });

  it('still reports the pre-existing stale-session shapes', () => {
    expect(provider.isSessionInvalid(new Error('session not found'))).toBe(true);
    expect(provider.isSessionInvalid(new Error('ECONNRESET'))).toBe(true);
  });

  it('keeps the continuation for an ordinary failure', () => {
    expect(provider.isSessionInvalid(new Error('model returned an empty response'))).toBe(false);
  });
});
