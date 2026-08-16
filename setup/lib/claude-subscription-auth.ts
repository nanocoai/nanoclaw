import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractClaudeOAuthToken } from './captured-token.js';
import { machineChildEnvironment, runInteractiveProcess } from './interactive-process.js';
import { registerSensitiveValue } from './redaction.js';
import { withSecretFile } from './secret-file.js';
import type { SetupDriver } from './setup-driver.js';

const PROVIDER_STREAM_BUFFER_BYTES = 64 * 1024;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const VAULT_TIMEOUT_MS = 2 * 60 * 1000;

export type ClaudeSubscriptionMachineResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'login_url_missing'
        | 'login_failed'
        | 'output_limit'
        | 'spawn_failed'
        | 'timed_out'
        | 'token_missing'
        | 'vault_failed';
      detail?: string;
    };

function makePrivateDirectory(parent: string, name: string): string {
  const directory = path.join(parent, name);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

function findClaudeLoginUrl(output: string): string | undefined {
  const clean = output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  for (const match of clean.matchAll(/https:\/\/[^\s<>"']+/g)) {
    const candidate = match[0].replace(/[),.;]+$/, '');
    try {
      const url = new URL(candidate);
      if ((url.hostname === 'claude.ai' || url.hostname === 'claude.com') && url.pathname.includes('/oauth/authorize'))
        return url.toString();
    } catch {
      // A partial chunk is expected; the next chunk extends the rolling buffer.
    }
  }
  return undefined;
}

/** Run Claude's subscription setup-token flow through semantic driver events. */
export async function runClaudeSubscriptionMachineAuth(driver: SetupDriver): Promise<ClaudeSubscriptionMachineResult> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-claude-login-'));
  fs.chmodSync(root, 0o700);
  const home = makePrivateDirectory(root, 'home');
  const config = makePrivateDirectory(root, 'config');
  const cache = makePrivateDirectory(root, 'cache');
  const data = makePrivateDirectory(root, 'data');

  const buffers = { stdout: '', stderr: '' };
  let loginUrl: string | undefined;
  let token: string | undefined;
  let urlDisplayed = false;

  const failed = (
    reason: Exclude<ClaudeSubscriptionMachineResult, { ok: true }>['reason'],
    detail?: string,
  ): ClaudeSubscriptionMachineResult => {
    driver.progress('claude-login', 'failed');
    return { ok: false, reason, ...(detail ? { detail } : {}) };
  };

  try {
    driver.progress('claude-login', 'running', 'Waiting for Claude sign-in');
    const login = await runInteractiveProcess(driver, 'claude', ['setup-token'], {
      timeoutMs: LOGIN_TIMEOUT_MS,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: config,
        XDG_CACHE_HOME: cache,
        XDG_DATA_HOME: data,
      },
      async onOutput(chunk, stream, input) {
        buffers[stream] = `${buffers[stream]}${chunk}`.slice(-PROVIDER_STREAM_BUFFER_BYTES);
        const completeOutput = buffers[stream].slice(
          0,
          Math.max(buffers[stream].lastIndexOf('\n'), buffers[stream].lastIndexOf('\r')) + 1,
        );
        token ??= extractClaudeOAuthToken(completeOutput) ?? undefined;
        if (token) registerSensitiveValue(token);

        loginUrl ??= findClaudeLoginUrl(completeOutput);
        if (!loginUrl || urlDisplayed) return;
        urlDisplayed = true;
        registerSensitiveValue(loginUrl);
        driver.display({
          id: 'claude-subscription-url',
          kind: 'url',
          url: loginUrl,
          label: 'Claude sign-in',
          sensitive: true,
        });
        const code = String(
          await driver.prompt({
            id: 'claude-authorization-code',
            kind: 'secret',
            message: 'Paste the Claude authorization code',
            validation: { required: true, maxLength: 4096 },
          }),
        ).trim();
        input.write(`${code}\n`);
        input.end();
      },
    });

    token ??= extractClaudeOAuthToken(`${buffers.stdout}\n${buffers.stderr}`) ?? undefined;
    if (token) registerSensitiveValue(token);

    if (login.reason === 'spawn_failed') {
      return failed('spawn_failed', login.message);
    }
    if (login.reason === 'output_limit') return failed('output_limit');
    if (login.reason === 'timed_out') return failed('timed_out');
    if (login.exitCode !== 0) {
      return failed('login_failed', `exit ${login.exitCode}`);
    }
    if (!loginUrl) return failed('login_url_missing');
    if (!token) return failed('token_missing');
    driver.progress('claude-login', 'succeeded');

    const saved = await withSecretFile(token, async (filePath) => {
      const args = [
        'secrets',
        'create',
        '--name',
        'Anthropic',
        '--type',
        'anthropic',
        '--file',
        filePath,
        '--host-pattern',
        'api.anthropic.com',
      ];
      driver.progress('auth', 'running', 'Saving your Claude credentials to your OneCLI vault');
      const result = await runInteractiveProcess(driver, 'onecli', args, {
        env: machineChildEnvironment(),
        timeoutMs: VAULT_TIMEOUT_MS,
      });
      const ok = result.reason === 'exited' && result.exitCode === 0;
      driver.progress('auth', ok ? 'succeeded' : 'failed');
      return ok;
    });
    return saved ? { ok: true } : { ok: false, reason: 'vault_failed' };
  } finally {
    if (urlDisplayed) driver.clearDisplay('claude-subscription-url');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
