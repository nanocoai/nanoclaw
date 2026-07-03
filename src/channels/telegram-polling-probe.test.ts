/**
 * Unit tests for the Telegram polling-collision probe.
 *
 * Covers detection of HTTP 409 from `getUpdates`, the three error-shape
 * heuristics in `isTelegramPollingCollision`, and the probe's
 * fail-fast-on-409 / fail-soft-on-network behaviour.
 */
import { describe, expect, it } from 'vitest';

import {
  classifyProbeResponse,
  isTelegramPollingCollision,
  probeBotPollingFreedom,
  TelegramPollingCollisionError,
  withSetupRetry,
} from './telegram-polling-probe.js';

function makeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('classifyProbeResponse', () => {
  it('returns null for 200 OK', () => {
    expect(classifyProbeResponse(200, { ok: true, result: [] })).toBeNull();
  });

  it('returns null for non-409 errors', () => {
    expect(classifyProbeResponse(401, { ok: false, description: 'Unauthorized' })).toBeNull();
    expect(classifyProbeResponse(500, { ok: false })).toBeNull();
  });

  it('returns a TelegramPollingCollisionError for 409 with description', () => {
    const err = classifyProbeResponse(409, {
      ok: false,
      error_code: 409,
      description: 'Conflict: terminated by other getUpdates request',
    });
    expect(err).toBeInstanceOf(TelegramPollingCollisionError);
    expect(err!.description).toContain('Conflict');
    expect(err!.message).toMatch(/another client/i);
  });

  it('returns a TelegramPollingCollisionError for 409 with no body', () => {
    const err = classifyProbeResponse(409, null);
    expect(err).toBeInstanceOf(TelegramPollingCollisionError);
    // Falls back to a generic description so the caller still gets a
    // meaningful message.
    expect(err!.description).toMatch(/conflict/i);
  });
});

describe('isTelegramPollingCollision', () => {
  it('recognises our own collision error class', () => {
    const err = new TelegramPollingCollisionError('Conflict: terminated by other getUpdates request');
    expect(isTelegramPollingCollision(err)).toBe(true);
  });

  it('recognises a chat-adapter ValidationError that carries the Telegram description', () => {
    // Shape mirrors @chat-adapter/shared's ValidationError: a plain Error
    // with a Telegram-like message.
    const err = new Error('Conflict: terminated by other getUpdates request');
    expect(isTelegramPollingCollision(err)).toBe(true);
  });

  it('recognises a generic error mentioning 409 and telegram', () => {
    const err = new Error('Telegram API getUpdates failed (status 409, error 409)');
    expect(isTelegramPollingCollision(err)).toBe(true);
  });

  it('does NOT match generic transient network errors', () => {
    const err = new Error('NetworkError: Network error calling Telegram getUpdates');
    expect(isTelegramPollingCollision(err)).toBe(false);
  });

  it('does NOT match a non-Telegram conflict (e.g. some other 409)', () => {
    const err = new Error('Conflict on resource X');
    expect(isTelegramPollingCollision(err)).toBe(false);
  });

  it('does NOT match a 401 / auth error', () => {
    const err = new Error('Telegram API getMe failed (status 401)');
    expect(isTelegramPollingCollision(err)).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isTelegramPollingCollision(undefined)).toBe(false);
    expect(isTelegramPollingCollision(null)).toBe(false);
    expect(isTelegramPollingCollision('Conflict: terminated by other getUpdates request')).toBe(false);
    expect(isTelegramPollingCollision({ message: 'Conflict' })).toBe(false);
  });
});

describe('probeBotPollingFreedom', () => {
  it('resolves silently when Telegram returns 200 with an empty update list', async () => {
    const fetchMock = async () => makeResponse(200, { ok: true, result: [] });
    await expect(probeBotPollingFreedom('test-token', fetchMock as typeof fetch)).resolves.toBeUndefined();
  });

  it('throws TelegramPollingCollisionError on a 409 response', async () => {
    const fetchMock = async () =>
      makeResponse(409, {
        ok: false,
        error_code: 409,
        description: 'Conflict: terminated by other getUpdates request',
      });
    await expect(probeBotPollingFreedom('test-token', fetchMock as typeof fetch)).rejects.toThrow(
      TelegramPollingCollisionError,
    );
  });

  it('the thrown error includes the conflict description and a fix hint', async () => {
    const fetchMock = async () =>
      makeResponse(409, {
        ok: false,
        description: 'Conflict: terminated by other getUpdates request',
      });
    let caught: unknown;
    try {
      await probeBotPollingFreedom('test-token', fetchMock as typeof fetch);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TelegramPollingCollisionError);
    const tpe = caught as TelegramPollingCollisionError;
    expect(tpe.description).toContain('Conflict');
    expect(tpe.message).toMatch(/duplicate NanoClaw host|another process polling/i);
  });

  it('handles a 409 with non-JSON body without crashing — still throws collision', async () => {
    const fetchMock = async () =>
      new Response('<html>some HTML error page</html>', {
        status: 409,
        headers: { 'Content-Type': 'text/html' },
      });
    await expect(probeBotPollingFreedom('test-token', fetchMock as typeof fetch)).rejects.toThrow(
      TelegramPollingCollisionError,
    );
  });

  it('does NOT throw on transient network failures — lets bridge.setup handle them', async () => {
    const fetchMock = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(probeBotPollingFreedom('test-token', fetchMock as typeof fetch)).resolves.toBeUndefined();
  });

  it('does NOT throw on non-409 HTTP errors — bridge.setup will surface auth/etc with proper context', async () => {
    const fetchMock = async () => makeResponse(401, { ok: false, description: 'Unauthorized' });
    await expect(probeBotPollingFreedom('test-token', fetchMock as typeof fetch)).resolves.toBeUndefined();
  });

  it('sends getUpdates with timeout=0 and offset=-1 (avoids consuming in-flight updates)', async () => {
    let capturedBody: unknown;
    const fetchMock = async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return makeResponse(200, { ok: true, result: [] });
    };
    await probeBotPollingFreedom('test-token', fetchMock as typeof fetch);
    expect(capturedBody).toEqual({ timeout: 0, offset: -1 });
  });

  it('targets the correct Telegram API URL with the bot token', async () => {
    let capturedUrl = '';
    const fetchMock = async (url: string) => {
      capturedUrl = url;
      return makeResponse(200, { ok: true, result: [] });
    };
    await probeBotPollingFreedom('SECRET-TOKEN', fetchMock as typeof fetch);
    expect(capturedUrl).toBe('https://api.telegram.org/botSECRET-TOKEN/getUpdates');
  });
});

describe('withSetupRetry', () => {
  // Pass a no-op sleep so the retry tests don't burn real time.
  const noSleep = async () => {};

  it('returns the value on first-try success', async () => {
    let calls = 0;
    const result = await withSetupRetry(
      async () => {
        calls++;
        return 'ok';
      },
      'test',
      { sleep: noSleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries on transient errors and eventually succeeds', async () => {
    let calls = 0;
    const result = await withSetupRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('transient blip');
        return 'recovered';
      },
      'test',
      { sleep: noSleep },
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('throws the last error after exhausting retries', async () => {
    let calls = 0;
    let caught: unknown;
    try {
      await withSetupRetry(
        async () => {
          calls++;
          throw new Error(`attempt ${calls} failed`);
        },
        'test',
        { sleep: noSleep, maxAttempts: 3 },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('attempt 3 failed');
    expect(calls).toBe(3);
  });

  it('fails fast on a polling-collision error — no retry, no backoff', async () => {
    let calls = 0;
    let caught: unknown;
    try {
      await withSetupRetry(
        async () => {
          calls++;
          throw new TelegramPollingCollisionError('Conflict: terminated by other getUpdates request');
        },
        'test',
        { sleep: noSleep, maxAttempts: 5 },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TelegramPollingCollisionError);
    // Critical: did NOT retry. A 409 won't recover by waiting.
    expect(calls).toBe(1);
  });

  it('also fails fast when the SDK reports a 409 as a generic Conflict error', async () => {
    let calls = 0;
    let caught: unknown;
    try {
      await withSetupRetry(
        async () => {
          calls++;
          // The chat-adapter SDK's ValidationError on 409 carries this
          // description from Telegram. We detect by message shape.
          throw new Error('Conflict: terminated by other getUpdates request');
        },
        'test',
        { sleep: noSleep, maxAttempts: 5 },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(calls).toBe(1);
  });

  it('uses the provided sleep — confirming exponential backoff is delegated, not hard-coded', async () => {
    const delays: number[] = [];
    const recordingSleep = async (ms: number) => {
      delays.push(ms);
    };
    let calls = 0;
    let caught: unknown;
    try {
      await withSetupRetry(
        async () => {
          calls++;
          throw new Error('always fails');
        },
        'test',
        { sleep: recordingSleep, maxAttempts: 4 },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(calls).toBe(4);
    // 3 sleeps between 4 attempts: 1000, 2000, 4000 (capped at 16000).
    expect(delays).toEqual([1000, 2000, 4000]);
  });
});
