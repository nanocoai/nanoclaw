/**
 * Mailbox delivery loop (sandbox-spec D15) — the code runner's inbound side.
 *
 * Watches the registered mailbox (`getAgentMailbox()` through the runner's
 * db barrel — SQLite files on one deployment, an object store on another;
 * this loop never learns which) and, when the interactive session is idle,
 * TYPES pending messages into the PTY — the attached human literally sees
 * the mail arrive. Busy turns are never interrupted: the PostToolUse hook
 * notifies mid-turn, the Stop hook flips the state file to idle, and the
 * next tick here delivers.
 *
 * Ack discipline is the chat runner's, reused 1:1 (D22): claim with a
 * 'processing' ack, ack 'completed' — never writing the inbound side.
 * An unacked row keeps countDueMessages > 0 and the host re-wakes containers
 * forever; a 'processing' claim older than ~60s gets the container killed.
 * clearStaleProcessingAcks() at boot is the crash-recovery half of that
 * contract; the mailbox interface's releaseProcessingClaims is the retry half.
 *
 * The COMPLETED ack is earned, not assumed (ISSUES #1, characterized by T6
 * 2026-08-18): typing paste+CR into a TUI that is not input-settled leaves
 * the text in the composer unsubmitted, so acking on the write silently
 * loses the submit. Instead the loop holds the claim as a cross-tick
 * pending-ack and completes only on the hook-stamp evidence that the TUI
 * actually took the input: a state stamp (busy = UserPromptSubmit, idle = a
 * whole turn ran inside the poll gap) strictly newer than the injection, in
 * the same child life. No transition within ACK_WINDOW_MS → one bare CR
 * re-nudge; still nothing after NUDGE_WINDOW_MS → release the claim (delete
 * the 'processing' row) so the next tick re-claims and re-injects. An
 * operator compose hold defers the nudge but can never starve the claim:
 * past HOLD_RELEASE_MS the claim is released un-nudged — releasing needs no
 * PTY write, so it is safe mid-composition — keeping the claim's age far
 * under the host's 60s claim-stuck SLA (which would otherwise kill the
 * container out from under the attached operator). A message
 * that fails MAX_INJECT_ATTEMPTS injections stops being re-claimed — its
 * last 'processing' row is deliberately left to age past the host's
 * claim-stuck SLA, whose kill + backoff + MAX_TRIES ceiling is the existing
 * poison-message bound (a fresh boot is the contract's answer to a wedged
 * TUI).
 *
 * Deliberately NOT here (chat composition, D16): XML message wrapping,
 * <message to> dispatch, auto-replies, re-wrap nudges. Replies are the
 * agent's own explicit act via `ncl outbox send`.
 */
import fs from 'fs';

import {
  clearStaleProcessingAcks,
  getPendingMessages,
  markCompleted,
  markProcessing,
  releaseProcessingClaims,
  type MessageInRow,
} from '../db/index.js';
import { markScriptSkipped } from '../db/messages-in.js';
import { applyPreTaskScripts } from '../scheduling/task-script.js';
import { stripLegacyTaskContract } from '../formatter.js';
import { formatLocalTime, TIMEZONE } from '../timezone.js';
import { AGENT_STATE_PATH, MAIL_NOTICE_PATH, READY_FALLBACK_MS, readAgentState, writeMailNotice } from './agent-state.js';
import { listSpoolEntries, writeSpoolEntry } from './channel-spool.js';

/** Implementation choice, not a locked decision: injected messages longer than this become previews. */
const DEFAULT_PREVIEW_CHARS = 700;

const DEFAULT_POLL_MS = 1_000;

/** Mirrors poll-loop's corruption escape hatch: a poisoned store never recovers in-process. */
const CORRUPTION_EXIT_THRESHOLD = 10;

/**
 * A 'busy' with no transition this long is a wedge (a turn interrupted with
 * Esc fires no Stop hook), not a working turn: PreToolUse refreshes the
 * stamp on every tool call, so legitimate long turns stay fresh. Mirrors
 * the host's 30-min absolute ceiling — deliberately NOT shorter, because a
 * permission-prompt wait fires no hooks either and must stay undisturbed.
 */
export const BUSY_STALE_MS = 30 * 60_000;

/** Hold injection while an attached human typed recently — never submit someone's half-composed prompt. */
export const COMPOSE_HOLD_MS = 10_000;

/**
 * How long after an injection to wait for the hook-stamp evidence of a
 * submit before re-nudging with a bare CR. T6 saw the unsettled window at
 * ~3s post-spawn; its ~19s outlier (unsettled long after turn-end with a
 * live attach client) is deliberately under-covered. NOTE the true cost of
 * under-coverage is DUPLICATE delivery, not merely a spent retry: each
 * release re-pastes into the still-unsettled composer, so the eventual
 * settle submits the accumulated copies at once — and a settle landing
 * after the attempt-cap escalation leaves already-delivered mail
 * 'processing' for the host recycle to redeliver whole in the fresh boot.
 * A sanctioned duplicates-over-loss trade; tune from live observation
 * (RUNBOOK-mailbox §3), not by widening these windows toward the 60s SLA.
 */
export const ACK_WINDOW_MS = 3_000;

/** How long after the CR re-nudge to wait before releasing the claim for retry. */
export const NUDGE_WINDOW_MS = 3_000;

/**
 * Hard ceiling on a pending-ack that the operator compose hold keeps
 * un-nudged. Without it, an attached operator typing with gaps under
 * COMPOSE_HOLD_MS would defer the nudge forever, freeze the 'processing'
 * claim past the host's claim-stuck SLA (CLAIM_STUCK_MS=60s), and the kill
 * would land on the live attach — the exact interruption the hold exists
 * to prevent. Releasing a claim needs no PTY write, so it runs safely
 * mid-composition; half the SLA leaves the release + re-claim cycle ample
 * headroom.
 */
export const HOLD_RELEASE_MS = 30_000;

/**
 * In-process injection ceiling PER MESSAGE ID (not per batch — batch
 * composition changes when new mail rides along on a re-claim, and a
 * shifting key would reset the counter). When any id in a batch hits the
 * cap, the loop stops re-claiming and leaves the last 'processing' row
 * unrefreshed: the host's claim-stuck SLA (~60s kill + tries/backoff/
 * MAX_TRIES) recycles the container — the existing poison-message ceiling.
 */
export const MAX_INJECT_ATTEMPTS = 3;

export interface MailboxSession {
  write(data: string): void;
  readonly running: boolean;
  /** Spawn time of the current child life — readiness is per life, not per container. */
  readonly lastSpawnAt: number;
}

export interface MailboxOptions {
  session: MailboxSession;
  stateFilePath?: string;
  pollMs?: number;
  previewChars?: number;
  /** Epoch ms of the last attach-client keystroke, 0 if none (AttachServer.lastClientInputAt). */
  lastOperatorInputAt?: () => number;
  now?: () => number;
  /** Test seam: replaces process.exit on repeated corruption. */
  onFatal?: (code: number) => void;
  /**
   * Channel transport (terminal-architecture phase 2): when set, deliveries
   * are spooled for the nanoclaw-mailbox channel server instead of typed
   * into the terminal, and the bare-CR re-nudge becomes a no-op (there is no
   * composer to nudge). EVERYTHING else — claims, hook-evidence acks, the
   * windows, compose holds, attempt caps — runs identically: the state
   * machine is transport-independent by design, and channels give no
   * delivery signal of their own (silent drop when unloaded/org-blocked),
   * so the contract here is still what makes delivery trustworthy.
   */
  channelSpoolDir?: string;
  /** Where the busy-notify stamp lands for the PostToolUse hook to read. */
  mailNoticePath?: string;
}

/** A delivered-but-unacked injection, carried across ticks (never an in-tick sleep). */
interface PendingAck {
  ids: string[];
  /** now() at the moment of the paste+CR write — the ack must postdate this strictly. */
  injectedAt: number;
  /** session.lastSpawnAt at injection: a respawn mid-wait means the injection died with the old life. */
  lifeSpawnAt: number;
  /** now() when the bare-CR re-nudge was written; null until then. */
  nudgedAt: number | null;
  /** This delivery went out over the channel transport (no composer to nudge). */
  viaChannel: boolean;
}

interface ParsedContent {
  text?: string;
  sender?: string;
  author?: { fullName?: string; userName?: string };
  prompt?: string;
  scriptOutput?: unknown;
}

function parseContent(raw: string): ParsedContent {
  try {
    const parsed = JSON.parse(raw) as ParsedContent;
    return typeof parsed === 'object' && parsed !== null ? parsed : { text: raw };
  } catch {
    return { text: raw };
  }
}

function isCorruptionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /malformed|corrupt/i.test(msg);
}

/**
 * Inbound mail is attacker-controlled input being TYPED INTO A TERMINAL.
 * A message containing the literal bracketed-paste-end sequence would
 * escape the paste wrapper and deliver raw keystrokes (including Enter) to
 * the TUI. Strip every C0 control except newline and tab (CR becomes LF),
 * plus ESC and DEL — mail is text, not key sequences.
 */
export function sanitizeForTerminal(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export function renderMailbox(messages: MessageInRow[], previewChars: number): string {
  const blocks = messages.map((msg) => {
    const content = parseContent(msg.content);
    let header: string;
    let text: string;
    if (msg.kind === 'task') {
      // Deliberate minimal duplicate of the chat runner's formatTaskMessage:
      // that function is module-private and stays that way (D22 — never amend
      // chat-runner code to enable reuse here). scriptOutput arrives from the
      // delivery-time pre-task script run, exactly as on the chat side.
      header = `[nanoclaw task · ${formatLocalTime(msg.process_after ?? msg.timestamp, TIMEZONE)}]`;
      text =
        (content.scriptOutput ? `Script output: ${JSON.stringify(content.scriptOutput)}\n` : '') +
        `Instructions: ${stripLegacyTaskContract(content.prompt ?? '')}`;
    } else {
      const sender = content.sender || content.author?.fullName || content.author?.userName || 'unknown';
      header = `[nanoclaw mail · ${sender} · ${formatLocalTime(msg.timestamp, TIMEZONE)}]`;
      text = content.text ?? msg.content;
    }
    const body =
      text.length > previewChars
        ? `${text.slice(0, previewChars)}\n… [truncated — full text: ncl inbox read --id ${msg.id}]`
        : text;
    return `${header}\n${body}`;
  });
  return blocks.join('\n\n');
}

export class MailboxDeliveryLoop {
  private readonly opts: Required<Omit<MailboxOptions, 'session' | 'channelSpoolDir'>> & {
    session: MailboxSession;
    channelSpoolDir?: string;
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstPoll = true;
  private readonly bootAt: number;
  private fallbackLoggedForLife = -1;
  private staleBusyLogged = false;
  private corruptionStreak = 0;
  private injectionAt = 0;
  private delivering = false;
  private pendingAck: PendingAck | null = null;
  /** In-process injection attempts per MESSAGE ID (see MAX_INJECT_ATTEMPTS). */
  private readonly attempts = new Map<string, number>();
  /** Set when a message hit the attempt cap — the loop stops claiming and waits for the host's kill. */
  private escalated = false;
  /**
   * Set when a channel-transport delivery went unacked: channels are
   * unavailable in this session (org policy, client version, or an
   * unregistered plugin all present identically — the client drops events
   * with no error to the server, VERIFIED live on 2.1.238: "Channels are not
   * currently available" while our server emitted happily into the void).
   * Availability is therefore not knowable at config time, so the fallback
   * is dynamic: downgrade this session to the typing transport permanently
   * and let the released claim redeliver. One wasted ack window, no lost
   * mail, no churn — the decision note's "channels where available,
   * send-keys where not" resolved at runtime instead of by configuration.
   */
  private channelDowngraded = false;

  constructor(options: MailboxOptions) {
    this.opts = {
      stateFilePath: AGENT_STATE_PATH,
      mailNoticePath: MAIL_NOTICE_PATH,
      pollMs: DEFAULT_POLL_MS,
      previewChars: DEFAULT_PREVIEW_CHARS,
      lastOperatorInputAt: () => 0,
      now: () => Date.now(),
      onFatal: (code) => process.exit(code),
      ...options,
    };
    this.bootAt = this.opts.now();
  }

  /** Epoch ms of the last injection (0 before the first) — a D14 liveness input. */
  get lastInjectionAt(): number {
    return this.injectionAt;
  }

  /** Channel transport configured AND not yet proven unavailable. */
  private get channelTransportLive(): boolean {
    return this.opts.channelSpoolDir !== undefined && !this.channelDowngraded;
  }

  /** True once a channel delivery went unacked and the loop fell back to typing. */
  get channelFellBack(): boolean {
    return this.channelDowngraded;
  }

  /** Drop spool entries the channel server never emitted, so a downgrade
   * cannot leave a duplicate waiting for a server that will never read it. */
  private purgeSpool(): void {
    const dir = this.opts.channelSpoolDir;
    if (!dir) return;
    for (const file of listSpoolEntries(dir)) {
      try {
        fs.unlinkSync(file);
      } catch {
        // already emitted; nothing to purge
      }
    }
  }

  start(): void {
    // Crash-recovery contract: a dead predecessor's 'processing' claims
    // would otherwise hide those messages from us forever.
    clearStaleProcessingAcks();
    this.timer = setInterval(() => this.tick(), this.opts.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One poll — exposed for tests (await it); production runs it on the
   * interval. Re-entrancy-guarded: a pre-task script can hold a delivery
   * across many interval fires, and an overlapping deliver would double-claim
   * the same batch.
   */
  async tick(): Promise<void> {
    if (this.delivering) return;
    this.delivering = true;
    try {
      await this.deliver();
      this.corruptionStreak = 0;
    } catch (error) {
      if (isCorruptionError(error)) {
        this.corruptionStreak++;
        if (this.corruptionStreak >= CORRUPTION_EXIT_THRESHOLD) {
          console.error('[code-runner] repeated SQLite corruption — exiting for a fresh mount');
          this.opts.onFatal(75);
        }
      }
      console.error('[code-runner] mailbox tick failed:', error);
    } finally {
      // AFTER delivery, and outside its failure path on purpose — see
      // publishMailNotice. Delivery is the point; the notify is a courtesy.
      this.publishMailNotice();
      this.delivering = false;
    }
  }

  /**
   * Stamp what is waiting, for the PostToolUse hook's mid-turn notify.
   *
   * The hook is a claude subprocess that fires on EVERY tool call, so it
   * must not open the mailbox itself: with SQLite files that was two cheap
   * local reads, but the seam's transport can be an object store, where a
   * per-tool-call mailbox open is a full listing over the network. So the
   * process that already holds a live mailbox and already polls every
   * second publishes the answer instead, and the hook reads one local file
   * — the same hook↔runner file vocabulary the idle/busy state already
   * uses, in the other direction. Sole writer here; hooks only ever read.
   *
   * Runs on EVERY tick, past every readiness gate, because the notify exists
   * precisely for the busy turns deliver() returns early from. The filter is
   * the hook's own: due, wake-eligible, non-system mail nobody has claimed.
   * Sequences (not a count) so the hook keeps its high-water dedupe; rows
   * with no sequence are unaddressable by that mark and skipped, exactly as
   * the hook's `seq > ?` predicate skipped them.
   *
   * A NOTIFY MUST NEVER COST A DELIVERY. Two rules keep that true, and both
   * are load-bearing:
   *
   * - It runs in tick()'s `finally`, AFTER deliver(). The stamp is one
   *   `/tmp` write, and /tmp can be full, read-only or mode-broken; ahead of
   *   deliver() an ENOSPC would abort the tick before a single message
   *   moved. Behind it, the same failure costs one mid-turn nudge and
   *   nothing else. It also makes the stamp truthful: mail deliver() just
   *   claimed is no longer news, so the agent is not told about the mail it
   *   was handed a millisecond ago.
   * - It swallows its own errors. `finally` re-throws, and the mailbox read
   *   here can fail too — so nothing from this method leaves it. The
   *   corruption ladder stays deliver()'s, which is the read that matters.
   */
  private publishMailNotice(): void {
    try {
      const seqs = getPendingMessages(false)
        .filter((m) => m.kind !== 'system' && m.trigger === 1 && typeof m.seq === 'number')
        .map((m) => m.seq as number);
      writeMailNotice({ seqs }, this.opts.mailNoticePath);
    } catch (error) {
      console.error('[code-runner] mail notice not stamped — the mid-turn notify is skipped, delivery is not:', error);
    }
  }

  /**
   * Resolve an outstanding pending-ack. MUST run before the readiness gates:
   * after a successful injection the state file reads 'busy' — which IS the
   * ack signal — and the busy early-return would skip the code that records
   * it; the compose-hold return would likewise block ack processing whenever
   * an attached operator types during the wait.
   *
   * Returns true when the pending-ack resolved to a completed ack and
   * deliver() may fall through to normal gating; false when deliver() must
   * stop here this tick (still waiting, nudged, released, or escalated —
   * a released claim is re-claimed on the NEXT tick, never this one).
   */
  private resolvePendingAck(): boolean {
    const pending = this.pendingAck!;
    const now = this.opts.now();

    // Respawn mid-wait: the injection died with the old life — release the
    // claim for retry, never ack on a life that cannot have submitted it.
    if (this.opts.session.lastSpawnAt !== pending.lifeSpawnAt) {
      releaseProcessingClaims(pending.ids);
      this.pendingAck = null;
      console.error('[code-runner] claude respawned before the injection acked — claim released for retry');
      return false;
    }

    // The ack: a hook stamp STRICTLY newer than the injection, same life.
    // 'busy' is UserPromptSubmit — the CR submitted; 'idle' is a Stop from a
    // turn that started AND finished inside the polling gap — treating it as
    // a miss would re-deliver already-processed mail. Strictly newer, not
    // >=: the PRE-injection gating idle stamp can share the injection's
    // millisecond (deterministic under the fake clock) and must never ack.
    const state = readAgentState(this.opts.stateFilePath);
    if (state !== null && Date.parse(state.at) > pending.injectedAt) {
      markCompleted(pending.ids);
      for (const id of pending.ids) this.attempts.delete(id);
      this.pendingAck = null;
      this.firstPoll = false; // delivery proven — safe to retire the on_wake window
      return true;
    }

    // No evidence yet. First give the TUI ACK_WINDOW_MS, then one bare-CR
    // re-nudge (the T6 failure shape: paste landed in the composer, the CR
    // didn't submit — a second CR submits it).
    if (pending.nudgedAt === null) {
      if (now - pending.injectedAt < ACK_WINDOW_MS) return false;
      // Never submit over a human mid-keystroke: an attached operator's
      // composer text would ride our '\r'. Extend the wait, don't nudge —
      // but never past HOLD_RELEASE_MS: a compose hold must not starve this
      // state machine into the host's 60s claim-stuck kill. Releasing needs
      // no PTY write, so it runs even mid-composition; deliver()'s own
      // compose hold then defers the re-claim until the operator pauses.
      // Deliberately NO cap check here — escalation leaves a claim to die,
      // which must never happen because a human was typing (the cap still
      // binds on the next post-nudge failure).
      const lastTyped = this.opts.lastOperatorInputAt();
      if (lastTyped > 0 && now - lastTyped < COMPOSE_HOLD_MS) {
        if (now - pending.injectedAt < HOLD_RELEASE_MS) return false;
        releaseProcessingClaims(pending.ids);
        this.pendingAck = null;
        // firstPoll stays armed: on_wake rows must survive to the re-fetch.
        console.error(
          '[code-runner] operator compose hold outlasted the ack wait — claim released, un-nudged, before the claim-stuck SLA',
        );
        return false;
      }
      // The CR re-nudge is paste mechanics — on the channel transport it is
      // a no-op, but it still STAMPS: the state machine's windows and caps
      // run identically on both transports (the T6 suite covers them once),
      // and the channel's "nudge" grace is simply more time for the queued
      // notification's turn to start.
      if (!pending.viaChannel) this.opts.session.write('\r');
      pending.nudgedAt = now;
      return false;
    }

    if (now - pending.nudgedAt < NUDGE_WINDOW_MS) return false;

    // Nudge failed too — this attempt is spent. At the per-id cap: stop
    // re-claiming and leave the 'processing' rows to age into the host's
    // claim-stuck SLA (kill + tries/backoff/MAX_TRIES) — the existing
    // poison-message ceiling; a fresh boot heals a wedged TUI.
    if (pending.ids.some((id) => (this.attempts.get(id) ?? 0) >= MAX_INJECT_ATTEMPTS)) {
      this.escalated = true;
      this.pendingAck = null;
      console.error(
        `[code-runner] injection unacked after ${MAX_INJECT_ATTEMPTS} attempts — leaving claim for the host's claim-stuck recycle`,
      );
      return false;
    }
    // A channel delivery that never acked means the events are going
    // nowhere — the client acknowledges nothing, so this silence IS the
    // availability signal. Downgrade permanently and let the release below
    // redeliver by typing.
    if (pending.viaChannel && !this.channelDowngraded) {
      this.channelDowngraded = true;
      this.purgeSpool();
      console.error(
        '[code-runner] channel delivery went unacked — channels are unavailable in this session ' +
          '(org policy, client version, or unregistered plugin); falling back to the typing transport for good',
      );
    }
    releaseProcessingClaims(pending.ids);
    this.pendingAck = null;
    // firstPoll stays armed: on_wake rows must survive to the re-fetch.
    console.error('[code-runner] injection never acked (no hook transition) — claim released, next tick retries');
    return false;
  }

  private async deliver(): Promise<void> {
    if (this.escalated) return;
    if (!this.opts.session.running) return;

    // Pending-ack resolution runs BEFORE every readiness gate — see
    // resolvePendingAck. While one is outstanding, nothing new is claimed.
    if (this.pendingAck !== null && !this.resolvePendingAck()) return;

    // Readiness is PER CHILD LIFE: the code runner deletes the state file on
    // every claude spawn (respawns included), so a fresh life holds until
    // its own SessionStart hook fires. A state stamp predating the current
    // spawn is a dead life's leftover — same as no state at all.
    const lifeStart = Math.max(this.bootAt, this.opts.session.lastSpawnAt);
    let state = readAgentState(this.opts.stateFilePath);
    if (state !== null && Date.parse(state.at) < lifeStart) state = null;

    // The two degraded paths where the busy signal can never come keep
    // ack-on-write semantics: fail-open means hooks are broken (an ack wait
    // would turn "mail moves with jank" into "mail never completes"), and a
    // stale-busy delivery is typed over a wedged turn whose hooks stopped
    // reporting.
    let ackOnWrite = false;

    if (state === null) {
      // No hook has fired in THIS life. Early: wait. Long after: hooks are
      // broken (e.g. corrupt settings.json) — fail open so mail still moves.
      if (this.opts.now() - lifeStart < READY_FALLBACK_MS) return;
      if (this.fallbackLoggedForLife !== lifeStart) {
        this.fallbackLoggedForLife = lifeStart;
        console.error('[code-runner] no hook state after 60s — assuming idle (are the mailbox hooks registered?)');
      }
      ackOnWrite = true;
    } else if (state.state === 'busy') {
      // An interrupted turn (Esc) fires no Stop hook — give 'busy' the same
      // staleness ceiling the host gives claims, or mail wedges forever.
      if (this.opts.now() - Date.parse(state.at) < BUSY_STALE_MS) return;
      if (!this.staleBusyLogged) {
        this.staleBusyLogged = true;
        console.error('[code-runner] busy state stale past 30min — treating as idle');
      }
      ackOnWrite = true;
    } else {
      this.staleBusyLogged = false;
    }

    // Never submit over a human mid-keystroke: an attached operator's
    // composer text would ride our '\r'.
    const lastTyped = this.opts.lastOperatorInputAt();
    if (lastTyped > 0 && this.opts.now() - lastTyped < COMPOSE_HOLD_MS) return;

    const isFirstPoll = this.firstPoll;
    const batch = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
    if (batch.length === 0) {
      // Nothing pending at all — safe to retire the on_wake window.
      this.firstPoll = false;
      return;
    }

    // Accumulate contract: trigger=0 rows are context-only; they ride along
    // with the next trigger=1 arrival, never engage the agent on their own.
    // Keep firstPoll armed — the skipped batch may hold on_wake rows that
    // only an isFirstPoll fetch can see again.
    if (!batch.some((m) => m.trigger === 1)) return;

    const ids = batch.map((m) => m.id);
    markProcessing(ids);
    // Pre-task scripts gate and enrich task rows exactly as on the chat side
    // (task-script.ts is shared scheduling code, imported 1:1). A gated or
    // broken script acks as a script-skip — the row must not wake the agent,
    // and the host's consecutive-failure backoff keeps counting.
    const { keep, skipped } = await applyPreTaskScripts(batch);
    if (skipped.length > 0) {
      markScriptSkipped(skipped);
      console.error(`[code-runner] pre-task script skipped ${skipped.length} task(s)`);
    }
    if (keep.length === 0) {
      this.firstPoll = false;
      return;
    }
    const keepIds = keep.map((m) => m.id);
    const rendered = sanitizeForTerminal(renderMailbox(keep, this.opts.previewChars));
    if (this.channelTransportLive) {
      // Channel transport: one spool entry per delivery batch — the channel
      // server forwards it as one notification, the client queues it while
      // busy and delivers it as one turn, and the batch's ids ack together
      // on that turn's hook evidence exactly as a typed batch would.
      writeSpoolEntry(
        { content: rendered, meta: { ids: keepIds.join(','), batch: String(keep.length) } },
        this.opts.channelSpoolDir,
      );
    } else {
      this.opts.session.write(`\x1b[200~${rendered}\x1b[201~\r`);
    }
    this.injectionAt = this.opts.now();

    if (ackOnWrite) {
      // Degraded paths only (broken hooks / stale busy): no transition can
      // ever arrive, so complete on the write exactly as before the
      // pending-ack machinery — never retry-loop these.
      markCompleted(keepIds);
      this.firstPoll = false;
      return;
    }

    // The completed ack is earned by the busy transition, not assumed on the
    // write (ISSUES #1). firstPoll stays armed until the ack lands — a failed
    // delivery's on_wake rows must survive to a re-fetch.
    for (const id of keepIds) this.attempts.set(id, (this.attempts.get(id) ?? 0) + 1);
    this.pendingAck = {
      ids: keepIds,
      injectedAt: this.injectionAt,
      lifeSpawnAt: this.opts.session.lastSpawnAt,
      nudgedAt: null,
      viaChannel: this.channelTransportLive,
    };
  }
}
