import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const TSX_LOADER = import.meta.resolve('tsx');
const AUTO = path.join(ROOT, 'setup', 'auto.ts');
const envelope = { protocol: 'nanoclaw.driver.v1', operation: 'setup' } as const;

let setupRoot: string;
let testHome: string;

beforeEach(() => {
  setupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-setup-protocol-'));
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-setup-home-'));
  const bin = path.join(testHome, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'pnpm'),
    '#!/bin/sh\nprintf \'=== NANOCLAW SETUP: verify ===\\nSTATUS: %s\\nCREDENTIALS: configured\\nSERVICE: running\\nCONFIGURED_CHANNELS: 0\\n=== END ===\\n\' "$VERIFY_STATUS"\n',
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(setupRoot, { recursive: true, force: true });
  fs.rmSync(testHome, { recursive: true, force: true });
});

async function run(status: 'success' | 'failed' | 'skipped'): Promise<{
  code: number | null;
  stdout: string;
  events: Array<Record<string, unknown>>;
}> {
  const child = spawn(process.execPath, ['--import', TSX_LOADER, AUTO], {
    cwd: setupRoot,
    env: {
      ...process.env,
      HOME: testHome,
      NANOCLAW_PROTOCOL: 'nanoclaw.driver.v1',
      NANOCLAW_OPERATION: 'setup',
      NANOCLAW_NO_DIAGNOSTICS: '1',
      NANOCLAW_SKIP: 'environment,container,onecli,auth,mounts,service,cli-agent,timezone,channel,first-chat',
      VERIFY_STATUS: status,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events: Array<Record<string, unknown>> = [];
  let stdout = '';
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    buffer += chunk.toString('utf8');
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line) as Record<string, unknown>;
      events.push(event);
      const prompt = event.prompt as { id?: string } | undefined;
      if (event.type === 'prompt' && prompt?.id === 'setup-start-choice') {
        child.stdin.write(
          `${JSON.stringify({ ...envelope, type: 'answer', promptId: prompt.id, value: 'default' })}\n`,
        );
      }
    }
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, stdout, events };
}

describe('machine setup completion boundary', () => {
  it.each([
    ['flag', ['--onecli-api-token', 'oc_direct-secret'], {}],
    ['environment', [], { NANOCLAW_ONECLI_API_TOKEN: 'oc_direct-secret' }],
    ['registry enrollment environment', [], { NANOCLAW_REGISTRY_ENROLL_CODE: 'oc_direct-secret' }],
    ['registry token environment', [], { NANOCLAW_REGISTRY_TOKEN: 'oc_direct-secret' }],
  ] as const)('rejects direct machine secret transport through %s', (_source, args, extraEnv) => {
    const result = spawnSync(process.execPath, ['--import', TSX_LOADER, AUTO, ...args], {
      cwd: setupRoot,
      env: {
        ...process.env,
        NANOCLAW_PROTOCOL: 'nanoclaw.driver.v1',
        NANOCLAW_OPERATION: 'setup',
        NANOCLAW_NO_DIAGNOSTICS: '1',
        ...extraEnv,
      },
      encoding: 'utf8',
      input: '',
    });

    expect(result.status, result.stderr).toBe(1);
    const events = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: 'error',
        code: 'secret_transport_forbidden',
      }),
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain('oc_direct-secret');
  });

  it.each([
    ['success', 1, false, 'service_identity_unproven'],
    ['failed', 1, false, 'verification_failed'],
    ['skipped', 1, false, 'verification_failed'],
  ] as const)(
    'requires verify and service health before completion (%s)',
    async (status, exitCode, completes, errorCode) => {
      const result = await run(status);

      expect(result.code, result.stdout).toBe(exitCode);
      expect(result.stdout[0]).toBe('{');
      expect(result.events.filter((event) => event.type === 'hello')).toHaveLength(1);
      expect(result.events.some((event) => event.type === 'complete')).toBe(completes);
      if (!completes) {
        expect(result.events.at(-1)).toEqual(
          expect.objectContaining({
            type: 'error',
            code: errorCode,
          }),
        );
      }
    },
    15_000,
  );

  it('reports SIGINT during the remote health check as cancelled with exit 2', async () => {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, AUTO], {
      cwd: setupRoot,
      env: {
        ...process.env,
        HOME: testHome,
        NANOCLAW_PROTOCOL: 'nanoclaw.driver.v1',
        NANOCLAW_OPERATION: 'setup',
        NANOCLAW_NO_DIAGNOSTICS: '1',
        NANOCLAW_ONECLI_API_HOST: 'http://127.0.0.1:1',
        NANOCLAW_SKIP: 'environment,container,auth,mounts,service,cli-agent,timezone,channel,first-chat',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const events: Array<Record<string, unknown>> = [];
    let buffer = '';
    let signalled = false;
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line) as Record<string, unknown>;
        events.push(event);
        const prompt = event.prompt as { id?: string } | undefined;
        if (event.type === 'prompt' && prompt?.id === 'setup-start-choice') {
          child.stdin.write(
            `${JSON.stringify({ ...envelope, type: 'answer', promptId: prompt.id, value: 'default' })}\n`,
          );
        }
        if (
          event.type === 'progress' &&
          event.stepId === 'onecli-remote-check' &&
          event.state === 'running' &&
          !signalled
        ) {
          signalled = true;
          child.kill('SIGINT');
        }
      }
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });

    expect(signalled).toBe(true);
    expect(code).toBe(2);
    expect(events.at(-1)?.type).toBe('cancelled');
    expect(events.some((event) => event.type === 'error')).toBe(false);
  }, 15_000);
});
