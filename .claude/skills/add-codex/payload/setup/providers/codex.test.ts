import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

// Mock child_process so runCodexLoginAuth never spawns a real codex CLI; the
// spawn stand-in plays `codex login` writing auth.json into whatever
// CODEX_HOME it was handed.
const mockSpawn = vi.fn();
const mockSpawnSync = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// Keep the auth flow's structured logging out of logs/setup.log.
vi.mock('../logs.js', () => ({ step: vi.fn(), userInput: vi.fn() }));

import { buildCodexFailurePrompt, runCodexInstallCheck, runCodexLoginAuth, verifyCodexInstall } from './codex.js';

// Structural guard for the codex payload wiring: provider files, both barrel
// imports, and the pinned Dockerfile install. Goes red if any of them is
// removed without going through the /add-codex (or its REMOVE.md) path.
describe('verifyCodexInstall', () => {
  it('passes on a tree with the codex payload wired', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-complete-check-'));
    try {
      for (const file of [
        'src/providers/codex.ts',
        'src/providers/codex-agents-md.ts',
        'container/agent-runner/src/providers/codex.ts',
        'container/agent-runner/src/providers/codex-app-server.ts',
        'src/providers/index.ts',
        'container/agent-runner/src/providers/index.ts',
      ]) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "import './codex.js';\n");
      }
      fs.writeFileSync(path.join(root, 'container/cli-tools.json'), JSON.stringify([{ name: '@openai/codex' }]));
      expect(verifyCodexInstall(root)).toEqual({ ok: true, problems: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks setup when the payload is incomplete', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-install-check-'));
    try {
      await expect(runCodexInstallCheck(root)).rejects.toThrow(/Codex provider is not fully installed/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// Pure prompt builder for the failure-assist hook — no spawning involved.
describe('buildCodexFailurePrompt', () => {
  it('carries the failure context and the de-duped reference list', () => {
    const projectRoot = '/repo';
    const prompt = buildCodexFailurePrompt(
      {
        stepName: 'verify',
        msg: 'first-chat ping timed out',
        hint: 'check the container logs',
        rawLogPath: '/repo/logs/setup-steps/verify.log',
      },
      projectRoot,
    );

    expect(prompt).toContain('Failed step: verify');
    expect(prompt).toContain('Error: first-chat ping timed out');
    expect(prompt).toContain('Hint: check the container logs');
    expect(prompt).toContain('README.md'); // BIG_PICTURE_FILES
    expect(prompt).toContain('setup/verify.ts'); // STEP_FILES['verify']
    expect(prompt).toContain('logs/setup.log');
    expect(prompt).toContain('logs/setup-steps/verify.log'); // relativized rawLogPath
  });

  it('falls back to the step-log directory when no raw log path is given', () => {
    const prompt = buildCodexFailurePrompt({ stepName: 'verify', msg: 'boom' }, '/repo');
    expect(prompt).toContain('logs/setup-steps/');
    expect(prompt).not.toContain('Hint:');
  });
});

// Session-isolation invariant: the ChatGPT session vaulted for the gateway
// must never be the user's personal ~/.codex session — sharing one OAuth
// session across two consumers gets the whole family invalidated server-side
// when refresh tokens rotate (see the header of codex.ts).
describe('runCodexLoginAuth', () => {
  it('logs in under an isolated CODEX_HOME, vaults from it, and deletes it', async () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    mockExecFileSync.mockReturnValue('');

    let loginEnv: NodeJS.ProcessEnv | undefined;
    mockSpawn.mockImplementation((...args: unknown[]) => {
      const opts = args[2] as { env?: NodeJS.ProcessEnv };
      loginEnv = opts.env;
      fs.writeFileSync(path.join(opts.env!.CODEX_HOME!, 'auth.json'), '{"tokens":{}}');
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });

    const save = vi.fn(async (_provider, credential) => {
      expect(fs.existsSync(credential.file)).toBe(true);
    });
    await runCodexLoginAuth('browser', { has: async () => false, save });

    // The login spawn ran under a CODEX_HOME that is not the personal one.
    const codexHome = loginEnv?.CODEX_HOME;
    expect(codexHome).toBeDefined();
    expect(codexHome).not.toBe(path.join(os.homedir(), '.codex'));

    // The vault snapshot was read from the isolated dir, not ~/.codex.
    expect(save).toHaveBeenCalledWith('codex', { kind: 'oauth', file: path.join(codexHome!, 'auth.json') });

    // The isolated dir holds a live credential — gone once vaulted.
    expect(fs.existsSync(codexHome!)).toBe(false);
  });
});
