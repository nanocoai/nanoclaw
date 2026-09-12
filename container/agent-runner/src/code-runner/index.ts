/**
 * Code runner — the second runner type .
 *
 * Lives beside the chat runner in the same mounted source tree and the same
 * image; the host selects it at spawn time for code-mode groups. It never
 * imports chat composition (formatter, destinations addendum, dispatch
 * wrapping) — decontamination by omission, not by branching .
 *
 * Owns the persistent tmux session, mailbox delivery and the heartbeat that
 * keeps host-sweep liveness honest. The Host mediates terminal attachment
 * through the tmux client; disconnecting leaves the session running.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';

import { loadConfig } from '../config.js';
import { AGENT_STATE_PATH, readAgentState, readAttachActivityAt, writeAttachState } from './agent-state.js';
import { CHANNEL_SPOOL_DIR } from './channel-spool.js';
import { channelArgs, ensureChannelMcpConfig, ensureProjectMcpConsent, resolveChannelMode } from './channel-mode.js';
import { claudeArgs, resolvePermissionMode, resumeArgs } from './claude-args.js';
import { ensureClaudeState, hasResumableSession } from './claude-state.js';
import { heartbeatPath, touchHeartbeat } from './heartbeat-lease.js';
import { decideLiveness, resolveAttachIdleTtlMs, resolveIdleTtlMs, retirementNotice } from './liveness.js';
import { BUSY_STALE_MS, MailboxDeliveryLoop } from './mailbox.js';
import { ensureMailboxHooks, ensureTerminalDefaults } from './settings-hooks.js';
import { SESSION_TERM_ENV } from './term-env.js';
import { TmuxEvidence } from './tmux-evidence.js';
import { TmuxSession, TMUX_SOCKET_PATH } from './tmux-session.js';
// Capability barrel — registers the singular mailbox slot (the chat runner
// loads the same barrel at src/index.ts; a runner without it dies at boot on
// 'No agent mailbox registered' in clearStaleProcessingAcks).
import '../modules/index.js';
import { getAgentMailbox, readMailboxContext } from '../mailbox/index.js';
import type { AgentMailbox } from '../mailbox/types.js';

const WORKSPACE_DIR = '/workspace/group';

const config = loadConfig();

console.log(`[code-runner] boot group=${config.agentGroupId || 'unknown'}`);

if (config.codeMode !== true) {
  console.error('[code-runner] spawned for a group whose config does not set code_mode — refusing (selection bug)');
  process.exit(1);
}

let heartbeatWarned = false;
function beat(): void {
  if (touchHeartbeat()) return;
  if (heartbeatWarned) return;
  heartbeatWarned = true;
  console.error(`[code-runner] heartbeat not writable at ${heartbeatPath()} — continuing; check the heartbeat mount`);
}

/**
 * Exit only after the registered mailbox has flushed. Bounded, because a
 * store that cannot be reached must not outlive the signal that asked this
 * process to go — the acks it still holds are recoverable (an unacked claim
 * is re-delivered), a container that will not die is not.
 *
 * An incomplete flush is the one new failure mode this wait introduces, so
 * both of its shapes SAY so before the exit: on this box the container log
 * is all anybody gets, and "mail went missing after a restart" is
 * unanswerable if the last thing the runner did was swallow the reason.
 */
function exitAfterMailboxFlush(mailbox: AgentMailbox, code: number): void {
  const flushed = mailbox.stop().then(
    () => true,
    (error) => {
      console.error('[code-runner] mailbox flush failed on exit — unacked claims will be redelivered:', error);
      return true; // reported, not survivable: go.
    },
  );
  const deadline = Bun.sleep(2_000).then(() => false);
  void Promise.race([flushed, deadline]).then((done) => {
    if (!done) {
      console.error(
        '[code-runner] mailbox did not flush within 2s — exiting anyway; unacked claims will be redelivered',
      );
    }
    process.exit(code);
  });
}

function sessionEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, SESSION_TERM_ENV);
  return env;
}

async function main(): Promise<void> {
  const probe = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    throw new Error('Code mode requires tmux in the agent image; install tmux and rebuild the image.');
  }
  const bootAt = Date.now();
  // Unconditional boot stamp: a heartbeat file that never existed is
  // invisible to host-sweep's kill ceiling. The lease below only decides
  // whether to KEEP refreshing it .
  beat();

  // Open the registered mailbox for THIS session before anything reads it.
  // The chat runner does the same at src/index.ts and every `ncl` invocation
  // opens its own — the seam is per-process, and start() is where an
  // implementation learns which session it serves. The SQLite driver reaches
  // its files by fixed path and so survived the omission; an implementation
  // that is not a file cannot, and without this the delivery loop would read
  // an empty mailbox forever while the first outbox write threw.
  const agentMailbox = getAgentMailbox();
  await agentMailbox.start(await readMailboxContext());

  // Register the idle/busy + notify hooks BEFORE the session spawns, so the
  // interactive CLI reads settings.json with them already in place .
  ensureMailboxHooks();
  // …and its first-run state, or every disposable container stops at a folder-trust
  // dialog no one is attached to answer.
  const permissionMode = resolvePermissionMode(process.env.NANOCLAW_CODE_PERMISSION_MODE);
  ensureClaudeState(WORKSPACE_DIR, permissionMode === 'bypass');
  // Channel transport: the server registration and the project-MCP
  // consent must also predate the spawn — claude reads both at startup.
  const channelMode = resolveChannelMode(process.env.NANOCLAW_CODE_CHANNELS);
  if (channelMode !== 'off') {
    ensureChannelMcpConfig(WORKSPACE_DIR);
    ensureProjectMcpConsent();
  }

  // Seed fullscreen defaults; `/tui` stays the operator's choice.
  ensureTerminalDefaults();

  // A reap stops being amnesia. The CLI's session store rides the
  // durable ~/.claude mount, so a post-reap boot finds the reaped
  // conversation and resumes it with `--continue`; a fresh workspace finds
  // nothing and boots with exactly the argv it always did. If the resume
  // dies at the gate (state the CLI cannot load), the session's first-life
  // fallback drops the flag and boots fresh — loudly, in this log.
  const resumable = hasResumableSession(WORKSPACE_DIR);
  const freshBootArgs = [...claudeArgs(config.model, permissionMode), ...channelArgs(channelMode)];
  if (resumable) console.log('[code-runner] prior CLI session state found — resuming with --continue');
  const sessionOptions = {
    command: 'claude',
    args: [...freshBootArgs, ...resumeArgs(resumable)],
    ...(resumable ? { fallbackArgs: freshBootArgs } : {}),
    cwd: WORKSPACE_DIR,
    env: sessionEnv(),
    // Every child life starts unready: a dead life's idle/busy stamp must
    // never gate injection into a booting TUI (mail would be acked and
    // lost). Deleting the state file re-arms the mailbox readiness hold
    // until THIS life's SessionStart hook fires.
    onSpawn: () => fs.rmSync(AGENT_STATE_PATH, { force: true }),
  };

  const session = new TmuxSession(sessionOptions);
  await session.start();
  const presence = new TmuxEvidence();
  presence.start();
  // Only tmux's live clients supply human presence for approvals and leases.
  const stampAttach = (count: number) =>
    writeAttachState(count, undefined, {
      lastInputAt: presence.lastClientInputAt,
      lastConnectAt: presence.lastClientConnectAt,
    });

  let lastSig = '';
  const presenceTimer = setInterval(() => {
    const sig = `${presence.clientCount}:${presence.lastClientInputAt}:${presence.lastClientConnectAt}`;
    if (sig !== lastSig) {
      lastSig = sig;
      stampAttach(presence.clientCount);
    }
  }, 1_000);
  // Boot stamp: a fresh life starts detached — hooks reading a file that was
  // never written (or a torn one) also read detached, the escalating end.
  stampAttach(presence.clientCount);

  const deliveryLoop = new MailboxDeliveryLoop({
    session,
    lastOperatorInputAt: () => presence.lastClientInputAt,
    ...(channelMode !== 'off' ? { channelSpoolDir: CHANNEL_SPOOL_DIR } : {}),
  });
  deliveryLoop.start();
  console.log(
    `[code-runner] session up — tmux socket at ${TMUX_SOCKET_PATH}, mailbox loop running (${channelMode !== 'off' ? `channel transport, mode ${channelMode}` : 'typing transport'})`,
  );

  // The heartbeat is a lease, not a pulse: refresh only while the session is
  // observably in use, else exit 0 and let the host respawn on demand .
  const idleTtlMs = resolveIdleTtlMs();
  const attachIdleTtlMs = resolveAttachIdleTtlMs();
  let retiring = false;
  const lease = setInterval(() => {
    // Freshness heartbeat for the attach stamp: a stamp only ever written on
    // connect/disconnect goes stale during a long quiet attach, and the
    // boundary hook treats a stale stamp as detached (ATTACH_STAMP_FRESH_MS).
    stampAttach(presence.clientCount);
    const state = readAgentState();
    const stateAt = state ? Date.parse(state.at) : NaN;
    const busyUntilAt = state?.busyUntil ? Date.parse(state.busyUntil) : NaN;
    const now = Date.now();
    const liveClientAt = presence.attachedClientActivityAt;
    const decision = decideLiveness({
      now,
      bootAt,
      clientCount: presence.clientCount,
      agentState:
        state && Number.isFinite(stateAt)
          ? { state: state.state, at: stateAt, busyUntil: Number.isFinite(busyUntilAt) ? busyUntilAt : undefined }
          : undefined,
      lastClientInputAt: presence.lastClientInputAt,
      lastClientConnectAt: presence.lastClientConnectAt,
      lastInjectionAt: deliveryLoop.lastInjectionAt,
      lastAttachExecAt: readAttachActivityAt(),
      attachedClientIdleMs: liveClientAt !== undefined ? Math.max(0, now - liveClientAt) : undefined,
      idleTtlMs,
      attachIdleTtlMs,
      busyStaleMs: BUSY_STALE_MS,
    });
    if (decision.alive) {
      beat();
      return;
    }
    if (retiring) return;
    retiring = true;
    clearInterval(lease);
    console.log(`[code-runner] idle lease expired (${decision.reason}) — exiting`);
    // An operator still attached would otherwise watch the container vanish
    // under the terminal: mouse reporting left on, no word why. Detach the
    // clients cleanly first, the reason on their terminal; bounded, and the
    // exit does not depend on it.
    const retire =
      presence.clientCount > 0
        ? session
            .detachClients(retirementNotice(liveClientAt !== undefined ? now - liveClientAt : idleTtlMs))
            .then((gone) => {
              if (!gone) console.error('[code-runner] attached clients did not detach in time — exiting anyway');
            })
        : Promise.resolve();
    void retire.finally(() => exitAfterMailboxFlush(agentMailbox, 0));
  }, 30_000);

  const shutdown = (signal: string) => {
    console.log(`[code-runner] ${signal} — shutting down`);
    deliveryLoop.stop();
    clearInterval(presenceTimer);
    presence.stop();
    session.dispose();
    exitAfterMailboxFlush(agentMailbox, 0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[code-runner] fatal:', error);
  process.exit(1);
});
