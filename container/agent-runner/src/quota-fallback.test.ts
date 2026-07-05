/**
 * Tests for the quota-fallback flow: quota-error detection and the
 * single-turn fallback runner that retries an unanswered prompt on the
 * overflow provider.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getContinuation } from './db/session-state.js';
import { isQuotaErrorMessage, QuotaExhaustedError } from './quota.js';
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

describe('isQuotaErrorMessage', () => {
  it('matches real quota/limit error shapes', () => {
    expect(isQuotaErrorMessage('Claude AI usage limit reached|1783240000')).toBe(true);
    expect(isQuotaErrorMessage('429 {"type":"rate_limit_error"}')).toBe(true);
    expect(isQuotaErrorMessage('Your credit balance is too low to access the API')).toBe(true);
    expect(isQuotaErrorMessage('quota exceeded for this billing period')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isQuotaErrorMessage('No conversation found with session ID abc')).toBe(false);
    expect(isQuotaErrorMessage('fetch failed: ETIMEDOUT')).toBe(false);
    expect(isQuotaErrorMessage('Claude Code process exited with code 1')).toBe(false);
  });
});

describe('QuotaExhaustedError', () => {
  it('carries the unanswered prompt for the fallback retry', () => {
    const err = new QuotaExhaustedError('usage limit reached', '<messages>hello</messages>');
    expect(err.lastPrompt).toBe('<messages>hello</messages>');
    expect(err.name).toBe('QuotaExhaustedError');
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
});
