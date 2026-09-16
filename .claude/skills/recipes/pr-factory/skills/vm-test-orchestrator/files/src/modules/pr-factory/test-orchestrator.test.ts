/**
 * vm-test-orchestrator component guard — the modules-barrel line (`import
 * './pr-factory/test-orchestrator.js'` in src/modules/index.ts), the
 * registration on pr-factory-core's test-orchestration seam, and the module's
 * conformance to the TestOrchestratorModule contract, driven through the REAL
 * queue against a PATH-shimmed `ssh` binary.
 *
 * The shim logs every invocation's argv and answers like a healthy control
 * plane + VM (prints `active` for the systemd stability probe), so the full
 * lifecycle — clone, tag, SSH wait, PR checkout, build, restart, stability —
 * runs for real with only the network edge faked. Timing knobs are shrunk via
 * the module's test-only _setTimingForTest so the polls complete in
 * milliseconds.
 *
 * Pins the install-specific parameterization (TEST_VM_SSH_USER /
 * TEST_VM_NAME_PREFIX / TEST_VM_HOST_TEMPLATE / PR_FACTORY_TEST_SSH_HOST) in
 * one generation and the documented exe.dev defaults (exedev@,
 * nctest-<pr>.exe.xyz) in a second, and the failure path's consumption of
 * core's pr_threads/session reads on a real migrated DB.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-prf-vmorch/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-prf-vmorch/groups',
  };
});

import type { TestOrchestratorModule } from './test-orchestration.js';

const TEST_DIR = '/tmp/nanoclaw-test-prf-vmorch';
const SSH_LOG = path.join(TEST_DIR, 'ssh-calls.log');
const SSH_FAIL_FLAG = path.join(TEST_DIR, 'ssh-fail-flag');
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_PATH = process.env.PATH;
const REPO = 'acme/widgets';

const KNOB_KEYS = [
  'PR_FACTORY_TEST_SSH_HOST',
  'PR_FACTORY_TEST_SSH_KEY',
  'PR_FACTORY_TEST_VM_TEMPLATE',
  'TEST_VM_SSH_USER',
  'TEST_VM_NAME_PREFIX',
  'TEST_VM_HOST_TEMPLATE',
];

const FAST_TIMING = {
  sshWaitIntervalMs: 5,
  sshWaitTimeoutMs: 2_000,
  stabilityPollMs: 5,
  stabilityRequiredMs: 0,
  stabilityTimeoutMs: 2_000,
};

let mod: TestOrchestratorModule;
let closeDbFn: () => void;

function sshCalls(): string[] {
  if (!fs.existsSync(SSH_LOG)) return [];
  return fs.readFileSync(SSH_LOG, 'utf8').trim().split('\n').filter(Boolean);
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function now(): string {
  return new Date().toISOString();
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_DIR, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'data'), { recursive: true });

  // Fake ssh: logs argv tab-separated, fails when the flag file exists,
  // answers the systemd stability probe with `active`.
  const shim = [
    '#!/bin/sh',
    `LOG="${SSH_LOG}"`,
    'out=""',
    'for a in "$@"; do out="$out$a\t"; done',
    'printf \'%s\\n\' "$out" >> "$LOG"',
    `if [ -e "${SSH_FAIL_FLAG}" ]; then echo "clone failed: quota exceeded" >&2; exit 1; fi`,
    'case "$*" in',
    '  *is-active*) echo "active" ;;',
    '  *) echo "ok" ;;',
    'esac',
  ].join('\n');
  fs.writeFileSync(path.join(TEST_DIR, 'bin', 'ssh'), shim, { mode: 0o755 });
  process.env.PATH = `${path.join(TEST_DIR, 'bin')}:${process.env.PATH}`;

  // readEnvFile resolves .env from cwd — run from a dir guaranteed to have none.
  process.chdir(TEST_DIR);
  for (const k of [...KNOB_KEYS, 'GITHUB_WEBHOOK_SECRET', 'PR_FACTORY_SLACK_CHANNEL_ID', 'SLACK_BOT_TOKEN']) {
    delete process.env[k];
  }

  // Generation 1: every install-specific knob overridden — pins that nothing
  // exe.dev-shaped is hard-coded in the SSH plumbing.
  process.env.PR_FACTORY_TEST_SSH_HOST = 'control.vms.test';
  process.env.PR_FACTORY_TEST_VM_TEMPLATE = 'tmpl-nc';
  process.env.TEST_VM_SSH_USER = 'vmtester';
  process.env.TEST_VM_NAME_PREFIX = 'pvt-';
  process.env.TEST_VM_HOST_TEMPLATE = '{name}.vms.test';

  const dbMod = await import('../../db/index.js');
  const db = dbMod.initTestDb();
  dbMod.runMigrations(db);
  closeDbFn = dbMod.closeDb;
  dbMod.createAgentGroup({ id: 'ag-w', name: 'W', folder: 'w', agent_provider: null, created_at: now() });
  const { createSession } = await import('../../db/sessions.js');
  createSession({
    id: 'sess-43',
    agent_group_id: 'ag-w',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  const { createPrThread } = await import('../../db/pr-threads.js');
  createPrThread({
    channel_id: 'slack:C0WORK',
    thread_ts: '1700000000.000043',
    channel_type: 'slack',
    repo_full_name: REPO,
    pr_number: 43,
    session_id: 'sess-43',
    created_at: now(),
  });

  await import('../index.js'); // the REAL modules barrel — the line under guard lives here
  const { getTestOrchestrator } = await import('./test-orchestration.js');
  const registered = getTestOrchestrator();
  expect(registered, 'no TestOrchestratorModule registered — barrel line missing?').not.toBeNull();
  mod = registered!;
  (await import('./test-orchestrator.js'))._setTimingForTest(FAST_TIMING);
});

afterAll(async () => {
  await mod?.shutdown();
  closeDbFn?.();
  process.chdir(ORIGINAL_CWD);
  process.env.PATH = ORIGINAL_PATH;
  for (const k of KNOB_KEYS) delete process.env[k];
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(SSH_LOG, { force: true });
  fs.rmSync(SSH_FAIL_FLAG, { force: true });
});

describe('vm-test-orchestrator through the real queue (parameterized knobs)', () => {
  it('submitTest runs the full VM lifecycle over shimmed ssh and reports the knob-derived host via onVmReady', async () => {
    const ready = deferred<{ prNumber: number; repo: string; vmHost: string; planContent: string }>();
    const onRunFailed = vi.fn().mockResolvedValue(undefined);
    mod.init({
      onVmReady: async (prNumber, repo, vmHost, planContent) => ready.resolve({ prNumber, repo, vmHost, planContent }),
      onRunFailed,
    });

    mod.submitTest({ prNumber: 42, repo: REPO, planContent: '## Plan body' });
    const result = await ready.promise;

    expect(result).toEqual({ prNumber: 42, repo: REPO, vmHost: 'pvt-42.vms.test', planContent: '## Plan body' });
    expect(onRunFailed).not.toHaveBeenCalled();

    const calls = sshCalls();
    // Control plane: clone + ephemeral tag against the configured host.
    expect(calls.some((c) => c.includes('control.vms.test\tcp\ttmpl-nc\tpvt-42'))).toBe(true);
    expect(calls.some((c) => c.includes('control.vms.test\ttag\tpvt-42\tephemeral'))).toBe(true);
    // VM side: every command logs in as <TEST_VM_SSH_USER>@<templated host>.
    expect(calls.some((c) => c.includes('vmtester@pvt-42.vms.test\techo ok'))).toBe(true);
    expect(
      calls.some((c) => c.includes('vmtester@pvt-42.vms.test') && c.includes('git fetch origin pull/42/head')),
    ).toBe(true);
    expect(calls.some((c) => c.includes('vmtester@pvt-42.vms.test') && c.includes('pnpm run build'))).toBe(true);
    expect(calls.some((c) => c.includes('vmtester@pvt-42.vms.test') && c.includes('is-active'))).toBe(true);
    // Nothing exe.dev-shaped leaked past the knobs.
    expect(calls.join('\n')).not.toContain('exe.dev');
    expect(calls.join('\n')).not.toContain('exedev@');
  });

  it('destroyVm tears the per-PR VM down through the control plane', async () => {
    await mod.destroyVm(42);
    expect(sshCalls().some((c) => c.includes('control.vms.test\trm\tpvt-42'))).toBe(true);
    // Idempotent: a second destroy finds no pool entry and makes no ssh call.
    fs.rmSync(SSH_LOG, { force: true });
    await mod.destroyVm(42);
    expect(sshCalls()).toEqual([]);
  });

  it('a failed VM setup reports through onRunFailed (with core pr_threads/session context reads) and cleans up', async () => {
    fs.writeFileSync(SSH_FAIL_FLAG, '1');
    const failed = deferred<{ prNumber: number; reason: string }>();
    mod.init({
      onVmReady: vi.fn().mockResolvedValue(undefined),
      onRunFailed: async (prNumber, _repo, reason) => failed.resolve({ prNumber, reason }),
    });

    mod.submitTest({ prNumber: 43, repo: REPO, planContent: '## Plan' });
    const result = await failed.promise;

    expect(result.prNumber).toBe(43);
    expect(result.reason).toContain('quota exceeded');
    // Cleanup was attempted even though the control plane was down.
    expect(sshCalls().some((c) => c.includes('control.vms.test\trm\tpvt-43'))).toBe(true);
  });

  it('shutdown destroys pooled VMs and drops the callbacks', async () => {
    await mod.shutdown();
    expect(() => mod.submitTest({ prNumber: 1, repo: REPO, planContent: 'x' })).toThrow('not initialized');
  });
});

describe('documented defaults (fresh module generation, no TEST_VM_* knobs)', () => {
  it('pins the exe.dev shape: exedev@nctest-<pr>.exe.xyz via the exe.dev control plane', async () => {
    vi.resetModules();
    for (const k of KNOB_KEYS) delete process.env[k];
    process.env.PR_FACTORY_TEST_VM_TEMPLATE = 'tmpl-nc';

    await import('../index.js');
    const { getTestOrchestrator } = await import('./test-orchestration.js');
    const fresh = getTestOrchestrator()!;
    expect(fresh).not.toBeNull();
    (await import('./test-orchestrator.js'))._setTimingForTest(FAST_TIMING);

    const ready = deferred<string>();
    fresh.init({
      onVmReady: async (_pr, _repo, vmHost) => ready.resolve(vmHost),
      onRunFailed: vi.fn().mockResolvedValue(undefined),
    });
    fresh.submitTest({ prNumber: 7, repo: REPO, planContent: 'plan' });

    expect(await ready.promise).toBe('nctest-7.exe.xyz');
    const calls = sshCalls();
    expect(calls.some((c) => c.includes('exe.dev\tcp\ttmpl-nc\tnctest-7'))).toBe(true);
    expect(calls.some((c) => c.includes('exedev@nctest-7.exe.xyz\techo ok'))).toBe(true);

    await fresh.shutdown();
  });
});
