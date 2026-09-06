import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TOKEN = `sk-ant-oat${'A'.repeat(90)}AA`;
const URL = 'https://claude.com/cai/oauth/authorize?code=true&state=driver-test';
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-claude-driver-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function executable(name: string, contents: string): string {
  const file = path.join(root, 'bin', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o755 });
  return file;
}

describe('Claude subscription through the NDJSON driver', () => {
  it('translates a bidirectional provider login into semantic events only', async () => {
    const marker = path.join(root, 'vaulted');
    executable(
      'claude',
      `#!/usr/bin/env bash
printf 'private provider noise\\n%s\\n' '${URL}'
IFS= read -r code
test "$code" = 'authorization-code' || exit 9
printf '%s\\n' '${TOKEN}'
`,
    );
    executable(
      'onecli',
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const index = args.indexOf('--file');
if (index < 0 || args.includes('--value')) process.exit(7);
const file = args[index + 1];
const secret = fs.readFileSync(file, 'utf8');
if (!/^sk-ant-oat[A-Za-z0-9_-]{80,500}AA$/.test(secret)) process.exit(8);
if ((fs.statSync(file).mode & 0o777) !== 0o600) process.exit(9);
fs.writeFileSync(${JSON.stringify(marker)}, 'ok');
`,
    );

    const fixture = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'claude-subscription-driver.ts',
    );
    const tsx = path.resolve('node_modules/tsx/dist/cli.mjs');
    const child = spawn(process.execPath, [tsx, fixture], {
      env: { ...process.env, PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH ?? ''}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const events: Array<Record<string, unknown>> = [];
    let stdout = '';
    let stderr = '';
    let buffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
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
            `${JSON.stringify({
              protocol: 'nanoclaw.driver.v1',
              operation: 'setup',
              type: 'externalActionCompleted',
              actionId: action.id,
              result: 'attempted',
            })}\n`,
          );
        }
        if (event.type === 'prompt') {
          const prompt = event.prompt as { id: string };
          child.stdin.write(
            `${JSON.stringify({
              protocol: 'nanoclaw.driver.v1',
              operation: 'setup',
              type: 'answer',
              promptId: prompt.id,
              value: 'authorization-code',
            })}\n`,
          );
        }
      }
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    expect(exitCode, `${stderr}\n${stdout}`).toBe(0);
    expect(events[0]?.type).toBe('hello');
    expect(events.at(-1)?.type).toBe('complete');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'display',
        display: expect.objectContaining({ kind: 'url', url: URL, sensitive: true }),
      }),
    );
    expect(events.some((event) => event.type === 'externalAction')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'prompt',
        prompt: expect.objectContaining({ id: 'claude-authorization-code', sensitive: true }),
      }),
    );
    expect(events.filter((event) => event.type === 'progress').map((event) => event.state)).toEqual([
      'running',
      'succeeded',
      'running',
      'succeeded',
    ]);
    expect(stdout).not.toContain(TOKEN);
    expect(stdout).not.toContain('private provider noise');
    expect(stderr).not.toContain(TOKEN);
    expect(fs.readFileSync(marker, 'utf8')).toBe('ok');
  }, 10_000);
});
