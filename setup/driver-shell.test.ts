import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const ACKS = ['--driver-ack', 'low-memory', '--driver-ack', 'gce', '--driver-ack', 'root'];

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-driver-shell-'));
  fs.mkdirSync(path.join(fixtureRoot, 'setup', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'nanoclaw.sh'), path.join(fixtureRoot, 'nanoclaw.sh'));
  fs.copyFileSync(
    path.join(ROOT, 'setup', 'lib', 'diagnostics.sh'),
    path.join(fixtureRoot, 'setup', 'lib', 'diagnostics.sh'),
  );
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function parseEvents(stdout: string): Array<Record<string, unknown>> {
  expect(stdout[0]).toBe('{');
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function driverEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NANOCLAW_NO_DIAGNOSTICS: '1' };
}

function executable(name: string, body: string): string {
  const file = path.join(fixtureRoot, 'fake-bin', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return file;
}

async function collectShell(
  child: ReturnType<typeof spawn>,
  onStdout?: (chunk: string) => void,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stdout += text;
    onStdout?.(text);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { status, stdout, stderr };
}

describe('nanoclaw.sh NDJSON boundary', () => {
  it('reports missing uninstall runtime without creating setup state', () => {
    const result = spawnSync(
      'bash',
      [path.join(fixtureRoot, 'nanoclaw.sh'), '--uninstall', '--protocol', 'nanoclaw.driver.v1'],
      { cwd: fixtureRoot, env: driverEnv(), encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    const events = parseEvents(result.stdout);
    expect(events.map((event) => event.type)).toEqual(['hello', 'error']);
    expect(events[1].code).toBe('runtime_missing');
    expect(fs.existsSync(path.join(fixtureRoot, 'logs'))).toBe(false);
    expect(fs.existsSync(path.join(fixtureRoot, 'data'))).toBe(false);
  });

  it('keeps terminal uninstall as the default presentation', () => {
    const tsx = path.join(fixtureRoot, 'node_modules', '.bin', 'tsx');
    fs.mkdirSync(path.dirname(tsx), { recursive: true });
    fs.writeFileSync(tsx, '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$PWD/tsx.args"\necho terminal-uninstall-child\n', {
      mode: 0o755,
    });

    const result = spawnSync('bash', [path.join(fixtureRoot, 'nanoclaw.sh'), '--uninstall'], {
      cwd: fixtureRoot,
      env: driverEnv(),
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('terminal-uninstall-child');
    expect(result.stdout.trimStart().startsWith('{')).toBe(false);
    expect(fs.readFileSync(path.join(fixtureRoot, 'tsx.args'), 'utf8').trim()).toBe(
      `${path.join(fixtureRoot, 'setup', 'auto.ts')} --uninstall`,
    );
  });

  it('keeps cold bootstrap output private and hands frontend stdin to TypeScript', async () => {
    fs.writeFileSync(
      path.join(fixtureRoot, 'setup.sh'),
      '#!/usr/bin/env bash\nif IFS= read -r line; then echo "unexpected-stdin:$line"; else echo stdin-closed; fi\necho bootstrap-private-output\necho "STATUS: success"\n',
    );
    const tsx = path.join(fixtureRoot, 'node_modules', '.bin', 'tsx');
    fs.mkdirSync(path.dirname(tsx), { recursive: true });
    fs.writeFileSync(
      tsx,
      '#!/usr/bin/env bash\nprintf \'{"protocol":"nanoclaw.driver.v1","operation":"setup","type":"prompt","prompt":{"id":"handoff","kind":"confirm","message":"Continue?","sensitive":false}}\\n\'\nIFS= read -r _\nprintf \'{"protocol":"nanoclaw.driver.v1","operation":"setup","type":"complete","completedAt":"2026-01-01T00:00:00.000Z"}\\n\'\n',
    );
    fs.chmodSync(tsx, 0o755);

    const child = spawn('bash', [path.join(fixtureRoot, 'nanoclaw.sh'), '--protocol', 'nanoclaw.driver.v1', ...ACKS], {
      cwd: fixtureRoot,
      env: driverEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    const result = await collectShell(child, (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line && (JSON.parse(line) as { type: string }).type === 'prompt') {
          child.stdin?.write(
            '{"protocol":"nanoclaw.driver.v1","operation":"setup","type":"answer","promptId":"handoff","value":true}\n',
          );
        }
      }
    });

    const bootstrapLog = path.join(fixtureRoot, 'logs', 'setup-steps', '01-bootstrap.log');
    expect(
      result.status,
      `${result.stderr}\n${result.stdout}\n${fs.existsSync(bootstrapLog) ? fs.readFileSync(bootstrapLog, 'utf8') : ''}`,
    ).toBe(0);
    const events = parseEvents(result.stdout);
    expect(events.filter((event) => event.type === 'hello')).toHaveLength(1);
    expect(events.some((event) => event.type === 'progress' && event.stepId === 'bootstrap')).toBe(true);
    expect(events.at(-1)?.type).toBe('complete');
    expect(result.stdout).not.toContain('bootstrap-private-output');
    expect(result.stdout).not.toContain('stdin-closed');
    expect(fs.readFileSync(bootstrapLog, 'utf8')).toContain('stdin-closed\nbootstrap-private-output\nSTATUS: success');
  });

  it('SIGKILLs a bootstrap grandchild that ignores SIGTERM after its leader exits', async () => {
    executable('uname', 'echo Linux');
    executable('awk', 'echo 8192');
    executable('grep', 'exit 1');
    executable('id', 'echo 1000');
    const marker = path.join(fixtureRoot, 'descendant.pid');
    const stubborn = executable('stubborn', `trap '' TERM\necho $$ > ${JSON.stringify(marker)}\nexec sleep 30`);
    fs.writeFileSync(
      path.join(fixtureRoot, 'setup.sh'),
      `#!/usr/bin/env bash\n${JSON.stringify(stubborn)} &\necho "STATUS: success"\nwait\n`,
      { mode: 0o755 },
    );
    const child = spawn('bash', [path.join(fixtureRoot, 'nanoclaw.sh'), '--protocol', 'nanoclaw.driver.v1', ...ACKS], {
      cwd: fixtureRoot,
      env: { ...driverEnv(), PATH: `${path.join(fixtureRoot, 'fake-bin')}:/bin`, NANOCLAW_DISABLE_SETSID: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let buffer = '';
    let cancelled = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line) as { type: string; stepId?: string };
        if (event.type === 'progress' && event.stepId === 'bootstrap' && !cancelled) {
          cancelled = true;
          void (async () => {
            const deadline = Date.now() + 5_000;
            while (!fs.existsSync(marker) && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            child.kill('SIGINT');
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
      expect(code, stdout).toBe(2);
      expect(fs.existsSync(marker)).toBe(true);
      pid = Number(fs.readFileSync(marker, 'utf8').trim());
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  }, 15_000);

  it.each(['disconnect', 'cancel'] as const)(
    'cancels bootstrap when the frontend sends %s',
    async (mode) => {
      fs.writeFileSync(path.join(fixtureRoot, 'setup.sh'), '#!/usr/bin/env bash\nexec sleep 30\n');
      const child = spawn(
        'bash',
        [path.join(fixtureRoot, 'nanoclaw.sh'), '--protocol', 'nanoclaw.driver.v1', ...ACKS],
        { cwd: fixtureRoot, env: driverEnv(), stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let buffer = '';
      let sent = false;
      const result = await collectShell(child, (chunk) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line) as { type: string; stepId?: string };
          if (!sent && event.type === 'progress' && event.stepId === 'bootstrap') {
            sent = true;
            if (mode === 'disconnect') child.stdin?.end();
            else
              child.stdin?.write(
                '{"protocol":"nanoclaw.driver.v1","operation":"setup","type":"cancel","reason":"test"}\n',
              );
          }
        }
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
      expect(parseEvents(result.stdout).at(-1)?.type).toBe('cancelled');
    },
    10_000,
  );

  it('requires the bootstrap status postcondition before handing off', async () => {
    fs.writeFileSync(path.join(fixtureRoot, 'setup.sh'), '#!/usr/bin/env bash\necho "STATUS: deps_failed"\n');
    const tsx = path.join(fixtureRoot, 'node_modules', '.bin', 'tsx');
    fs.mkdirSync(path.dirname(tsx), { recursive: true });
    fs.writeFileSync(tsx, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

    const child = spawn('bash', [path.join(fixtureRoot, 'nanoclaw.sh'), '--protocol', 'nanoclaw.driver.v1', ...ACKS], {
      cwd: fixtureRoot,
      env: driverEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const result = await collectShell(child);

    expect(result.status).toBe(1);
    const events = parseEvents(result.stdout);
    expect(events.at(-1)?.type).toBe('error');
    expect(events.at(-1)?.code).toBe('bootstrap_failed');
    expect(events.some((event) => event.type === 'complete')).toBe(false);
  });

  it.each([
    ['gce_unsupported', 'rerun'],
    ['root_user', 'rerun'],
    ['homebrew_required', 'manual'],
  ] as const)('reports the %s pre-Node decision before mutation', (code, recoveryKind) => {
    if (code === 'homebrew_required') {
      executable('uname', 'echo Darwin');
      executable('sysctl', 'echo 8589934592');
    } else {
      executable('uname', 'echo Linux');
      executable('awk', 'echo 8192');
      executable('grep', code === 'gce_unsupported' ? 'exit 0' : 'exit 1');
      executable('id', code === 'root_user' ? 'echo 0' : 'echo 1000');
    }
    const result = spawnSync('bash', [path.join(fixtureRoot, 'nanoclaw.sh'), '--protocol', 'nanoclaw.driver.v1'], {
      cwd: fixtureRoot,
      env: {
        ...driverEnv(),
        PATH: `${path.join(fixtureRoot, 'fake-bin')}:/usr/bin:/bin`,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    const event = parseEvents(result.stdout).at(-1);
    expect(event?.code, `${result.stdout}\n${result.stderr}`).toBe(code);
    expect((event?.recovery as Array<{ kind: string }>)[0].kind).toBe(recoveryKind);
    expect(fs.existsSync(path.join(fixtureRoot, 'logs'))).toBe(false);
    expect(fs.existsSync(path.join(fixtureRoot, 'data'))).toBe(false);
  });

  it('rejects an unrecognized acknowledgement before creating setup state', () => {
    const result = spawnSync(
      'bash',
      [path.join(fixtureRoot, 'nanoclaw.sh'), '--protocol', 'nanoclaw.driver.v1', '--driver-ack', 'invented'],
      { cwd: fixtureRoot, env: driverEnv(), encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    const events = parseEvents(result.stdout);
    expect(events.map((event) => event.type)).toEqual(['hello', 'error']);
    expect(events[1].code).toBe('invalid_driver_ack');
    expect(fs.existsSync(path.join(fixtureRoot, 'logs'))).toBe(false);
    expect(fs.existsSync(path.join(fixtureRoot, 'data'))).toBe(false);
  });

  it('rejects duplicate versioned protocol flags with hello then typed error', () => {
    const result = spawnSync(
      'bash',
      [path.join(fixtureRoot, 'nanoclaw.sh'), '--protocol', 'nanoclaw.driver.v1', '--protocol', 'nanoclaw.driver.v1'],
      { cwd: fixtureRoot, env: driverEnv(), encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(parseEvents(result.stdout).map((event) => event.type)).toEqual(['hello', 'error']);
    expect(parseEvents(result.stdout).at(-1)?.code).toBe('duplicate_protocol');
    expect(fs.existsSync(path.join(fixtureRoot, 'logs'))).toBe(false);
  });

  it('preserves non-secret setup arguments in acknowledgement recovery', () => {
    const bin = path.join(fixtureRoot, 'fake-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'awk'), '#!/bin/sh\necho 1024\n', { mode: 0o755 });
    const result = spawnSync(
      'bash',
      [
        path.join(fixtureRoot, 'nanoclaw.sh'),
        '--display-name',
        'A "B"',
        '--protocol',
        'nanoclaw.driver.v1',
        '--driver-ack',
        'gce',
      ],
      {
        cwd: fixtureRoot,
        env: { ...driverEnv(), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(1);
    const events = parseEvents(result.stdout);
    expect(events.at(-1)?.code).toBe('low_memory');
    expect((events.at(-1)?.recovery as Array<{ args?: string[] }>)[0].args).toEqual([
      '--protocol',
      'nanoclaw.driver.v1',
      '--display-name',
      'A "B"',
      '--driver-ack',
      'gce',
      '--driver-ack',
      'low-memory',
    ]);
  });

  it.each([
    ['argument', ['--onecli-api-token', 'launch-secret'], {}],
    ['environment', [], { NANOCLAW_ONECLI_API_TOKEN: 'launch-secret' }],
    ['registry enrollment environment', [], { NANOCLAW_REGISTRY_ENROLL_CODE: 'launch-secret' }],
    ['registry token environment', [], { NANOCLAW_REGISTRY_TOKEN: 'launch-secret' }],
  ] as const)('rejects secret transport through the launch %s', (_source, args, extraEnv) => {
    const result = spawnSync(
      'bash',
      [path.join(fixtureRoot, 'nanoclaw.sh'), '--protocol', 'nanoclaw.driver.v1', ...args],
      { cwd: fixtureRoot, env: { ...driverEnv(), ...extraEnv }, encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(parseEvents(result.stdout).at(-1)?.code).toBe('secret_transport_forbidden');
    expect(`${result.stdout}${result.stderr}`).not.toContain('launch-secret');
  });

  it('rejects control characters before recovery JSON is constructed', () => {
    const result = spawnSync(
      'bash',
      [path.join(fixtureRoot, 'nanoclaw.sh'), '--protocol', 'nanoclaw.driver.v1', '--display-name', 'bad\u0001value'],
      { cwd: fixtureRoot, env: driverEnv(), encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(parseEvents(result.stdout).at(-1)?.code).toBe('invalid_arguments');
  });

  it('keeps terminal setup as the default path and preserves bootstrap ordering', () => {
    executable('uname', 'echo Darwin');
    executable('sysctl', 'echo 8589934592');
    executable('brew', 'exit 0');
    executable('pnpm', 'echo pnpm >> "$PWD/order"\necho "$*" > "$PWD/pnpm.args"\necho terminal-setup-child');
    fs.mkdirSync(path.join(fixtureRoot, 'assets'));
    fs.writeFileSync(path.join(fixtureRoot, 'assets', 'setup-splash.txt'), 'terminal-splash\n');
    fs.writeFileSync(
      path.join(fixtureRoot, 'setup.sh'),
      '#!/usr/bin/env bash\necho bootstrap >> "$PWD/order"\necho STATUS: success\n',
    );

    const result = spawnSync('bash', [path.join(fixtureRoot, 'nanoclaw.sh'), '--display-name', 'Terminal'], {
      cwd: fixtureRoot,
      env: {
        ...driverEnv(),
        PATH: `${path.join(fixtureRoot, 'fake-bin')}:/usr/bin:/bin`,
      },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('terminal-splash');
    expect(result.stdout).toContain('terminal-setup-child');
    expect(result.stdout.trimStart().startsWith('{')).toBe(false);
    expect(fs.readFileSync(path.join(fixtureRoot, 'order'), 'utf8').trim().split('\n')).toEqual(['bootstrap', 'pnpm']);
    expect(fs.readFileSync(path.join(fixtureRoot, 'pnpm.args'), 'utf8').trim()).toBe(
      '--silent run setup:auto --display-name Terminal',
    );
  });

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'turns a bootstrap %s into cancelled and exit 2',
    async (signal) => {
      fs.writeFileSync(path.join(fixtureRoot, 'setup.sh'), '#!/usr/bin/env bash\nexec sleep 30\n');
      const child = spawn(
        'bash',
        [path.join(fixtureRoot, 'nanoclaw.sh'), '--protocol', 'nanoclaw.driver.v1', ...ACKS],
        { cwd: fixtureRoot, env: driverEnv(), stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let signalled = false;
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (!signalled && stdout.includes('"stepId":"bootstrap"')) {
          signalled = true;
          child.kill(signal);
        }
      });

      const code = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });

      expect(code).toBe(2);
      const events = parseEvents(stdout);
      expect(events.filter((event) => event.type === 'hello')).toHaveLength(1);
      expect(events.at(-1)?.type).toBe('cancelled');
    },
    10_000,
  );
});
