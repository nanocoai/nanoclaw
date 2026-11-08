import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';
import './index.js';
import '../provider-contracts/index.js';
import { registerProviderMemorySessionHook } from '../provider-contracts/realize.js';
import { createProvider } from './factory.js';

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

    const provider = createProvider('claude');
    registerProviderMemorySessionHook('claude', provider, MEMORY_SESSION_HOOK);
    registerProviderMemorySessionHook('claude', provider, MEMORY_SESSION_HOOK);

    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(settings.outputStyle).toBe('default');
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

  it.each([undefined, 'Explanatory', 'My chat style'])('seeds tone without replacing %j', (outputStyle) => {
    const settingsFile = path.join(configDir, 'settings.json');
    if (outputStyle !== undefined) fs.writeFileSync(settingsFile, JSON.stringify({ outputStyle }));
    const provider = createProvider('claude');
    registerProviderMemorySessionHook('claude', provider, MEMORY_SESSION_HOOK);
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8')).outputStyle).toBe(outputStyle ?? 'default');

    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, outputStyle: 'Learning' }));
    registerProviderMemorySessionHook('claude', provider, MEMORY_SESSION_HOOK);
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8')).outputStyle).toBe('Learning');
  });

  it('leaves a FIFO settings.json alone instead of blocking on it', () => {
    const settingsFile = path.join(configDir, 'settings.json');
    expect(Bun.spawnSync(['mkfifo', settingsFile]).exitCode).toBe(0);
    // In a child with a deadline: a blocking open would hang this process,
    // where a test timeout cannot interrupt it.
    const src = path.resolve(import.meta.dir, '..');
    const modules = ['modules/index.ts', 'providers/index.ts', 'provider-contracts/index.ts'];
    const script = `
      ${modules.map((m) => `import ${JSON.stringify(path.join(src, m))};`).join('\n')}
      import { MEMORY_SESSION_HOOK } from ${JSON.stringify(path.join(src, 'memory/session-hook.ts'))};
      import { registerProviderMemorySessionHook } from ${JSON.stringify(path.join(src, 'provider-contracts/realize.ts'))};
      import { createProvider } from ${JSON.stringify(path.join(src, 'providers/factory.ts'))};
      registerProviderMemorySessionHook('claude', createProvider('claude'), MEMORY_SESSION_HOOK);
      console.log('returned');
    `;
    const child = Bun.spawnSync([process.execPath, '-e', script], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      timeout: 10_000,
    });
    expect(child.signalCode ?? null).toBeNull();
    expect(child.stdout.toString()).toContain('returned');
    expect(child.stderr.toString()).toContain('not a regular file');
    expect(fs.lstatSync(settingsFile).isFIFO()).toBe(true);
  });

  it('leaves a symlinked settings.json and its target alone', () => {
    const target = path.join(configDir, 'elsewhere.json');
    fs.writeFileSync(target, '{"keep":true}');
    const settingsFile = path.join(configDir, 'settings.json');
    fs.symlinkSync(target, settingsFile);
    registerProviderMemorySessionHook('claude', createProvider('claude'), MEMORY_SESSION_HOOK);
    expect(fs.lstatSync(settingsFile).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"keep":true}');
  });

  it('leaves a directory at settings.json alone', () => {
    const settingsFile = path.join(configDir, 'settings.json');
    fs.mkdirSync(settingsFile);
    registerProviderMemorySessionHook('claude', createProvider('claude'), MEMORY_SESSION_HOOK);
    expect(fs.statSync(settingsFile).isDirectory()).toBe(true);
  });

  it('does not rewrite settings.json when nothing changed', () => {
    const settingsFile = path.join(configDir, 'settings.json');
    const provider = createProvider('claude');
    registerProviderMemorySessionHook('claude', provider, MEMORY_SESSION_HOOK);
    fs.utimesSync(settingsFile, 0, 0);
    registerProviderMemorySessionHook('claude', provider, MEMORY_SESSION_HOOK);
    expect(fs.statSync(settingsFile).mtimeMs).toBe(0);
    expect(fs.readdirSync(configDir)).toEqual(['settings.json']);
  });
});
