import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getInstallSlug } from '../../src/install-slug.js';

const ROOT = process.cwd();
const TSX_LOADER = import.meta.resolve('tsx');
const AUTO = path.join(ROOT, 'setup', 'auto.ts');
const envelope = { protocol: 'nanoclaw.driver.v1', operation: 'uninstall' } as const;

type Child = ReturnType<typeof spawn>;
type Event = Record<string, unknown>;
type Artifact = { id: string; kind: string; location: string; disposition: string };

let installRoot: string;

beforeEach(() => {
  installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-uninstall-protocol-'));
});

afterEach(() => {
  fs.rmSync(installRoot, { recursive: true, force: true });
});

function start(env: NodeJS.ProcessEnv = {}): Child {
  return spawn(process.execPath, ['--import', TSX_LOADER, AUTO, '--uninstall'], {
    cwd: installRoot,
    env: {
      ...process.env,
      NANOCLAW_PROTOCOL: 'nanoclaw.driver.v1',
      NANOCLAW_OPERATION: 'uninstall',
      NANOCLAW_NO_DIAGNOSTICS: '1',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function installEmptyOnecli(): string {
  const fakeBin = path.join(installRoot, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'onecli'), '#!/bin/sh\nprintf %s \'{"data":[]}\'\n', { mode: 0o755 });
  return fakeBin;
}

function choices(service: 'preserve' | 'remove', data: 'preserve' | 'remove') {
  return [
    { groupId: 'service', choice: service },
    { groupId: 'data', choice: data },
    { groupId: 'user', choice: 'preserve' },
    { groupId: 'onecli', choice: 'preserve' },
  ];
}

function apply(child: Child, planId: string, values = choices('preserve', 'preserve')): void {
  child.stdin!.write(
    `${JSON.stringify({
      ...envelope,
      type: 'applyUninstall',
      planId,
      choices: values,
    })}\n`,
  );
}

async function collect(
  child: Child,
  onEvent: (event: Event) => void,
): Promise<{ code: number | null; stdout: string; stderr: string; events: Event[] }> {
  const events: Event[] = [];
  let stdout = '';
  let stderr = '';
  let buffer = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stdout += text;
    buffer += text;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line) as Event;
      events.push(event);
      onEvent(event);
    }
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, stdout, stderr, events };
}

function planItems(events: Event[]): Artifact[] {
  return events.filter((event) => event.type === 'uninstallPlanItem').map((event) => event.artifact as Artifact);
}

function receiptItems(events: Event[]): Artifact[] {
  return events.filter((event) => event.type === 'uninstallReceiptItem').map((event) => event.artifact as Artifact);
}

describe('machine uninstall session', () => {
  it('rejects unsafe choices, then preserves the four-group streamed plan', async () => {
    const child = start();
    let answered = false;
    const result = await collect(child, (event) => {
      if (event.type !== 'uninstallPlan' || answered) return;
      answered = true;
      const plan = event.plan as { id: string; groups: Array<{ id: string; default: string }> };
      expect(plan).not.toHaveProperty('artifacts');
      expect(plan.groups.map((group) => group.id)).toEqual(['service', 'data', 'user', 'onecli']);
      expect(plan.groups.every((group) => group.default === 'preserve')).toBe(true);
      apply(child, plan.id, choices('preserve', 'remove'));
      apply(child, plan.id);
    });

    const items = planItems(result.events);
    const actions = result.events
      .filter((event) => event.type === 'uninstallAction')
      .map((event) => event.result as { artifactId: string });
    const complete = result.events.find((event) => event.type === 'complete') as {
      receipt: { outcome: string };
    };

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout[0]).toBe('{');
    expect(result.events.filter((event) => event.type === 'hello')).toHaveLength(1);
    expect(
      result.events.some((event) => event.type === 'inputRejected' && event.code === 'unsafe_uninstall_choices'),
    ).toBe(true);
    expect(new Set(actions.map((action) => action.artifactId))).toEqual(new Set(items.map((item) => item.id)));
    expect(complete.receipt.outcome).toBe('success');
    expect(complete.receipt).not.toHaveProperty('results');
    expect(complete.receipt).not.toHaveProperty('remaining');
    expect(result.events.some((event) => String(event.type).includes('Page'))).toBe(false);
    expect(fs.readdirSync(installRoot)).toEqual([]);
  }, 15_000);

  it('rejects app-data deletion when OneCLI cannot be inspected', async () => {
    const fakeBin = path.join(installRoot, 'fake-unavailable-bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'onecli'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const localBin = path.join(os.homedir(), '.local', 'bin');
    const child = start({ PATH: `${fakeBin}${path.delimiter}${localBin}` });
    let answered = false;
    const result = await collect(child, (event) => {
      if (event.type !== 'uninstallPlan' || answered) return;
      answered = true;
      const planId = (event.plan as { id: string }).id;
      apply(child, planId, choices('remove', 'remove'));
      apply(child, planId);
    });

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'inputRejected',
        code: 'unsafe_uninstall_choices',
        message: expect.stringContaining('Restore OneCLI'),
      }),
    );
  }, 15_000);

  it('skips a replaced data directory while removing an unchanged logs directory', async () => {
    const data = path.join(installRoot, 'data');
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'approved.txt'), 'approved');
    const logs = path.join(installRoot, 'logs');
    fs.mkdirSync(logs);
    fs.writeFileSync(path.join(logs, 'remove.txt'), 'remove');
    const fakeBin = installEmptyOnecli();
    const child = start({ PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` });
    const result = await collect(child, (event) => {
      if (event.type !== 'uninstallPlan') return;
      fs.renameSync(data, path.join(installRoot, 'data.old'));
      fs.mkdirSync(data);
      fs.writeFileSync(path.join(data, 'replacement.txt'), 'replacement');
      apply(child, (event.plan as { id: string }).id, choices('remove', 'remove'));
    });

    const complete = result.events.find((event) => event.type === 'complete') as {
      receipt: { outcome: string };
    };
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(complete.receipt.outcome).toBe('incomplete');
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'uninstallAction',
        result: expect.objectContaining({
          outcome: 'untouched',
          error: expect.objectContaining({ code: 'ownership_root_changed' }),
        }),
      }),
    );
    expect(fs.readFileSync(path.join(data, 'replacement.txt'), 'utf8')).toBe('replacement');
    expect(fs.readFileSync(path.join(installRoot, 'data.old', 'approved.txt'), 'utf8')).toBe('approved');
    expect(fs.existsSync(logs)).toBe(false);
  }, 15_000);

  it('streams the external credential backup after successful .env removal', async () => {
    fs.writeFileSync(path.join(installRoot, '.env'), 'TOKEN=fixture-secret');
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-uninstall-backup-home-'));
    const runtime = path.join(installRoot, 'fake-container-runtime');
    const fakeBin = path.join(installRoot, 'fake-bin');
    fs.writeFileSync(runtime, '#!/bin/sh\n[ "$1" = ps ] && exit 0\nexit 1\n', { mode: 0o755 });
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'onecli'), '#!/bin/sh\nprintf %s \'{"data":[]}\'\n', { mode: 0o755 });

    try {
      const child = start({
        HOME: testHome,
        CONTAINER_RUNTIME: runtime,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      });
      const result = await collect(child, (event) => {
        if (event.type === 'uninstallPlan') {
          apply(child, (event.plan as { id: string }).id, choices('remove', 'remove'));
        }
      });
      const complete = result.events.find((event) => event.type === 'complete') as {
        receipt: { outcome: string; checkoutRemoval: { safe: boolean; blockers: string[] } };
      };
      const backupRoot = path.join(
        testHome,
        'Library',
        'Application Support',
        'NanoClaw',
        'uninstall-backups',
        getInstallSlug(fs.realpathSync(installRoot)),
      );
      const backupPath = path.join(backupRoot, '.env.bak');

      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(complete.receipt).toEqual(
        expect.objectContaining({
          outcome: 'success',
          checkoutRemoval: { safe: true, blockers: [] },
        }),
      );
      expect(receiptItems(result.events)).toContainEqual(
        expect.objectContaining({
          kind: 'credential-backup',
          location: backupPath,
          disposition: 'external',
        }),
      );
      expect(fs.readFileSync(backupPath, 'utf8')).toBe('TOKEN=fixture-secret');
      expect(fs.statSync(backupRoot).mode & 0o777).toBe(0o700);
      expect(fs.statSync(backupPath).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(result.events)).not.toContain('fixture-secret');
    } finally {
      fs.rmSync(testHome, { recursive: true, force: true });
    }
  }, 15_000);

  it('stops before the next action when cancelled during apply', async () => {
    fs.writeFileSync(path.join(installRoot, '.env'), 'TOKEN=still-here');
    const fakeBin = path.join(installRoot, 'fake-bin');
    const runtime = path.join(installRoot, 'fake-runtime');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'onecli'), '#!/bin/sh\nprintf %s \'{"data":[]}\'\n', { mode: 0o755 });
    fs.writeFileSync(runtime, '#!/bin/sh\n[ "$1" = ps ] && exit 0\nexit 1\n', { mode: 0o755 });

    const child = start({
      CONTAINER_RUNTIME: runtime,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    });
    let cancelled = false;
    const result = await collect(child, (event) => {
      if (event.type === 'uninstallPlan') {
        apply(child, (event.plan as { id: string }).id, choices('remove', 'remove'));
      } else if (event.type === 'uninstallAction' && !cancelled) {
        const action = event.result as { actionId: string };
        if (!action.actionId.startsWith('preserve-')) {
          cancelled = true;
          child.stdin!.write(`${JSON.stringify({ ...envelope, type: 'cancel', reason: 'stop now' })}\n`);
        }
      }
    });

    const terminal = result.events.at(-1) as Event;
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(2);
    expect(terminal.type).toBe('cancelled');
    expect(terminal).not.toHaveProperty('results');
    expect(terminal).not.toHaveProperty('remaining');
    expect(receiptItems(result.events)).toContainEqual(
      expect.objectContaining({
        location: path.join(fs.realpathSync(installRoot), '.env'),
      }),
    );
    expect(fs.readFileSync(path.join(installRoot, '.env'), 'utf8')).toBe('TOKEN=still-here');
  }, 15_000);

  it('streams a large plan and one result per artifact without pagination', async () => {
    const fakeBin = path.join(installRoot, 'fake-bin');
    const runtime = path.join(installRoot, 'fake-runtime');
    fs.mkdirSync(fakeBin);
    const agents = Array.from({ length: 65 }, (_, index) => ({
      id: `agent-${index}`,
      identifier: `ag-${index}`,
      name: `Agent ${index}`,
      isDefault: false,
    }));
    fs.writeFileSync(
      path.join(fakeBin, 'onecli'),
      `#!/bin/sh\nprintf %s ${JSON.stringify(JSON.stringify({ data: agents }))}\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(fakeBin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(runtime, '#!/bin/sh\n[ "$1" = ps ] && exit 0\nexit 1\n', { mode: 0o755 });

    const child = start({
      CONTAINER_RUNTIME: runtime,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    });
    const result = await collect(child, (event) => {
      if (event.type === 'uninstallPlan') apply(child, (event.plan as { id: string }).id);
    });
    const artifacts = planItems(result.events);
    const actionIds = result.events
      .filter((event) => event.type === 'uninstallAction')
      .map((event) => (event.result as { artifactId: string }).artifactId);

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(artifacts.length).toBeGreaterThan(65);
    expect(new Set(actionIds)).toEqual(new Set(artifacts.map((artifact) => artifact.id)));
    expect(result.events.some((event) => String(event.type).includes('Page'))).toBe(false);
  }, 15_000);
});
