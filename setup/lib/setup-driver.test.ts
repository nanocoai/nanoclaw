import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const TSX_LOADER = import.meta.resolve('tsx');
const HARNESS = path.join(ROOT, 'setup', 'lib', 'fixtures', 'setup-driver-child.ts');
const CONTINUATION_HARNESS = path.join(ROOT, 'setup', 'lib', 'fixtures', 'setup-driver-continuation.ts');
const TTY_HARNESS = path.join(ROOT, 'setup', 'lib', 'fixtures', 'setup-driver-tty.ts');
const CANCEL_RACE_HARNESS = path.join(ROOT, 'setup', 'lib', 'fixtures', 'setup-driver-cancel-race.ts');
const CHILD_CANCEL_HARNESS = path.join(ROOT, 'setup', 'lib', 'fixtures', 'setup-driver-child-cancel.ts');
const WINDOWED_CANCEL_HARNESS = path.join(ROOT, 'setup', 'lib', 'fixtures', 'setup-driver-windowed-cancel.ts');
const envelope = { protocol: 'nanoclaw.driver.v1', operation: 'setup' } as const;

describe('NDJSON setup driver child boundary', () => {
  it('keeps stdout parseable, rejects bad commands, and redacts accepted secrets', async () => {
    const secret = 'secret-value"\nnext\\part';
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-driver-output-'));
    const child = spawn(process.execPath, ['--import', TSX_LOADER, HARNESS], {
      cwd: ROOT,
      env: {
        ...process.env,
        NANOCLAW_PROTOCOL: 'nanoclaw.driver.v1',
        NANOCLAW_NO_DIAGNOSTICS: '0',
        NANOCLAW_TEST_OUTPUT_DIR: outputDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const events: Array<Record<string, unknown>> = [];
    let stdout = '';
    let stderr = '';
    let buffer = '';
    let answeredCredential = false;
    let answeredContinue = false;
    const send = (command: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify({ ...envelope, ...command })}\n`);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      buffer += text;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line) as Record<string, unknown>;
        events.push(event);
        if (event.type === 'prompt') {
          const prompt = event.prompt as { id: string };
          if (prompt.id === 'credential' && !answeredCredential) {
            answeredCredential = true;
            child.stdin.write('not-json\n');
            send({ operation: 'uninstall', type: 'answer', promptId: prompt.id, value: secret });
            send({ type: 'futureCommand', promptId: prompt.id });
            send({ type: 'answer', promptId: 'stale', value: secret });
            send({ type: 'answer', promptId: prompt.id, value: false });
            const valid = { type: 'answer', promptId: prompt.id, value: secret, futureField: 'ignored' };
            send(valid);
            send(valid);
          } else if (prompt.id === 'continue' && !answeredContinue) {
            answeredContinue = true;
            send({ type: 'answer', promptId: prompt.id, value: true });
          }
          continue;
        }
        if (event.type === 'externalAction') {
          const action = event.action as { id: string };
          send({ type: 'externalActionCompleted', actionId: action.id, result: 'attempted' });
          send({ type: 'externalActionCompleted', actionId: action.id, result: 'attempted' });
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });

    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout[0]).toBe('{');
    expect(stdout).not.toMatch(/\x1b\[[0-9;]*[A-Za-z]/);
    expect(
      stdout
        .trim()
        .split('\n')
        .every((line) => JSON.parse(line)),
    ).toBe(true);
    expect(events.filter((event) => event.type === 'hello')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(1);
    for (const event of events.filter((candidate) => candidate.type === 'externalAction')) {
      const action = event.action as Record<string, unknown>;
      expect(['openURL', 'startApplication', 'systemPermission']).toContain(action.kind);
      expect(action).not.toHaveProperty('executable');
      expect(action).not.toHaveProperty('args');
      expect(action).not.toHaveProperty('command');
    }
    expect(events.filter((event) => event.type === 'inputRejected').map((event) => event.code)).toEqual([
      'invalid_json',
      'wrong_envelope',
      'unknown_command',
      'stale_command',
      'invalid_answer',
      'stale_command',
      'postcondition_failed',
    ]);
    expect(stdout).not.toContain('secret-value');
    expect(stdout.match(/display-one/g)).toHaveLength(1);
    expect(stdout.match(/display-two/g)).toHaveLength(1);
    expect(events.some((event) => event.type === 'clearDisplay' && event.displayId === 'rotating-code')).toBe(true);
    const persisted =
      fs.readFileSync(path.join(outputDir, 'logs', 'setup.log'), 'utf8') +
      fs.readFileSync(path.join(outputDir, 'diagnostic-body.json'), 'utf8');
    expect(persisted).not.toContain('secret-value');
    expect(persisted).not.toContain('display-one');
    expect(persisted).not.toContain('display-two');
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('continues an sg-style re-exec with one hello and one stdin reader', () => {
    const result = spawnSync(process.execPath, ['--import', TSX_LOADER, CONTINUATION_HARNESS], {
      cwd: ROOT,
      encoding: 'utf8',
      input: JSON.stringify({ ...envelope, type: 'answer', promptId: 'continued-confirm', value: true }) + '\n',
      env: {
        ...process.env,
        NANOCLAW_PROTOCOL: 'nanoclaw.driver.v1',
        NANOCLAW_TEST_TSX_LOADER: TSX_LOADER,
      },
    });
    const events = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(result.status).toBe(0);
    expect(events.filter((event) => event.type === 'hello')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'prompt')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(1);
  });

  it('rejects an oversized raw line before a newline is received', async () => {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, HARNESS], {
      cwd: ROOT,
      env: { ...process.env, NANOCLAW_PROTOCOL: 'nanoclaw.driver.v1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const events: Array<Record<string, unknown>> = [];
    let buffer = '';
    let sentOversized = false;
    let sentValid = false;
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line) as Record<string, unknown>;
        events.push(event);
        if (event.type === 'prompt') {
          const prompt = event.prompt as { id: string };
          if (prompt.id === 'credential' && !sentOversized) {
            sentOversized = true;
            child.stdin.write(`${'x'.repeat(1_048_577)}\n`);
          } else if (prompt.id === 'continue' && !sentValid) {
            sentValid = true;
            child.stdin.write(`${JSON.stringify({ ...envelope, type: 'answer', promptId: prompt.id, value: true })}\n`);
          }
        }
        if (event.type === 'inputRejected' && event.code === 'command_too_large') {
          child.stdin.write(
            `${JSON.stringify({ ...envelope, type: 'answer', promptId: 'credential', value: 'secret-value' })}\n`,
          );
        }
        if (event.type === 'externalAction') {
          const action = event.action as { id: string };
          child.stdin.write(
            `${JSON.stringify({ ...envelope, type: 'externalActionCompleted', actionId: action.id, result: 'attempted' })}\n`,
          );
          child.stdin.write(
            `${JSON.stringify({ ...envelope, type: 'externalActionCompleted', actionId: action.id, result: 'attempted' })}\n`,
          );
        }
      }
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    expect(code).toBe(0);
    expect(events.some((event) => event.type === 'inputRejected' && event.code === 'command_too_large')).toBe(true);
    expect(events.at(-1)?.type).toBe('complete');
  }, 15_000);

  it('renders a TTY-owning device login through machine semantics', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-driver-tty-'));
    const prefix = path.join(temp, 'global');
    const fakeBin = path.join(temp, 'bin');
    const calls = path.join(temp, 'teams.calls');
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'npm'), '#!/bin/sh\nprintf \'%s\\n\' "$TEST_TEAMS_PREFIX"\n', { mode: 0o755 });
    fs.writeFileSync(
      path.join(prefix, 'bin', 'teams'),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$TEST_TEAMS_CALLS"\nprintf \'Open https://microsoft.com/devicelogin\\nEnter code ABCD-EFGH\\n=== NANOCLAW SETUP: TEAMS-LOGIN ===\\nSTATUS: success\\n=== END ===\\n\'\n',
      { mode: 0o755 },
    );
    try {
      const child = spawn(process.execPath, ['--import', TSX_LOADER, TTY_HARNESS], {
        cwd: temp,
        env: {
          ...process.env,
          NANOCLAW_PROTOCOL: 'nanoclaw.driver.v1',
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          TEST_TEAMS_PREFIX: prefix,
          TEST_TEAMS_CALLS: calls,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const events: Array<Record<string, unknown>> = [];
      let stdout = '';
      let stderr = '';
      let buffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdout += text;
        buffer += text;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line) as Record<string, unknown>;
          events.push(event);
          if (event.type === 'externalAction') {
            const action = event.action as { id: string };
            child.stdin.write(
              `${JSON.stringify({ ...envelope, type: 'externalActionCompleted', actionId: action.id, result: 'attempted' })}\n`,
            );
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });

      expect(code, `${stdout}\n${stderr}`).toBe(0);
      expect(stderr).toBe('');
      expect(events.filter((event) => event.type === 'hello')).toHaveLength(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'externalAction',
          action: expect.objectContaining({ kind: 'openURL', url: 'https://microsoft.com/devicelogin' }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'display',
          display: expect.objectContaining({ id: 'teams-login-code', content: 'ABCD-EFGH', sensitive: true }),
        }),
      );
      expect(events).toContainEqual(expect.objectContaining({ type: 'clearDisplay', displayId: 'teams-login-url' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'clearDisplay', displayId: 'teams-login-code' }));
      expect(events.at(-1)?.type).toBe('complete');
      expect(fs.readFileSync(calls, 'utf8')).toContain('login');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 15_000);

  it('keeps cancelled terminal when an in-flight postcondition finishes later', async () => {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, CANCEL_RACE_HARNESS], {
      cwd: ROOT,
      env: { ...process.env, NANOCLAW_PROTOCOL: 'nanoclaw.driver.v1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const events: Array<Record<string, unknown>> = [];
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line) as Record<string, unknown>;
        events.push(event);
        if (event.type === 'externalAction') {
          const action = event.action as { id: string };
          child.stdin.write(
            `${JSON.stringify({ ...envelope, type: 'externalActionCompleted', actionId: action.id, result: 'attempted' })}\n`,
          );
          setTimeout(() => child.kill('SIGINT'), 20);
        }
      }
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });

    expect(code).toBe(2);
    expect(events.filter((event) => event.type === 'cancelled')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('cancelled');
    expect(events.some((event) => event.type === 'inputRejected')).toBe(false);
  }, 15_000);

  it('SIGKILLs a runner grandchild that ignores SIGTERM after its leader exits', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-driver-child-cancel-'));
    const marker = path.join(temp, 'child.pid');
    const child = spawn(process.execPath, ['--import', TSX_LOADER, CHILD_CANCEL_HARNESS], {
      cwd: ROOT,
      env: { ...process.env, NANOCLAW_PROTOCOL: 'nanoclaw.driver.v1', NANOCLAW_TEST_CHILD_MARKER: marker },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const events: Array<{ type: string; state?: string }> = [];
    let buffer = '';
    let stderr = '';
    let cancelled = false;
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line) as { type: string; state?: string };
        events.push(event);
        if (event.type === 'progress' && event.state === 'running' && !cancelled) {
          cancelled = true;
          void (async () => {
            const deadline = Date.now() + 5_000;
            while (!fs.existsSync(marker) && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            child.stdin.write(`${JSON.stringify({ ...envelope, type: 'cancel', reason: 'test' })}\n`);
          })();
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    let pid = 0;
    try {
      expect(code, `${JSON.stringify(events)}\n${stderr}`).toBe(2);
      expect(events.at(-1)?.type).toBe('cancelled');
      expect(fs.existsSync(marker)).toBe(true);
      pid = Number(fs.readFileSync(marker, 'utf8').trim());
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 15_000);

  it('SIGKILLs a windowed-step grandchild that ignores SIGTERM after its leader exits', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-driver-windowed-cancel-'));
    const marker = path.join(temp, 'child.pid');
    const bin = path.join(temp, 'bin');
    fs.mkdirSync(bin);
    const stubborn = path.join(bin, 'stubborn');
    fs.writeFileSync(stubborn, `#!/bin/sh\ntrap '' TERM\necho $$ > ${JSON.stringify(marker)}\nexec sleep 30\n`, {
      mode: 0o755,
    });
    fs.writeFileSync(
      path.join(bin, 'pnpm'),
      `#!/bin/sh\n${JSON.stringify(stubborn)} &\nwhile [ ! -s ${JSON.stringify(marker)} ]; do sleep 0.01; done\nprintf '%s\\n' '=== NANOCLAW SETUP: cancel-window ===' 'STATUS: success' '=== END ==='\nwait\n`,
      { mode: 0o755 },
    );
    const child = spawn(process.execPath, ['--import', TSX_LOADER, WINDOWED_CANCEL_HARNESS], {
      cwd: temp,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        NANOCLAW_PROTOCOL: 'nanoclaw.driver.v1',
        NANOCLAW_NO_DIAGNOSTICS: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const events: Array<{ type: string; state?: string }> = [];
    let buffer = '';
    let cancelled = false;
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line) as { type: string; state?: string; stepId?: string };
        events.push(event);
        if (event.type === 'progress' && event.state === 'running' && !cancelled) {
          cancelled = true;
          void (async () => {
            const deadline = Date.now() + 5_000;
            while (!fs.existsSync(marker) && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            child.stdin.write(`${JSON.stringify({ ...envelope, type: 'cancel', reason: 'test' })}\n`);
          })();
        }
      }
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });

    let pid = 0;
    try {
      expect(code).toBe(2);
      expect(events.at(-1)?.type).toBe('cancelled');
      expect(fs.existsSync(marker)).toBe(true);
      pid = Number(fs.readFileSync(marker, 'utf8').trim());
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 15_000);
});
