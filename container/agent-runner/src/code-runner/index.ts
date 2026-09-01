/**
 * Code runner — the second runner type (sandbox-spec D13, D15, D22).
 *
 * Lives beside the chat runner in the same mounted source tree and the same
 * image; the host selects it at spawn time for code-mode groups. It never
 * imports chat composition (formatter, destinations addendum, dispatch
 * wrapping) — decontamination by omission, not by branching (D16/D22).
 *
 * What it owns: the persistent interactive PTY session (the agent works
 * here; connect and disconnect freely, the session persists — D2/D15), the
 * attach socket the host mediates every connection through (D20/D22), and
 * the heartbeat that keeps host-sweep liveness honest (D14).
 */
import { spawnSync } from 'child_process';
import fs from 'fs';

import { loadConfig } from '../config.js';
import { AGENT_STATE_PATH, readAgentState, readDoorActivityAt, writeAttachState } from './agent-state.js';
import { AttachServer, ATTACH_SOCKET_PATH } from './attach-server.js';
import { CHANNEL_SPOOL_DIR } from './channel-spool.js';
import { channelArgs, ensureChannelMcpConfig, ensureProjectMcpConsent, resolveChannelMode } from './channel-mode.js';
import { claudeArgs, resolvePermissionMode, resumeArgs } from './claude-args.js';
import { ensureClaudeState, hasResumableSession } from './claude-state.js';
import { decideLiveness, resolveAttachIdleTtlMs, resolveIdleTtlMs } from './liveness.js';
import { BUSY_STALE_MS, MailboxDeliveryLoop } from './mailbox.js';
import { PtySession } from './pty-session.js';
import { ensureMailboxHooks, ensureTerminalDefaults, PROVIDER_KEY_ENV } from './settings-hooks.js';
import { SESSION_TERM_ENV } from './term-env.js';
import { TmuxEvidence } from './tmux-evidence.js';
import { TmuxSession, TMUX_SOCKET_PATH } from './tmux-session.js';
// Capability barrel — registers the singular mailbox slot (the chat runner
// loads the same barrel at src/index.ts; a runner without it dies at boot on
// 'No agent mailbox registered' in clearStaleProcessingAcks, 2026-08-21).
import '../modules/index.js';
import { getAgentMailbox, readMailboxContext } from '../mailbox/index.js';
import type { AgentMailbox } from '../mailbox/types.js';

// Same path the chat runner's liveness contract uses (heartbeat.ts).
const HEARTBEAT_PATH = '/workspace/.heartbeat';
const WORKSPACE_DIR = '/workspace/group';

const config = loadConfig();

console.log(`[code-runner] boot group=${config.agentGroupId || 'unknown'}`);

if (config.codeMode !== true) {
  console.error('[code-runner] spawned for a group whose config does not set code_mode — refusing (selection bug)');
  process.exit(1);
}

function touchHeartbeat(): void {
  try {
    const now = new Date();
    fs.utimesSync(HEARTBEAT_PATH, now, now);
  } catch {
    fs.writeFileSync(HEARTBEAT_PATH, '');
  }
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
      console.error('[code-runner] mailbox did not flush within 2s — exiting anyway; unacked claims will be redelivered');
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
  // Hand the provider key over under a private name — see PROVIDER_KEY_ENV.
  // The CLI receives it through `apiKeyHelper`, so it never meets a raw
  // ANTHROPIC_API_KEY it would stop to ask about. The value still never
  // touches disk; only the variable it travels in changes.
  if (env.ANTHROPIC_API_KEY) {
    env[PROVIDER_KEY_ENV] = env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}

async function main(): Promise<void> {
  const bootAt = Date.now();
  // Unconditional boot stamp: a heartbeat file that never existed is
  // invisible to host-sweep's kill ceiling. The lease below only decides
  // whether to KEEP refreshing it (D14).
  touchHeartbeat();

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
  // interactive CLI reads settings.json with them already in place (D15).
  ensureMailboxHooks();
  // …and its first-run state, or every disposable pod stops at a folder-trust
  // dialog no one is attached to answer.
  const permissionMode = resolvePermissionMode(process.env.NANOCLAW_CODE_PERMISSION_MODE);
  ensureClaudeState(WORKSPACE_DIR, permissionMode === 'bypass');
  // Channel transport (phase 2): the server registration and the project-MCP
  // consent must also predate the spawn — claude reads both at startup.
  const channelMode = resolveChannelMode(process.env.NANOCLAW_CODE_CHANNELS);
  if (channelMode !== 'off') {
    ensureChannelMcpConfig(WORKSPACE_DIR);
    ensureProjectMcpConsent();
  }

  // Terminal mode (terminal-architecture): tmux puts the session in a tmux
  // server and retires the attach stack for this life; 'attach' is the
  // explicit opt-out (classic PTY + attach-socket stack). tmux IS the default
  // — the parity gate the phase-1 rollout waited on was passed by the owner
  // on 2026-08-28 after the POC and stanford-demo proofs. The safe end moved
  // into the binary probe below: an image with no tmux falls back to attach
  // instead of stranding the session.
  let termMode: 'attach' | 'tmux' =
    process.env.NANOCLAW_CODE_TERM === 'attach' ? 'attach' : 'tmux';
  if (termMode === 'tmux') {
    const probe = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
    if (probe.status !== 0) {
      console.error('[code-runner] tmux not present in this image — falling back to the attach stack');
      termMode = 'attach';
    }
  }
  // Under tmux the operator's mouse reaches a real terminal, so the CLI's
  // fullscreen renderer (alt screen + mouse tracking) is the right default —
  // seeded, never forced, so `/tui` stays the operator's call.
  if (termMode === 'tmux') ensureTerminalDefaults();

  // C13: a reap stops being amnesia. The CLI's session store rides the
  // durable ~/.claude mount, so a post-reap boot finds the reaped
  // conversation and resumes it with `--continue`; a fresh workspace finds
  // nothing and boots with exactly the argv it always did. If the resume
  // dies at the gate (state the CLI cannot load), the session's first-life
  // fallback drops the flag and boots fresh — loudly, in this log.
  const resumable = hasResumableSession(WORKSPACE_DIR);
  const freshBootArgs = [...claudeArgs(config.model, permissionMode), ...channelArgs(channelMode)];
  if (resumable) console.log('[code-runner] prior CLI session state found — resuming with --continue (C13)');
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

  // One presence surface for both modes: the attach server earns evidence by
  // owning the socket; the tmux adapter reads the same signals back out of
  // tmux's client list. Either way every stamp carries the human evidence
  // (keystroke/connect recency) the boundary hook needs to tell a watched
  // terminal from an exec-shim orphan (agent-state.ts hasLiveAttachEvidence).
  let presence: { readonly clientCount: number; readonly lastClientInputAt: number; readonly lastClientConnectAt: number };
  const stampAttach = (count: number) =>
    writeAttachState(count, undefined, {
      lastInputAt: presence.lastClientInputAt,
      lastConnectAt: presence.lastClientConnectAt,
    });

  let session: PtySession | TmuxSession;
  let server: AttachServer | null = null;
  let evidence: TmuxEvidence | null = null;
  if (termMode === 'tmux') {
    const tmuxSession = new TmuxSession(sessionOptions);
    await tmuxSession.start();
    session = tmuxSession;
    evidence = new TmuxEvidence();
    evidence.start();
    presence = evidence;
    // The attach server stamped on every connect/disconnect; tmux clients
    // come and go without telling us, so stamp on observed change (the 30s
    // liveness tick below keeps the freshness heartbeat either way).
    let lastSig = '';
    setInterval(() => {
      const sig = `${presence.clientCount}:${presence.lastClientInputAt}:${presence.lastClientConnectAt}`;
      if (sig !== lastSig) {
        lastSig = sig;
        stampAttach(presence.clientCount);
      }
    }, 1_000);
  } else {
    const pty = new PtySession(sessionOptions);
    pty.start();
    session = pty;
    server = new AttachServer(pty, ATTACH_SOCKET_PATH, (count) => stampAttach(count));
    await server.listen();
    presence = server;
  }
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
    `[code-runner] session up — ${
      termMode === 'tmux' ? `tmux socket at ${TMUX_SOCKET_PATH}` : `attach socket at ${ATTACH_SOCKET_PATH}`
    }, mailbox loop running (${channelMode !== 'off' ? `channel transport, mode ${channelMode}` : 'typing transport'})`,
  );

  // The heartbeat is a lease, not a pulse: refresh only while the session is
  // observably in use, else exit 0 and let the host respawn on demand (D14).
  const idleTtlMs = resolveIdleTtlMs();
  const attachIdleTtlMs = resolveAttachIdleTtlMs();
  setInterval(() => {
    // Freshness heartbeat for the attach stamp: a stamp only ever written on
    // connect/disconnect goes stale during a long quiet attach, and the
    // boundary hook treats a stale stamp as detached (ATTACH_STAMP_FRESH_MS).
    stampAttach(presence.clientCount);
    const state = readAgentState();
    const stateAt = state ? Date.parse(state.at) : NaN;
    const busyUntilAt = state?.busyUntil ? Date.parse(state.busyUntil) : NaN;
    const now = Date.now();
    // The connected-client lease (v2) exists only where tmux vouches for the
    // client — under the legacy attach stack this stays undefined and the
    // decision is exactly v1's.
    const liveClientAt = evidence?.attachedClientActivityAt;
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
      lastDoorExecAt: readDoorActivityAt(),
      attachedClientIdleMs: liveClientAt !== undefined ? Math.max(0, now - liveClientAt) : undefined,
      idleTtlMs,
      attachIdleTtlMs,
      busyStaleMs: BUSY_STALE_MS,
    });
    if (decision.alive) {
      touchHeartbeat();
    } else {
      console.log(`[code-runner] idle lease expired (${decision.reason}) — exiting`);
      exitAfterMailboxFlush(agentMailbox, 0);
    }
  }, 30_000);

  const shutdown = (signal: string) => {
    console.log(`[code-runner] ${signal} — shutting down`);
    deliveryLoop.stop();
    server?.close();
    evidence?.stop();
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
