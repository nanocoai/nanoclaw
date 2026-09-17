/**
 * vm-test-orchestrator component — VM lifecycle, sequential queue, pool
 * management. Implements pr-factory-core's `TestOrchestratorModule` and
 * registers on the test-orchestration seam at import time.
 *
 * Owns everything test-VM-facing. Never touches sessions, agents, Slack,
 * or verdicts — core's orchestrator.ts drives it through the seam and
 * receives results via the callbacks wired in `init()`.
 *
 * Entry point: `submitTest()` is called by core's testing-approval flow
 * after a human approves a test plan. The queue processes one test at a
 * time. VM lifecycle: clone → SSH wait → checkout PR → build → start →
 * stability check. On success: `onVmReady()` → core wakes the tester
 * agent. On failure: `onRunFailed()` → core posts the error to the thread.
 *
 * The VM provider is any host reachable over SSH that exposes
 * `cp <template> <name>` / `tag <name> ephemeral` / `rm <name>` commands
 * and DNS-resolvable per-VM hostnames (exe.dev's CLI shape; the defaults
 * below are its conventions). Install-specific knobs (.env, process.env
 * overrides):
 *
 *   PR_FACTORY_TEST_SSH_HOST    — control-plane host (default: exe.dev)
 *   PR_FACTORY_TEST_SSH_KEY    — ssh identity file for the control plane
 *                                 (default: ssh's own defaults)
 *   PR_FACTORY_TEST_VM_TEMPLATE — template VM cloned per test run
 *                                 (required to run tests)
 *   TEST_VM_SSH_USER            — login user on the per-test VMs
 *                                 (default: exedev)
 *   TEST_VM_NAME_PREFIX         — per-PR VM name prefix; the VM name is
 *                                 `<prefix><pr-number>` (default: nctest-)
 *   TEST_VM_HOST_TEMPLATE       — per-VM hostname template, `{name}`
 *                                 expands to the VM name
 *                                 (default: {name}.exe.xyz)
 *
 * Template VM contract (prepared once by the operator, see SKILL.md): the
 * project checked out at `~/nanoclaw`, buildable with `pnpm run build`, and
 * running as a systemd user service whose unit name contains `nanoclaw`.
 */
import { execFile } from 'child_process';

import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { getPrThreadByRepoPr } from '../../db/pr-threads.js';
import { getSession } from '../../db/sessions.js';
import {
  registerTestOrchestrator,
  type OrchestratorCallbacks,
  type TestOrchestratorModule,
  type TestRun,
} from './test-orchestration.js';

// ── Config ──

const testEnv = readEnvFile([
  'PR_FACTORY_TEST_SSH_HOST',
  'PR_FACTORY_TEST_SSH_KEY',
  'PR_FACTORY_TEST_VM_TEMPLATE',
  'TEST_VM_SSH_USER',
  'TEST_VM_NAME_PREFIX',
  'TEST_VM_HOST_TEMPLATE',
]);
const CONTROL_HOST = process.env.PR_FACTORY_TEST_SSH_HOST || testEnv.PR_FACTORY_TEST_SSH_HOST || 'exe.dev';
const CONTROL_SSH_KEY = process.env.PR_FACTORY_TEST_SSH_KEY || testEnv.PR_FACTORY_TEST_SSH_KEY || '';
const TEMPLATE_VM = process.env.PR_FACTORY_TEST_VM_TEMPLATE || testEnv.PR_FACTORY_TEST_VM_TEMPLATE || '';
const VM_SSH_USER = process.env.TEST_VM_SSH_USER || testEnv.TEST_VM_SSH_USER || 'exedev';
const VM_NAME_PREFIX = process.env.TEST_VM_NAME_PREFIX || testEnv.TEST_VM_NAME_PREFIX || 'nctest-';
const VM_HOST_TEMPLATE = process.env.TEST_VM_HOST_TEMPLATE || testEnv.TEST_VM_HOST_TEMPLATE || '{name}.exe.xyz';

const MAX_VMS = 20;

// Wait/poll intervals. Module-level so the PATH-shimmed ssh seam test can
// shrink them to milliseconds; production never touches the setter.
const timing = {
  sshWaitIntervalMs: 5_000,
  sshWaitTimeoutMs: 90_000,
  stabilityPollMs: 3_000,
  stabilityRequiredMs: 10_000,
  stabilityTimeoutMs: 60_000,
};

/** Test-only: override the wait/poll intervals. */
export function _setTimingForTest(overrides: Partial<typeof timing>): void {
  Object.assign(timing, overrides);
}

// ── State ──

export interface VmInfo {
  vmName: string;
  vmHost: string;
  prNumber: number;
  createdAt: number;
}

let callbacks: OrchestratorCallbacks | null = null;
const queue: TestRun[] = [];
let processing = false;
const activeVms = new Map<number, VmInfo>();

// ── SSH helpers ──

/**
 * Combine stderr + stdout + err.message into a single error string. SSH emits
 * useful failure details on stderr, but the inner command's failure can show
 * up on stdout. Joining both ensures we surface the real cause without
 * stripping benign warnings — those are already suppressed by LogLevel=ERROR.
 */
function sshError(err: Error, stdout: string, stderr: string): Error {
  const parts: string[] = [];
  const e = stderr?.trim();
  const o = stdout?.trim();
  if (e) parts.push(e);
  if (o) parts.push(o);
  return new Error(parts.length ? parts.join('\n---\n') : err.message);
}

function sshControl(args: string[]): Promise<string> {
  const keyArgs = CONTROL_SSH_KEY ? ['-i', CONTROL_SSH_KEY] : [];
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      [...keyArgs, '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR', CONTROL_HOST, ...args],
      { timeout: 120_000 },
      (err, stdout, stderr) => {
        if (err) return reject(sshError(err, String(stdout), String(stderr)));
        resolve(String(stdout).trim());
      },
    );
  });
}

function sshVm(vmHost: string, command: string, opts?: { timeout?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      [
        '-o',
        'ConnectTimeout=10',
        '-o',
        'LogLevel=ERROR',
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        `${VM_SSH_USER}@${vmHost}`,
        command,
      ],
      { timeout: opts?.timeout ?? 300_000 },
      (err, stdout, stderr) => {
        if (err) return reject(sshError(err, String(stdout), String(stderr)));
        resolve(String(stdout).trim());
      },
    );
  });
}

// ── VM lifecycle helpers ──

function vmName(prNumber: number): string {
  return `${VM_NAME_PREFIX}${prNumber}`;
}

function vmHost(prNumber: number): string {
  return VM_HOST_TEMPLATE.replace('{name}', vmName(prNumber));
}

async function enforcePoolLimit(): Promise<void> {
  if (activeVms.size < MAX_VMS) return;

  // Find oldest VM by createdAt
  let oldest: VmInfo | null = null;
  for (const vm of activeVms.values()) {
    if (!oldest || vm.createdAt < oldest.createdAt) oldest = vm;
  }
  if (!oldest) return;

  log.info('VM pool at limit, destroying oldest', { vmName: oldest.vmName, prNumber: oldest.prNumber });
  try {
    await sshControl(['rm', oldest.vmName]);
    // eslint-disable-next-line no-catch-all/no-catch-all -- best-effort pool eviction; the clone proceeds either way
  } catch (err) {
    log.warn('Failed to destroy oldest VM during pool enforcement', { vmName: oldest.vmName, err });
  }
  activeVms.delete(oldest.prNumber);
}

async function cloneVm(prNumber: number): Promise<string> {
  if (!TEMPLATE_VM) {
    throw new Error('PR_FACTORY_TEST_VM_TEMPLATE not set — cannot clone a test VM (see .env)');
  }
  const name = vmName(prNumber);
  const host = vmHost(prNumber);

  // If a VM already exists for this PR (e.g. re-test), destroy it first
  if (activeVms.has(prNumber)) {
    log.info('Destroying existing VM before clone', { vmName: name });
    try {
      await sshControl(['rm', name]);
      // eslint-disable-next-line no-catch-all/no-catch-all -- best-effort pre-clone cleanup; the clone is the operation that matters
    } catch {
      // already gone
    }
    activeVms.delete(prNumber);
  }

  await enforcePoolLimit();

  log.info('Cloning test VM', { template: TEMPLATE_VM, vmName: name });
  await sshControl(['cp', TEMPLATE_VM, name]);
  await sshControl(['tag', name, 'ephemeral']);
  activeVms.set(prNumber, { vmName: name, vmHost: host, prNumber, createdAt: Date.now() });
  return host;
}

async function waitForSsh(host: string): Promise<void> {
  const deadline = Date.now() + timing.sshWaitTimeoutMs;
  while (Date.now() < deadline) {
    try {
      await sshVm(host, 'echo ok', { timeout: 10_000 });
      return;
      // eslint-disable-next-line no-catch-all/no-catch-all -- polling: every failure means "not ready yet"
    } catch {
      // Not ready yet
    }
    await sleep(timing.sshWaitIntervalMs);
  }
  throw new Error(`SSH not available after ${timing.sshWaitTimeoutMs / 1000}s`);
}

async function checkoutPr(host: string, prNumber: number): Promise<void> {
  log.info('Checking out PR on test VM', { vmHost: host, prNumber });
  await sshVm(
    host,
    `cd ~/nanoclaw && git fetch origin pull/${prNumber}/head:pr-${prNumber} && git checkout pr-${prNumber}`,
    { timeout: 60_000 },
  );
}

async function startRuntime(host: string): Promise<void> {
  log.info('Building and starting runtime on test VM', { vmHost: host });
  await sshVm(host, 'cd ~/nanoclaw && pnpm run build', { timeout: 120_000 });
  await sshVm(
    host,
    "export XDG_RUNTIME_DIR=/run/user/$(id -u) && systemctl --user restart $(systemctl --user list-unit-files --type=service | grep nanoclaw | awk '{print $1}')",
    { timeout: 30_000 },
  );
}

async function waitForStability(host: string): Promise<void> {
  const deadline = Date.now() + timing.stabilityTimeoutMs;
  let stableSince: number | null = null;

  while (Date.now() < deadline) {
    try {
      const status = await sshVm(
        host,
        "export XDG_RUNTIME_DIR=/run/user/$(id -u) && systemctl --user is-active $(systemctl --user list-unit-files --type=service | grep nanoclaw | awk '{print $1}')",
        { timeout: 10_000 },
      );
      if (status === 'active') {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= timing.stabilityRequiredMs) return;
      } else {
        stableSince = null;
      }
      // eslint-disable-next-line no-catch-all/no-catch-all -- polling: every failure resets the stability window
    } catch {
      stableSince = null;
    }
    await sleep(timing.stabilityPollMs);
  }
  throw new Error(`Service not stable after ${timing.stabilityTimeoutMs / 1000}s`);
}

// ── Queue processing ──

async function processQueue(): Promise<void> {
  if (processing) return;
  if (queue.length === 0) return;

  processing = true;
  try {
    while (queue.length > 0) {
      const run = queue.shift()!;
      log.info('Dequeued test run', { prNumber: run.prNumber, repo: run.repo, queueDepth: queue.length });

      try {
        const host = await cloneVm(run.prNumber);
        await waitForSsh(host);
        await checkoutPr(host, run.prNumber);
        await startRuntime(host);
        await waitForStability(host);

        log.info('Test VM ready', { prNumber: run.prNumber, vmHost: host });
        await callbacks!.onVmReady(run.prNumber, run.repo, host, run.planContent);
        // eslint-disable-next-line no-catch-all/no-catch-all -- a failed VM setup is reported through onRunFailed, never thrown past the queue
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const pr = getPrThreadByRepoPr(run.repo, run.prNumber);
        const session = pr ? getSession(pr.session_id) : null;
        log.error('Test run failed during VM setup', {
          prNumber: run.prNumber,
          repo: run.repo,
          category: 'test-vm-setup',
          sessionId: pr?.session_id,
          agentGroup: session?.agent_group_id,
          threadTs: pr?.thread_ts,
          channelId: pr?.channel_id,
          err,
        });

        // Clean up the VM on failure
        try {
          await sshControl(['rm', vmName(run.prNumber)]);
          // eslint-disable-next-line no-catch-all/no-catch-all -- best-effort cleanup after a failed setup
        } catch {
          // best effort
        }
        activeVms.delete(run.prNumber);

        await callbacks!.onRunFailed(run.prNumber, run.repo, reason, run.planContent);
      }
    }
  } finally {
    processing = false;
  }
}

// ── TestOrchestratorModule implementation ──

function init(cbs: OrchestratorCallbacks): void {
  callbacks = cbs;
  log.info('Test orchestrator initialized');
}

function submitTest(run: TestRun): void {
  if (!callbacks) throw new Error('Test orchestrator not initialized');
  log.info('Test submitted', { prNumber: run.prNumber, repo: run.repo, queueDepth: queue.length });
  queue.push(run);
  processQueue().catch((err) => log.error('processQueue error', { err }));
}

/**
 * Mark a run as complete. The VM stays alive in the pool for investigation —
 * it leaves activeVms via destroyVm, pool enforcement, or shutdown.
 */
function completeRun(prNumber: number): void {
  log.info('Test run completed', { prNumber });
}

/** Cancel an active run (timeout path). Destroys the VM. */
async function cancelRun(prNumber: number): Promise<void> {
  log.info('Cancelling test run', { prNumber });
  await destroyVm(prNumber);
}

/** Destroy a test VM. Called on PR close/merge, timeout, and pool enforcement. */
async function destroyVm(prNumber: number): Promise<void> {
  const vm = activeVms.get(prNumber);
  if (!vm) return;

  log.info('Destroying test VM', { vmName: vm.vmName, prNumber });
  try {
    await sshControl(['rm', vm.vmName]);
    // eslint-disable-next-line no-catch-all/no-catch-all -- best-effort teardown; the pool entry is removed either way
  } catch (err) {
    log.warn('Failed to destroy test VM', { vmName: vm.vmName, err });
  }
  activeVms.delete(prNumber);
}

/** Shutdown: clear queue, destroy all VMs. */
async function shutdown(): Promise<void> {
  queue.length = 0;

  const destroys = Array.from(activeVms.values()).map(async (vm) => {
    try {
      await sshControl(['rm', vm.vmName]);
      // eslint-disable-next-line no-catch-all/no-catch-all -- best-effort teardown during shutdown
    } catch {
      // best effort
    }
  });
  await Promise.all(destroys);
  activeVms.clear();
  callbacks = null;
  log.info('Test orchestrator shut down');
}

registerTestOrchestrator({
  init,
  submitTest,
  completeRun,
  cancelRun,
  destroyVm,
  shutdown,
} satisfies TestOrchestratorModule);

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
