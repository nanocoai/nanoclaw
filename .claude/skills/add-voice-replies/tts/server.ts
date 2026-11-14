/**
 * Voice-reply MCP server. Registered per agent group with `ncl groups config
 * add-mcp-server`; its env carries the group's TTS settings. The tool writes
 * an audio file and returns its path; delivery stays with the core
 * `send_file` tool, so every channel that accepts files can carry it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { getTtsProvider } from './index.js';

const EXTENSIONS: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
  'audio/pcm': 'pcm',
};

export interface SpeechFile {
  path: string;
  mimeType: string;
  bytes: number;
}

export async function synthesizeToFile(
  input: { text: string; voice?: string },
  env: Record<string, string | undefined> = process.env,
): Promise<SpeechFile> {
  const text = input.text.trim();
  if (!text) throw new Error('text is required');

  const provider = getTtsProvider(env.TTS_PROVIDER || 'espeak');
  const audio = await provider.synthesize({
    text,
    voice: input.voice || env.TTS_VOICE || undefined,
    model: env.TTS_MODEL || undefined,
    baseUrl: env.TTS_BASE_URL || undefined,
    language: env.TTS_LANGUAGE || undefined,
    format: env.TTS_FORMAT || undefined,
  });
  if (audio.data.byteLength === 0) throw new Error('TTS provider returned no audio');

  const dir = env.TTS_OUTPUT_DIR || path.join(os.tmpdir(), 'voice-replies');
  fs.mkdirSync(dir, { recursive: true });
  const ext = EXTENSIONS[audio.mimeType] ?? 'audio';
  const file = path.join(dir, `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  fs.writeFileSync(file, audio.data);
  return { path: file, mimeType: audio.mimeType, bytes: audio.data.byteLength };
}

export function createVoiceServer(env: Record<string, string | undefined> = process.env): McpServer {
  const server = new McpServer(
    { name: 'voice', version: '1.0.0' },
    {
      instructions:
        'When the user asks for a spoken or voice reply, call synthesize_speech with the reply text, ' +
        'then deliver the returned path with mcp__nanoclaw__send_file to the same destination.',
    },
  );

  server.tool(
    'synthesize_speech',
    'Turn text into a spoken audio file and return its path. Send the file with mcp__nanoclaw__send_file. ' +
      'Pass `voice` only to override the configured voice (for espeak: a language code such as "en" or "de").',
    {
      text: z.string().describe('The words to speak.'),
      voice: z.string().optional().describe('Optional voice override.'),
    },
    async ({ text, voice }) => {
      try {
        const out = await synthesizeToFile({ text, voice }, env);
        return {
          content: [
            { type: 'text' as const, text: `Speech saved to ${out.path} (${out.mimeType}, ${out.bytes} bytes)` },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

if (import.meta.main) {
  await createVoiceServer().connect(new StdioServerTransport());
}
