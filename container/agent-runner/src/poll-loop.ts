import { bindIdentityTurn, extendIdentityTurn } from './turn-identity.js';
import {
  confirmationGatePaused,
  isAwaitingSensitiveConfirmation,
  resetConfirmationGateState,
} from './confirmation-gate-state.js';
import { findByName, findByRouting, getAllDestinations, type DestinationEntry } from './destinations.js';
import {
  getPendingMessages,
  markProcessing,
  markCompleted,
  markFailed,
  markScriptSkipped,
  releaseProcessing,
  type MessageInRow,
} from './db/messages-in.js';
import {
  countChatMessagesSince,
  hasChatMessageTextSince,
  hasChatMessageToDestinationSince,
  getReplyTargetMessageIdBySeq,
  getRoutingBySeq,
  getUndeliveredMessages,
  outboundDbNow,
  writeMessageOut,
  type MessageOutRow,
} from './db/messages-out.js';
import { writeTaskFire, type TaskFireDispatch } from './db/task-fires.js';
import { clearStaleProcessingAcks } from './db/container-state.js';
import { resolveDestinationThread } from './db/session-routing.js';
import { touchHeartbeat } from './heartbeat.js';
import { getAgentMailbox } from './mailbox/index.js';
import {
  clearAllSessionTrackingState,
  clearContinuation,
  clearContinuationStartedAt,
  clearCurrentBatchReplyTarget,
  clearCurrentInReplyTo,
  consumeRotationNotice,
  clearCurrentReplyRoute,
  migrateLegacyContinuation,
  setContinuation,
  setContinuationStartedAt,
  setCurrentBatchReplyTarget,
  setCurrentInReplyTo,
  setRotationNotice,
  setCurrentReplyRoute,
} from './db/session-state.js';
import {
  buildFailedTurnRecord,
  clearFailedTurn,
  clearFailedTurnFor,
  consumeFailedTurnNotice,
  failedTurnEligible,
  recordFailedTurn,
} from './failed-turn-notice.js';
import {
  buildPressureHandoffPrompt,
  buildRotationNotice,
  shouldRequestPressureHandoff,
  type PressureState,
} from './pressure-rotation.js';
import { computeRotationDate } from './session-rotation.js';
import { attachLocalFileLinks, outboxDirFor, sweepLocalFileLinks, type DetectedFileLink } from './local-file-links.js';
import { TIMEZONE } from './timezone.js';
import { findQueuedGeneratedImage, recordQueuedGeneratedImage } from './generated-image-delivery.js';
import fs from 'fs';
import path from 'path';
import {
  formatMessages,
  extractRouting,
  isAddressedTurn,
  extractMessageSender,
  extractImageAttachments,
  categorizeMessage,
  FAILURE_NOTICE_FIELD,
  GENERIC_FAILURE_NOTICE,
  isClearCommand,
  isRunnerCommand,
  isSessionEcho,
  stripInternalTags,
  type InboundImageRef,
  type RoutingContext,
} from './formatter.js';
import { getConfig } from './config.js';
import { stripHarnessTagArtifacts } from './harness-tag-strip.js';
import {
  AUTH_FAILURE_USER_TEXT,
  emitProviderAuthFailureAlert,
  isProviderAuthFailureText,
} from './provider-auth-failure.js';
import { isUploadTraceCommand, uploadTrace } from './upload-trace.js';
import type {
  AgentProvider,
  AgentQuery,
  ImageContentBlock,
  ProviderEvent,
  ProviderExchange,
} from './providers/types.js';
import type { ProviderRuntimeContract } from './provider-contracts/registry.js';

/**
 * Generic user-facing notice for a turn that failed before it could answer.
 * Written for the person in the chat, not the operator: diagnostics stay in
 * the runner log and exchange archive. The next same-chat turn also gets a
 * one-shot reminder of the unfinished request (failed-turn-notice.ts).
 * The text lives in formatter.ts so the host's setup/chat copies stay in sync.
 */
export const FAILED_RUN_USER_TEXT = GENERIC_FAILURE_NOTICE;

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;
// Host-side IDLE_TIMEOUT defaults to 120s; refresh well under that so
// one slow tick still leaves multiple ticks of headroom.
const QUERY_KEEPALIVE_MS = 30_000;
// Maximum SDK-silent gap the keepalive will bridge. The keepalive exists
// to cover legitimate LLM-only intervals (long text generation between
// tool calls, SDK ramp between push() and the first new event). The
// upper bound on a healthy LLM-only window is a few minutes; anything
// past STREAM_INACTIVITY_MS without ANY SDK event is the stream stalled
// half-open, not the model thinking. Past that threshold the keepalive
// stops touching the heartbeat so host-sweep's adaptive idle timeout
// (ACTIVE_IDLE_TIMEOUT=15min by default) can finally fire stop-idle.
//
// Incident 2026-05-20 (whatsapp_tico, telegram_dm_nicole): two Claude
// chat containers ran 2–3h after their last `Result:` event because the
// SDK iterator suspended post-result (legitimate keep-warm shape for
// follow-up turns) but never resumed/closed. The keepalive kept touching
// .heartbeat every 30s, the host saw a fresh heartbeat every sweep, and
// stop-idle could not fire. The codex provider has its own mid-turn
// inactivity watchdog (`9624e9ad`) for the pre-result variant of this
// hang; this is the symmetric post-result fix at the keepalive layer so
// every provider benefits without each implementing their own watchdog.
// Tuned well above any realistic single LLM-only window so a slow
// generation never trips it, well below ACTIVE_IDLE_TIMEOUT so the
// host's stop-idle has time to fire after we stop bumping the
// heartbeat.
const STREAM_INACTIVITY_MS = 5 * 60_000;

/**
 * Pure decision for the keepalive's "should I refresh the heartbeat?"
 * check. Returns true when the SDK stream has emitted an event within
 * the inactivity window — i.e. the keepalive should keep bridging the
 * legitimate LLM-only gap. Returns false once the gap has exceeded
 * `inactivityMs`, at which point the keepalive stops refreshing
 * heartbeat so host-sweep's stop-idle path can fire on a stalled
 * half-open stream. Exported for tests.
 */
export function shouldKeepaliveBridge(args: { lastEventAt: number; now: number; inactivityMs: number }): boolean {
  return args.now - args.lastEventAt <= args.inactivityMs;
}

/**
 * A same-sender chat follow-up pushed before the current provider result makes
 * that result stale. Providers such as Codex implement push as a subsequent
 * turn, so the in-flight turn cannot see the newly queued details and may emit
 * a now-wrong reply (for example, "I didn't receive the order") immediately
 * before processing the order that arrived seconds later.
 *
 * Only the currently unresolved push can be superseded. Results already
 * consumed remain deliverable history, while task/system pushes retain their
 * independent delivery semantics.
 */
export function supersedeCurrentChatPush(superseded: boolean[], resultIndex: number, providerName = 'codex'): boolean {
  // Codex queues push() as a subsequent turn. Claude's streaming input can
  // instead fold the new user message into the pending result. Suppressing
  // that result drops the fully updated answer and leaves no later result to
  // deliver (Danielle DM, 2026-08-25).
  if (providerName !== 'codex' || resultIndex >= superseded.length) return false;
  superseded[resultIndex] = true;
  return true;
}

/**
 * The same stale-reply guard for a provider that reports `pushWaitsFor`
 * (Pi): a chat push that will run after `waitsFor` results not yet produced
 * makes the chat replies among them stale, since each was drafted without it.
 * Pi steers a chat message into a running chat turn (waitsFor 0, nothing
 * stale); it queues one behind a task run or an input already queued ahead
 * (Tico, 2026-10-31). Only the newest `waitsFor` unresolved pushes are
 * candidates, and only chat ones: task, handoff and other internal results
 * keep their own delivery semantics.
 */
export function supersedeQueuedChatPushes(
  superseded: boolean[],
  chatPushes: readonly boolean[],
  resultIndex: number,
  waitsFor: number,
): boolean {
  const end = Math.min(superseded.length, chatPushes.length);
  const start = Math.max(resultIndex, end - Math.max(0, Math.floor(waitsFor)));
  let marked = false;
  for (let i = start; i < end; i++) {
    if (!chatPushes[i]) continue;
    superseded[i] = true;
    marked = true;
  }
  return marked;
}

// Inject at push time, not result time: Codex starts the queued turn as soon
// as its previous turn completes, before the runner can feed back a receipt.
// The old answer remains in the provider transcript even though dispatch will
// withhold it. Without this notice the next turn can say "see above" about an
// answer the user never received (Teddy Telegram, 2026-09-08).
const SUPERSEDED_RESPONSE_NOTICE =
  '<system>An earlier in-flight final response was not delivered: the runner is withholding it because this ' +
  'follow-up arrived before completion. Its generated text may still appear in your transcript; that is not ' +
  'proof of delivery. Reconcile the original request with the new information and provide a self-contained ' +
  'answer, including all still-relevant analysis from the withheld response in <message to="name"> blocks. ' +
  'Do not refer to the withheld answer as "above", already sent, or received. Separately tool-sent messages ' +
  'may already have been delivered; this notice applies only to the withheld final response. ' +
  'Do not repeat completed tool actions or side effects just to resend their explanation.</system>';

/**
 * Pure batch-selection for the initial wake. Decides which rows ride
 * this provider turn and which are deferred (left pending for the next
 * wake). Returns the chosen batch plus any log lines the caller should
 * emit. Pure so it can be tested without standing up the SDK.
 *
 * Two isolation layers, applied in order:
 *
 * 1. Task/chat isolation — if any trigger=1 task row is present, drop
 *    ALL chat/chat-sdk rows. Without this, silent-maintenance tasks
 *    ("do NOT send any messages") get chat shoved into the prompt and
 *    the model overrides the silence instruction to reply to what looks
 *    like a live user turn. Two motivating incidents:
 *      - 2026-05-11 04:01 (shit-talk): mackchiu's trigger=0 accumulate
 *        chats from the prior evening dragged into the 04:02 maintenance
 *        wake; agent posted a chat reply despite the silent-task
 *        instruction.
 *      - 2026-05-16 13:22 (AI Friends dream leak): the original fix's
 *        hole — `taskOnlyWake = triggerRows.every(kind==='task')` missed
 *        the case where AI-Friends mention-sticky chat was marked
 *        trigger=1. Now isolation triggers on *any* task trigger, and
 *        defers chat rows regardless of their trigger flag (sticky-
 *        engage chat is still chat).
 *
 * 2. Dream-only isolation — if any dream-series row (`series_id` starts
 *    with `dream-`) is in the post-step-1 batch, defer every non-dream
 *    row too. The dream's silent `<internal>` summary must be the only
 *    result event in the stream so per-push attribution can route the
 *    text to the dream's fire context. Without this, a co-arriving
 *    non-dream task (recap/status-update/RSS — anything that registered
 *    AFTER the dream) wins attribution when the result lands and the
 *    dream fire row ends with `assistant_text=''`. Observed 2026-05-25,
 *    `ag-1778154011329-g9zust` (Degenerate Server): dashboard showed
 *    "Silent fire — no output captured" for a dream that ran correctly.
 *    The dream is silent-by-design — deferring co-arrivers costs at
 *    most one poll tick before they get their own clean stream.
 *
 * 3. Reaction-only-wake isolation — if the only trigger=1 rows are
 *    reactions, defer every trigger=0 chat row. A reaction on the agent's
 *    own message is a deliberately *soft* trigger (`evaluateReactionEngage`
 *    on the host): someone acknowledged something the agent said. It is not
 *    a request to answer the conversation that happened since. Without this
 *    layer the soft wake flushes the entire accumulated ambient backlog into
 *    the turn as fresh input, and the model — correctly seeing unanswered
 *    human messages — replies to them.
 *      - 2026-08-20 13:25 (shit-talk): four minutes of ambient chat
 *        accumulated as trigger=0 after the agent's last answer. A 😂 on
 *        the agent's OWN earlier message woke it; all 7 accumulated rows
 *        rode along, and the agent posted an unprompted joke about Teddy's
 *        ambient "We should ask Hyung". Teddy: "you responded even though
 *        you weren't triggered to."
 *    Same shape as layer 1's 2026-05-11 shit-talk incident (accumulate
 *    dragged into a maintenance wake), one layer over. The deferred rows
 *    stay pending and are picked up by the next real trigger, so no context
 *    is lost — it just stops being an implicit licence to reply. A trigger=1
 *    chat row (a real @mention / reply-to-bot) anywhere in the batch means
 *    this is a genuine chat turn and no isolation applies.
 */
export function selectInitialBatch(messages: MessageInRow[]): {
  batch: MessageInRow[];
  logs: string[];
} {
  const logs: string[] = [];
  const isChatRow = (m: MessageInRow): boolean => m.kind === 'chat' || m.kind === 'chat-sdk';
  const isDreamRow = (m: MessageInRow): boolean => (m.series_id ?? '').startsWith('dream-');

  let batch = messages;

  const hasTaskTrigger = messages.some((m) => m.trigger === 1 && m.kind === 'task');
  if (hasTaskTrigger) {
    const dropped = messages.filter(isChatRow);
    if (dropped.length > 0) {
      const stickyDeferred = dropped.filter((m) => m.trigger === 1).length;
      logs.push(
        `Task trigger present: isolating task turn, deferring ${dropped.length} chat row(s) ` +
          `(${stickyDeferred} trigger=1 sticky-engage) — left pending for next chat wake`,
      );
      batch = messages.filter((m) => !isChatRow(m));
    }
  }

  if (batch.some(isDreamRow)) {
    const dreamRows = batch.filter(isDreamRow);
    const nonDream = batch.filter((m) => !isDreamRow(m));
    if (nonDream.length > 0) {
      logs.push(
        `Dream trigger present: isolating ${dreamRows.length} dream row(s), ` +
          `deferring ${nonDream.length} non-dream row(s) — left pending for next wake`,
      );
      batch = dreamRows;
    }
  }

  const triggers = batch.filter((m) => m.trigger === 1);
  const reactionOnlyWake = triggers.length > 0 && triggers.every((m) => m.kind === 'reaction');
  if (reactionOnlyWake) {
    const ambient = batch.filter((m) => isChatRow(m) && m.trigger !== 1);
    if (ambient.length > 0) {
      logs.push(
        `Reaction-only wake: isolating ${triggers.length} reaction trigger(s), ` +
          `deferring ${ambient.length} accumulate-only chat row(s) — left pending for next chat wake`,
      );
      batch = batch.filter((m) => !(isChatRow(m) && m.trigger !== 1));
    }
  }

  // 4. Operator-note isolation (Optimus) — a Dashboard Chats operator note
  //    (`chief-nudge:` row) has its own protected principal, the note's
  //    issuer; a routed user message has the user's. One turn has exactly one
  //    principal, so a mixed batch made the host refuse it and the turn ran
  //    with no user. Run whichever arrived first; the rest stays pending for
  //    its own turn. The host's protected queue accepts the same split.
  const batchTriggers = batch.filter((m) => m.trigger === 1);
  const notes = batchTriggers.filter(isOperatorNoteRow);
  if (notes.length > 0 && notes.length < batchTriggers.length) {
    const noteFirst = isOperatorNoteRow(batchTriggers[0]);
    const kept = batch.filter((m) => isOperatorNoteRow(m) === noteFirst);
    const deferred = batch.filter((m) => !kept.includes(m));
    logs.push(
      `Operator note and routed input co-arrived: running the ${noteFirst ? 'operator note(s)' : 'routed input'} first, ` +
        `deferring ${deferred.length} row(s) (${deferred.filter((m) => m.trigger === 1).length} trigger=1) ` +
        `— left pending for their own turn`,
    );
    batch = kept;
  }

  // 5. Single-requester initial batch (Optimus) — routed chat triggers from
  //    two different senders co-arrived in one batch made one turn with two
  //    requesters; the host refuses that (one turn, one principal) and the
  //    turn ran with no user. Run the first trigger's sender; other senders'
  //    triggers stay pending for their own turns, exactly like the follow-up
  //    cross-sender deferral. Accumulate-only (trigger=0) context rides along.
  //    The host's protected queue accepts the same single-sender claim.
  const chatTriggers = batch.filter((m) => m.trigger === 1 && isChatRow(m) && !isOperatorNoteRow(m));
  if (chatTriggers.length > 1) {
    const firstSender = extractMessageSender(chatTriggers[0]);
    const others = chatTriggers.filter((m) => extractMessageSender(m) !== firstSender);
    if (others.length > 0) {
      batch = batch.filter((m) => !others.includes(m));
      logs.push(
        `Triggers from more than one sender co-arrived: running the first sender's ` +
          `${chatTriggers.length - others.length} trigger row(s), deferring ${others.length} other-sender trigger row(s) ` +
          `— left pending for their own turn`,
      );
    }
  }

  return { batch, logs };
}

/** Optimus Dashboard Chats operator note row (host bridge `chief-nudge:<id>`). */
export const OPERATOR_NOTE_ID_PREFIX = 'chief-nudge:';
function isOperatorNoteRow(m: MessageInRow): boolean {
  return m.kind === 'chat' && m.id.startsWith(OPERATOR_NOTE_ID_PREFIX);
}

/**
 * Push-scoped attribution: pick the newest unwritten task context in the
 * oldest push that still has one. The SDK emits `result` events in push
 * order, so the earliest push with pending contexts owns the next result.
 *
 * Pure so the attribution decision is testable without standing up the
 * SDK. See processQuery's attribution comment for the 2026-05-25
 * Degenerate-Server incident this replaces.
 */
/**
 * Reverse-isolation decision: should an incoming follow-up batch be deferred
 * because a task trigger (dream/maintenance/RSS occurrence) arrived while a
 * CHAT turn is active? `activeSender` is truthy exactly when the active turn
 * is a chat turn (it's the chat sender; null/empty for task-only turns). The
 * pre-existing follow-up guard only defers chat *into* a task turn — this is
 * its mirror, so a task that comes due mid-chat gets its own
 * selectInitialBatch-isolated turn instead of folding into the live chat
 * conversation. Pure so the decision is testable without the SDK stream.
 */
export function shouldDeferTaskFromChatTurn(activeSender: string | null, followups: MessageInRow[]): boolean {
  if (!activeSender) return false;
  return followups.some((m) => m.kind === 'task' && m.trigger === 1);
}

/**
 * Deferred work may end a query only after EVERY pending input is answered
 * and its result dispatch finishes. A warm query's earlier result says nothing
 * about a later push (AI Friends, 2026-09-11). Acknowledgments are not results.
 */
export function mayEndQueryForDeferredFollowUps(pendingResults: number, dispatchingResult = false): boolean {
  return pendingResults === 0 && !dispatchingResult;
}

/**
 * Whether a spawn should resume a persisted continuation. Dream / maintenance
 * spawns ALWAYS start fresh (return false) — resuming a stale or poisoned
 * provider thread is the root cause of silent empty dream fires (codex
 * `thread/resume` deadlock, hung `thread/start`, or rmcp transport crash on a
 * large stale-thread replay; observed across Degenerates / Stanielle / Teddy
 * DM 2026-05/06). A normal spawn resumes iff it actually has a continuation.
 * Pure so the resume-gate decision is unit-testable without the poll loop.
 */
export function shouldResumeContinuation(continuation: string | undefined, isDreamRun: boolean): boolean {
  if (!continuation) return false;
  if (isDreamRun) return false;
  return true;
}

/**
 * Whether a freshly-adopted continuation should be DURABLY persisted back as
 * the group's standing continuation. A dream's thread is ephemeral and must
 * never overwrite the interactive session's thread (else the next user turn
 * resumes the dream's one-shot maintenance context). Pure twin of
 * `shouldResumeContinuation` for the write side.
 */
export function shouldPersistContinuation(isDreamRun: boolean): boolean {
  return !isDreamRun;
}

export function pickPushScopedContext(pushes: TaskFireContext[][]): TaskFireContext | null {
  for (const push of pushes) {
    for (let i = push.length - 1; i >= 0; i--) {
      if (!push[i].written) return push[i];
    }
  }
  return null;
}

/** Consecutive driver-classified failures before a fresh runner is required. */
const MAILBOX_FAILURE_STREAK_EXIT = 10;

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────
//
// The host reaps an idle (or ceiling-exceeded) container via `docker stop`,
// which SIGTERMs the agent-runner (PID-child under tini) before SIGKILLing it
// after the grace window. Without a handler, SIGTERM kills the runner — and
// the codex `app-server` it drives — mid-turn, leaving codex's CODEX_HOME
// turn-state with a dangling/interrupted turn that the next container inherits
// and aborts, producing zero output and getting re-killed: a self-perpetuating
// poison on busy groups (Degenerates AI-Friends, 2026-06-08). Trapping SIGTERM
// and ending the active query lets the provider finish/checkpoint the current
// turn cleanly. `query.end()` (NOT abort) is deliberate: for codex it ends the
// stdin stream so the in-flight turn drains to `turn/completed` rather than
// being `turn/interrupt`ed; for claude it closes the SDK input iterator the
// same way. The loop then exits at its next top-of-loop check.
let shuttingDown = false;
let activeQueryForShutdown: { end(): void; abort(): void } | null = null;
let interruptRequested = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Begin a graceful wind-down: stop accepting new turns and end the active
 * query so the current turn drains cleanly. Idempotent. Exported for the
 * entrypoint's SIGTERM handler and for tests; the poll loop also consults
 * `shuttingDown` at the top of each iteration to break out.
 */
export function requestGracefulShutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log('SIGTERM — graceful shutdown requested; ending active query so the current turn drains');
  try {
    activeQueryForShutdown?.end();
  } catch (err) {
    log(`graceful shutdown: query.end() failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function isInterruptRequested(): boolean {
  return interruptRequested;
}

/**
 * Host interrupt (SIGINT; a user asked the agent to stop): abort the active
 * query instead of draining it, start no new turn, and leave every input
 * without its own result unacknowledged so the host decides its fate (it
 * completes the stopped request and lets everything else retry). Idempotent;
 * upgrades a graceful shutdown already in progress.
 */
export function requestInterruptShutdown(): void {
  if (interruptRequested) return;
  interruptRequested = true;
  shuttingDown = true;
  log('SIGINT — host interrupt requested; aborting the active query');
  try {
    activeQueryForShutdown?.abort();
  } catch (err) {
    log(`interrupt: query.abort() failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Test-only: reset the module shutdown latch between cases. */
export function _resetShutdownStateForTests(): void {
  shuttingDown = false;
  interruptRequested = false;
  activeQueryForShutdown = null;
}

/**
 * Message status from the query that just ran, for the caller's final
 * marking. Each pushed input is completed (or failed, for an error result) by
 * its own result; inputs still without a result when the stream ends are
 * `unresolved`. Reset by the caller before each processQuery.
 */
const queryMessageOutcome = { failed: new Set<string>(), unresolved: [] as string[] };

/**
 * Read inbound image attachments off disk and convert to Anthropic
 * vision content blocks. The host writes raw bytes to
 * `<sessDir>/inbox/<msgId>/<file>` (resized client-side via sharp when
 * over Anthropic's 5MB cap; see src/media/image-processing.ts), and the
 * session dir is mounted at `/workspace`. We base64-encode and emit the
 * blocks for the provider.
 *
 * Per-image read failure is logged + skipped so one bad attachment
 * doesn't kill the whole turn. Returns empty array when the input is
 * empty or all reads failed.
 */
function loadImageBlocks(refs: InboundImageRef[]): ImageContentBlock[] {
  const blocks: ImageContentBlock[] = [];
  for (const ref of refs) {
    try {
      const buffer = fs.readFileSync(ref.absolutePath);
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: ref.mediaType,
          data: buffer.toString('base64'),
        },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Failed to read image attachment ${ref.absolutePath}: ${errMsg}`);
    }
  }
  return blocks;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /** Declared provider runtime behavior. Contractless providers keep legacy defaults. */
  providerContract?: Pick<ProviderRuntimeContract, 'textDelivery' | 'commands'>;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
  /**
   * True on a Dream / maintenance spawn (see RunnerConfig.isDreamRun). When
   * set, the poll loop NEVER resumes a persisted continuation — the dream
   * always runs on a fresh provider thread. This is the root-cause fix for
   * silent empty dream fires: resuming a stale/poisoned codex thread is what
   * deadlocks `thread/resume`, hangs `thread/start`, or crashes the rmcp
   * stdio transport mid-replay, none of which emit an agentMessage. The
   * dream's last step rotates the session anyway, so a fresh thread is also
   * the semantically correct behavior.
   */
  isDreamRun?: boolean;
  /**
   * Optional stop signal. In production the loop runs until the container
   * dies; tests pass a signal so an abandoned loop actually exits instead of
   * polling forever and stealing messages from the next test's DB.
   */
  signal?: AbortSignal;
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll the mailbox for pending messages
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write outbound messages
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Contract providers declare these; a contractless (legacy payload)
  // provider keeps declaring them as instance flags, exactly as before.
  const legacy = config.provider as { supportsNativeSlashCommands?: boolean; emitsMidTurnText?: boolean };
  const nativeSlashCommands = config.providerContract
    ? config.providerContract.commands.formatting === 'native'
    : (legacy.supportsNativeSlashCommands ?? false);
  const midTurnCompleteDelivery = config.providerContract
    ? config.providerContract.textDelivery === 'mid-turn-complete'
    : (legacy.emitsMidTurnText ?? false);

  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  // Dream / maintenance spawns ALWAYS start fresh — never resume. Resuming a
  // stale or poisoned thread is the single root cause behind silent empty
  // dream fires: codex `thread/resume` deadlocks on a poisoned rollout
  // (Stanielle 2026-05-27), `thread/start` hangs unanswered after the resume
  // attempt (Degenerates 2026-06-01/02), or the rmcp stdio transport crashes
  // replaying a large stale thread (Teddy DM 2026-05-30) — each leaves
  // `task_fires.assistant_text` empty. The dream consolidates and calls
  // `rotate_session` as its final step, so a fresh thread is also exactly
  // what the protocol intends. We deliberately do NOT clearContinuation()
  // here: the standing continuation belongs to the group's interactive
  // session and must survive the dream untouched (the dream's own
  // rotate_session is what clears it when appropriate).
  if (continuation && !shouldResumeContinuation(continuation, Boolean(config.isDreamRun))) {
    log(`Dream pass — starting fresh ${config.providerName} thread (not resuming ${continuation})`);
    continuation = undefined;
  }

  // Before resuming, drop a session whose on-disk transcript has grown too
  // large/old to cold-resume within the host's idle ceiling. Without this a
  // long-lived hub keeps trying to reload an ever-growing .jsonl, hangs the
  // first turn, and gets killed before it can reply (then repeats forever).
  if (continuation) {
    const rotateReason = config.provider.maybeRotateContinuation?.(continuation, config.cwd);
    if (rotateReason) {
      log(`Rotating session — ${rotateReason}; starting fresh`);
      clearContinuation(config.providerName);
      setRotationNotice(buildRotationNotice(rotateReason));
      continuation = undefined;
    }
  }

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();
  // Same for the reply stamp a killed container left behind (see session-state.ts).
  clearCurrentReplyRoute();

  let pollCount = 0;
  let isFirstPoll = true;
  let idlePollFailureStreak = 0;
  while (true) {
    // Graceful shutdown: a SIGTERM (host reap) ends the active query and sets
    // this latch. Break BEFORE dequeuing more work so we don't start a turn
    // we can't finish before docker's SIGKILL — leaving its rows pending for
    // the next container instead of consuming them with no output.
    if (shuttingDown) {
      log('Shutdown latch set — exiting poll loop without starting a new turn');
      break;
    }
    if (config.signal?.aborted) return;
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    let messages: MessageInRow[];
    try {
      messages = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
      idlePollFailureStreak = 0;
    } catch (err) {
      // The follow-up poll already survives driver-classified transient
      // mailbox errors; the idle poll did not, so one hot-journal READONLY
      // that outlasted withInboundDb's retries escaped runPollLoop and
      // killed the runner (`Fatal error: attempt to write a readonly
      // database`). Same contract as the follow-up path: skip this tick,
      // and only exit for a fresh runner after a sustained streak.
      if (!getAgentMailbox().shouldRestartAfter?.(err)) throw err;
      idlePollFailureStreak += 1;
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Poll error (transient, ${idlePollFailureStreak}/${MAILBOX_FAILURE_STREAK_EXIT}): ${errMsg}`);
      if (idlePollFailureStreak >= MAILBOX_FAILURE_STREAK_EXIT) throw err;
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    isFirstPoll = false;
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold through countDueMessages().
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Task/chat isolation: a kind='task' trigger row must NEVER share a
    // provider turn with chat rows. If the batch contains any task
    // trigger, isolate the task(s) into their own stream and defer ALL
    // chat/chat-sdk rows (left pending — they ride along the next
    // chat-triggered wake). Without this, silent-maintenance tasks
    // ("do NOT send any messages") get chat shoved into the prompt and
    // the model overrides the silence instruction to reply to what
    // looks like a live user turn. RSS-style tasks that *do* want to
    // post still post via MCP send_message — isolation only removes
    // chat-as-context from the prompt, not outbound delivery.
    //
    // Two incidents motivate the *generalized* form below:
    //  - 2026-05-11 04:01 (shit-talk): mackchiu's trigger=0 accumulate
    //    chats from May 10 20:42 dragged into the 04:02 maintenance
    //    wake; agent posted a chat reply despite the silent-task
    //    instruction. The original fix dropped only trigger=0 chat when
    //    `taskOnlyWake` (every trigger=1 row is a task).
    //  - 2026-05-16 13:22 (AI Friends dream leak): the original fix's
    //    hole. The dream task (trigger=1, kind=task) co-arrived with
    //    AI-Friends mention-sticky chat that the router had marked
    //    trigger=1. `taskOnlyWake` = triggerRows.every(kind==='task')
    //    was therefore false, isolation was skipped, the conversation
    //    folded into the silent dream turn, and the agent reply-pilled
    //    the dream-cycle summary onto "Lame…" in AI Friends. The fix:
    //    isolation triggers on *any* task trigger present, and defers
    //    chat rows regardless of their trigger flag (sticky-engage
    //    chat is still chat — it must not ride a maintenance turn).
    const isolation = selectInitialBatch(messages);
    for (const line of isolation.logs) log(line);
    const batch = isolation.batch;

    const ids = batch.map((m) => m.id);
    markProcessing(ids);
    // Bind before commands or pre-task scripts, not merely before the model:
    // scripts can call MCP and must use the same host-verified principal.
    const releaseIdentity = await bindIdentityTurn(batch.filter((m) => m.trigger === 1).map((m) => m.id));
    try {
      const routing = extractRouting(batch);
      // Did a human @mention this agent or reply to one of its messages
      // this turn? Computed once here from the same batch routing uses.
      // Threaded into processQuery → dispatchResultText so an addressed
      // turn that produces no deliverable output emits an explicit
      // fallback instead of a bare silent_turn_complete the user never
      // sees (2026-05-17 AI Friends incident).
      //
      // assistantName only powers isAddressedTurn's *secondary*
      // reply-to-bot-by-name path; the primary isMention / replyTo.toBot
      // signals don't need it. Resolve it defensively: getConfig() throws
      // if loadConfig() hasn't run (the production entrypoint always calls
      // it first, but integration tests drive runPollLoop directly without
      // it). A throw here would crash the whole loop for a name-match
      // nicety — degrade to "" (skip only the name path) instead.
      let assistantName = '';
      try {
        assistantName = getConfig().assistantName;
      } catch {
        // config not loaded (test harness / very early boot) — name-match
        // path is skipped, isMention/toBot still work.
      }
      const addressed = isAddressedTurn(batch, assistantName);

      // Command handling: the host router gates filtered and unauthorized
      // admin commands before they reach the container. The only command
      // the runner handles directly is /clear (session reset).
      const normalMessages: MessageInRow[] = [];
      const commandIds: string[] = [];

      for (const msg of batch) {
        if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
          log('Clearing session (resetting continuation)');
          continuation = undefined;
          clearContinuation(config.providerName);
          clearContinuationStartedAt(config.providerName);
          clearFailedTurn();
          await writeMessageOut({
            id: generateId(),
            kind: 'chat',
            platform_id: routing.platformId,
            channel_type: routing.channelType,
            thread_id: routing.threadId,
            content: JSON.stringify({ text: 'Session cleared.' }),
          });
          commandIds.push(msg.id);
          continue;
        }
        // isSessionEcho guard: a copied "/upload-trace" from another session is
        // ambient context, never a runner command (isClearCommand self-guards).
        if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && !isSessionEcho(msg) && isUploadTraceCommand(msg)) {
          log('Uploading session trace to Hugging Face');
          await writeMessageOut({
            id: generateId(),
            kind: 'chat',
            platform_id: routing.platformId,
            channel_type: routing.channelType,
            thread_id: routing.threadId,
            content: JSON.stringify({ text: uploadTrace(config.providerName) }),
          });
          commandIds.push(msg.id);
          continue;
        }
        normalMessages.push(msg);
      }

      if (commandIds.length > 0) {
        markCompleted(commandIds);
      }

      if (normalMessages.length === 0) {
        const remainingIds = ids.filter((id) => !commandIds.includes(id));
        if (remainingIds.length > 0) markCompleted(remainingIds);
        log(`All ${batch.length} message(s) were commands, skipping query`);
        continue;
      }

      // Pre-task scripts: for any task rows with a `script`, run it before the
      // provider call. Scripts returning wakeAgent=false (or erroring) gate
      // their own task row only — surviving messages still go to the agent.
      // Without the scheduling module, the marker block is empty, `keep`
      // falls back to `normalMessages`, and no gating happens.
      let keep: MessageInRow[] = normalMessages;
      let skipped: Array<{ id: string; reason: string }> = [];
      // MODULE-HOOK:scheduling-pre-task:start
      const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
      const preTask = await applyPreTaskScripts(normalMessages);
      keep = preTask.keep;
      skipped = preTask.skipped;
      if (skipped.length > 0) {
        markScriptSkipped(skipped);
        log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.map((s) => s.id).join(', ')}`);
        // Record a 'gated' fire per skipped task. The task fired on
        // schedule and its script ran — it just decided not to wake the
        // agent. Without this row the dashboard shows "never ran" for a
        // healthy quiet task (RSS pollers, dream/maintenance checks that
        // usually no-op). One row per occurrence; series_id groups them.
        for (const g of preTask.gated) {
          try {
            writeTaskFire({
              id: generateId(),
              seriesId: g.seriesId,
              taskId: g.taskId,
              status: 'gated',
              assistantText: null,
              dispatched: [],
              errorMessage: g.reason === 'script error/no output' ? g.reason : null,
            });
          } catch (err) {
            log(`task_fires gated-write failed for ${g.taskId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      // MODULE-HOOK:scheduling-pre-task:end

      if (keep.length === 0) {
        log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
        continue;
      }

      // Re-check the accumulate gate after script filtering. The gate at the
      // top of the loop lets the batch through if ANY message has trigger=1,
      // but a recurring task with wakeAgent=false (e.g. dream/maintenance
      // scripts that decide nothing's worth waking for) is the only trigger=1
      // row in the batch and gets stripped here. Without this re-check, the
      // trigger=0 accumulate rows that rode along get processed as prompts —
      // exactly the v1 requires_trigger gap operators reported (2026-05-09
      // AI Friends "close.. just gotta suppress those embeds" echo).
      if (!keep.some((m) => m.trigger === 1)) {
        log(
          `Skipping ${keep.length} accumulate-only message(s) after script filter — leaving pending until next trigger`,
        );
        // They were claimed by markProcessing above; without releasing the
        // claim they stay 'processing', are excluded from the next poll and
        // never ride along with the next trigger.
        releaseProcessing(keep.map((m) => m.id));
        continue;
      }

      // Format messages: passthrough commands get raw text (only if the
      // provider natively handles slash commands), others get XML.
      const prompt = formatMessagesWithCommands(keep, nativeSlashCommands, config.providerName);

      log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

      // Capture the active turn's trigger sender. Follow-up messages from a
      // different sender are deferred (left pending) instead of pushed into
      // this query — pushing folds both senders' requests into one combined
      // reply (boysnight 2026-04-27, ported from v1 apps/nanoclaw/src/index.ts).
      const triggerRow = keep.find((m) => m.trigger === 1) ?? keep[0];
      const activeSender = extractMessageSender(triggerRow);

      // Task-fire tracking: if a task row triggered this stream, capture its
      // series_id + id so processQuery can write a task_fires row when the
      // stream ends. `series_id` falls back to `id` for pre-migration rows
      // (matches the host-side backfill in src/db/session-db.ts:349). Only
      // the kind='task' branch participates — chat-triggered wakes don't
      // produce fire rows.
      // Shared, mutable list seeded with the initial-batch task rows; the
      // follow-up poll closure appends a context per follow-up task that
      // survives its pre-task script. One context per due task occurrence so
      // each gets exactly one fire row even when several fold into one
      // provider stream (multiple recurring tasks coming due in the same
      // wake, or follow-ups arriving mid-turn). `series_id` falls back to
      // `id` for pre-migration rows (matches host-side backfill in
      // src/db/session-db.ts:349). Chat-triggered wakes produce no context.
      const taskFireContexts: TaskFireContext[] = [];
      for (const m of keep) {
        if (m.trigger !== 1 || m.kind !== 'task') continue;
        registerTaskFireContextOnce(taskFireContexts, m);
      }

      // Load any inbound image attachments as Anthropic vision content blocks.
      // The host wrote bytes to <sessDir>/inbox/<msgId>/<file> (sized to fit
      // the 5MB API cap by chat-sdk-bridge before insert), and the session dir
      // mounts at /workspace, so absolutePath is `/workspace/inbox/...`.
      // Empty array on no images / all reads failed — provider sends text-only.
      const imageRefs = extractImageAttachments(keep);
      const imageBlocks = loadImageBlocks(imageRefs);
      if (imageBlocks.length > 0) {
        log(`Loaded ${imageBlocks.length} image attachment(s) for multimodal turn`);
      }

      // Per-dequeue session rotation — fires BEFORE provider.query() so the
      // current turn always runs on a coherent thread (rotating mid-flight
      // would destroy the in-memory `resume` id while the SDK is still using
      // it). Upstream calls maybeRotateContinuation once at container boot;
      // we additionally call it before every query so drift-axis triggers
      // (post-compact summaries, day-boundary crossings — see
      // session-rotation.ts) fire even in a long-lived warm container.
      if (continuation) {
        const reason = config.provider.maybeRotateContinuation?.(continuation, config.cwd);
        if (reason) {
          log(`Rotating session before query: ${reason} (previous continuation: ${continuation})`);
          clearContinuation(config.providerName);
          setRotationNotice(buildRotationNotice(reason));
          continuation = undefined;
        }
      }

      // A fresh thread that follows a rotation gets a one-shot pointer to the
      // handoff note / archived transcripts, so it doesn't silently start with
      // zero knowledge of an in-flight conversation (the "it compacted and
      // then forgot everything" experience). Dream runs skip it — their fresh
      // thread is ephemeral maintenance, not the conversation's successor.
      let promptForQuery = prompt;
      if (continuation === undefined && !config.isDreamRun) {
        const notice = consumeRotationNotice();
        if (notice) {
          log('Prepending rotation notice to fresh-thread prompt');
          promptForQuery = `<system>${notice}</system>\n\n${prompt}`;
        }
      }

      // One-shot pickup of a request whose reply failed on this route
      // (failed-turn-notice.ts). Interactive turns only: Dream and task-only
      // turns neither consume nor see it, nor do routes that could never have
      // recorded one (a2a, failure-notice wakes). Works on resumed and fresh threads.
      if (!config.isDreamRun && taskFireContexts.length === 0 && failedTurnEligible(routing, false)) {
        const failedNotice = consumeFailedTurnNotice(routing);
        if (failedNotice) {
          log('Prepending failed-turn notice to prompt');
          promptForQuery = `<system>${failedNotice}</system>\n\n${promptForQuery}`;
        }
      }

      const query = config.provider.query({
        prompt: promptForQuery,
        continuation,
        cwd: config.cwd,
        systemContext: config.systemContext,
        imageBlocks: imageBlocks.length > 0 ? imageBlocks : undefined,
      });
      // Expose the active query to the SIGTERM handler so a host reap can end
      // it cleanly mid-turn (drain to completion) instead of the process being
      // SIGKILLed with the turn still open. If shutdown was requested in the
      // window between the loop-top check and here, end immediately.
      activeQueryForShutdown = query;
      if (interruptRequested) query.abort();
      else if (shuttingDown) query.end();

      // Process the query while concurrently polling for new messages
      const skippedSet = new Set(skipped.map((s) => s.id));
      const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
      // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
      // can stamp it on outbound rows — needed for a2a return-path routing.
      // Two transports, both required: module state for any in-process
      // consumer, AND session_state (outbound.db) because the built-in MCP
      // server runs as a separate stdio subprocess that cannot see this
      // process's module state. The DB value is the AUTHORITATIVE reply
      // target — it is `null` for task-only / accumulate-only turns
      // (extractRouting → pickInReplyToMessage already excluded task rows),
      // which is exactly the signal that stops a recurring RSS/status post
      // from inheriting a stale human @mention's reply pill. See
      // setCurrentBatchReplyTarget's docstring for the full incident chain.
      setCurrentInReplyTo(routing.inReplyTo);
      setCurrentBatchReplyTarget(routing.inReplyTo);
      // Set when processQuery threw a retryable-with-no-result failure; guards
      // the markCompleted below so the host re-fires the task instead of the
      // run silently completing (codex MCP-init empty-fire, 2026-06-05).
      let retryableBatchFailure = false;
      // Whether this turn produced at least one result event. Read after the
      // try/finally to decide, on a shutdown-cut-short turn, between completing
      // the rows (work happened) and leaving them pending (work didn't).
      let sawResult = false;
      queryMessageOutcome.failed.clear();
      queryMessageOutcome.unresolved = [];
      publishReplyRoute(routing);
      // Forward a loop stop to the ACTIVE query. The stream deliberately stays
      // open between turns, so the loop can be parked inside processQuery when
      // config.signal fires; without this, the "stopped" loop's query — and its
      // 500ms follow-up poller — outlives the stop and keeps polling (and
      // claiming) messages from whatever inbound DB the process points at. In
      // tests that leaked one immortal poller per loop-driven test, which could
      // steal a later test's follow-up message into a dead query.
      const abortActiveQuery = () => query.abort();
      if (config.signal?.aborted) abortActiveQuery();
      else config.signal?.addEventListener('abort', abortActiveQuery, { once: true });
      try {
        const result = await processQuery(
          query,
          routing,
          processingIds,
          config.providerName,
          activeSender,
          addressed,
          assistantName,
          taskFireContexts,
          // Proactive pressure rotation is for the persistent interactive
          // thread only — a dream's fresh thread is ephemeral by design.
          config.isDreamRun ? null : (config.provider.pressureRotationTokens?.() ?? null),
          config.provider.onExchangeComplete?.bind(config.provider),
          prompt,
          continuation,
          midTurnCompleteDelivery,
          config.signal,
        );
        sawResult = Boolean(result.sawResult);
        if (result.pressureRotated) {
          // processQuery already cleared the persisted continuation rows and
          // wrote the rotation notice; drop the in-memory id too, or the next
          // warm dequeue would resume — and re-persist — the retired thread.
          log('Pressure rotation completed — next turn starts a fresh thread');
          continuation = undefined;
        } else if (result.continuation && result.continuation !== continuation) {
          const isNewThread = continuation === undefined;
          // A dream's fresh thread is EPHEMERAL — it must never become the
          // group's persisted continuation. Persisting it would clobber the
          // interactive session's thread with the throwaway dream thread, so
          // the next user turn would resume the dream's one-shot maintenance
          // context instead of the conversation. The dream owns its own
          // lifecycle (it calls rotate_session as its final step); the
          // poll-loop just must not write its thread id back. Keep the local
          // `continuation` var updated so any in-process follow-up dream turn
          // stays on the same fresh thread, but skip the durable write.
          continuation = result.continuation;
          if (shouldPersistContinuation(Boolean(config.isDreamRun))) {
            setContinuation(config.providerName, continuation);
            // Stamp the rotation-day this continuation started on. Only on a
            // newly-adopted thread — resuming an existing one keeps the
            // original stamp so the day-boundary check measures from when the
            // thread truly began, not when this container happened to attach.
            if (isNewThread) {
              setContinuationStartedAt(config.providerName, computeRotationDate(new Date(), TIMEZONE));
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Query error: ${err instanceof Error ? (err.stack ?? err.message) : errMsg}`);

        // A retryable provider failure with no result (processQuery's
        // `retryable provider error, no result:` throw) must NOT be marked
        // completed — leaving the row pending lets the host re-fire it.
        // Everything else still completes: a non-retryable error is terminal
        // (re-running would just fail again), so we record the error fire and
        // move on as before.
        const killedDream =
          taskFireContexts.length > 0 &&
          taskFireContexts.every((ctx) => ctx.seriesId.startsWith('dream-') && !ctx.written) &&
          /Claude Code process exited with code 137\b/.test(errMsg);
        if (errMsg.startsWith('retryable provider error, no result:') || killedDream) {
          retryableBatchFailure = true;
        }

        // Stale/corrupt continuation recovery: ask the provider whether
        // this error means the stored continuation is unusable, and clear
        // it so the next attempt starts fresh.
        if (continuation && config.provider.isSessionInvalid(err)) {
          log(`Stale session detected (${continuation}) — clearing for next retry`);
          continuation = undefined;
          clearContinuation(config.providerName);
          clearContinuationStartedAt(config.providerName);
        }

        // processQuery owns push-scoped failure notices and auth alerts.

        // Task-fire error record. Captures the error message so the
        // dashboard can show "this fire failed and why" instead of leaving
        // the fire row missing entirely (which would look like the task
        // simply didn't run). One row per still-unwritten due task; mark
        // each written so processQuery's finally can't also write a
        // completed/silent row for it (the single-fire invariant).
        for (const ctx of taskFireContexts) {
          if (ctx.written) continue;
          try {
            writeTaskFire({
              id: generateId(),
              seriesId: ctx.seriesId,
              taskId: ctx.taskId,
              status: 'error',
              assistantText: null,
              dispatched: [],
              errorMessage: errMsg,
            });
            ctx.written = true;
          } catch (writeErr) {
            log(`task_fires error-write failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
          }
        }
      } finally {
        // The turn is over (success, error, or shutdown-drain) — stop exposing
        // this query to the SIGTERM handler so a late reap can't call .end() on
        // an already-settled query.
        activeQueryForShutdown = null;
        clearCurrentInReplyTo();
        // Drop the DB-published target too. Once the key is absent the MCP
        // subprocess falls back to its legacy heuristic — correct for any
        // stray off-turn send, and prevents a finished turn's target from
        // leaking onto the next turn before poll-loop republishes.
        clearCurrentBatchReplyTarget();
        clearCurrentReplyRoute();
        config.signal?.removeEventListener('abort', abortActiveQuery);
      }

      // Ensure completed even if processQuery ended without a result event
      // (e.g. stream closed unexpectedly). EXCEPT a retryable-with-no-result
      // failure: leave the rows pending and exit this container. The processing
      // claim lives in outbound.db, so a warm runner cannot claim the row again;
      // exiting is what lets host-sweep observe the stopped container, clear the
      // stale claim with backoff, and spawn a clean provider process. Staying
      // alive here stranded the trigger until the 30-minute absolute ceiling
      // (Fasting Add Chat, 2026-07-13).
      if (retryableBatchFailure) {
        log(
          `Leaving ${processingIds.length} message(s) pending and exiting container for host retry ` +
            `(retryable provider failure)`,
        );
        return;
      } else if (interruptRequested) {
        // Host interrupt: inputs that got their own result were acked as they
        // finished; everything else stays unacknowledged for the host.
        log(`Interrupted by host — leaving ${processingIds.length} message(s) unacknowledged and exiting`);
        return;
      } else if (shuttingDown && !sawResult) {
        // SIGTERM ended the query before it produced any result — the turn was
        // cut short by the host reap, not finished. Leave the rows pending so
        // the next container actually answers them (Teddy's AI-Friends mention,
        // 2026-06-08, was consumed with zero output exactly because a cut-short
        // turn still marked its rows completed). A drain that DID produce a
        // result falls through to markCompleted below — that work really happened.
        log(
          `Shutdown mid-turn before any result — leaving ${processingIds.length} message(s) pending for next container`,
        );
      } else {
        // Dreams neither resume nor persist a continuation (shouldResumeContinuation /
        // shouldPersistContinuation), and daily rotation is provider-owned since
        // 2026-10-14, so a completed Dream no longer clears session tracking.
        // An error result marked its inputs failed already; don't overwrite.
        markCompleted(processingIds.filter((id) => !queryMessageOutcome.failed.has(id)));
        log(`Completed ${ids.length} message(s)`);
      }
      // Follow-ups pushed into this query that never got their own result.
      // A cut-short or retryable turn leaves them for the next container like
      // the batch above; otherwise they were dropped, which is a failure.
      const followUps = queryMessageOutcome.unresolved.filter((id) => !processingIds.includes(id));
      if (followUps.length > 0) {
        if (retryableBatchFailure || shuttingDown) {
          log(`Leaving ${followUps.length} unanswered follow-up(s) pending for the next container`);
        } else {
          log(`Marking ${followUps.length} follow-up(s) failed — the query ended before answering them`);
          for (const id of followUps) markFailed(id);
        }
      }
    } finally {
      await releaseIdentity();
    }
  }
}

export function shouldSendErrorResponseForBatch(messages: MessageInRow[]): boolean {
  return !messages.every((m) => m.kind === 'task');
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(
  messages: MessageInRow[],
  nativeSlashCommands: boolean,
  providerName: string,
): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg, providerName);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return prependDeliveryFeedback(parts.join('\n\n'));
}

interface QueryResult {
  continuation?: string;
  // True if at least one `result` event arrived before the stream settled.
  // Lets the caller distinguish a turn that actually produced output from one
  // that was cut short (e.g. a SIGTERM-driven `query.end()` mid-turn), so the
  // latter leaves its rows pending for the next container instead of silently
  // completing them.
  sawResult?: boolean;
  // True when a context-pressure handoff ran and the persisted continuation
  // rows were cleared inside this stream (see pressure-rotation.ts). The
  // caller must drop its in-memory continuation so the next dequeue starts
  // a fresh thread instead of resuming — and re-persisting — the retired one.
  pressureRotated?: boolean;
}

/**
 * Per-stream task-fire tracking. Set when the initial batch that opened
 * this query stream included a `kind='task'` trigger row — we record one
 * task_fires row at stream end (or on error) capturing what the agent
 * produced. Follow-up pushes within the same stream are user-driven and
 * don't count as new fires (a new task fire would arrive on a fresh
 * wake via host-sweep). seriesId is the stable per-task identity;
 * taskId is the concrete messages_in.id that fired.
 */
export interface TaskFireContext {
  seriesId: string;
  taskId: string;
  // Per-task accumulators. One stream can fold MULTIPLE task triggers
  // (the initial batch task + any follow-up task rows that came due while
  // the container was already running — RSS + dream + reflection in one
  // container lifetime). Each due task occurrence gets exactly ONE fire
  // row keyed by its own (seriesId, taskId); these accumulate the
  // dispatch/text attributed to it. `written` is the write-once guard
  // shared between the error path (outer catch) and the normal-completion
  // path (finally) so a task can never produce two rows.
  dispatched: TaskFireDispatch[];
  assistantText: string | null;
  errorMessage?: string;
  written: boolean;
}

/**
 * Register a task-fire context for `m` unless one already exists for the
 * same concrete row (`taskId`). Idempotent so the multiple seeding
 * points — initial batch, the post-markProcessing follow-up pass (which
 * runs ahead of every early-return for Issue A), and the pre-push
 * re-affirmation — can all call it without ever double-counting a fire.
 * `series_id` falls back to `id` for pre-migration rows (matches the
 * host-side backfill in src/db/session-db.ts:349).
 */
// Exported for unit tests — the Issue-A seed/drop invariant (idempotent
// registration, drop-only-unwritten) is timing-independent and worth
// covering directly rather than through the flaky in-query fold race.
export function registerTaskFireContextOnce(contexts: TaskFireContext[], m: MessageInRow): void {
  if (contexts.some((c) => c.taskId === m.id)) return;
  contexts.push({
    seriesId: m.series_id ?? m.id,
    taskId: m.id,
    dispatched: [],
    assistantText: null,
    written: false,
  });
}

/**
 * Remove fire contexts for `rows` that were seeded ahead of a bail
 * (accumulate-only follow-up, or stream-already-done) and therefore did
 * NOT run this turn. Only drops still-unwritten contexts — a context the
 * writers already flushed stays (its fire is real). Without this, the
 * Issue-A seeding (which deliberately registers before every early
 * return) would make processQuery's finally emit a 'silent' fire for a
 * task that never actually executed; the genuine fire is recorded when
 * the released row is re-triggered and runs in its own isolated turn.
 */
export function dropUnrunTaskContexts(contexts: TaskFireContext[], rows: MessageInRow[]): void {
  const ids = new Set(rows.filter((m) => m.kind === 'task' && m.trigger === 1).map((m) => m.id));
  if (ids.size === 0) return;
  for (let i = contexts.length - 1; i >= 0; i--) {
    if (!contexts[i].written && ids.has(contexts[i].taskId)) contexts.splice(i, 1);
  }
}

export function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  activeSender: string | null,
  addressed: boolean,
  assistantName: string,
  taskFireContexts: TaskFireContext[],
  pressureThresholdTokens?: number | null,
  onExchangeComplete?: ((exchange: ProviderExchange) => void) | undefined,
  initialPrompt?: string,
  initialContinuation?: string,
  emitsMidTurnText?: boolean,
  signal?: AbortSignal,
): Promise<QueryResult>;
/** Compatibility overload retained for the staged upstream mid-turn suites. */
export function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  onExchangeComplete?: ((exchange: ProviderExchange) => void) | undefined,
  initialPrompt?: string,
  initialContinuation?: string,
  emitsMidTurnText?: boolean,
  signal?: AbortSignal,
): Promise<QueryResult>;
export async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  activeSenderOrHook: string | null | ((exchange: ProviderExchange) => void) | undefined = null,
  addressedOrPrompt: boolean | string = false,
  assistantNameOrContinuation: string | undefined = '',
  taskFireContextsOrCapability: TaskFireContext[] | boolean = [],
  pressureThresholdTokensArg: number | null | AbortSignal = null,
  onExchangeCompleteArg?: ((exchange: ProviderExchange) => void) | undefined,
  initialPromptArg = '',
  initialContinuationArg: string | undefined = undefined,
  emitsMidTurnTextArg = false,
  signalArg?: AbortSignal,
): Promise<QueryResult> {
  const upstreamCallShape = typeof addressedOrPrompt === 'string' || typeof taskFireContextsOrCapability === 'boolean';
  const activeSender = upstreamCallShape ? null : (activeSenderOrHook as string | null);
  const addressed = upstreamCallShape ? false : (addressedOrPrompt as boolean);
  const assistantName = upstreamCallShape ? '' : (assistantNameOrContinuation ?? '');
  const taskFireContexts = upstreamCallShape ? [] : (taskFireContextsOrCapability as TaskFireContext[]);
  const pressureThresholdTokens = typeof pressureThresholdTokensArg === 'number' ? pressureThresholdTokensArg : null;
  const signal =
    upstreamCallShape && pressureThresholdTokensArg && typeof pressureThresholdTokensArg === 'object'
      ? pressureThresholdTokensArg
      : signalArg;
  const onExchangeComplete = upstreamCallShape
    ? typeof activeSenderOrHook === 'function'
      ? activeSenderOrHook
      : undefined
    : onExchangeCompleteArg;
  const initialPrompt = upstreamCallShape ? (addressedOrPrompt as string) : initialPromptArg;
  const initialContinuation = upstreamCallShape ? assistantNameOrContinuation : initialContinuationArg;
  const defaultMidTurnText = upstreamCallShape ? taskFireContextsOrCapability === true : emitsMidTurnTextArg;
  const activeProviderName = (): string => query.delivery?.providerName ?? providerName;
  let textProviderName = activeProviderName();
  // adoptTurn mutates routing in place; copy so the caller's batch routing
  // (used for the query error notice) stays the first message's.
  routing = { ...routing };
  let queryContinuation: string | undefined;
  let done = false;
  let unwrappedNudged = false;
  // Separate from the one-nudge-per-push guard above: once the nudge is sent,
  // deferred ambient work must not end the query until its retry result lands.
  let wrappingRetryInFlight = false;
  // Codex results consume one push; Claude results consume all pending pushes.
  // Preserve whether each push was directly addressed so a warm request is not mistaken
  // for ambient continuation (Nook 2026-06-07).
  const pushAddressed: boolean[] = [addressed];
  // Parallel to pushAddressed: whether the push answers a chat message (its
  // result is a chat reply the Pi stale-reply guard may withhold).
  const pushChat: boolean[] = [addressed || activeSender !== null];
  // Message ids by push index (into pushAddressed). Each push's rows are
  // marked when the result that consumes that push arrives: completed, or
  // failed for an error result, so a failed turn is not recorded as answered.
  // Retry/handoff pushes carry no rows.
  const pushIds = new Map<number, string[]>([[0, initialBatchIds]]);
  const takePushIds = (from: number, to: number): string[] => {
    const ids: string[] = [];
    for (let i = from; i < to; i++) {
      ids.push(...(pushIds.get(i) ?? []));
      pushIds.delete(i);
    }
    return ids;
  };
  // Parallel to pushAddressed. A same-sender chat follow-up that arrives
  // before the current result supersedes that result: the provider queued the
  // follow-up as the next turn, so the current turn cannot know its contents.
  const pushSuperseded: boolean[] = [false];
  let resultIndex = 0;
  // Text of the most recent isError result this stream already handled
  // (delivered to chat or recorded on the task fire). The Claude SDK re-throws
  // that same failure as "Claude Code returned an error result: <text>" when
  // the query is later ended; see isHandledErrorResultEcho.
  let lastHandledErrorResult: string | null = null;
  // Lifecycle accounting is separate from per-push delivery attribution:
  // Codex queues one result per input; Claude may merge pushed inputs into
  // one result. Never use the lifetime resultIndex as an idle signal.
  let pendingResults = 1;
  let dispatchingResult = false;
  const mayEndDeferredQuery = (): boolean => mayEndQueryForDeferredFollowUps(pendingResults, dispatchingResult);
  const noteInput = (): void => {
    pendingResults++;
    loggedHoldingForFirstResult = false;
  };
  // Pressure-rotation state machine: 'idle' until a result reports context
  // tokens above the threshold → push ONE handoff turn ('handoff-requested')
  // → when that turn's result arrives, clear the persisted continuation
  // state, stamp the rotation notice, and end the query ('rotated').
  let pressureState: PressureState = 'idle';
  // Index into pushAddressed of the handoff push, so the rotation step only
  // fires on the handoff turn's own result (a user follow-up that slipped in
  // ahead of it keeps its result attribution untouched).
  let pressureHandoffPushIndex = -1;
  // Reported to the caller so it drops its in-memory continuation.
  let pressureRotated = false;
  // Claude compaction is normally transparent. If the resumed turn then
  // ends without a final deliverable, surface a narrow user-facing notice
  // instead of silently ending after an earlier progress acknowledgement.
  let compactedSinceLastResult = false;
  // A retryable provider error that arrived with no result this turn. The
  // provider emits `error` as a stream event (not a throw), so without this
  // the stream just closes and the finally + caller mark the batch
  // completed — silently finishing a task that did nothing. The canonical
  // case is codex's MCP-init transport failure (rmcp worker quit on the
  // `initialized` notification → codex exits 0 before any turn), which used
  // to empty-fire the degenerates dream (2026-06-05). When set and no
  // result was seen, we throw at stream end so the caller's catch writes an
  // `error` fire and leaves the row pending for the host to retry.
  let retryableErrorWithoutResult: string | null = null;
  // SQLite-UTC stamp captured before the agent runs, so the addressed-
  // silent safety net can tell whether the agent delivered a chat
  // message via an MCP tool (send_file/send_message) during this turn —
  // those write straight to outbound.db and never appear as <message>
  // blocks. Captured once here, passed to every dispatchResultText call.
  const turnStartedAt = outboundDbNow();
  // Clear the per-turn confirmation-gate flag. Sticky state here would
  // suppress the addressed-silent safety net for genuinely broken later
  // turns — the exact failure the net exists to catch.
  resetConfirmationGateState();
  // Attribution: result events fold into one provider stream and the SDK
  // does not tag which pushed prompt produced a given <message> block.
  // The ROW COUNT and KEYS are always exact (one row per due task, keyed
  // by its own series_id/id); only the dispatched/assistantText *payload*
  // needs disambiguation when multiple tasks fold into one stream.
  //
  // Strategy: push-scoped attribution. The SDK delivers `result` events
  // in push order — push 1's result before push 2's — so we partition
  // contexts by which `query.push` (or initial batch) produced them and
  // serve them in that order. Each result picks the OLDEST push that
  // still has an unwritten context, then the newest unwritten context
  // within that push.
  //
  // Why push-scoped beats the prior "most recent unwritten overall":
  //   On 2026-05-25 a Degenerate-Server dream task fired in the initial
  //   batch alongside 30+ gated recap claims; later a real recap task +
  //   a chat-sdk turn arrived as separate follow-up pushes. With "most
  //   recent unwritten overall", the follow-up chat-sdk context became
  //   `mostRecentTaskContext()` when the agent's `result.text` (which
  //   was actually the dream's `<internal>` summary) landed — text was
  //   attributed to the chat task, dream context flushed empty,
  //   dashboard showed "Silent fire — no output captured" for the dream
  //   even though it ran correctly.
  //
  //   Push-scoping makes the initial-batch dream context the only
  //   eligible target for the first result; the chat-sdk follow-up only
  //   becomes eligible after the dream context is written.
  //
  // Paired with the dream-only isolation block above (an initial batch
  // with a dream row defers all non-dream rows), the canonical dream
  // case is now structurally clean: dream is the lone context in push 0,
  // its result attributes to it, fire row carries the `<internal>`
  // summary.
  //
  // Errors set `streamErrored` so the finally skips the normal-completion
  // write; the outer catch in startMessageLoop writes one error fire per
  // unwritten context instead.
  //
  // Each entry is the contexts registered during a single push (initial
  // batch at index 0, each subsequent `query.push` appends a new entry).
  // Contexts can appear in only one push — `registerPushContexts` skips
  // any already present in an earlier push (idempotent with the existing
  // `registerTaskFireContextOnce`).
  const pushes: TaskFireContext[][] = [];
  const registerPushContexts = (ctxs: TaskFireContext[]): void => {
    const seenInPriorPush = new Set<string>();
    for (const earlier of pushes) {
      for (const c of earlier) seenInPriorPush.add(c.taskId);
    }
    const next = ctxs.filter((c) => !seenInPriorPush.has(c.taskId));
    pushes.push(next);
  };
  // Seed push 0 with the initial-batch contexts already populated by
  // the caller. Safe even when empty (chat-only turn — no task contexts;
  // results just won't attribute to any context, matching prior behavior).
  registerPushContexts([...taskFireContexts]);
  const mostRecentTaskContext = (): TaskFireContext | null => pickPushScopedContext(pushes);
  let streamErrored = false;
  // Lower bound for the task-turn destination/body dedup, advanced after each
  // result so the dedup only ever sees tool-sends from the CURRENT result's
  // turn — never an earlier turn's legitimate send in the same processQuery.
  // See dispatchResultText's `taskTurnDedupSince` param.
  let resultBoundaryAt = turnStartedAt;

  // Write a fire row for every still-unwritten task context. Called at
  // the `result` event (eager — a result means the turn is done) AND in
  // the finally (backstop for contexts that never produced a result,
  // e.g. stream torn down before result). The `written` guard makes the
  // second call a no-op for anything the first already flushed, so a
  // task can never produce two rows.
  //
  // Why eager-at-result, not finally-only (2026-05-16, telegram_dm_teddy
  // 23folg): the finally only runs when the `for await` stream closes.
  // On a warm agent-shared container the query is held open for the
  // follow-up window and the container does not idle-kill for many
  // minutes (browser pre-warm + 10 MCP servers keep it resident), so a
  // silent dream task that finished its turn at T had its fire stuck
  // unwritten until the stream finally closed — the dashboard showed
  // "never ran" for a task that completed. The `result` event is the
  // authoritative "this turn finished" signal; flush there.
  const flushUnwrittenTaskFires = (): void => {
    if (streamErrored) return; // error path writes its own 'error' fires
    for (const ctx of taskFireContexts) {
      if (ctx.written) continue;
      try {
        writeTaskFire({
          id: generateId(),
          seriesId: ctx.seriesId,
          taskId: ctx.taskId,
          status: ctx.errorMessage ? 'error' : ctx.dispatched.length > 0 ? 'completed' : 'silent',
          assistantText: ctx.assistantText,
          dispatched: ctx.dispatched,
          errorMessage: ctx.errorMessage,
        });
        ctx.written = true;
      } catch (err) {
        log(`task_fires write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  // Per-turn streamed-delivery state. The buffer and cursors reset at
  // each result boundary so later turns may deliberately repeat content.
  let midTurnSent = 0;
  // Delegation is not the reply owed to the requester.
  let midTurnReplied = 0;
  let turnStartSeq = maxOutboundSeq();
  let midTurnTail = '';
  let deliveredAssemblyFragment: string | undefined;
  // Why this turn's wrapped <message> blocks were refused (streamed door);
  // the wrapping retry names them instead of claiming nothing was wrapped.
  let turnDropReasons: DroppedBlock[] = [];
  // Prompt queue for the exchange hook — each result event consumes the
  // oldest unanswered prompt. Retries append the original user prompt at
  // their position in the provider input queue.
  const archivePrompts: string[] = initialPrompt ? [initialPrompt] : [];
  // Where replies go is a property of the TURN, not the query. The query
  // stays open across turns (below), so a message pushed after the previous
  // answer finished is a new turn and replies go to ITS thread; a message
  // pushed while an answer is still streaming waits its turn — the in-flight
  // answer keeps the destination it started with. Pushed routes queue in
  // push order (including retries) and advance at every result, mirroring
  // archivePrompts. An empty initial prompt (a pre-warmed query) starts idle.
  let answering = initialPrompt !== '';
  type QueuedTurn = {
    routing: RoutingContext;
    unwrappedNudged: boolean;
    nudgedWindow?: SeqWindow;
    /** The pushed prompt, kept so a failed queued turn can be remembered. */
    prompt?: string;
  };
  // Retry dedup is bounded to its original turn, never intervening follow-ups.
  let nudgedWindow: SeqWindow | undefined;
  const queuedTurns: QueuedTurn[] = [];
  // The user request the turn being answered still owes, for the failed-turn
  // reminder. Tracked explicitly: archivePrompts is shifted at each result and
  // its head may already be the NEXT turn's prompt. A pressure-handoff turn
  // owes none (undefined), so it never re-raises an answered request.
  let answeringPrompt: string | undefined = initialPrompt || undefined;
  const adoptTurn = (next: QueuedTurn): void => {
    Object.assign(routing, next.routing);
    unwrappedNudged = next.unwrappedNudged;
    nudgedWindow = next.nudgedWindow;
    answeringPrompt = next.prompt;
    publishReplyRoute(routing);
    answering = true;
  };
  // A retry is another provider input, behind any follow-ups already pushed.
  // Preserve its original route, prompt and retry guards until it is answered.
  // `userPrompt` is the user request the retry still owes an answer to (a
  // wrapping retry); the pressure handoff owes none, so it never feeds the
  // failed-turn reminder.
  const pushRetry = (prompt: string, retryOf?: SeqWindow, userPrompt?: string): void => {
    noteInput();
    query.push(prompt);
    queuedTurns.push({
      routing: { ...routing },
      unwrappedNudged,
      nudgedWindow: retryOf,
      prompt: userPrompt,
    });
    archivePrompts.push(archivePrompts[0] ?? initialPrompt);
  };

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  let endedForCommand = false;
  // One-shot: log a first-result hold once per turn, not on every poll tick
  // (otherwise it spams once per poll). Reset for every pushed input.
  let loggedHoldingForFirstResult = false;
  // Wall-clock of the last SDK event consumed on the events for-await
  // below. Initialized at stream open (a half-open stream that never
  // emits anything would otherwise leave this at 0 and let the
  // STREAM_INACTIVITY_MS gate fire immediately). Updated on every SDK
  // event in the events for-await loop. Read by the keepalive interval
  // to decide whether to refresh the heartbeat — see STREAM_INACTIVITY_MS.
  let lastEventAt = Date.now();
  // Keepalive: while the query stream is open AND has shown SDK
  // activity within STREAM_INACTIVITY_MS, refresh heartbeat at a cadence
  // well under IDLE_TIMEOUT (default 120s). The for-await loop below
  // bumps heartbeat on every SDK event, and Pre/PostToolUse hooks bump
  // on every tool boundary, but neither fires during LLM-only intervals
  // — a long text generation after the last tool call, or SDK ramp-up
  // between query.push() and the first new event, can exceed
  // IDLE_TIMEOUT and trip the host's `stop-idle` kill mid-thought. The
  // keepalive bridges those windows.
  //
  // BUT: an unconditional keepalive structurally suppresses host-side
  // stop-idle whenever the SDK stream goes silent half-open (Claude
  // SDK post-`result` keep-warm where the iterator suspends awaiting a
  // follow-up that never arrives; observed 2026-05-20, two chat
  // containers ran 2–3h after their last result event because the
  // keepalive kept .heartbeat fresh forever). Gate on lastEventAt:
  // once the SDK has gone silent past STREAM_INACTIVITY_MS, stop
  // touching the heartbeat so host-sweep's adaptive idle timeout can
  // do its job. A legitimately slow LLM-only interval emits SOME
  // SDK message (token delta, tool boundary, sub-agent status) inside
  // this window; only a genuinely stalled stream goes this quiet.
  const keepaliveHandle = setInterval(() => {
    if (done) return;
    if (!shouldKeepaliveBridge({ lastEventAt, now: Date.now(), inactivityMs: STREAM_INACTIVITY_MS })) return;
    touchHeartbeat();
  }, QUERY_KEEPALIVE_MS);
  let mailboxFailureStreak = 0;
  const pollHandle = setInterval(() => {
    // A host interrupt claims nothing more: new input waits for the next runtime.
    if (done || pollInFlight || endedForCommand || interruptRequested) return;
    pollInFlight = true;

    void (async () => {
      try {
        const pending = getPendingMessages();

        // Slash commands need a fresh query: /clear resets the SDK's
        // resume id (fixed at sdkQuery() time); admin/passthrough commands
        // (/compact, /cost, …) only dispatch when they're the first input
        // of a query — pushed mid-stream they arrive as plain text and
        // the SDK never runs them. Abort the active stream and leave the
        // rows pending; the outer loop handles them on next iteration via
        // the canonical command path + formatMessagesWithCommands. Abort,
        // not end: end() lets an in-flight turn run to completion, which
        // can block the command (e.g. /clear during a long task) for as
        // long as the turn takes.
        if (pending.some((m) => isRunnerCommand(m, providerName))) {
          log('Pending slash command — aborting active stream so outer loop can process');
          endedForCommand = true;
          query.abort();
          return;
        }

        // Skip system messages (MCP tool responses).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        // Accumulated trigger=0 context rows do not enter a live turn by
        // themselves. They ride only with a real trigger follow-up, then the
        // local isolation/script gates below may further defer them.
        const hasFollowUpTrigger = pending.some((m) => m.kind !== 'system' && m.trigger === 1);
        let newMessages = pending.filter((m) => m.kind !== 'system' && (m.trigger === 1 || hasFollowUpTrigger));
        if (newMessages.length === 0) return;

        // Accumulate gate (mirror of the cold-start gate above): if the
        // follow-up batch contains only trigger=0 rows, do NOT push them
        // into the active query. They're context-only (router stored them
        // under ignored_message_policy='accumulate' because the engagement
        // gate didn't fire) and pushing them as prompts makes the agent
        // respond to messages that were never addressed to it. Leave them
        // pending; the next trigger=1 message picks them up as context.
        // Without this gate, a warm container that's mid-turn responds to
        // every accumulate message in the channel — exactly the v1
        // requires_trigger gap operators reported (2026-05-09 AI Friends
        // "F" echo).
        if (!newMessages.some((m) => m.trigger === 1)) {
          // Don't markCompleted these — they need to ride along with the
          // next real trigger so the agent sees them as context.
          //
          // GUARD: do NOT end any active turn before its first result.
          // Ending here tears down the provider subprocess mid-init or
          // mid-generation → provider exits with no output → flagged
          // retryable → trigger stays pending → every host retry repeats.
          // This affected task turns first (Degenerates Dream, 2026-06-06)
          // and then a normal chat turn (Fasting, 2026-07-13). Leave the
          // accumulate-only rows pending and let the addressed turn finish;
          // after its result, this same gate can unwind the stream cleanly.
          if (!mayEndDeferredQuery()) {
            if (!loggedHoldingForFirstResult) {
              loggedHoldingForFirstResult = true;
              const holdReason = wrappingRetryInFlight
                ? 'the wrapping retry is still in flight'
                : 'the active turn is still in flight (no result yet)';
              log(
                `Holding active query open — ${newMessages.length} accumulate-only ` +
                  `follow-up(s) pending but ${holdReason}`,
              );
            }
            return;
          }
          // End the active query so the outer loop can unwind. Without
          // this, the SDK turn stays open indefinitely and this poll
          // interval keeps firing every 500ms forever — observed
          // 2026-05-12 ai_friends container in a 500ms hot loop
          // logging "Skipping 7 accumulate-only follow-up(s)" after
          // the agent had already returned a result; ambient Discord
          // chatter kept arriving as trigger=0 rows but no trigger=1
          // wake came. Stream lifecycle does NOT affect Anthropic
          // prompt-cache lifetime (5-min server-side TTL keyed on
          // prefix hash, see comment ~L376), so close+reopen within
          // 5 min still gets cache hits. Same shape as the
          // cross-sender stream-end below; accumulate-only is the
          // other "nothing to do here, let the outer loop sleep
          // cleanly" condition.
          log(`Ending active query — ${newMessages.length} accumulate-only follow-up(s) pending, no trigger=1 work`);
          if (!endedForCommand) {
            endedForCommand = true;
            query.end();
          }
          return;
        }

        // Cross-sender deferral: in a shared-session group chat, a trigger from
        // a different sender than the one currently being answered must NOT
        // get pushed into the active query — the SDK folds both into one
        // combined reply. Leave those rows pending; the outer loop re-queries
        // them after the current turn ends, where they get their own respond_to
        // marker and native platform reply-threading.
        //
        // **End the active query when ALL pending messages are cross-sender.**
        // The query intentionally stays open across same-sender follow-ups to
        // avoid re-spawning the SDK every turn. But when the only thing
        // pending is from a different sender, the query has nothing to do —
        // it just keeps deferring on every poll iteration. Without ending,
        // the outer loop never gets to start a fresh query for the deferred
        // sender, and the host's absolute-ceiling watchdog eventually kills
        // the container after ~30 min. Symptom: pending escalation/task rows
        // sit untouched while the log spams `Deferring N cross-sender
        // follow-up(s)` every 500ms (boysnight 2026-05-09: Adrian's
        // re-escalation request + a maintenance task pending 30 min before
        // container kill). Ending the stream lets the outer for-await unwind,
        // the outer loop re-queries fresh, and `activeSender` gets bound to
        // the deferred sender so the right respond_to lands.
        // Track whether either deferral fired this tick — used below to
        // decide whether to end the active stream when nothing pushable
        // remains. Without this, a batch containing BOTH cross-sender
        // rows AND a maintenance task row spins forever: cross-sender
        // branch leaves the task in `sameSender` (so length!=0, no
        // stream-end), task-wake branch strips the task and returns
        // silently (no stream-end either), outer loop never gets to
        // re-query for the deferred sender, host's 30-min absolute
        // ceiling eventually SIGKILLs. Observed 2026-05-13 in
        // discord_ai_friends from 16:35 onward.
        let crossSenderDeferred = false;
        if (activeSender) {
          const sameSender: typeof newMessages = [];
          const deferred: string[] = [];
          for (const m of newMessages) {
            // Only another sender's *trigger* is cross-sender work. Accumulated
            // trigger=0 rows are unaddressed room context from the same route
            // (the mailbox already filtered to it); they must ride with the
            // same-sender trigger. Deferring them by sender hid everyone
            // else's messages from the turn (Boys Night 2026-10-23: four
            // people posted bets, the mention saw only Teddy's own). Context
            // from another route still defers, and context alone never pushes.
            const s = extractMessageSender(m);
            const sameRouteContext =
              m.trigger !== 1 && m.platform_id === routing.platformId && m.channel_type === routing.channelType;
            if (s && s !== activeSender && !sameRouteContext) {
              deferred.push(m.id);
            } else {
              sameSender.push(m);
            }
          }
          if (!sameSender.some((m) => m.trigger === 1)) {
            // Only context remained: leave it pending for the deferred trigger.
            for (const m of sameSender) deferred.push(m.id);
            sameSender.length = 0;
          }
          if (deferred.length > 0) {
            log(`Deferring ${deferred.length} cross-sender follow-up(s) — will re-process after active turn`);
            crossSenderDeferred = true;
          }
          newMessages = sameSender;
          if (newMessages.length === 0) {
            if (deferred.length > 0 && !endedForCommand && mayEndDeferredQuery()) {
              log(
                `All pending messages are cross-sender — ending active query so outer loop can re-query for deferred sender`,
              );
              endedForCommand = true;
              query.end();
            }
            return;
          }
        }

        // Task-wake deferral: maintenance task rows (kind='task',
        // typically reflection/dream/recurring) that arrive mid-user-turn
        // must NOT be pushed into the active query. The SDK folds the
        // task prompt onto the live conversation, which produces a
        // second result event with a near-duplicate <message> block —
        // the user sees the same reply twice ~3 sec apart (observed
        // 2026-05-12 Tico+Janathan WA group: reflection fired at 13:17:44
        // between two outbound rows for Janice's "lol but how do I
        // listen", agent re-replied with the same Suno suggestion).
        // The "DO NOT MESSAGE THE USER" prompt instruction is backstop,
        // not gate — the model can rationalize a second reply when the
        // immediately-prior user turn is still vivid in context. Leave
        // task rows pending; the outer loop picks them up on the next
        // iteration where they get their own respond_to context and a
        // task-only batch (chat row is already markCompleted, so won't
        // ride along). Same shape as the cross-sender deferral above.
        if (activeSender) {
          const userOnly: typeof newMessages = [];
          const taskDeferred: string[] = [];
          for (const m of newMessages) {
            if (m.kind === 'task' && m.trigger === 1) {
              taskDeferred.push(m.id);
            } else {
              userOnly.push(m);
            }
          }
          if (taskDeferred.length > 0) {
            log(`Deferring ${taskDeferred.length} maintenance task wake(s) — will re-process after active user turn`);
          }
          newMessages = userOnly;
          if (newMessages.length === 0) {
            // A trigger task commonly appears immediately after an
            // acknowledgement because the host schedules reflection from
            // that outbound. Ending before the chat's first result aborts
            // the promised work and lets the silent reflection replace it
            // (New York Crew, twice on 2026-08-29). Defer immediately, but
            // hold the active query until its result is safely delivered.
            if (!mayEndDeferredQuery()) {
              if (!loggedHoldingForFirstResult) {
                loggedHoldingForFirstResult = true;
                const holdReason = wrappingRetryInFlight
                  ? 'the wrapping retry is still in flight'
                  : 'the active user turn is still in flight (no result yet)';
                log(
                  `Holding active user query open — ${taskDeferred.length} deferred maintenance task ` +
                    `wake(s) pending but ${holdReason}`,
                );
              }
              return;
            }
            // Nothing pushable remains — end the active stream regardless of
            // whether cross-sender deferred too. The earlier rationale here
            // ("if only task rows deferred, leave open so Result: can land")
            // assumed the active turn was still mid-response. That's a wrong
            // proxy: when the model has finished its turn the SDK simply
            // stops emitting events — there is no "still typing" signal we
            // can read from in here. Leaving the stream open in that case
            // produces an infinite spin: every poll tick re-defers the same
            // task row, host-sweep sees `dueCount > 0` so the idle-timeout
            // never fires, and the container stays up forever (observed
            // 2026-05-14 in discord_degenerates: agent finished a 4-message
            // burst at 23:09, then RSS + reflection task rows arrived and
            // were deferred every 500ms for 20+ min).
            //
            // end() may terminate the provider immediately (Codex). The
            // pending-input/dispatch guard above, not end() itself, makes
            // this safe. Deferred tasks stay pending for the next query.
            if (!endedForCommand) {
              const reason = crossSenderDeferred ? `re-query for deferred sender` : `re-query for deferred task`;
              log(`Remaining pending are only deferred — ending active query so outer loop can ${reason}`);
              endedForCommand = true;
              query.end();
            }
            return;
          }
        }

        // Task-turn chat deferral — the symmetric counterpart of the
        // task-wake deferral above, and the follow-up-path half of the
        // Bug D fix (the initial-batch half is the hasTaskTrigger
        // isolation up top). When the ACTIVE turn is a task-only turn
        // (activeSender null — tasks carry no chat sender — and a task
        // context was seeded), chat/chat-sdk rows that arrive mid-turn
        // must NOT be pushed into the task's stream: folding live chat
        // into a silent maintenance turn is exactly the 2026-05-16
        // AI-Friends dream-summary leak. Bug 6's end-stream-at-result
        // shrinks this window to a single LLM generation, but the
        // follow-up poll runs concurrently during that generation, so
        // chat can still arrive before the result event — this closes
        // it. Leave the chat rows pending; the outer loop gives them
        // their own chat-triggered turn. Non-chat follow-ups (another
        // due task) still flow through.
        if (!activeSender && taskFireContexts.length > 0) {
          const chatDeferred = newMessages.filter((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
          if (chatDeferred.length > 0) {
            log(
              `Task-only turn active — deferring ${chatDeferred.length} chat follow-up(s); left pending for next chat wake`,
            );
            newMessages = newMessages.filter((m) => !(m.kind === 'chat' || m.kind === 'chat-sdk'));
            if (newMessages.length === 0) {
              // Deferring the chat is correct immediately; ending the task's
              // stream is not. If the task has not produced a result yet,
              // query.end() kills Codex during init/generation and leaves the
              // same task + chat triggers pending for an identical retry loop.
              if (!mayEndDeferredQuery()) {
                if (!loggedHoldingForFirstResult) {
                  loggedHoldingForFirstResult = true;
                  const holdReason = wrappingRetryInFlight
                    ? 'the wrapping retry is still in flight'
                    : 'the task is still in flight (no result yet)';
                  log(
                    `Holding active task query open — ${chatDeferred.length} deferred chat ` +
                      `follow-up(s) pending but ${holdReason}`,
                  );
                }
                return;
              }
              if (!endedForCommand) {
                log('Only chat follow-ups remain after task result — ending stream so outer loop re-queries them');
                endedForCommand = true;
                query.end();
              }
              return;
            }
          }
        }

        // Symmetric guard for the REVERSE case: a task trigger (the dream /
        // maintenance occurrence is the common one) arriving while a CHAT
        // turn is active. The block above only defers chat *into* a task
        // turn; without this, a dream task that comes due mid-chat gets
        // `query.push`ed straight into the live chat conversation. The
        // silent-maintenance prompt folds into the chat thread and the agent
        // emits a throwaway chat-evaluation `<internal>` (or nothing) instead
        // of running the Dream protocol — the dream fire records empty and the
        // day's consolidation never happens. Observed 2026-05-31
        // `ag-1778154011329-g9zust`: group notes/CURRENT froze at 2026-05-28;
        // dream fires 05-27/30/31 were all `silent` empty because the dream
        // rode a later chat wake into an active chat turn. End the stream so
        // the outer loop re-queries the task in its own selectInitialBatch-
        // isolated turn. The task rows stay pending (never markProcessing'd
        // here), so they're not lost. `activeSender` truthy === a chat turn
        // is active (it's the chat sender; null for task-only turns).
        // A bound task turn cannot absorb another task's owner or execute
        // its script under the original principal. Optimus isolates it too.
        const boundTaskFollowup =
          Boolean(process.env.OPTIMUS_TURN_IDENTITY_FILE) &&
          newMessages.some((m) => m.kind === 'task' && m.trigger === 1);
        if ((boundTaskFollowup || shouldDeferTaskFromChatTurn(activeSender, newMessages)) && !endedForCommand) {
          if (!mayEndDeferredQuery()) return;
          const taskCount = newMessages.filter((m) => m.kind === 'task' && m.trigger === 1).length;
          log(
            `Task trigger (${taskCount}) arrived during an active turn — ending stream so the task gets an isolated turn`,
          );
          endedForCommand = true;
          query.end();
          return;
        }

        // Never push a new addressed input or run its scripts under merely
        // the previous turn's principal. Host selection cannot change actor.
        if (
          process.env.OPTIMUS_TURN_IDENTITY_FILE &&
          !(await extendIdentityTurn(newMessages.filter((m) => m.trigger === 1).map((m) => m.id)))
        ) {
          if (mayEndDeferredQuery() && !endedForCommand) {
            endedForCommand = true;
            query.end();
          }
          return;
        }
        if (done) return;
        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Register fire contexts for follow-up task triggers BEFORE the
        // pre-task-script await and BEFORE any early-return below.
        //
        // Issue A (telegram_dm_teddy 23folg, 2026-05-16): a busy
        // agent-shared session had 6 completed dream-task rows and ZERO
        // task_fires rows. Cause: a follow-up task is markProcessing'd
        // here, then the pre-task `await import()` yields; the active
        // outer query can finish during that await, so `if (done)
        // return;` (and the accumulate-only return) bail *before* the
        // original seeding loop further down. The row is left
        // 'processing' with no fire context, gets swept to 'completed'
        // host-side, and no fire is ever written — the dashboard shows
        // "never ran" for a task that ran every day. Seeding here, ahead
        // of every bail, guarantees the finally/error writers in
        // processQuery flush a (silent|completed|error) fire for it.
        // The later seeding loop is now idempotent (registerTaskFire-
        // ContextOnce) so a task that DOES survive to the push isn't
        // double-counted.
        for (const m of newMessages) {
          if (m.kind !== 'task' || m.trigger !== 1) continue;
          registerTaskFireContextOnce(taskFireContexts, m);
        }

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: Array<{ id: string; reason: string }> = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markScriptSkipped(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.map((s) => s.id).join(', ')}`);
          // Record a 'gated' fire per skipped follow-up task — the exact
          // mirror of the initial-batch gated-write at the
          // scheduling-pre-task hook above. Without this, a script-gated
          // task that arrives while the container is already running
          // (the dream/maintenance common case, since those agents are
          // usually mid-turn when the 04:00 occurrence comes due) shows
          // "never ran" on the dashboard despite firing on schedule.
          for (const g of preTask.gated) {
            try {
              writeTaskFire({
                id: generateId(),
                seriesId: g.seriesId,
                taskId: g.taskId,
                status: 'gated',
                assistantText: null,
                dispatched: [],
                errorMessage: g.reason === 'script error/no output' ? g.reason : null,
              });
            } catch (err) {
              log(`task_fires gated-write failed for ${g.taskId}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;

        // Re-check the accumulate gate after script filtering. The gate
        // above lets the batch through if ANY message has trigger=1, but
        // a recurring task with wakeAgent=false (e.g. dream/maintenance
        // scripts that decide nothing's worth waking for) is the only
        // trigger=1 row in the batch and gets stripped here. Without this
        // re-check, the trigger=0 accumulate rows that rode along get
        // pushed to the agent as if they were prompts — defeating the
        // requires_trigger contract.
        if (!keep.some((m) => m.trigger === 1)) {
          log(
            `Skipping ${keep.length} accumulate-only follow-up(s) after script filter — leaving pending until next trigger`,
          );
          // These tasks did NOT run this turn — drop the contexts seeded
          // right after markProcessing so processQuery's finally can't
          // write a spurious 'silent' fire for a task that never ran.
          // The real fire is recorded when the task is re-triggered and
          // runs in its own (now Bug-D-isolated) turn.
          dropUnrunTaskContexts(taskFireContexts, newMessages);
          // Release the claim taken by markProcessing(newIds) so the rows
          // really are pending again and ride along with the next trigger.
          releaseProcessing(keep.map((m) => m.id));
          return;
        }
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim
        // sweep and re-triggered, where they record their fire properly.
        if (done) {
          dropUnrunTaskContexts(taskFireContexts, newMessages);
          return;
        }

        // Re-affirm fire contexts for the follow-up tasks that survived
        // the pre-task script and are about to be pushed. Idempotent:
        // the seeding right after markProcessing(newIds) above already
        // registered these; this is a no-op for them and only matters
        // if `keep` somehow gained a task row the earlier pass missed.
        // The finally/error writers iterate every registered context.
        for (const m of keep) {
          if (m.kind !== 'task' || m.trigger !== 1) continue;
          registerTaskFireContextOnce(taskFireContexts, m);
        }

        const keptIds = keep.map((m) => m.id);
        let prompt = prependDeliveryFeedback(formatMessages(keep));
        // Load inbound image attachments for the follow-up batch too —
        // operator can drop a screenshot mid-turn and the agent should see
        // it without waiting for a fresh query. Same /workspace/inbox/ path
        // shape as the initial turn.
        const followupImageRefs = extractImageAttachments(keep);
        const followupImageBlocks = loadImageBlocks(followupImageRefs);
        if (followupImageBlocks.length > 0) {
          log(
            `Pushing ${keep.length} follow-up message(s) with ${followupImageBlocks.length} image(s) into active query`,
          );
        } else {
          log(`Pushing ${keep.length} follow-up message(s) into active query`);
        }
        // Reset the unwrapped-output nudge gate so the next turn's
        // formatter check fires fresh (upstream v2.0.58 fix(poll-loop):
        // nudge agent when output lacks message wrapping).
        // Bump heartbeat before pushing. The push hands work to the SDK,
        // but the SDK ramp-up (LLM API call, first tool call) can exceed
        // IDLE_TIMEOUT (120s) — host-sweep would then read a stale
        // heartbeat (last bumped at the previous PostToolUse) with
        // current_tool empty and dueCount=0 (we're about to markCompleted),
        // and fire `stop-idle` mid-stream. Signal "we just gave the agent
        // more work" so the idle clock restarts from now.
        touchHeartbeat();
        lastEventAt = Date.now();
        // Open a new push partition for per-push attribution before the
        // SDK push. Result events that arrive after this point are
        // candidates to attribute to these follow-up task contexts only
        // once every earlier push's contexts have been written. The push
        // entry can be empty (a chat-sdk-only follow-up registers no task
        // contexts) — that's fine; it just means no task-attribution
        // change for this push, and earlier pushes' contexts remain
        // eligible for results.
        const pushTaskContexts = keep
          .filter((m) => m.kind === 'task' && m.trigger === 1)
          .map((m) => taskFireContexts.find((c) => c.taskId === m.id))
          .filter((c): c is TaskFireContext => c !== undefined);
        registerPushContexts(pushTaskContexts);
        const pushIsChat = keep.some((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
        // Read immediately before push(): the provider's fold-vs-queue choice
        // is made synchronously from the same state.
        const waitsFor = pushIsChat && query.pushWaitsFor ? query.pushWaitsFor(prompt) : 0;
        if (
          pushIsChat &&
          ((resultIndex !== pressureHandoffPushIndex &&
            supersedeCurrentChatPush(pushSuperseded, resultIndex, activeProviderName())) ||
            (waitsFor > 0 && supersedeQueuedChatPushes(pushSuperseded, pushChat, resultIndex, waitsFor)))
        ) {
          prompt += `\n${SUPERSEDED_RESPONSE_NOTICE}`;
        }
        pushIds.set(pushAddressed.length, keptIds);
        pushAddressed.push(isAddressedTurn(keep, assistantName));
        pushChat.push(pushIsChat);
        pushSuperseded.push(false);
        noteInput();
        query.push(prompt, followupImageBlocks.length > 0 ? followupImageBlocks : undefined);
        archivePrompts.push(prompt);
        const next: QueuedTurn = {
          routing: extractRouting(keep),
          unwrappedNudged: false,
          prompt,
        };
        // The user wrote again on a route with an unfinished-request marker:
        // this still-open thread already holds the failed turn, so retire the
        // marker rather than let a later fresh thread resurface it.
        if (keep.some((m) => m.kind === 'chat' || m.kind === 'chat-sdk') && failedTurnEligible(next.routing, false)) {
          clearFailedTurnFor(next.routing);
        }
        if (answering) queuedTurns.push(next);
        else adoptTurn(next);
        // keptIds stay claimed until their own result marks them.
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);

        if (getAgentMailbox().shouldRestartAfter?.(err)) {
          mailboxFailureStreak += 1;
          if (mailboxFailureStreak >= MAILBOX_FAILURE_STREAK_EXIT) {
            log(
              `Follow-up poll: ${mailboxFailureStreak} consecutive '${errMsg}' errors — ` +
                `mailbox driver requested a fresh runner. Exiting so the host respawns it.`,
            );
            // Stop touching the heartbeat so host-sweep stale detection fires
            // promptly even if exit() races with in-flight async work.
            done = true;
            clearInterval(pollHandle);
            // Defer exit one tick so this log line flushes through Docker's
            // log driver before the process dies.
            setTimeout(() => process.exit(75), 100);
          }
        } else {
          mailboxFailureStreak = 0;
        }
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    try {
      // Inner try only exists to flip streamErrored before re-throwing —
      // the outer try/finally still owns interval cleanup + task-fire
      // write. Without this flag we'd write a 'silent'/'completed' row
      // in the finally below AND an 'error' row in the outer caller's
      // catch, double-counting the fire.
      for await (const event of query.events) {
        // Failover may switch harnesses inside the same query. Do not cache
        // the standing provider's delivery mode or assemble a partial tag
        // across two independent harness attempts. Keep successful sends for
        // dedup/fallback accounting; switching is not a new user turn.
        const deliveryProviderName = activeProviderName();
        const emitsMidTurnText = query.delivery?.emitsMidTurnText ?? defaultMidTurnText;
        if (deliveryProviderName !== textProviderName) {
          midTurnTail = '';
          deliveredAssemblyFragment = undefined;
          textProviderName = deliveryProviderName;
        }
        // Claude's streaming input folds pushes into the in-flight result,
        // unless the query serializes inputs (Optimus' effort resolver holds
        // each push until the previous result): then every push has its own.
        const mergesPushes = query.mergesPushedInputs ?? deliveryProviderName === 'claude';
        const resultPushEnd = mergesPushes ? pushAddressed.length : resultIndex + 1;
        if (event.type === 'result') {
          // Consume inputs before any awaited dispatch; a push during dispatch
          // belongs to the next result. Read the wrapped query's ACTIVE harness.
          dispatchingResult = true;
          pendingResults = mergesPushes ? 0 : Math.max(0, pendingResults - 1);
        }
        await handleEvent(event, routing);
        touchHeartbeat();
        lastEventAt = Date.now();

        if (event.type === 'init') {
          queryContinuation = event.continuation;
          // Persist immediately so a mid-turn container crash still lets the
          // next wake resume the conversation. Without this, the session id
          // was only written after the full stream completed — if the
          // container died between `init` and `result`, the SDK session was
          // effectively orphaned and the next message started a blank
          // Claude session with no prior context.
          setContinuation(providerName, event.continuation);
        } else if (event.type === 'text') {
          if (emitsMidTurnText) {
            const fireCtx = mostRecentTaskContext();
            const resultAddressed = pushAddressed[resultIndex] ?? false;
            const taskTurn = !!fireCtx && !resultAddressed;
            const scan = await deliverMidTurnBlocks(event.text, routing, turnStartSeq, midTurnTail, {
              turnStartedAt: resultBoundaryAt,
              taskTurn,
              taskTurnDedupSince: resultBoundaryAt,
              nudgedWindow,
            });
            midTurnSent += scan.delivered;
            midTurnReplied += scan.replied;
            midTurnTail = scan.tail;
            deliveredAssemblyFragment = scan.deliveredAssemblyFragment;
            turnDropReasons.push(...scan.dropped);
            if (fireCtx && scan.dispatched.length > 0) fireCtx.dispatched.push(...scan.dispatched);
          }
        } else if (event.type === 'result') {
          // Provider results are ordered with pushes. If the prior result
          // triggered a wrapping retry, this is that retry's result; deferred
          // follow-up gates may end the query again after it is processed.
          wrappingRetryInFlight = false;
          // A result — with or without text — means the turn is done. Mark
          // the initial batch completed now so the host sweep doesn't see
          // stale 'processing' claims while the query stays open for
          // follow-up pushes. The agent may have responded via MCP
          // (send_message) mid-turn, or the message may not need a response
          // at all — either way the turn is finished.
          //
          // Error results are terminal, but never successful/silent fires.
          // Telegram Dream 2026-08-26 returned a gateway 502 as a result;
          // telemetry previously labelled it silent and hid the failure.
          lastHandledErrorResult = event.isError ? (event.error ?? event.text) : null;
          if (event.isError) {
            const ctx = mostRecentTaskContext();
            if (ctx) ctx.errorMessage = event.error || event.text || 'Provider returned an error result';
          }
          // Snapshot taken before handleEvent awaits: inputs arriving during
          // dispatch belong to the next result. Claude merges pending inputs,
          // so advancing just one slot leaves stale addressed flags behind and
          // misclassifies a later internal pressure handoff as a user request.
          const resultAddressed = pushAddressed.slice(resultIndex, resultPushEnd).some(Boolean);
          const resultChat = pushChat.slice(resultIndex, resultPushEnd).some(Boolean);
          // A queued Codex push may have been replayed into Claude during
          // failover; Claude can merge it into this very result. Pi (any
          // query reporting pushWaitsFor) serializes queued pushes like Codex.
          const resultSuperseded =
            (deliveryProviderName === 'codex' || (typeof query.pushWaitsFor === 'function' && !mergesPushes)) &&
            (pushSuperseded[resultIndex] ?? false);
          const resultIds = takePushIds(resultIndex, resultPushEnd);
          resultIndex = resultPushEnd;
          if (event.isError) {
            for (const id of resultIds) {
              markFailed(id);
              queryMessageOutcome.failed.add(id);
            }
          } else {
            markCompleted(resultIds);
          }
          if (resultSuperseded) {
            log('Suppressing superseded chat result — a same-sender follow-up arrived before completion');
            notifyExchangeComplete(onExchangeComplete, {
              prompt: archivePrompts[0] ?? initialPrompt,
              result: event.text,
              continuation: queryContinuation ?? initialContinuation,
              status: 'undelivered',
            });
            archivePrompts.shift();
            compactedSinceLastResult = false;
            resultBoundaryAt = outboundDbNow();
            midTurnSent = 0;
            midTurnReplied = 0;
            nudgedWindow = undefined;
            turnStartSeq = maxOutboundSeq();
            midTurnTail = '';
            deliveredAssemblyFragment = undefined;
            turnDropReasons = [];
            const next = queuedTurns.shift();
            if (next) adoptTurn(next);
            else {
              answering = false;
              answeringPrompt = undefined;
            }
            dispatchingResult = false;
            continue;
          }
          if (event.text || event.isError) {
            const authFailure =
              event.isError && isProviderAuthFailureText([event.text, event.error].filter(Boolean).join('\n'));
            const archivedResult = [event.text, event.isError ? event.error : undefined].filter(Boolean).join('\n');
            // Attribute this result push-scoped: the newest unwritten
            // context in the OLDEST push that still has one. The SDK
            // delivers results in push order, so the earliest pending
            // push owns the next result. See processQuery's attribution
            // note for why this beats the prior overall-most-recent walk.
            const fireCtx = mostRecentTaskContext();
            if (fireCtx) fireCtx.assistantText = archivedResult;
            // A task turn = this result push is attributed to a task fire and
            // no human addressed it. Such turns owe "exactly one message" and
            // must not append a final summary block to a destination they
            // already delivered to mid-turn via send_message/send_file.
            const isTaskTurn = !!fireCtx && !resultAddressed;
            const { hasUnwrapped, dispatched, dropped, undelivered } = await dispatchResultText(
              authFailure ? AUTH_FAILURE_USER_TEXT : (event.text ?? ''),
              routing,
              resultAddressed,
              resultBoundaryAt,
              compactedSinceLastResult,
              isTaskTurn,
              resultBoundaryAt,
              {
                midTurnSent,
                midTurnReplied,
                turnStartSeq,
                nudgedWindow,
                deliveredAssemblyFragment,
                suppressDelivery: emitsMidTurnText,
                errorResult: event.isError === true,
              },
            );
            if (fireCtx && dispatched.length > 0) {
              fireCtx.dispatched.push(...dispatched);
            }
            if (event.isError === true) {
              // Non-retryable error turn (e.g. both provider accounts are at
              // quota) with no <message> envelope: deliver the notice for an
              // interactive chat instead of dropping it as scratchpad. Task-
              // only failures remain silent in-channel, matching the outer
              // provider-throw path and scheduled-maintenance contract.
              if (authFailure) {
                await emitProviderAuthFailureAlert({
                  provider: deliveryProviderName,
                  failedOverTo: null,
                  turnKind: isTaskTurn ? 'task' : 'chat',
                });
              }
              if (isTaskTurn) {
                log(`Suppressing user-visible error result for task-only turn: ${event.text ?? '(empty)'}`);
              } else if (routing.failureNoticeWake) {
                // Never answer a failure notice with another: an a2a or
                // self-addressed failure chain stops after one notice. Keep
                // the reason here, since the skipped notice was its only record.
                log(`Error result — notice not sent on this route: ${event.error ?? FAILED_RUN_USER_TEXT}`);
              } else {
                await deliverErrorResult(
                  routing,
                  authFailure ? AUTH_FAILURE_USER_TEXT : (event.error ?? FAILED_RUN_USER_TEXT),
                );
                rememberFailedTurn(routing, isTaskTurn, [answeringPrompt]);
              }
              notifyExchangeComplete(onExchangeComplete, {
                prompt: archivePrompts[0] ?? initialPrompt,
                result: archivedResult,
                continuation: queryContinuation ?? initialContinuation,
                status: 'error',
              });
              archivePrompts.shift();
            } else {
              const willRetryWrapping = hasUnwrapped && !unwrappedNudged;
              const refusedBlocks = uniqueDroppedBlocks([...turnDropReasons, ...dropped]);
              if (!willRetryWrapping) {
                // No retry remains. Refused blocks must not vanish even when
                // other output was delivered or the wrapping retry was ignored.
                // Send-time refusals already recorded their own feedback.
                for (const block of refusedBlocks) {
                  if (!block.feedbackRecorded) recordDeliveryFeedback(`${block.detail}; that block was not posted.`);
                }
              }
              notifyExchangeComplete(onExchangeComplete, {
                prompt: archivePrompts[0] ?? initialPrompt,
                result: archivedResult,
                continuation: queryContinuation ?? initialContinuation,
                status: hasUnwrapped ? 'undelivered' : 'completed',
              });
              if (willRetryWrapping) {
                unwrappedNudged = true;
                wrappingRetryInFlight = true;
                const destinations = getAllDestinations();
                const names = destinations.map((d) => d.name).join(', ');
                const sentThisTurn = chatRowsInWindow(turnStartSeq);
                // Keep actionable refusal diagnostics even when an earlier tool
                // acknowledgment/delegation requires the informed retry too.
                const retryPrompt = wrappingRetryPrompt(names, refusedBlocks);
                pushRetry(
                  sentThisTurn.length > 0
                    ? buildInformedWrapNudge(sentThisTurn, undelivered ?? '', destinations, refusedBlocks)
                    : retryPrompt,
                  { after: turnStartSeq, upto: maxOutboundSeq() },
                  answeringPrompt,
                );
                pushAddressed.push(resultAddressed);
                pushChat.push(resultChat);
                pushSuperseded.push(false);
              } else if (hasUnwrapped && resultAddressed) {
                // The model ignored the one allowed wrapping retry. Convert
                // the exhausted addressed turn into the same deterministic
                // scoped fallback as a truly empty addressed result. Do not
                // pass the stream-wide turnStartedAt: an earlier push may
                // legitimately have replied in this warm query, but that
                // must not make this later follow-up look answered.
                const fallback = await dispatchResultText('', routing, true);
                if (fireCtx && fallback.dispatched.length > 0) {
                  fireCtx.dispatched.push(...fallback.dispatched);
                }
              }
              // The wrapping-retry result answers the SAME user prompt — keep it
              // queued so the retry archives against it, not the nudge text.
              archivePrompts.shift();
            }
          } else if (resultAddressed && midTurnSent === 0 && !chatRowWrittenSince(turnStartSeq)) {
            // A result event with no text is still a completed provider turn.
            // Retryable provider failures use the separate error-event path;
            // a genuinely empty addressed result must not disappear silently.
            // Scope tool-delivery detection to this push so an earlier warm-
            // query reply cannot suppress the fallback for this follow-up.
            const fireCtx = mostRecentTaskContext();
            const fallback = await dispatchResultText('', routing, true, resultBoundaryAt, compactedSinceLastResult);
            if (fireCtx && fallback.dispatched.length > 0) {
              fireCtx.dispatched.push(...fallback.dispatched);
            }
            notifyExchangeComplete(onExchangeComplete, {
              prompt: archivePrompts[0] ?? initialPrompt,
              result: null,
              continuation: queryContinuation ?? initialContinuation,
              status: 'completed',
            });
            archivePrompts.shift();
          } else {
            // Silent result (no text, no compaction notice) — keep the
            // exchange archive queue in sync with consumed prompts.
            archivePrompts.shift();
          }
          compactedSinceLastResult = false;
          // Advance the per-result dedup boundary. A single processQuery can
          // service multiple result pushes (task fire + deferred chat
          // follow-up); turnStartedAt is captured once and would let an
          // EARLIER push's legit send to a destination suppress a LATER,
          // distinct push's message to the same destination (cross-turn
          // bleed — broke `mixed task + chat batch` integration test).
          // Scoping the task-turn destination/body dedup to "since the previous
          // result boundary" confines it to this push's own mid-turn sends.
          resultBoundaryAt = outboundDbNow();
          // Eager flush: a `result` means the turn finished. Write the
          // fire(s) now instead of waiting for the stream to close —
          // a warm agent-shared container holds the query open for many
          // minutes, so finally-only left silent task fires unwritten
          // (telegram_dm_teddy 23folg, 2026-05-16: 0 fires after a
          // 7-min watch; the container never idle-killed). Runs after
          // attribution/dispatch above so status + assistantText +
          // dispatched are populated. Unconditional (outside the
          // `if (event.text)` block) so a silent / `<internal>`-only
          // turn — the canonical dream/maintenance shape, empty
          // event.text — also records its 'silent' fire. The finally
          // remains as a backstop for contexts that never see a result.
          flushUnwrittenTaskFires();

          // ── Context-pressure consolidate-then-rotate ──
          // (pressure-rotation.ts). Runs BEFORE the task-only stream-end
          // below so a handoff requested on a task-only result keeps the
          // query open long enough to execute.
          const thisResultPushIndex = resultIndex - 1;
          if (pressureState === 'handoff-requested' && thisResultPushIndex >= pressureHandoffPushIndex) {
            // The handoff turn finished — its durable note is written (or
            // the agent flubbed it; either way the markdown archive from
            // maybeRotateContinuation's next pass and memory/ still exist).
            // Rotation is poll-loop-owned and deterministic: clear the
            // persisted thread state, leave a one-shot notice for the
            // fresh thread, and end the stream so the next dequeue starts
            // clean.
            const cleared = clearAllSessionTrackingState();
            setRotationNotice(buildRotationNotice('context pressure — proactive pre-compaction rotation'));
            pressureState = 'rotated';
            pressureRotated = true;
            log(`Pressure rotation: handoff turn complete — cleared ${cleared} session-tracking row(s), ending stream`);
            if (!endedForCommand) {
              endedForCommand = true;
              query.end();
            }
          } else if (shouldRequestPressureHandoff(pressureState, event.tokensUsed, pressureThresholdTokens)) {
            pressureState = 'handoff-requested';
            pressureHandoffPushIndex = pushAddressed.length;
            log(
              `Context pressure: ${event.tokensUsed} tokens >= ${pressureThresholdTokens} — ` +
                `pushing consolidate-then-rotate handoff turn`,
            );
            pushRetry(buildPressureHandoffPrompt(event.tokensUsed as number, pressureThresholdTokens as number));
            pushAddressed.push(false);
            pushChat.push(false);
            pushSuperseded.push(false);
          }

          // Bug 6 (telegram_dm_teddy 23folg, 2026-05-16): end the stream
          // after a task-only turn's result. `activeSender` is null when
          // the trigger was a task row (tasks have no chat sender — the
          // same signal the task-wake-deferral keys off below), and
          // taskFireContexts is non-empty iff ≥1 task trigger drove this
          // turn. A scheduled task has no human follow-up sender to wait
          // for, so holding the query open serves nothing — it only
          // keeps the keepalive (poll-loop.ts:675) bumping the heartbeat
          // every 30s, which permanently suppresses the host's
          // `stop-idle` kill (heartbeatAge never exceeds the 120s
          // idleTimeout). The container then lingers until orphan-reap
          // or a host restart (~30 min observed) instead of idle-killing
          // in ~2 min. `query.end()` only signals "no more inputs from
          // us" — pending SDK output still drains through this for-await
          // so nothing is truncated; the outer loop re-queries cleanly
          // if another task came due meanwhile. Identical shape to the
          // accumulate-only / cross-sender stream-ends below. A chat
          // turn (activeSender set) is left open as before so a human
          // can follow up without re-spawning the SDK.
          if (
            !activeSender &&
            taskFireContexts.length > 0 &&
            !endedForCommand &&
            pressureState !== 'handoff-requested' &&
            pendingResults === 0
          ) {
            log('Task-only turn complete — ending stream so the container can idle-kill');
            endedForCommand = true;
            query.end();
          }
          // Streamed-delivery state is turn-scoped. Advance the durable
          // cursor only after the result's nudge/dedupe decisions consumed it.
          midTurnSent = 0;
          midTurnReplied = 0;
          nudgedWindow = undefined;
          turnStartSeq = maxOutboundSeq();
          midTurnTail = '';
          deliveredAssemblyFragment = undefined;
          turnDropReasons = [];
          const next = queuedTurns.shift();
          if (next) adoptTurn(next);
          else {
            answering = false;
            answeringPrompt = undefined;
          }
          dispatchingResult = false;
        } else if (event.type === 'progress' && event.message.startsWith('Context compacted')) {
          compactedSinceLastResult = true;
        } else if (event.type === 'error' && event.retryable && resultIndex === 0) {
          // Remember the most recent retryable error that arrived without a
          // result. Don't throw mid-stream — let the provider drain any
          // trailing events. Resolved after the for-await closes.
          retryableErrorWithoutResult = event.message;
        }
      }
      // The stream closed with a retryable error and never produced a
      // result — surface it as a throw so the caller's catch path records an
      // `error` fire and leaves the task row pending for a host retry,
      // instead of the finally/caller silently marking it completed.
      if (retryableErrorWithoutResult && resultIndex === 0) {
        streamErrored = true;
        throw new Error(`retryable provider error, no result: ${retryableErrorWithoutResult}`);
      }
    } catch (err) {
      if (isHandledErrorResultEcho(err, lastHandledErrorResult, resultIndex, answering)) {
        // The error result was already delivered/recorded when it arrived;
        // the SDK is only repeating it at teardown. Rethrowing posted a second
        // "Error: Claude Code returned an error result: …" to the user
        // (Danielle DM, 2026-09-24, 13 minutes after the first) and lost
        // sawResult, so the outer loop misreported the turn as cut short.
        log(`Ignoring teardown echo of an already-handled error result: ${lastHandledErrorResult}`);
        return { continuation: queryContinuation, sawResult: true, pressureRotated };
      }
      streamErrored = true;
      // Claude can emit a retryable API error and then THROW when its CLI
      // dies (e.g. exit 137). That bypasses the normal iterator-close check
      // above. Preserve the retry decision instead of acknowledging a failed
      // occurrence as complete. Never replay a turn that already had a result.
      if (retryableErrorWithoutResult && resultIndex === 0) {
        const detail = err instanceof Error ? err.message : String(err);
        if (detail.startsWith('retryable provider error, no result:')) throw err;
        throw new Error(`retryable provider error, no result: ${detail}`, { cause: err });
      }
      throw err;
    }
  } catch (err) {
    // Freeze the queue before awaiting notices. Follow-ups have already been
    // acknowledged, so an abandoned queued turn cannot rely on redelivery.
    done = true;
    const cancelled = endedForCommand || signal?.aborted;
    const errMsg = err instanceof Error ? err.message : String(err);
    notifyExchangeComplete(onExchangeComplete, {
      prompt: archivePrompts[0] ?? initialPrompt,
      result: `Error: ${errMsg}`,
      continuation: queryContinuation ?? initialContinuation,
      status: 'error',
    });
    const authFailure = isProviderAuthFailureText(errMsg);
    if (authFailure)
      await emitProviderAuthFailureAlert({
        provider: activeProviderName(),
        failedOverTo: null,
        turnKind: mostRecentTaskContext() ? 'task' : 'chat',
      });
    const pendingRetry = errMsg.startsWith('retryable provider error, no result:');
    if (!cancelled && !pendingRetry) {
      // Completed turns are no longer answering or queued. Preserve partial
      // output from unfinished turns and report that the run did not finish.
      // Retrying the same route or several queued turns in one thread needs
      // only one notice. Task wakes have no human chat endpoint. The host picks
      // an a2a reply's session by in_reply_to, so agent routes also compare it.
      // A turn woken only by failure notices sends none.
      const failedRoutes = [...(answering ? [routing] : []), ...queuedTurns.map((turn) => turn.routing)];
      // Every unfinished prompt per route (answering turn first, then queued
      // follow-ups in push order) for the next-turn reminder. A retry
      // re-queues the original prompt, so identical prompts collapse.
      const failedPrompts = [
        ...(answering ? [{ routing, prompt: answeringPrompt }] : []),
        ...queuedTurns.map((turn) => ({ routing: turn.routing, prompt: turn.prompt })),
      ];
      const promptsFor = (target: RoutingContext): string[] => [
        ...new Set(
          failedPrompts
            .filter(
              (entry) =>
                entry.routing.platformId === target.platformId &&
                entry.routing.channelType === target.channelType &&
                entry.routing.threadId === target.threadId,
            )
            .map((entry) => entry.prompt)
            .filter((prompt): prompt is string => !!prompt),
        ),
      ];
      const noticed: RoutingContext[] = [];
      for (const target of failedRoutes) {
        if (
          (target === routing && mostRecentTaskContext() && !(pushAddressed[resultIndex] ?? false)) ||
          !target.platformId ||
          !target.channelType ||
          target.failureNoticeWake
        )
          continue;
        if (
          noticed.some(
            (prior) =>
              prior.platformId === target.platformId &&
              prior.channelType === target.channelType &&
              prior.threadId === target.threadId &&
              (target.channelType !== 'agent' || prior.inReplyTo === target.inReplyTo),
          )
        )
          continue;
        noticed.push(target);
        try {
          await deliverErrorResult(target, authFailure ? AUTH_FAILURE_USER_TEXT : FAILED_RUN_USER_TEXT);
          // A task-attributed answering turn was skipped above, so every
          // target here is an interactive (or a2a, filtered by eligibility) turn.
          rememberFailedTurn(target, false, promptsFor(target));
        } catch (noticeError) {
          log(
            `Failed to deliver query error notice: ${noticeError instanceof Error ? noticeError.message : String(noticeError)}`,
          );
        }
      }
    }
    // Continuation recovery receives the original error; diagnostics remain
    // in the exchange archive and runner log, never in the channel notice.
    throw err;
  } finally {
    done = true;
    queryMessageOutcome.unresolved = [...pushIds.values()].flat();
    clearInterval(pollHandle);
    clearInterval(keepaliveHandle);
    // Backstop: flush any task context that never saw a `result` event
    // (stream torn down before result, etc.). The eager flush at the
    // `result` event already wrote the common case; `written` makes this
    // a no-op for those. Status reflects whether that task's attributed
    // output dispatched anything ('completed') or finished silent
    // ('silent' — the maintenance/dream task that intentionally didn't
    // post). Error fires are written by the outer caller
    // (startMessageLoop's catch) so flushUnwrittenTaskFires self-skips
    // when streamErrored; `written` is the per-context guard so the
    // result-event flush, this backstop, and the error path can never
    // double-write one task.
    flushUnwrittenTaskFires();
  }

  return { continuation: queryContinuation, sawResult: resultIndex > 0, pressureRotated };
}

function notifyExchangeComplete(
  hook: ((exchange: ProviderExchange) => void) | undefined,
  exchange: ProviderExchange,
): void {
  if (!hook) return;
  try {
    hook(exchange);
  } catch (err) {
    log(`onExchangeComplete failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleEvent(event: ProviderEvent, routing: RoutingContext): Promise<void> {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'generated_image':
      await deliverGeneratedImage(event.path, routing);
      break;
    case 'file':
      await deliverProviderFile(event.path, routing);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
    case 'text':
    case 'activity':
      break;
  }
}

const CODEX_GENERATED_IMAGES_ROOT = '/home/node/.codex/generated_images';
const GENERATED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** Stage a provider-generated image in the session outbox and enqueue it for normal channel delivery. */
export async function deliverGeneratedImage(
  generatedPath: string,
  routing: RoutingContext,
  allowedRoot = CODEX_GENERATED_IMAGES_ROOT,
): Promise<void> {
  const root = fs.realpathSync(allowedRoot);
  const resolved = fs.realpathSync(generatedPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing generated image outside provider output root: ${generatedPath}`);
  }
  const stat = fs.statSync(resolved);
  const extension = path.extname(resolved).toLowerCase();
  if (!stat.isFile() || !GENERATED_IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(`Refusing invalid generated image: ${generatedPath}`);
  }

  if (findQueuedGeneratedImage(resolved, routing)) {
    log('Skipping already queued generated image for this request');
    return;
  }
  const id = generateId();
  const filename = path.basename(resolved);
  const outboxDir = outboxDirFor(id);
  fs.mkdirSync(outboxDir, { recursive: true });
  fs.copyFileSync(resolved, path.join(outboxDir, filename));
  await writeMessageOut({
    id,
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text: '', files: [filename] }),
  });
  recordQueuedGeneratedImage(path.join(outboxDir, filename), routing, id);
  log(`Generated image staged for automatic delivery: ${filename}`);
}

/** Stage a provider-declared generic file for normal outbound delivery. */
async function deliverProviderFile(providerPath: string, routing: RoutingContext): Promise<void> {
  const resolved = fs.realpathSync(providerPath);
  if (!fs.statSync(resolved).isFile()) throw new Error(`Refusing non-file provider output: ${providerPath}`);

  const id = generateId();
  const filename = path.basename(resolved);
  const outboxDir = outboxDirFor(id);
  fs.mkdirSync(outboxDir, { recursive: true });
  fs.copyFileSync(resolved, path.join(outboxDir, filename));
  await writeMessageOut({
    id,
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text: '', files: [filename] }),
  });
  log(`Provider file staged for automatic delivery: ${filename}`);
}

/**
 * Deliver a turn's text straight to the channel the batch arrived on. Used when
 * a turn ends in a provider error (e.g. a non-retryable 403 billing_error) with
 * no <message> envelope: the notice would otherwise be dropped as scratchpad.
 * This is the same user-facing write the outer catch block does, minus the
 * `Error:` prefix — the provider's text is already a user-facing message.
 */
/** Never lets bookkeeping break failure handling. */
function rememberFailedTurn(routing: RoutingContext, isTaskTurn: boolean, prompts: Array<string | undefined>): void {
  const known = prompts.filter((prompt): prompt is string => !!prompt);
  if (known.length === 0 || !failedTurnEligible(routing, isTaskTurn)) return;
  try {
    const record = buildFailedTurnRecord(routing, known);
    if (record) recordFailedTurn(record);
  } catch (err) {
    log(`Failed to record failed-turn notice: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function deliverErrorResult(routing: RoutingContext, text: string): Promise<void> {
  log('Error result with no <message> envelope — delivering to channel');
  // A rejected credential's raw text ("Failed to authenticate. API Error: 401
  // OAuth access token has been revoked.") means nothing to a user and hides
  // that the operator must act; send the plain notice instead.
  const userText = isProviderAuthFailureText(text) ? AUTH_FAILURE_USER_TEXT : stripHarnessTagArtifacts(text);
  await writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    // Flagged so a receiving agent's own failure sends no notice back.
    content: JSON.stringify({ text: userText, [FAILURE_NOTICE_FIELD]: true }),
  });
}

/**
 * True when a stream throw merely repeats an error result this stream already
 * handled. Requires that no later turn is in flight, so a genuinely new
 * failure on a follow-up push still surfaces. Exported for tests.
 */
export function isHandledErrorResultEcho(
  err: unknown,
  lastHandledErrorResult: string | null,
  resultIndex: number,
  answering: boolean,
): boolean {
  if (resultIndex === 0 || answering || !lastHandledErrorResult) return false;
  const message = err instanceof Error ? err.message : String(err);
  const handled = lastHandledErrorResult.trim();
  return handled.length > 0 && message === `Claude Code returned an error result: ${handled}`;
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 */
// Exported for tests. Local-fork patch: the unwrapped-output branch needs
// focused coverage so the leak-to-channel class of bug stays caught.
// Returns { sent, hasUnwrapped, dispatched } so callers can also kick off the
// upstream nudge re-prompt. `dispatched` is the list of
// { destination, body } pairs actually sent (post-dedup) so the
// poll-loop's task_fires writer can record what the agent emitted on a
// task fire.
export interface DispatchedMessage {
  destination: string;
  body: string;
}

/**
 * A wrapped `<message>` block that was refused. `feedbackRecorded` is true
 * when the refusing path already queued next-turn delivery feedback.
 */
export interface DroppedBlock {
  detail: string;
  feedbackRecorded: boolean;
}

function uniqueDroppedBlocks(blocks: DroppedBlock[]): DroppedBlock[] {
  const seen = new Set<string>();
  return blocks.filter((block) => !seen.has(block.detail) && !!seen.add(block.detail));
}

/**
 * The one wrapping retry. When the agent DID wrap its reply and a block was
 * refused, say exactly why; claiming the output "was not wrapped" sends the
 * model back to re-emit the identical block (AI Friends, 2026-10-11).
 */
export function wrappingRetryPrompt(destinationNames: string, refused: DroppedBlock[] = []): string {
  const tail =
    `Your destinations: ${destinationNames}. ` +
    `Earlier tool messages may be only acknowledgments; do not repeat messages already sent or re-run tools. ` +
    `Keep tool results and internal notes inside <internal>.</system>`;
  if (refused.length > 0) {
    return (
      `<system>Your response was not delivered. Your <message> block was wrapped, but it was refused: ` +
      `${refused.map((block) => block.detail).join('; ')}. ` +
      `Fix that and re-send only the missing response. ` +
      `A <message> tag takes to="name" (required) and optionally reply_to_message_id="#N" (a visible message id from that destination). ` +
      tail
    );
  }
  return (
    `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
    `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
    `Please re-send only the missing response with the correct wrapping. ` +
    tail
  );
}

const MISSING_TO_DETAIL = 'a <message> tag had no to="name" attribute';

interface MessageBlock {
  to: string;
  replyToSeq: number | null;
  body: string;
}

/** Streamed providers require a turn boundary: another send cannot settle a missed block. */
export type ResultDispatchOptions = ResultDispatchCounts &
  ({ suppressDelivery?: false; turnStartSeq?: number } | { suppressDelivery: boolean; turnStartSeq: number });

interface ResultDispatchCounts {
  /** Exact streamed fragment already consumed by a delivered cross-segment block. */
  deliveredAssemblyFragment?: string;
  midTurnSent?: number;
  midTurnReplied?: number;
  nudgedWindow?: SeqWindow;
  /** A bare error is delivered immediately after dispatch returns. */
  errorResult?: boolean;
}

export interface MidTurnScanResult {
  deliveredAssemblyFragment?: string;
  delivered: number;
  /** Delivered blocks that count as the reply (see answersBatch). */
  replied: number;
  tail: string;
  dispatched: DispatchedMessage[];
  /** Wrapped blocks this scan refused, with the reason. */
  dropped: DroppedBlock[];
}

interface MidTurnDeliveryOptions {
  nudgedWindow?: SeqWindow;
  turnStartedAt?: string;
  taskTurn?: boolean;
  taskTurnDedupSince?: string;
}

/** Complete internal spans are private scratchpad and never a content door. */
const INTERNAL_SPAN_RE = /<internal\b[\s\S]*?<\/internal>/gi;
const EXPLICIT_SILENT_TURN_RE = /<internal\b[^>]*>\s*silent turn\s*<\/internal>/i;
const NONEMPTY_INTERNAL_SPAN_RE = /<internal\b[^>]*>[\s\S]*?\S[\s\S]*?<\/internal>/i;
const OPEN_INTERNAL_RE = /<internal\b/i;
const OPEN_MESSAGE_RE = /<message\b/;

/**
 * Remove closed internal spans and conservatively drop an unclosed internal
 * tail. This is deliberately broader than stripInternalTags: attributes and
 * case variants must not turn a quoted draft into a real send.
 */
function stripInternalSpansForDelivery(input: string): string {
  const withoutClosed = input.replace(INTERNAL_SPAN_RE, '');
  const open = OPEN_INTERNAL_RE.exec(withoutClosed);
  return open ? withoutClosed.slice(0, open.index) : withoutClosed;
}

/** Index where an unresolved streamed construct begins. */
export function unresolvedTailStart(input: string): number {
  const masked = input.replace(INTERNAL_SPAN_RE, (match) => ' '.repeat(match.length));
  const candidates: number[] = [];
  const internalOpen = OPEN_INTERNAL_RE.exec(masked);
  if (internalOpen) candidates.push(internalOpen.index);

  const lastClose = masked.lastIndexOf('</message>');
  const searchFrom = lastClose === -1 ? 0 : lastClose + '</message>'.length;
  const messageOpen = OPEN_MESSAGE_RE.exec(masked.slice(searchFrom));
  if (messageOpen) candidates.push(searchFrom + messageOpen.index);
  if (candidates.length > 0) return Math.min(...candidates);

  const prefixStart = trailingTagPrefixStart(masked);
  return prefixStart === -1 ? input.length : prefixStart;
}

function trailingTagPrefixStart(input: string): number {
  const maxLength = Math.min('<internal'.length - 1, input.length);
  for (let length = maxLength; length >= 1; length--) {
    const tail = input.slice(input.length - length);
    if (tail === '<message'.slice(0, length)) return input.length - length;
    if (tail.toLowerCase() === '<internal'.slice(0, length)) return input.length - length;
  }
  return -1;
}

/** Current outbound sequence high-water mark. */
function maxOutboundSeq(): number {
  return getUndeliveredMessages().reduce((max, message) => Math.max(max, message.seq ?? 0), 0);
}

/** Outbound seq window (after, upto]. */
type SeqWindow = { after: number; upto: number };

function chatRowWrittenSince(afterSeq: number): boolean {
  return chatRowsInWindow(afterSeq).length > 0;
}

function chatRowsInWindow(afterSeq: number, uptoSeq = Infinity): MessageOutRow[] {
  try {
    return getUndeliveredMessages().filter(
      (message) => (message.seq ?? 0) > afterSeq && (message.seq ?? 0) <= uptoSeq && message.kind === 'chat',
    );
  } catch (err) {
    log(`Outbound lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** A message to another agent can be delegation, not the requester's reply. */
function answersBatch(dest: DestinationEntry, routing: RoutingContext): boolean {
  if (dest.type !== 'agent') return true;
  return routing.channelType === 'agent' && routing.platformId === dest.agentGroupId;
}

const INFORMED_NUDGE_QUOTE_MAX = 200;
const INFORMED_NUDGE_ROWS_MAX = 3;

/** Quote prior sends so the model distinguishes an acknowledgment from a full reply. */
export function buildInformedWrapNudge(
  rows: MessageOutRow[],
  finalText: string,
  destinations: DestinationEntry[],
  refused: DroppedBlock[] = [],
): string {
  const names = destinations.map((d) => d.name).join(', ');
  const destinationOf = (row: MessageOutRow): string =>
    destinations.find((d) =>
      d.type === 'agent'
        ? row.channel_type === 'agent' && row.platform_id === d.agentGroupId
        : row.channel_type === d.channelType && row.platform_id === d.platformId,
    )?.name ?? 'unknown';
  const clip = (text: string): string => escapePromptXml(clipCodePoints(text, INFORMED_NUDGE_QUOTE_MAX));
  const sent = rows.slice(0, INFORMED_NUDGE_ROWS_MAX).map((row) => {
    let text = '';
    try {
      const content = JSON.parse(row.content) as {
        text?: unknown;
        files?: unknown;
        operation?: unknown;
        emoji?: unknown;
      };
      const files = Array.isArray(content.files) ? `[file: ${content.files.join(', ')}]` : '';
      text =
        content.operation === 'reaction'
          ? `[reaction: ${typeof content.emoji === 'string' ? content.emoji : '?'}]`
          : [typeof content.text === 'string' ? content.text : '', files].filter(Boolean).join(' ');
    } catch {
      // Unparseable row: quote a placeholder.
    }
    return `<sent_message to="${escapePromptXml(destinationOf(row))}">${clip(text || '[non-text message]')}</sent_message>`;
  });
  if (rows.length > INFORMED_NUDGE_ROWS_MAX) sent.push(`(+${rows.length - INFORMED_NUDGE_ROWS_MAX} more)`);
  const reason =
    refused.length > 0
      ? `Your response was not delivered. Your <message> block was wrapped, but it was refused: ${escapePromptXml(refused.map((block) => block.detail).join('; '))}. Fix that and re-send only the missing response.`
      : `Your final text was not delivered — it was not wrapped in <message to="name">...</message> blocks:`;
  return (
    `<system>${reason}\n` +
    `<undelivered_text>${clip(finalText)}</undelivered_text>\n` +
    `Earlier in that turn you already sent:\n${sent.join('\n')}\n` +
    `If what was sent is the full reply, to where it was owed, respond with only <internal>done</internal> and nothing more will be sent. ` +
    `Otherwise send only what is still missing, wrapped in <message to="name">...</message>, without repeating what already went out. Do not re-run tools. ` +
    (refused.length > 0
      ? `A <message> tag takes to="name" (required) and optionally reply_to_message_id="#N" (a visible message id from that destination). `
      : '') +
    `Keep tool results and internal notes inside <internal>. Your destinations: ${escapePromptXml(names)}.</system>`
  );
}

function escapePromptXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Clip code points, never half a surrogate pair. */
function clipCodePoints(text: string, max: number): string {
  let end = 0;
  let count = 0;
  for (const char of text) {
    if (count === max) return `${text.slice(0, end)}…`;
    end += char.length;
    count++;
  }
  return text;
}

/** Retry echo suppression is bounded to the original turn's sends. */
function wasWrittenInWindow(dest: DestinationEntry, body: string, window: SeqWindow | undefined): boolean {
  if (!window) return false;
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  return chatRowsInWindow(window.after, window.upto).some((message) => {
    if (message.platform_id !== platformId || message.channel_type !== channelType) return false;
    try {
      const content = JSON.parse(message.content) as { text?: unknown; operation?: unknown };
      return content.operation === undefined && typeof content.text === 'string' && content.text.trim() === body.trim();
    } catch {
      return false;
    }
  });
}

function wasTextWrittenToDestinationSince(dest: DestinationEntry, body: string, cursor: string): boolean {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  const normalizedBody = body.replace(/\s+/g, ' ').trim();
  const cursorMatch = /^outbound-seq:(\d+)$/.exec(cursor);
  const afterSequence = cursorMatch ? Number(cursorMatch[1]) : null;
  const legacyTimestampCursor = /^\d{4}-\d{2}-\d{2}/.test(cursor);

  try {
    const found = getUndeliveredMessages().some((message) => {
      const afterCursor = afterSequence === null ? message.timestamp > cursor : (message.seq ?? 0) > afterSequence;
      if (
        !afterCursor ||
        message.kind !== 'chat' ||
        message.platform_id !== platformId ||
        message.channel_type !== channelType
      ) {
        return false;
      }
      try {
        const payload = JSON.parse(message.content) as { text?: unknown };
        return typeof payload.text === 'string' && payload.text.replace(/\s+/g, ' ').trim() === normalizedBody;
      } catch {
        return false;
      }
    });
    if (found) return true;
    // Non-SQLite drivers may use an opaque cursor that cannot be compared to
    // row timestamps/sequences here. Fall back to their semantic mailbox
    // operations; SQLite and legacy timestamp cursors took the exact
    // destination+body path above.
    if (afterSequence === null && !legacyTimestampCursor) {
      return (
        hasChatMessageTextSince(cursor, body) &&
        hasChatMessageToDestinationSince(cursor, { channel_type: channelType, platform_id: platformId })
      );
    }
    return false;
  } catch (err) {
    log(`Destination/text dedupe lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function wasWrittenInSeqWindow(dest: DestinationEntry, body: string, afterSeq: number, uptoSeq: number): boolean {
  if (uptoSeq <= afterSeq) return false;
  try {
    const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
    const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
    const content = JSON.stringify({ text: body });
    return getUndeliveredMessages().some(
      (message) =>
        (message.seq ?? 0) > afterSeq &&
        (message.seq ?? 0) <= uptoSeq &&
        message.kind === 'chat' &&
        message.platform_id === platformId &&
        message.channel_type === channelType &&
        message.content === content,
    );
  } catch (err) {
    log(`Echo-guard lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Deliver closed message blocks from the streamed-text door. Tool/result echo
 * suppression requires the same destination AND body. A prior acknowledgment
 * or another co-batched task's send is not evidence this result was delivered.
 */
export async function deliverMidTurnBlocks(
  text: string,
  routing: RoutingContext,
  turnStartSeq?: number,
  carry = '',
  options: MidTurnDeliveryOptions = {},
): Promise<MidTurnScanResult> {
  const input = carry + text;
  const tailStart = unresolvedTailStart(input);
  const settled = input.slice(0, tailStart);
  const tail = input.slice(tailStart);
  if (tail && carry !== tail) {
    log(`Mid-turn scan: carrying ${tail.length}-char unresolved tail to the next segment`);
  }

  const segmentStartSeq = turnStartSeq === undefined ? 0 : maxOutboundSeq();
  const visible = stripInternalSpansForDelivery(settled);
  const messageRe = /<message\s+([^>]*)>([\s\S]*?)<\/message>/g;
  const seen = new Set<string>();
  const dispatched: DispatchedMessage[] = [];
  const dropped: DroppedBlock[] = [];
  let delivered = 0;
  let replied = 0;
  let deliveredAssemblyFragment: string | undefined;
  let match: RegExpExecArray | null;

  while ((match = messageRe.exec(visible)) !== null) {
    const block = parseMessageBlock(match[1], match[2]);
    if (!block) {
      log('Mid-turn <message> block was malformed — skipped');
      dropped.push({ detail: MISSING_TO_DETAIL, feedbackRecorded: false });
      continue;
    }

    const rawBody = stripInternalTags(block.body);
    const swept = sweepLocalFileLinks(stripHarnessTagArtifacts(rawBody));
    const body = swept.text;
    if (!body && swept.links.length === 0) {
      log(`Mid-turn <message to="${block.to}"> empty after sanitization — skipped`);
      continue;
    }

    const destination = findByName(block.to);
    if (!destination) {
      log(`Mid-turn <message to="${block.to}"> names an unknown destination — skipped`);
      dropped.push({ detail: unknownDestinationDetail(block.to), feedbackRecorded: false });
      continue;
    }

    // The SDK result may repeat only the last fragment, not the assembled
    // block. Prove that the ENTIRE event is the suffix of this valid block;
    // unrelated trailing prose/malformed intent must still trigger a retry.
    const assembledFragment = carry && text && match[0].length > text.length && match[0].endsWith(text);
    const recordAssembly = () => {
      if (assembledFragment) deliveredAssemblyFragment = text;
    };
    const dedupKey = `${block.to} ${body.replace(/\s+/g, ' ')}`;
    if (seen.has(dedupKey)) {
      log(`Suppressing duplicate mid-turn <message to="${block.to}"> block`);
      continue;
    }
    seen.add(dedupKey);

    if (wasWrittenInWindow(destination, body, options.nudgedWindow)) {
      recordAssembly();
      log(`Mid-turn <message to="${block.to}"> repeats a message the nudged turn already sent — skipped`);
      continue;
    }
    const dedupSince = options.taskTurn ? (options.taskTurnDedupSince ?? options.turnStartedAt) : options.turnStartedAt;
    if (dedupSince && wasTextWrittenToDestinationSince(destination, body, dedupSince)) {
      recordAssembly();
      log(`Suppressing duplicate mid-turn <message to="${block.to}"> already delivered via MCP tool`);
      continue;
    }
    if (turnStartSeq !== undefined && wasWrittenInSeqWindow(destination, body, turnStartSeq, segmentStartSeq)) {
      recordAssembly();
      log(`Mid-turn <message to="${block.to}"> repeats an earlier segment in this turn — skipped`);
      continue;
    }

    const sent = await sendToDestination(destination, body, routing, block.replyToSeq, swept.links);
    if (!sent.sent) {
      log(`Mid-turn <message to="${block.to}"> dropped: ${sent.reason ?? 'not deliverable'}`);
      dropped.push({
        detail: `<message to="${block.to}"> could not be posted (${sent.reason ?? 'not deliverable'})`,
        feedbackRecorded: true,
      });
      continue;
    }
    recordAssembly();
    delivered++;
    if (answersBatch(destination, routing)) replied++;
    dispatched.push({ destination: block.to, body });
    log(`Mid-turn delivery: <message to="${block.to}"> (${body.length} chars)`);
  }

  return { delivered, replied, tail, dispatched, deliveredAssemblyFragment, dropped };
}

/**
 * True when a zero-output addressed turn is intentionally paused at the
 * sensitive-action confirmation gate. Re-exported for existing callers.
 */
export { isAwaitingSensitiveConfirmation };

/** Parse and dispatch the result-door representation of one provider turn. */
export async function dispatchResultText(
  text: string,
  routing: RoutingContext,
  addressed = false,
  turnStartedAt?: string,
  compactedDuringTurn = false,
  taskTurn = false,
  taskTurnDedupSince = turnStartedAt,
  options: ResultDispatchOptions = {},
): Promise<{
  sent: number;
  hasUnwrapped: boolean;
  dispatched: DispatchedMessage[];
  resultBlocks: number;
  dropped: DroppedBlock[];
  undelivered?: string;
}> {
  const originalText = text;
  const visibleText = stripInternalSpansForDelivery(text);
  const messageRe = /<message\s+([^>]*)>([\s\S]*?)<\/message>/g;

  // Recover a final unclosed block for providers without streamed delivery.
  // With streamed delivery this still makes the missed content visible to the
  // result-door nudge, but suppressDelivery prevents a second content door.
  const openerRe = /<message\s+[^>]*>/g;
  let lastOpenerEnd = -1;
  let openerMatch: RegExpExecArray | null;
  while ((openerMatch = openerRe.exec(visibleText)) !== null) {
    lastOpenerEnd = openerMatch.index + openerMatch[0].length;
  }
  const normalizedText =
    lastOpenerEnd !== -1 && !visibleText.slice(lastOpenerEnd).includes('</message>')
      ? `${visibleText}</message>`
      : visibleText;

  let match: RegExpExecArray | null;
  let sent = options.midTurnSent ?? 0;
  let replied = options.midTurnReplied ?? sent;
  let missed = 0;
  let previouslyAnswered = false;
  let resultBlocks = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];
  const dispatched: DispatchedMessage[] = [];
  const dropped: DroppedBlock[] = [];
  const seen = new Set<string>();

  while ((match = messageRe.exec(normalizedText)) !== null) {
    if (match.index > lastIndex) scratchpadParts.push(normalizedText.slice(lastIndex, match.index));
    lastIndex = messageRe.lastIndex;
    resultBlocks++;

    const block = parseMessageBlock(match[1], match[2]);
    if (!block) {
      scratchpadParts.push(`[dropped: malformed <message> block] ${match[2].trim()}`);
      dropped.push({ detail: MISSING_TO_DETAIL, feedbackRecorded: false });
      missed++;
      continue;
    }

    const rawBody = stripInternalTags(block.body);
    const swept = sweepLocalFileLinks(stripHarnessTagArtifacts(rawBody));
    const body = swept.text;
    const destination = findByName(block.to);
    if (!destination) {
      log(`Unknown destination in <message to="${block.to}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${block.to}"] ${body}`);
      dropped.push({ detail: unknownDestinationDetail(block.to), feedbackRecorded: false });
      missed++;
      continue;
    }
    if (!body && swept.links.length === 0) {
      scratchpadParts.push(`[dropped: empty after sanitization for "${block.to}"]`);
      continue;
    }

    if (options.suppressDelivery) {
      // Another send (including a delegation) cannot hide this missed block.
      const repeat =
        wasWrittenInWindow(destination, body, options.nudgedWindow) ||
        (options.turnStartSeq !== undefined &&
          wasWrittenInSeqWindow(destination, body, options.turnStartSeq, maxOutboundSeq())) ||
        (!!turnStartedAt && wasTextWrittenToDestinationSince(destination, body, turnStartedAt));
      if (repeat) {
        if (answersBatch(destination, routing)) previouslyAnswered = true;
      } else {
        scratchpadParts.push(`[not delivered — result door is disabled; to="${block.to}"] ${body}`);
        missed++;
      }
      continue;
    }
    if (wasWrittenInWindow(destination, body, options.nudgedWindow)) {
      if (answersBatch(destination, routing)) previouslyAnswered = true;
      log(`<message to="${block.to}"> repeats a message the nudged turn already sent — skipped`);
      continue;
    }

    const dedupKey = `${block.to} ${body.replace(/\s+/g, ' ')}`;
    if (seen.has(dedupKey)) {
      log(`Suppressing duplicate <message to="${block.to}"> block within one turn`);
      continue;
    }
    seen.add(dedupKey);

    const dedupSince = taskTurn ? taskTurnDedupSince : turnStartedAt;
    if (dedupSince && wasTextWrittenToDestinationSince(destination, body, dedupSince)) {
      log(`Suppressing duplicate final <message to="${block.to}"> already delivered via MCP tool`);
      continue;
    }

    const delivered = await sendToDestination(destination, body, routing, block.replyToSeq, swept.links);
    if (!delivered.sent) {
      scratchpadParts.push(`[dropped: ${delivered.reason} for "${block.to}"] ${rawBody}`);
      dropped.push({
        detail: `<message to="${block.to}"> could not be posted (${delivered.reason ?? 'not deliverable'})`,
        feedbackRecorded: true,
      });
      continue;
    }
    dispatched.push({ destination: block.to, body });
    sent++;
    if (answersBatch(destination, routing)) replied++;
  }
  if (lastIndex < normalizedText.length) scratchpadParts.push(normalizedText.slice(lastIndex));

  const scratchpad = stripInternalTags(scratchpadParts.join('')).trim();
  // Delivery normalization strips every private <internal> span first, so the
  // intent marker must be recognized against the original provider result.
  const explicitlySilent = EXPLICIT_SILENT_TURN_RE.test(originalText);
  // A host system wake (escalation resume/result, Chats reply) carries no
  // human input. When the model answers it with only a private <internal>
  // note and no <message> block, that is a deliberate no-op (for example the
  // origin request was already answered), not a failed reply. Keyed on the
  // structured turn origin plus the explicit internal-only shape, never on
  // the note's wording. A truly empty result still gets the fallback.
  const systemWakeNoOp =
    routing.systemWake === true &&
    resultBlocks === 0 &&
    !scratchpad &&
    NONEMPTY_INTERNAL_SPAN_RE.test(originalText) &&
    stripInternalSpansForDelivery(originalText).trim() === '';
  // An informed retry explicitly offers this ending when the original send
  // was the full reply. Do not turn that acknowledgment into a false failure.
  const informedDone =
    !!options.nudgedWindow &&
    chatRowsInWindow(options.nudgedWindow.after, options.nudgedWindow.upto).length > 0 &&
    /^\s*<internal>\s*done\s*<\/internal>\s*$/i.test(originalText);
  if (scratchpad) log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);

  const deliveredViaTool = !!turnStartedAt && countChatMessagesSince(turnStartedAt) > 0;
  const anythingDelivered = sent > 0 || deliveredViaTool || previouslyAnswered;
  // A tool acknowledgment proves only that a chat row was written, not that
  // the final answer was delivered. An orphan closing tag (including a bare
  // <message> opener with no destination) is explicit failed message intent.
  // A proven cross-segment delivery may leave only its closing fragment in
  // the SDK result: that exact fragment is not new failed message intent.
  // Retry other wrapping even after an acknowledgment, but never expose this
  // scratchpad directly or retry an identical tool-send echo. Tool sends alone
  // cannot settle unwrapped final text: the informed nudge quotes what went out.
  const orphanMessageBody = scratchpad.replace(/<\/?message\b[^>]*>/g, '').trim();
  const orphanMessage = resultBlocks === 0 && /<\/message\s*>/.test(scratchpad) && !!orphanMessageBody;
  const orphanEcho = orphanMessage && !!turnStartedAt && hasChatMessageTextSince(turnStartedAt, orphanMessageBody);
  const undeliveredMalformedMessage =
    orphanMessage && originalText !== options.deliveredAssemblyFragment && !orphanEcho;
  const hasUnwrapped =
    missed > 0 ||
    (replied === 0 &&
      !previouslyAnswered &&
      !!scratchpad &&
      originalText !== options.deliveredAssemblyFragment &&
      !orphanEcho) ||
    undeliveredMalformedMessage;

  if (hasUnwrapped) {
    log('WARNING: agent output had no deliverable <message> block — suppressing unwrapped text and nudging retry');
    if (!options.errorResult) await emitSilentTurnComplete();
    return { sent, hasUnwrapped: true, dispatched, resultBlocks, dropped, undelivered: scratchpad };
  }

  if (options.errorResult) return { sent, hasUnwrapped, dispatched, resultBlocks, dropped };

  if (sent === 0 && !anythingDelivered) {
    // The destination contract gives the model one unambiguous way to say
    // that an ambient/follow-up turn intentionally needs no reply. Honor it
    // even when the engagement gate marked the inbound as addressed; otherwise
    // a trailing attachment that adds nothing can manufacture a failure after
    // the preceding turn already answered successfully.
    if (explicitlySilent || informedDone || systemWakeNoOp) {
      log(
        systemWakeNoOp
          ? 'System wake answered with an internal-only no-op — suppressing degraded fallback'
          : 'Explicit silent-turn marker — suppressing degraded fallback',
      );
      await emitSilentTurnComplete();
      return { sent, hasUnwrapped, dispatched, resultBlocks, dropped };
    }

    if (addressed && compactedDuringTurn) {
      const destination = findByRouting(routing.channelType, routing.platformId);
      if (destination) {
        const body =
          'My session compacted before I could send a final status update. ' +
          'I may have completed the work; please ask me to confirm the result before relying on it.';
        const delivered = await sendToDestination(destination, body, routing);
        if (delivered.sent) {
          dispatched.push({ destination: destination.name, body });
          sent++;
          return { sent, hasUnwrapped, dispatched, resultBlocks, dropped };
        }
      }
    }

    if (addressed && (confirmationGatePaused() || isAwaitingSensitiveConfirmation(originalText))) {
      log('Addressed turn is awaiting sensitive confirmation — suppressing degraded fallback');
      await emitSilentTurnComplete();
      return { sent, hasUnwrapped, dispatched, resultBlocks, dropped };
    }

    if (addressed) {
      const destination = findByRouting(routing.channelType, routing.platformId);
      if (destination) {
        const body = "I couldn't complete that request or produce a reliable reply. Please try again.";
        const delivered = await sendToDestination(destination, body, routing);
        if (delivered.sent) {
          log('WARNING: addressed turn produced no deliverable output — sent scoped failure fallback');
          dispatched.push({ destination: destination.name, body });
          sent++;
          return { sent, hasUnwrapped, dispatched, resultBlocks, dropped };
        }
      }
      log('WARNING: addressed turn produced no deliverable output and had no valid reply destination');
    }
    await emitSilentTurnComplete();
  } else if (sent === 0 && deliveredViaTool) {
    // The content was sent via MCP; emit only the local turn-complete control.
    await emitSilentTurnComplete();
  }

  return { sent, hasUnwrapped, dispatched, resultBlocks, dropped };
}

/**
 * Last-resort delivery when the agent emitted result text but never wrapped
 * any of it in `<message to="...">`. Without this we silently drop the turn
 * and the user sees nothing — same shape as the silent-fallback regression
 * incident 2026-05-10 in `#boysnight`. Mirrors the v2 runner's
 * `assistant-fallback`: send the bare text to the originating channel with
 * a label so the user (a) gets *something*, and (b) knows the agent
 * skipped the wrap so the problem is visible instead of invisible.
 *
 * Stays local-fork-only — upstream's poll-loop has the strict drop
 * contract on purpose; this is Optimus-side belt-and-suspenders against
 * agent-prompt drift.
 */
/**
 * Emit a system-kind control row that tells the host this turn finished
 * with no user-facing output. The host's typing module picks it up via a
 * registered delivery-action handler and clears the typing indicator
 * immediately — without this, the indicator keeps refreshing on
 * heartbeat freshness for ~6s after the container goes idle, leaving the
 * user staring at "is typing…" with no message coming.
 *
 * Sent as kind='system' so the host's existing `kind === 'system'` branch
 * routes it to `handleSystemAction` → registered handler. No channel
 * delivery, no platform_id/channel_type needed.
 */
async function emitSilentTurnComplete(): Promise<void> {
  await writeMessageOut({
    id: generateId(),
    in_reply_to: null,
    kind: 'system',
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify({ action: 'silent_turn_complete' }),
  });
}

/**
 * Decide the reply-pill target for a dispatched outbound post.
 *
 * `routing.inReplyTo` is the TURN-AUTHORITATIVE target: poll-loop set it
 * once via `extractRouting → pickInReplyToMessage`, which is `null` for a
 * task-only / accumulate-only turn (RSS status, daily recap, dream/
 * maintenance) and the triggering message id for a real chat turn.
 *
 * `resolveDestinationThread().inReplyTo` is an independent, TURN-BLIND DB
 * hunt for the channel's newest non-task trigger=1 row. It exists only
 * to correct the reply target per-destination in agent-shared sessions
 * (one session fans out to several chats; routing's single target may
 * belong to a different chat than the one we're posting to). It must
 * NEVER resurrect a pill on a turn poll-loop deliberately marked
 * pill-free — doing so is exactly the recurring RSS/recap reply-pill
 * regression: `destRouting.inReplyTo ?? routing.inReplyTo` let the stale
 * DB hunt shadow the authoritative null, so every task fire pilled onto
 * the newest human @mention ever sent in the channel (observed
 * 2026-05-11/13/15/18/19 in AI Friends — a ~22h-old "Direct answers from
 * the chat log…" message). All prior fixes patched the MCP-tool path
 * (resolveInReplyTo / the session_state tri-state); the <message>-tag
 * dispatch path always used this turn-blind resolver and kept regressing.
 *
 * Contract: when the turn is authoritatively pill-free (routing.inReplyTo
 * is null) the post stays standalone, period. Only when routing has a
 * real target do we let the per-destination hunt refine it (or fall back
 * to routing's own target if the hunt found nothing).
 */
function resolveDispatchReplyTarget(
  routing: RoutingContext,
  destRouting: { threadId: string | null; inReplyTo: string | null } | null,
  explicitReplyToSeq: number | null = null,
  explicitRouting?: { channel_type: string; platform_id: string },
): string | null {
  if (explicitReplyToSeq != null && explicitRouting) {
    return resolveExplicitReplyTarget(explicitReplyToSeq, explicitRouting);
  }
  if (routing.inReplyTo == null) return null; // task / accumulate turn — never pill
  // Same-channel dispatch: routing.inReplyTo IS the authoritative target
  // (the message that triggered this turn). The per-destination DB hunt
  // (`destRouting.inReplyTo`) was designed for cross-destination fan-out
  // in agent-shared sessions — picking "newest trigger=1 in channel X"
  // when X is NOT the channel that woke this turn. Letting it shadow
  // routing.inReplyTo on a same-channel reply is the recurring "agent
  // quote-replied to the wrong message" bug: later trigger=1 inbounds
  // (a different user's @mention arriving while the agent was thinking)
  // become "newer" by seq DESC, and the reply pill attaches to that
  // stranger's message instead of the one we're actually answering
  // (observed 2026-05-23 in New York Crew WhatsApp — Optimus's reply
  // to Jon's earlier hotel-name request pilled onto Nicole's just-
  // arrived km-conversion request because Nicole's row was newer).
  const sameChannel =
    explicitRouting != null &&
    routing.channelType === explicitRouting.channel_type &&
    routing.platformId === explicitRouting.platform_id;
  if (sameChannel) return routing.inReplyTo;
  return destRouting?.inReplyTo ?? null;
}

/** Persist runner-side send feedback until the next initial or warm follow-up turn. */
function recordDeliveryFeedback(detail: string): void {
  log(`WARNING: ${detail}`);
  const ops = getAgentMailbox().operations;
  const previous = ops.getState('delivery_feedback')?.value;
  ops.setState('delivery_feedback', [previous, detail].filter(Boolean).join('\n'));
}

export function prependDeliveryFeedback(prompt: string): string {
  const ops = getAgentMailbox().operations;
  const feedback = ops.consumeState('delivery_feedback')?.value;
  const hostFeedback = ops.getDeliveryFeedbackMessages?.(20) ?? [];
  if (!feedback && hostFeedback.length === 0) return prompt;
  const notes = [feedback, ...hostFeedback.map((message) => message.content)].filter(Boolean);
  ops.markMessages(
    hostFeedback.map((message) => message.id),
    'completed',
  );
  return `${JSON.stringify({ delivery_feedback: notes })}\n\n${prompt}`;
}

async function sendToDestination(
  dest: DestinationEntry,
  body: string,
  routing: RoutingContext,
  explicitReplyToSeq: number | null = null,
  // Local-file links the caller already swept out of `body`. Each one that
  // resolves to a real file is staged into this message's outbox so the user
  // gets the actual attachment instead of an unopenable `sandbox:` link.
  fileLinks: DetectedFileLink[] = [],
): Promise<{ sent: boolean; reason?: string }> {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId, routing);
  const inReplyTo = resolveDispatchReplyTarget(routing, destRouting, explicitReplyToSeq, {
    channel_type: channelType,
    platform_id: platformId,
  });
  if (explicitReplyToSeq != null && inReplyTo == null) {
    recordDeliveryFeedback(
      `Invalid reply_to_message_id #${explicitReplyToSeq} for <message to="${dest.name}">; posting without a reply link.`,
    );
  }
  const id = generateId();
  const files = attachLocalFileLinks(fileLinks, id, { log });
  if (body.length === 0 && files.length === 0) {
    // Sweeping a link-only block can empty the body. With no file to show for
    // it there is nothing to deliver — posting a blank message would just read
    // as the bot glitching.
    recordDeliveryFeedback(
      `Nothing deliverable for ${dest.name} after removing unusable local-file links; no message posted.`,
    );
    return { sent: false, reason: 'no deliverable content after local-file-link sweep' };
  }
  try {
    await writeMessageOut({
      id,
      in_reply_to: inReplyTo,
      kind: 'chat',
      platform_id: platformId,
      channel_type: channelType,
      thread_id: destRouting?.threadId ?? null,
      content: JSON.stringify(files.length > 0 ? { text: body, files } : { text: body }),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    recordDeliveryFeedback(`Failed to queue message to ${dest.name}: ${reason}; no message posted.`);
    return { sent: false, reason };
  }
  return { sent: true };
}

function unknownDestinationDetail(name: string): string {
  return `to="${name}" is not one of your destinations`;
}

function parseMessageBlock(attrs: string, rawBody: string): MessageBlock | null {
  const parsed: Record<string, string> = {};
  // Double or single quotes: `to='name'` is the same intent, not a missing `to`.
  const attrRe = /([A-Za-z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(attrs)) !== null) {
    parsed[match[1]] = match[2] ?? match[3];
  }
  const to = parsed.to?.trim();
  if (!to) return null;
  const replyToSeq = parseMessageSeq(parsed.reply_to_message_id);
  // A malformed reply attribute must not erase otherwise valid message intent.
  return {
    to,
    replyToSeq: parsed.reply_to_message_id != null && replyToSeq == null ? -1 : replyToSeq,
    body: rawBody.trim(),
  };
}

function parseMessageSeq(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const trimmed = value.trim().replace(/^#/, '');
  if (!/^\d+$/.test(trimmed)) return null;
  const seq = Number(trimmed);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

function resolveExplicitReplyTarget(
  seq: number,
  routing: { channel_type: string; platform_id: string },
): string | null {
  const targetRouting = getRoutingBySeq(seq);
  if (!targetRouting) return null;
  if (targetRouting.channel_type !== routing.channel_type || targetRouting.platform_id !== routing.platform_id) {
    return null;
  }
  return getReplyTargetMessageIdBySeq(seq);
}

/** Publish `routing` as the reply stamp the MCP tools read (null route clears it). */
function publishReplyRoute(routing: RoutingContext): void {
  setCurrentInReplyTo(routing.inReplyTo);
  setCurrentBatchReplyTarget(routing.inReplyTo);
  setCurrentReplyRoute(
    routing.inReplyTo
      ? {
          inReplyTo: routing.inReplyTo,
          channelType: routing.channelType,
          platformId: routing.platformId,
          threadId: routing.threadId,
        }
      : null,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
