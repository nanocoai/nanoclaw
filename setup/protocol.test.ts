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

});
