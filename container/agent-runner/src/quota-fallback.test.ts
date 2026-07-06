/**
 * Tests for the quota-fallback flow: quota-error detection and the
 * single-turn fallback runner that retries an unanswered prompt on the
 * overflow provider.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getContinuation, isQuotaDegraded, setQuotaDegraded } from './db/session-state.js';
import { isGenuineQuotaError, isTransientLimit, QuotaExhaustedError } from './quota.js';
import { runFallbackTurn } from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';
import type { Database } from 'bun:sqlite';

const ROUTING = {
  platformId: 'whatsapp:123',
  channelType: 'whatsapp',
  threadId: null,
  inReplyTo: null,
};

let inbound: Database;

beforeEach(() => {
  ({ inbound } = initTestSessionDb());
  inbound
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
       VALUES ('user', 'User', 'channel', 'whatsapp', 'whatsapp:123')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

/** Minimal scripted provider: plays a fixed event sequence per query. */
function scriptedProvider(events: ProviderEvent[], onQuery?: (input: QueryInput) => void): AgentProvider {
  return {
    supportsNativeSlashCommands: false,
    isSessionInvalid: () => false,
    query(input: QueryInput): AgentQuery {
      onQuery?.(input);
      let ended = false;
      return {
        push() {},
        end() {
          ended = true;
        },
        abort() {
          ended = true;
        },
        events: (async function* () {
          for (const e of events) {
            if (ended) return;
            yield e;
          }
        })(),
      };
    },
  };
}

describe('isGenuineQuotaError', () => {
  it('matches genuine, durable usage/credit exhaustion', () => {
    expect(isGenuineQuotaError('Claude AI usage limit reached|1783240000')).toBe(true);
    expect(isGenuineQuotaError('Your credit balance is too low to access the API')).toBe(true);
    expect(isGenuineQuotaError('quota exceeded for this billing period')).toBe(true);
    // Confirmed live on daniela's server 2026-07-06 — this is what a
    // subscription session-limit hit actually looks like, and it arrives
    // as a normal (non-error) result, not an SDK error.
    expect(isGenuineQuotaError("You've hit your session limit · resets 7:30am (UTC)")).toBe(true);
  });

  it('does NOT treat transient throttling as genuine exhaustion (Defect 1)', () => {
    // These are the false-positive shapes that tripped the fallback at 63%
    // usage right after a restart. They are transient — the SDK retries them.
    expect(isGenuineQuotaError('429 {"type":"rate_limit_error"}')).toBe(false);
    expect(isGenuineQuotaError('Server is temporarily limiting requests')).toBe(false);
    expect(isGenuineQuotaError('{"type":"overloaded_error"}')).toBe(false);
    expect(isGenuineQuotaError('529 Server overloaded')).toBe(false);
  });

  it('does not match unrelated errors', () => {
    expect(isGenuineQuotaError('No conversation found with session ID abc')).toBe(false);
    expect(isGenuineQuotaError('fetch failed: ETIMEDOUT')).toBe(false);
    expect(isGenuineQuotaError('Claude Code process exited with code 1')).toBe(false);
  });
});

describe('isTransientLimit', () => {
  it('recognises transient throttles that must NOT switch providers', () => {
    expect(isTransientLimit('429 {"type":"rate_limit_error"}')).toBe(true);
    expect(isTransientLimit('Server is temporarily limiting requests')).toBe(true);
    expect(isTransientLimit('{"type":"overloaded_error"}')).toBe(true);
    expect(isTransientLimit('529 Server overloaded')).toBe(true);
  });

  it('genuine exhaustion is not classified as transient', () => {
    expect(isTransientLimit('Claude AI usage limit reached|1783240000')).toBe(false);
    expect(isTransientLimit("You've hit your session limit · resets 7:30am (UTC)")).toBe(false);
  });

  it('ordinary text is neither transient nor genuine', () => {
    expect(isTransientLimit('here is your answer')).toBe(false);
    expect(isGenuineQuotaError('here is your answer')).toBe(false);
  });
});

describe('QuotaExhaustedError', () => {
  it('carries the unanswered prompt for the fallback retry', () => {
    const err = new QuotaExhaustedError('usage limit reached', '<messages>hello</messages>');
    expect(err.lastPrompt).toBe('<messages>hello</messages>');
    expect(err.name).toBe('QuotaExhaustedError');
  });
});

describe('quota-degraded flag (notice de-dup)', () => {
  it('defaults to not-degraded for a brand-new session', () => {
    expect(isQuotaDegraded()).toBe(false);
  });

  it('round-trips true/false through the session_state store', () => {
    // Models the first quota hit: set the flag so subsequent quota hits in
    // the same outage suppress the notice (switch-to-Codex or no-fallback).
    setQuotaDegraded(true);
    expect(isQuotaDegraded()).toBe(true);

    // Models recovery: a successful primary turn clears the flag so the
    // recovery notice fires exactly once.
    setQuotaDegraded(false);
    expect(isQuotaDegraded()).toBe(false);
  });
});

describe('runFallbackTurn', () => {
  const fallbackOf = (p: AgentProvider) => ({ provider: p, providerName: 'codex' });

  it('delivers the fallback result and persists the fallback continuation', async () => {
    const provider = scriptedProvider([
      { type: 'init', continuation: 'codex-thread-1' },
      { type: 'result', text: '<message to="user">תשובה ממנוע הגיבוי</message>' },
    ]);

    await runFallbackTurn(fallbackOf(provider), 'prompt-text', ROUTING, '/workspace/agent');

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('תשובה ממנוע הגיבוי');
    expect(getContinuation('codex')).toBe('codex-thread-1');
  });

  it('resumes the fallback conversation from its own stored continuation', async () => {
    let seenContinuation: string | undefined;
    const provider = scriptedProvider(
      [
        { type: 'init', continuation: 'codex-thread-2' },
        { type: 'result', text: '<message to="user">ok</message>' },
      ],
      (input) => {
        seenContinuation = input.continuation;
      },
    );

    // First turn stores the continuation; second turn must receive it.
    await runFallbackTurn(fallbackOf(provider), 'first', ROUTING, '/workspace/agent');
    await runFallbackTurn(fallbackOf(provider), 'second', ROUTING, '/workspace/agent');
    expect(seenContinuation).toBe('codex-thread-2');
  });

  it('throws when the fallback provider is also out of quota', async () => {
    const provider = scriptedProvider([
      { type: 'error', message: '429 rate limit', retryable: false, classification: 'quota' },
    ]);

    await expect(runFallbackTurn(fallbackOf(provider), 'prompt', ROUTING, '/workspace/agent')).rejects.toThrow(
      /quota exhausted/i,
    );
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('throws when the fallback stream ends without any result', async () => {
    const provider = scriptedProvider([{ type: 'init', continuation: 'x' }]);

    await expect(runFallbackTurn(fallbackOf(provider), 'prompt', ROUTING, '/workspace/agent')).rejects.toThrow(
      /no result/i,
    );
  });

  it('times out and aborts a stuck fallback turn (Defect 2)', async () => {
    // Provider that emits init then hangs forever — models the wedged Codex
    // app-server (hung thread-resume / a turn that never streams a result).
    let released = false;
    let releaseAbort: () => void = () => {};
    const hung = new Promise<void>((r) => {
      releaseAbort = r;
    });
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(): AgentQuery {
        return {
          push() {},
          end() {},
          abort() {
            released = true;
            releaseAbort();
          },
          events: (async function* () {
            yield { type: 'init', continuation: 'stuck' } as ProviderEvent;
            await hung; // only resolves when abort() is called
          })(),
        };
      },
    };

    process.env.FALLBACK_TURN_DEADLINE_MS = '150';
    try {
      await expect(runFallbackTurn(fallbackOf(provider), 'prompt', ROUTING, '/workspace/agent')).rejects.toThrow(
        /timed out/i,
      );
    } finally {
      delete process.env.FALLBACK_TURN_DEADLINE_MS;
    }
    // The deadline must have driven a clean abort of the provider.
    expect(released).toBe(true);
  });
});
