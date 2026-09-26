/**
 * Drives the real MCP server entry over stdio, the way the agent's provider
 * spawns it after `ncl groups config add-mcp-server`, against a fake speech
 * endpoint. Also pins the request shapes the HTTP providers send.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { espeakArgs } from './espeak.js';
import { getTtsProvider } from './index.js';

const AUDIO = new Uint8Array([79, 103, 103, 83, 1, 2, 3, 4]);

interface Seen {
  path: string;
  search: string;
  body: Record<string, unknown>;
}

let seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;
let baseUrl = '';
let outDir = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, search: url.search, body: (await req.json()) as Record<string, unknown> });
      if (url.pathname.endsWith('/fail/audio/speech')) return new Response('quota exceeded', { status: 429 });
      return new Response(AUDIO, { headers: { 'content-type': 'audio/ogg' } });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-server-test-'));
});

afterAll(() => {
  server.stop(true);
  fs.rmSync(outDir, { recursive: true, force: true });
});

async function connect(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['run', path.join(import.meta.dir, 'server.ts')],
    env: { PATH: process.env.PATH ?? '', ...env },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'voice-server-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

describe('voice MCP server', () => {
  it('lists synthesize_speech and writes the provider audio to a file', async () => {
    seen = [];
    const client = await connect({
      TTS_PROVIDER: 'openai',
      TTS_BASE_URL: `${baseUrl}/v1`,
      TTS_MODEL: 'local-model',
      TTS_VOICE: 'narrator',
      TTS_FORMAT: 'opus',
      TTS_OUTPUT_DIR: outDir,
    });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('synthesize_speech');

      const result = await client.callTool({ name: 'synthesize_speech', arguments: { text: 'hello there' } });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ text: string }>)[0].text;
      const file = /saved to (\S+)/.exec(text)?.[1];
      expect(file).toBeDefined();
      expect(file!.startsWith(outDir)).toBe(true);
      expect(file!.endsWith('.ogg')).toBe(true);
      expect(new Uint8Array(fs.readFileSync(file!))).toEqual(AUDIO);

      expect(seen).toEqual([
        {
          path: '/v1/audio/speech',
          search: '',
          body: { model: 'local-model', voice: 'narrator', input: 'hello there', response_format: 'opus' },
        },
      ]);
    } finally {
      await client.close();
    }
  });

  it('lets a call override the configured voice', async () => {
    seen = [];
    const client = await connect({ TTS_PROVIDER: 'openai', TTS_BASE_URL: `${baseUrl}/v1`, TTS_OUTPUT_DIR: outDir });
    try {
      await client.callTool({ name: 'synthesize_speech', arguments: { text: 'hi', voice: 'other' } });
      expect(seen[0].body.voice).toBe('other');
    } finally {
      await client.close();
    }
  });

  it('returns a tool error instead of failing the server', async () => {
    const client = await connect({ TTS_PROVIDER: 'openai', TTS_BASE_URL: `${baseUrl}/fail`, TTS_OUTPUT_DIR: outDir });
    try {
      const result = await client.callTool({ name: 'synthesize_speech', arguments: { text: 'hi' } });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toContain('429');
    } finally {
      await client.close();
    }
  });
});

describe('provider request shapes', () => {
  it('elevenlabs posts to the voice path with model, language and output format', async () => {
    seen = [];
    const audio = await getTtsProvider('elevenlabs').synthesize({
      text: 'hola',
      baseUrl,
      voice: 'voice-1',
      model: 'model-1',
      language: 'es',
      format: 'mp3_44100_128',
    });
    expect(audio.mimeType).toBe('audio/ogg');
    expect(seen).toEqual([
      {
        path: '/v1/text-to-speech/voice-1',
        search: '?output_format=mp3_44100_128',
        body: { text: 'hola', model_id: 'model-1', language_code: 'es' },
      },
    ]);
  });

  it('espeak uses the voice, then the language, then English', () => {
    expect(espeakArgs({ text: 'x', voice: 'de', language: 'fr' })).toEqual(['--stdout', '-v', 'de', 'x']);
    expect(espeakArgs({ text: 'x', language: 'fr' })).toEqual(['--stdout', '-v', 'fr', 'x']);
    expect(espeakArgs({ text: 'x' })).toEqual(['--stdout', '-v', 'en', 'x']);
  });
});
