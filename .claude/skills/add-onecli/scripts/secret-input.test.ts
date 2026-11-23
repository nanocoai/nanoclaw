import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real child processes, except the subscription sign-in: it needs a browser.
const signIn = vi.hoisted(() => ({ fake: null as null | ((args: string[]) => Partial<SpawnSyncReturns<string>>) }));
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawnSync: ((cmd: string, args: string[], options: object) =>
      signIn.fake ? signIn.fake(args) : real.spawnSync(cmd, args, options)) as typeof real.spawnSync,
  };
});
const prompts = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clack/prompts')>()),
  select: prompts.select,
}));

import { run } from './auth.js';
import { createSecret, login, redact } from './secret-input.js';

const KEY = 'sk-ant-api03-TESTKEY-not-a-real-key-0123456789';
const OAUTH = 'sk-ant-oat01-TESTKEY-not-a-real-token-0123456789';
const GATEWAY_KEY = 'oc_TESTKEY-not-a-real-gateway-key-0123456789';
const SCRIPTS = path.dirname(new URL(import.meta.url).pathname);

let home: string;
let logDir: string;
const logged = (name: string) =>
  fs.existsSync(path.join(logDir, name)) ? fs.readFileSync(path.join(logDir, name), 'utf8') : '';

// An onecli that lists an empty vault but fails anything else: it records
// its argv, the --file it was given and its stdin, then echoes all of it back
// on stderr the way a gateway error might.
function stubOnecli(status = 1, stdout = ''): void {
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'onecli'),
    `#!/usr/bin/env bash
L=${JSON.stringify(logDir)}
printf '%s\\n' "$*" >> "$L/argv"
[ "$1 $2" = "secrets list" ] && { echo '{"data":[]}'; exit 0; }
f=""; prev=""
for a in "$@"; do [ "$prev" = --file ] && f="$a"; prev="$a"; done
if [ -n "$f" ]; then
  { stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f"; } > "$L/mode"
  cat "$f" > "$L/value"; echo "$f" > "$L/file"
fi
[ -t 0 ] || cat > "$L/stdin"
echo "rejected: $* $(cat "$L/value" "$L/stdin" 2>/dev/null)" >&2
printf '%s' ${JSON.stringify(stdout)}
exit ${status}
`,
    { mode: 0o755 },
  );
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-secret-home-'));
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-secret-log-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('PATH', `${path.join(home, '.local', 'bin')}${path.delimiter}${process.env.PATH}`);
});
afterEach(() => {
  signIn.fake = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(logDir, { recursive: true, force: true });
});

describe('a failed onecli call never shows the secret', () => {
  it('auth.ts: a custom-endpoint token stays off argv and out of the error', async () => {
    stubOnecli();
    vi.stubEnv('NANOCLAW_ANTHROPIC_BASE_URL', 'https://llm.example.test');
    vi.stubEnv('NANOCLAW_ANTHROPIC_AUTH_TOKEN', KEY);
    vi.spyOn(process, 'cwd').mockReturnValue(home);
    const error = await run().then(
      () => null,
      (e: unknown) => e as Error & { stderr?: string; cmd?: string },
    );
    expect(error).toBeInstanceOf(Error);
    expect(logged('argv')).toContain('secrets create');
    expect(logged('argv')).not.toContain(KEY);
    expect(logged('value')).toBe(KEY);
    expect(logged('mode').trim()).toBe('600');
    expect(fs.existsSync(logged('file').trim())).toBe(false);
    for (const text of [error!.message, error!.stack, error!.stderr, error!.cmd, String(error)])
      expect(text ?? '').not.toContain(KEY);
    expect(error!.message).toContain('[redacted]');
  });

  it('auth.ts: a captured subscription token is saved the same way', async () => {
    stubOnecli();
    vi.spyOn(process, 'cwd').mockReturnValue(home);
    prompts.select.mockResolvedValueOnce('subscription');
    let output = '';
    signIn.fake = (args) => {
      output = args[1];
      fs.writeFileSync(output, `${OAUTH}\n`, { mode: 0o600 });
      return { status: 0 };
    };
    const error = await run().then(
      () => null,
      (e: unknown) => e as Error & { stderr?: string; cmd?: string },
    );
    expect(error).toBeInstanceOf(Error);
    expect(logged('argv')).not.toContain(OAUTH);
    expect(logged('value')).toBe(OAUTH);
    expect(fs.existsSync(path.dirname(output))).toBe(false);
    for (const text of [error!.message, error!.stack, error!.stderr, error!.cmd])
      expect(text ?? '').not.toContain(OAUTH);
  });

  it('createSecret returns stdout on success and removes the temp file', () => {
    stubOnecli(0, '{"id":"sec-1"}');
    expect(createSecret(['--name', 'X', '--type', 'generic', '--host-pattern', 'x.test'], KEY)).toBe('{"id":"sec-1"}');
    expect(logged('argv')).not.toContain(KEY);
    expect(logged('value')).toBe(KEY);
    expect(fs.existsSync(logged('file').trim())).toBe(false);
  });

  it('login: the gateway API key goes on stdin, not argv, and not into the error', () => {
    stubOnecli();
    let error: (Error & { stderr?: string; cmd?: string }) | undefined;
    try {
      login(GATEWAY_KEY);
    } catch (e) {
      error = e as typeof error;
    }
    expect(error).toBeInstanceOf(Error);
    expect(logged('argv').trim()).toBe('auth login');
    expect(logged('stdin').trim()).toBe(GATEWAY_KEY);
    for (const text of [error!.message, error!.stack, error!.stderr, error!.cmd])
      expect(text ?? '').not.toContain(GATEWAY_KEY);
  });

  it('setup.ts never puts the gateway API key on the command line', () => {
    expect(fs.readFileSync(path.join(SCRIPTS, 'setup.ts'), 'utf8')).not.toMatch(/'--api-key'/);
  });
});

describe('register-claude-token.sh', () => {
  it('captures the token to a private file and leaves saving it to auth.ts', () => {
    stubOnecli(0);
    const bin = path.join(home, '.local', 'bin');
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'script'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'pnpm'), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(OAUTH)}\n`, { mode: 0o755 });
    // The prompt reads /dev/tty, which a test run has none of; feed it Enter instead.
    const tty = path.join(logDir, 'tty');
    fs.writeFileSync(tty, '\n');
    const copy = path.join(logDir, 'register-claude-token.sh');
    fs.writeFileSync(
      copy,
      fs
        .readFileSync(path.join(SCRIPTS, 'register-claude-token.sh'), 'utf8')
        .replaceAll('</dev/tty', `<${JSON.stringify(tty)}`),
    );
    const output = path.join(logDir, 'token');
    const r = spawnSync('bash', [copy, output], { encoding: 'utf8', env: process.env });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(OAUTH);
    expect(fs.readFileSync(output, 'utf8')).toBe(OAUTH);
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    expect(logged('argv')).toBe('');
  });
});

describe('redact', () => {
  it('removes the raw value and its quoted, escaped and encoded forms', () => {
    const value = 'sk-ant-api03-TEST"KEY/+=?&\\';
    const forms = [
      value,
      `'${value}'`,
      `Bearer ${value}`,
      JSON.stringify(value),
      encodeURIComponent(value),
      Buffer.from(value).toString('base64'),
      Buffer.from(value).toString('base64url'),
    ];
    const text = redact(`failed: ${forms.join(' | ')}`, [value]);
    expect(text).not.toContain('TEST');
    for (const form of forms.slice(4)) expect(text).not.toContain(form);
  });

  it('removes a value escaped twice or wrapped across lines', () => {
    const value = 'sk-ant-api03-TEST"KEY\\0123456789';
    const wrap = (s: string) => s.replace(/(.{10})/g, '$1\n');
    const base64 = Buffer.from(value).toString('base64');
    const forms = [JSON.stringify(JSON.stringify({ value })), wrap(value), wrap(JSON.stringify(value)), wrap(base64)];
    const text = redact(forms.join('\n'), [value]);
    expect(text).not.toContain('TEST');
    expect(text).not.toContain('0123');
    expect(text).not.toContain(base64.slice(10, 20));
  });

  it('removes a value wrapped before it was JSON-escaped, as in a CLI error object', () => {
    const text = redact(JSON.stringify({ error: `rejected ${KEY.slice(0, 10)}\n${KEY.slice(10)}` }), [KEY]);
    expect(text).toBe(JSON.stringify({ error: 'rejected [redacted]' }));
  });

  it('removes a value JSON-escaped as \\uXXXX or percent-encoded in lower case', () => {
    const value = 'custom-TEST&KEY/0123456789';
    const text = redact(`rejected {"value":"custom-TEST\\u0026KEY/0123456789"} url=custom-TEST%26KEY%2f0123456789`, [
      value,
    ]);
    expect(text).toBe('rejected {"value":"[redacted]"} url=[redacted]');
  });

  it('removes a value wrapped inside an escape sequence', () => {
    const value = 'custom-TEST&KEY/0123456789';
    const text = redact(`a custom-TEST%26KEY%2\nf0123456789 b custom-TEST\\u00\n26KEY/0123456789 c`, [value]);
    expect(text).toBe('a [redacted] b [redacted] c');
  });

  it('removes a value starting with n, r or t that follows a raw backslash', () => {
    for (const value of ['nT3stKey0123456789', 'rT3stKey0123456789', 'tT3stKey0123456789']) {
      expect(redact(`C:\\keys\\${value} done`, [value])).toBe('C:\\keys\\[redacted] done');
      expect(redact(`C:\\keys\\${value[0]}\r\n${value.slice(1)} done`, [value])).toBe('C:\\keys\\[redacted] done');
      const json = JSON.stringify({ error: `C:\\keys\\${value[0]}\r\n${value.slice(1)}` });
      expect(redact(json, [value])).toBe(JSON.stringify({ error: 'C:\\keys\\' }).replace(/"}$/, '[redacted]"}'));
    }
    // A false start just before the value must not hide it.
    expect(redact('C:\\keys\\AbCd\\nAbCdAbCd done', ['nAbCdAbCd'])).not.toContain('nAbCdAbCd');
    expect(redact('C:\\keys\\AbCd\\nAbCdAbCd done', ['nAbCdAbCd'])).not.toMatch(/AbCdAbCd/);
  });

  it('stays fast on long runs of backslashes', () => {
    const started = Date.now();
    const value = `sk-ant-api03-${'\\'.repeat(12)}Z`;
    expect(redact(`sk-ant-api03-${'\\'.repeat(5000)}X`, [value])).toContain('X');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('leaves text alone when there is nothing to redact', () => {
    expect(redact('Command failed: onecli secrets list', ['', '  '])).toBe('Command failed: onecli secrets list');
  });
});
