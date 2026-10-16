import fs from 'fs';
import os from 'os';
import path from 'path';

import { createGoogleChatAdapter } from '@chat-adapter/gchat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelRegistration } from './adapter.js';

const registered = vi.hoisted(() => new Map<string, ChannelRegistration>());
vi.mock('./channel-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./channel-registry.js')>()),
  registerChannelAdapter: (name: string, registration: ChannelRegistration) => registered.set(name, registration),
}));

import './gchat.js';

const credentials = { client_email: 'nanoclaw@example.iam.gserviceaccount.com', private_key: 'unused' };

// The adapter falls back to these process.env names; clear them so only .env counts.
const ADAPTER_ENV = [
  'GOOGLE_CHAT_PROJECT_NUMBER',
  'GOOGLE_CHAT_PUBSUB_AUDIENCE',
  'GOOGLE_CHAT_DISABLE_SIGNATURE_VERIFICATION',
  'GOOGLE_CHAT_CREDENTIALS',
];

describe('gchat factory', () => {
  let dir: string;

  beforeEach(() => {
    for (const name of ADAPTER_ENV) vi.stubEnv(name, undefined);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-env-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeEnv(lines: string[]): void {
    fs.writeFileSync(path.join(dir, '.env'), lines.join('\n') + '\n');
  }

  it('adapter refuses to start with credentials alone', () => {
    expect(() => createGoogleChatAdapter({ credentials })).toThrow(/signature verification is required/);
  });

  it('starts when GOOGLE_CHAT_PROJECT_NUMBER is only in .env', async () => {
    writeEnv([`GCHAT_CREDENTIALS=${JSON.stringify(credentials)}`, 'GOOGLE_CHAT_PROJECT_NUMBER=123456789012']);
    const adapter = await registered.get('gchat')!.factory();
    expect(adapter?.channelType).toBe('gchat');
  });

  it('returns null without credentials', async () => {
    writeEnv(['GOOGLE_CHAT_PROJECT_NUMBER=123456789012']);
    expect(await registered.get('gchat')!.factory()).toBeNull();
  });
});
