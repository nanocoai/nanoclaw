import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DriverCancelled, type SetupDriver } from './setup-driver.js';
import { resolveTimezoneViaClaude } from './tz-from-claude.js';

describe('machine timezone lookup', () => {
  it('stops a noisy machine lookup before its output can grow without bound', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-timezone-limit-'));
    const bin = path.join(temp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'claude'),
      `#!/usr/bin/env node
process.stdout.write('x'.repeat(70 * 1024));
setInterval(() => {}, 1000);
`,
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${previousPath ?? ''}`;
      const driver = {
        mode: 'ndjson',
        progress: () => {},
        throwIfCancelled: () => {},
      } as unknown as SetupDriver;
      await expect(resolveTimezoneViaClaude('Jerusalem', driver)).resolves.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('scrubs credentials and kills the Claude process group on cancellation', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-timezone-cancel-'));
    const bin = path.join(temp, 'bin');
    const envMarker = path.join(temp, 'env');
    const pidMarker = path.join(temp, 'pid');
    fs.mkdirSync(bin);
    const stubborn = path.join(bin, 'stubborn');
    fs.writeFileSync(
      stubborn,
      `#!/bin/sh
trap '' TERM
echo $$ > "$TZ_PID_MARKER"
exec sleep 30
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, 'claude'),
      `#!/bin/sh
printf '%s' "\${ANTHROPIC_AUTH_TOKEN-missing}" > "$TZ_ENV_MARKER"
${JSON.stringify(stubborn)} &
wait
`,
      { mode: 0o755 },
    );
    const previous = {
      path: process.env.PATH,
      token: process.env.ANTHROPIC_AUTH_TOKEN,
      envMarker: process.env.TZ_ENV_MARKER,
      pidMarker: process.env.TZ_PID_MARKER,
    };
    const controller = new AbortController();
    const driver = {
      mode: 'ndjson',
      cancellationSignal: controller.signal,
      progress: () => {},
      throwIfCancelled: () => {
        if (controller.signal.aborted) throw new DriverCancelled('test');
      },
    } as unknown as SetupDriver;
    let pid = 0;
    try {
      process.env.PATH = `${bin}:${previous.path ?? ''}`;
      process.env.ANTHROPIC_AUTH_TOKEN = 'must-not-reach-child';
      process.env.TZ_ENV_MARKER = envMarker;
      process.env.TZ_PID_MARKER = pidMarker;
      const result = resolveTimezoneViaClaude('Jerusalem', driver);
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(pidMarker) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(fs.readFileSync(envMarker, 'utf8')).toBe('missing');
      controller.abort();
      await expect(result).rejects.toBeInstanceOf(DriverCancelled);
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
        ANTHROPIC_AUTH_TOKEN: previous.token,
        TZ_ENV_MARKER: previous.envMarker,
        TZ_PID_MARKER: previous.pidMarker,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 10_000);
});
