import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import type { ResponseFrame } from './frame.js';
import { register } from './registry.js';
import { startCliServer, stopCliServer } from './socket-server.js';

type PrintArgs = {
  'argv-value': string;
  stdin_value: string;
  nested: { enabled: boolean };
};

register<PrintArgs, PrintArgs>({
  name: 'stdin-json-e2e-print',
  description: 'Print structured args for the stdin JSON E2E test.',
  access: 'open',
  parseArgs: (raw) => {
    if (
      typeof raw['argv-value'] !== 'string' ||
      typeof raw.stdin_value !== 'string' ||
      !raw.nested ||
      typeof raw.nested !== 'object' ||
      (raw.nested as Record<string, unknown>).enabled !== true
    ) {
      throw new Error('unexpected E2E args');
    }
    return raw as PrintArgs;
  },
  handler: async (args) => args,
});

it('pipes stdin JSON through the real CLI and socket server into a registered command', async () => {
  const tempDir = fs.mkdtempSync('/tmp/ncl-stdin-e2e-');
  const dataDir = path.join(tempDir, 'data');
  const socketPath = path.join(dataDir, 'ncl.sock');
  fs.mkdirSync(dataDir);

  try {
    await startCliServer(socketPath);

    const result = await runCli(tempDir, {
      stdin_value: 'from-stdin',
      nested: { enabled: true },
    });

    expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
    const frame = JSON.parse(result.stdout) as ResponseFrame;
    expect(frame).toEqual({
      id: expect.any(String),
      ok: true,
      data: {
        'argv-value': 'from-argv',
        stdin_value: 'from-stdin',
        nested: { enabled: true },
      },
    });
  } finally {
    await stopCliServer();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

it('runs when the CLI entry point is invoked through a symlink', async () => {
  const tempDir = fs.mkdtempSync('/tmp/ncl-stdin-symlink-e2e-');
  const dataDir = path.join(tempDir, 'data');
  const socketPath = path.join(dataDir, 'ncl.sock');
  const clientPath = fileURLToPath(new URL('./client.ts', import.meta.url));
  const symlinkPath = path.join(tempDir, 'ncl.ts');
  fs.mkdirSync(dataDir);
  fs.symlinkSync(clientPath, symlinkPath);

  try {
    await startCliServer(socketPath);

    const result = await runCli(
      tempDir,
      {
        stdin_value: 'from-stdin',
        nested: { enabled: true },
      },
      symlinkPath,
    );

    expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: {
        'argv-value': 'from-argv',
        stdin_value: 'from-stdin',
        nested: { enabled: true },
      },
    });
  } finally {
    await stopCliServer();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function runCli(
  cwd: string,
  stdin: Record<string, unknown>,
  clientPath = fileURLToPath(new URL('./client.ts', import.meta.url)),
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      clientPath,
      'stdin-json-e2e',
      'print',
      '--argv-value',
      'from-argv',
      '--stdin-json',
      '--json',
    ],
    { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  child.stdin.end(JSON.stringify(stdin));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
