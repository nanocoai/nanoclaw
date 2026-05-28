import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock readEnvFile BEFORE importing transcription so the cached singleton
// inside transcription.ts sees a controlled stub. The .env file in the
// project root contains a real OPENAI_API_KEY which would otherwise leak
// into tests that try to assert the missing-key branch.
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

import {
  TranscriptionError,
  isTranscribableMime,
  resetTranscriptionCacheForTests,
  transcribeAudio,
} from './transcription.js';

const ORIGINAL_KEY = process.env.OPENAI_API_KEY;

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'sk-test-key';
  resetTranscriptionCacheForTests();
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
  resetTranscriptionCacheForTests();
});

function fakeJsonResponse(body: unknown, ok: boolean = true, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: ok ? 'OK' : 'Bad',
    headers: { 'content-type': 'application/json' },
  });
}

describe('isTranscribableMime', () => {
  it('accepts audio/*', () => {
    expect(isTranscribableMime('audio/ogg')).toBe(true);
    expect(isTranscribableMime('audio/mpeg')).toBe(true);
    expect(isTranscribableMime('AUDIO/WAV')).toBe(true);
  });

  it('accepts video/mp4 and video/webm (chat-platform voice variants)', () => {
    expect(isTranscribableMime('video/mp4')).toBe(true);
    expect(isTranscribableMime('video/webm')).toBe(true);
  });

  it('rejects unknown / undefined / image / pdf mime types', () => {
    expect(isTranscribableMime(undefined)).toBe(false);
    expect(isTranscribableMime('')).toBe(false);
    expect(isTranscribableMime('image/png')).toBe(false);
    expect(isTranscribableMime('application/pdf')).toBe(false);
    expect(isTranscribableMime('text/plain')).toBe(false);
  });
});

describe('transcribeAudio', () => {
  it('throws TranscriptionError(no-key) when OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    resetTranscriptionCacheForTests();
    await expect(
      transcribeAudio(Buffer.from('audio'), 'voice.ogg', 'audio/ogg', {
        fetchImpl: async () => fakeJsonResponse({ text: 'never' }),
      }),
    ).rejects.toMatchObject({ kind: 'no-key' });
  });

  it('throws TranscriptionError(too-large) for empty buffers', async () => {
    await expect(
      transcribeAudio(Buffer.alloc(0), 'voice.ogg', 'audio/ogg', {
        fetchImpl: async () => fakeJsonResponse({ text: 'never' }),
      }),
    ).rejects.toMatchObject({ kind: 'too-large' });
  });

  it('throws TranscriptionError(too-large) for over-cap buffers', async () => {
    const big = Buffer.alloc(25 * 1024 * 1024 + 1, 0xab); // 24MB+1, over cap
    await expect(
      transcribeAudio(big, 'voice.ogg', 'audio/ogg', {
        fetchImpl: async () => fakeJsonResponse({ text: 'never' }),
      }),
    ).rejects.toMatchObject({ kind: 'too-large' });
  });

  it('returns the parsed text on a 200 OK response', async () => {
    let captured: string | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      captured = typeof input === 'string' ? input : ((input as URL).toString?.() ?? '');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-test-key');
      return fakeJsonResponse({ text: '  hello there  ' });
    };
    const out = await transcribeAudio(Buffer.from('audio'), 'voice.ogg', 'audio/ogg', { fetchImpl });
    expect(out.text).toBe('hello there');
    expect(captured).toContain('/audio/transcriptions');
  });

  it('throws TranscriptionError(http) on non-OK response', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' });
    const promise = transcribeAudio(Buffer.from('audio'), 'voice.ogg', 'audio/ogg', { fetchImpl });
    await expect(promise).rejects.toMatchObject({ kind: 'http' });
    await promise.catch((e: TranscriptionError) => {
      expect(e.message).toContain('429');
    });
  });

  it('throws TranscriptionError(network) when fetch itself rejects', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('connection reset');
    };
    await expect(transcribeAudio(Buffer.from('audio'), 'voice.ogg', 'audio/ogg', { fetchImpl })).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('throws TranscriptionError(malformed-response) when JSON has no "text" field', async () => {
    const fetchImpl: typeof fetch = async () => fakeJsonResponse({ other: 'data' });
    await expect(transcribeAudio(Buffer.from('audio'), 'voice.ogg', 'audio/ogg', { fetchImpl })).rejects.toMatchObject({
      kind: 'malformed-response',
    });
  });

  it('throws TranscriptionError(malformed-response) when text is empty', async () => {
    const fetchImpl: typeof fetch = async () => fakeJsonResponse({ text: '   ' });
    await expect(transcribeAudio(Buffer.from('audio'), 'voice.ogg', 'audio/ogg', { fetchImpl })).rejects.toMatchObject({
      kind: 'malformed-response',
    });
  });
});
