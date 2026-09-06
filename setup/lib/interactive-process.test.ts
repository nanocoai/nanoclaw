import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runInteractiveProcess } from './interactive-process.js';
import { DriverCancelled, type SetupDriver } from './setup-driver.js';

const STUBBORN_GRANDCHILD = `
  process.on('SIGTERM', () => {});
  process.stdout.write('ready\\n');
  setInterval(() => {}, 1000);
`;

function machineDriver(controller = new AbortController()): SetupDriver {
  return {
    mode: 'ndjson',
    operation: 'setup',
    cancellationSignal: controller.signal,
    throwIfCancelled() {
      if (controller.signal.aborted) throw new DriverCancelled('test');
    },
  } as SetupDriver;
}

describe('runInteractiveProcess', () => {
  it('pipes provider output and accepts provider input in machine mode', async () => {
    const seen: string[] = [];
    let answered = false;
    const result = await runInteractiveProcess(
      machineDriver(),
      process.execPath,
      [
        '-e',
        `
        process.stdout.write('code?\\n');
        process.stdin.once('data', (chunk) => {
          process.stdout.write(chunk.toString() === 'answer\\n' ? 'accepted\\n' : 'rejected\\n');
        });
      `,
      ],
      {
        onOutput(chunk, _stream, input) {
          seen.push(chunk);
          if (!answered && chunk.includes('code?')) {
            answered = true;
            input.write('answer\n');
            input.end();
          }
        },
      },
    );

    expect(result).toEqual({ reason: 'exited', exitCode: 0 });
    expect(seen.join('')).toContain('accepted');
  });

  it('passes only the machine allowlist plus explicit isolated overrides', async () => {
    const previous = process.env.NANOCLAW_ANTHROPIC_AUTH_TOKEN;
    process.env.NANOCLAW_ANTHROPIC_AUTH_TOKEN = 'must-not-leak';
    let output = '';
    try {
      const result = await runInteractiveProcess(
        machineDriver(),
        process.execPath,
        [
          '-e',
          `process.stdout.write(JSON.stringify({ home: process.env.HOME, leaked: process.env.NANOCLAW_ANTHROPIC_AUTH_TOKEN, color: process.env.NO_COLOR }))`,
        ],
        {
          env: { HOME: '/tmp/isolated-auth-home' },
          onOutput(chunk) {
            output += chunk;
          },
        },
      );
      expect(result).toEqual({ reason: 'exited', exitCode: 0 });
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_ANTHROPIC_AUTH_TOKEN;
      else process.env.NANOCLAW_ANTHROPIC_AUTH_TOKEN = previous;
    }

    expect(JSON.parse(output)).toEqual({
      home: '/tmp/isolated-auth-home',
      color: '1',
    });
  });

  it('stops a machine child whose output exceeds the fixed bound', async () => {
    const result = await runInteractiveProcess(machineDriver(), process.execPath, [
      '-e',
      `process.stdout.write(Buffer.alloc(${256 * 1024 + 1}, 120))`,
    ]);

    expect(result).toEqual({ reason: 'output_limit' });
  });

  it('stops a machine child at the provider deadline', async () => {
    const result = await runInteractiveProcess(
      machineDriver(),
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 25 },
    );

    expect(result).toEqual({ reason: 'timed_out' });
  });

  it.skipIf(process.platform === 'win32')('kills the whole process group on cancellation', async () => {
    const controller = new AbortController();
    let grandchildPid = 0;
    const running = runInteractiveProcess(
      machineDriver(controller),
      process.execPath,
      [
        '-e',
        `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(STUBBORN_GRANDCHILD)}], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        child.stdout.once('data', () => process.stdout.write(String(child.pid) + '\\n'));
        setInterval(() => {}, 1000);
      `,
      ],
      {
        onOutput(chunk) {
          grandchildPid = Number(chunk.trim());
          controller.abort();
        },
      },
    );

    try {
      await expect(running).rejects.toBeInstanceOf(DriverCancelled);
      expect(grandchildPid).toBeGreaterThan(0);
      await waitUntilGone(grandchildPid);
      expect(() => process.kill(grandchildPid, 0)).toThrow();
    } finally {
      if (grandchildPid > 0) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  });

  it.skipIf(process.platform === 'win32')('kills the whole process group when the setup parent exits', async () => {
    const fixture = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'interactive-process-parent-exit.ts',
    );
    const tsx = path.resolve('node_modules/tsx/dist/cli.mjs');
    const child = spawn(process.execPath, [tsx, fixture], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    expect(exitCode).toBe(23);
    const grandchildPid = Number(stdout.trim());
    expect(grandchildPid).toBeGreaterThan(0);
    await waitUntilGone(grandchildPid);
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  });
});

describe('setup process-group escalation', () => {
  it('does not gate SIGKILL on the process-group leader still running', () => {
    const setupDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    for (const file of [
      'auto.ts',
      'lib/agent-ping.ts',
      'lib/interactive-process.ts',
      'lib/runner.ts',
      'lib/skill-driver.ts',
      'lib/tz-from-claude.ts',
    ]) {
      const source = fs.readFileSync(path.join(setupDir, file), 'utf8');
      expect(source, file).not.toContain('child.exitCode === null');
    }
  });
});

async function waitUntilGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
