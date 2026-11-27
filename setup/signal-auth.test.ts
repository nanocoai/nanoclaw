/**
 * Pin the signal-cli probe timeout (#2582).
 *
 * signal-cli serializes access to its config directory with an exclusive
 * file lock. When the NanoClaw service is running, its `signal-cli daemon`
 * holds that lock indefinitely, and a bare `listAccounts` probe blocks
 * forever ("Config file is in use by another instance, waiting…") — the
 * setup wizard hung at the Signal step with no diagnostic. The probe must
 * time out and report `timedOut` so the caller can name the real cause.
 *
 * The tests point SIGNAL_CLI_PATH at stub scripts that emulate the three
 * relevant behaviors: normal JSON output, a hang (the daemon-lock state),
 * and a non-zero exit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listAccounts } from './signal-auth.js';

let tmpDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-signal-auth-'));
  savedEnv.SIGNAL_CLI_PATH = process.env.SIGNAL_CLI_PATH;
  savedEnv.NANOCLAW_SIGNAL_PROBE_TIMEOUT_MS = process.env.NANOCLAW_SIGNAL_PROBE_TIMEOUT_MS;
  // Keep the hang test fast: the timeout only needs to be shorter than the
  // stub's sleep to prove the kill fires.
  process.env.NANOCLAW_SIGNAL_PROBE_TIMEOUT_MS = '500';
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function stubCli(body: string): string {
  const file = path.join(tmpDir, 'signal-cli');
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  process.env.SIGNAL_CLI_PATH = file;
  return file;
}

describe('signal-auth listAccounts', () => {
  it('parses registered accounts from JSON output', async () => {
    stubCli(`echo '[{"number":"+15551234567","registered":true},{"number":"+15550000000","registered":false}]'`);
    expect(listAccounts()).toEqual({ accounts: ['+15551234567'], timedOut: false });
  });

  it('returns timedOut when signal-cli hangs on the config lock — the #2582 state', async () => {
    // Emulate "Config file is in use by another instance, waiting…": the
    // daemon holds the lock and listAccounts never returns on its own.
    stubCli('sleep 30');
    const started = Date.now();
    expect(listAccounts()).toEqual({ accounts: [], timedOut: true });
    // Must return via the probe timeout, not the stub finishing.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('reports a non-zero exit as no accounts, not a timeout', async () => {
    stubCli('exit 3');
    expect(listAccounts()).toEqual({ accounts: [], timedOut: false });
  });

  it('reports garbage output as no accounts', async () => {
    stubCli('echo not-json');
    expect(listAccounts()).toEqual({ accounts: [], timedOut: false });
  });
});
