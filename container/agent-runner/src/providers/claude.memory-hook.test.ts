import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';
import { ClaudeProvider } from './claude.js';

let configDir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-memory-hook-'));
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('Claude memory SessionStart registration', () => {
  it('writes the shared command once without disturbing other hooks', () => {
    const settingsFile = path.join(configDir, 'settings.json');
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        customValue: 'preserved',
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'custom-stop' }] }],
          SessionStart: [
            { matcher: 'resume', hooks: [{ type: 'command', command: 'custom-resume' }] },
            {
              matcher: '.*',
              hooks: [
                { type: 'command', command: 'bun /app/src/memory-hook.ts' },
                { type: 'command', command: 'custom-start' },
              ],
            },
          ],
        },
      }),
    );

    const provider = new ClaudeProvider();
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(settings.customValue).toBe('preserved');
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'custom-stop' }] }]);
    expect(settings.hooks.SessionStart).toEqual([
      { matcher: 'resume', hooks: [{ type: 'command', command: 'custom-resume' }] },
      { matcher: '.*', hooks: [{ type: 'command', command: 'custom-start' }] },
      {
        matcher: 'startup|clear|compact',
        hooks: [{ type: 'command', command: 'bun /app/src/memory/hook.ts', timeout: 10 }],
      },
    ]);
  });
});
