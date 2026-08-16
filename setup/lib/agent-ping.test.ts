import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isValidGroupFolder } from '../../src/group-folder.js';
import { classifyPingResult, PING_AGENT_FOLDER, pingCliAgent } from './agent-ping.js';
import type { SetupDriver } from './setup-driver.js';

it('uses a runtime-safe folder for the setup ping agent', () => {
  expect(isValidGroupFolder(PING_AGENT_FOLDER)).toBe(true);
});

describe('classifyPingResult', () => {
  it('treats a normal text reply as ok', () => {
    expect(classifyPingResult(0, 'pong\n')).toBe('ok');
  });

  it('detects Anthropic auth errors printed as a chat reply', () => {
    expect(
      classifyPingResult(
        0,
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
      ),
    ).toBe('auth_error');
  });

  it('detects auth errors on stderr too', () => {
    expect(classifyPingResult(1, '', 'Authentication error')).toBe('auth_error');
  });

  it('detects Claude Code login banners printed as a chat reply', () => {
    expect(classifyPingResult(0, 'Invalid API key · Please run /login')).toBe('auth_error');
    expect(classifyPingResult(0, 'Not logged in · Please run /login')).toBe('auth_error');
  });

  it('preserves socket errors', () => {
    expect(classifyPingResult(2, '')).toBe('socket_error');
  });

  it('treats empty output as no reply', () => {
    expect(classifyPingResult(0, '')).toBe('no_reply');
  });

  it('stops a noisy machine ping before its output can grow without bound', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ping-limit-'));
    const bin = path.join(temp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'pnpm'),
      `#!/usr/bin/env node
process.stdout.write('x'.repeat(70 * 1024));
setInterval(() => {}, 1000);
`,
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${previousPath ?? ''}`;
      const driver = { mode: 'ndjson' } as SetupDriver;
      await expect(pingCliAgent(30_000, driver)).resolves.toBe('output_limit');
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('scrubs machine credentials and kills the ping process group on cancellation', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ping-cancel-'));
    const bin = path.join(temp, 'bin');
    const envMarker = path.join(temp, 'env');
    const pidMarker = path.join(temp, 'pid');
    fs.mkdirSync(bin);
    const stubborn = path.join(bin, 'stubborn');
    fs.writeFileSync(
      stubborn,
      `#!/bin/sh
trap '' TERM
echo $$ > "$PING_PID_MARKER"
exec sleep 30
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, 'pnpm'),
      `#!/bin/sh
printf '%s' "\${ANTHROPIC_API_KEY-missing}" > "$PING_ENV_MARKER"
${JSON.stringify(stubborn)} &
wait
`,
      { mode: 0o755 },
    );
    const previous = {
      path: process.env.PATH,
      key: process.env.ANTHROPIC_API_KEY,
      envMarker: process.env.PING_ENV_MARKER,
      pidMarker: process.env.PING_PID_MARKER,
    };
    const controller = new AbortController();
    let pid = 0;
    try {
      process.env.PATH = `${bin}:${previous.path ?? ''}`;
      process.env.ANTHROPIC_API_KEY = 'must-not-reach-child';
      process.env.PING_ENV_MARKER = envMarker;
      process.env.PING_PID_MARKER = pidMarker;
      const driver = { mode: 'ndjson', cancellationSignal: controller.signal } as SetupDriver;
      const result = pingCliAgent(30_000, driver);
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(pidMarker) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(fs.readFileSync(envMarker, 'utf8')).toBe('missing');
      controller.abort();
      expect(await result).toBe('no_reply');
      pid = Number(fs.readFileSync(pidMarker, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      for (const [key, value] of Object.entries({
        PATH: previous.path,
        ANTHROPIC_API_KEY: previous.key,
        PING_ENV_MARKER: previous.envMarker,
        PING_PID_MARKER: previous.pidMarker,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 10_000);
});
