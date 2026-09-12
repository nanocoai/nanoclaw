import type { DeliveryMode } from './config.js';
import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import {
  getPendingMessages,
  markProcessing,
  markCompleted,
  markScriptSkipped,
  type MessageInRow,
} from './db/messages-in.js';
import {
  getDeliveriesSince,
  getMaxOutboundSeq,
  getUndeliveredMessages,
  sameDestination,
  writeMessageOut,
  type Delivery,
} from './db/messages-out.js';
import { clearStaleProcessingAcks } from './db/container-state.js';
import { resolveDestinationThread } from './db/session-routing.js';
import { touchHeartbeat } from './heartbeat.js';
import { getAgentMailbox } from './mailbox/index.js';
import {
  clearContinuation,
  clearCurrentReplyRoute,
  clearTurnOutboundBaseline,
  migrateLegacyContinuation,
  setContinuation,
  setCurrentReplyRoute,
  setTurnOutboundBaseline,
} from './db/session-state.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isRunnerCommand,
  isSessionEcho,
  stripInternalTags,
  isAgentChannelTrigger,
  replyTargetsFor,
  type ReplyTarget,
  type RoutingContext,
} from './formatter.js';
import { stripHarnessTagArtifacts } from './harness-tag-strip.js';
import { isUploadTraceCommand, uploadTrace } from './upload-trace.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderExchange } from './providers/types.js';
import type { ProviderRuntimeContract } from './provider-contracts/registry.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

/** Consecutive driver-classified failures before a fresh runner is required. */
const MAILBOX_FAILURE_STREAK_EXIT = 10;

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
   * Optional stop signal. In production the loop runs until the container
   * dies; tests pass a signal so an abandoned loop actually exits instead of
   * polling forever and stealing messages from the next test's DB.
   */
  signal?: AbortSignal;
  /**
   * Delivery contract for this group. Defaults to `envelope`, which is the
   * behavior every group had before the setting existed.
   */
  deliveryMode?: DeliveryMode;
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

  // Before resuming, drop a session whose on-disk transcript has grown too
  // large/old to cold-resume within the host's idle ceiling. Without this a
  // long-lived hub keeps trying to reload an ever-growing .jsonl, hangs the
  // first turn, and gets killed before it can reply (then repeats forever).
  if (continuation) {
    const rotateReason = config.provider.maybeRotateContinuation?.(continuation, config.cwd);
    if (rotateReason) {
      log(`Rotating session — ${rotateReason}; starting fresh`);
      clearContinuation(config.providerName);
      continuation = undefined;
    }
  }

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();
  // Same for the reply route and turn boundary a killed container left behind.
  clearCurrentReplyRoute();
  clearTurnOutboundBaseline();

  let pollCount = 0;
  let isFirstPoll = true;
  while (true) {
    if (config.signal?.aborted) return;
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
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

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(messages);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
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
      log(`All ${messages.length} message(s) were commands, skipping query`);
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
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const prompt = formatMessagesWithCommands(keep, nativeSlashCommands, config.providerName);

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });
    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped.map((s) => s.id));
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    // Publish the batch's route so MCP tools (send_message, send_file) thread
    // replies into the conversation being answered and stamp in_reply_to for
    // a2a return-path routing. Re-published at every turn boundary inside
    // processQuery as later messages are answered.
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
    // Where outbound stood before the turn ran, so the tools can tell what this
    // turn has already written. Handed over with each queued follow-up below;
    // the route and the numeric delivery boundary remain separate facts.
    setTurnOutboundBaseline(getMaxOutboundSeq());
    try {
      const result = await processQuery(
        query,
        routing,
        processingIds,
        config.providerName,
        config.provider.onExchangeComplete?.bind(config.provider),
        prompt,
        continuation,
        midTurnCompleteDelivery,
        config.deliveryMode ?? 'envelope',
      );
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      if (continuation && config.provider.isSessionInvalid(err)) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        clearContinuation(config.providerName);
      }

      // Write error response so the user knows something went wrong
      await writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: `Error: ${errMsg}` }),
      });

      // The batch is still acked completed below (no redelivery). Without
      // this line the only log trace of the errored turn is "Query error"
      // followed by a "Completed" line that reads like success.
      log(`Errored batch will be acked completed — ${processingIds.length} message(s), no redelivery`);
    } finally {
      clearCurrentReplyRoute();
      config.signal?.removeEventListener('abort', abortActiveQuery);
      clearTurnOutboundBaseline();
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    markCompleted(processingIds);
    log(`Completed ${ids.length} message(s)`);
  }
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

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
}

/**
 * A correspondent still owed something by a tools-only session.
 *
 * `target` absent means the wake arrived over an agent channel — a host notice
 * or peer traffic. Those are worth correcting (there is a real correspondent)
 * but never worth writing to, since an agent channel has no human endpoint and
 * unsolicited output there feeds straight back into an agent loop.
 */
export interface OutstandingReply {
  target?: ReplyTarget;
  nudged: boolean;
  /**
   * Push ordinal of the prompt that carries this request — the prompt it
   * arrived in, or, once corrected, the correction — and so the exchange at
   * whose result it may first be judged (see `promptsPushed` / `resultsSeen`
   * in processQuery).
   */
  exchange: number;
}

export async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  onExchangeComplete: ((exchange: ProviderExchange) => void) | undefined,
  initialPrompt: string,
  initialContinuation: string | undefined,
  /**
   * The provider contract's `textDelivery: 'mid-turn-complete'`. True →
   * mid-turn streaming is the single content
   * door: complete <message> blocks deliver exactly once, at parse time from
   * streamed 'text' events (with cross-segment assembly of split blocks),
   * and the final result never delivers content — it only surfaces error
   * results and decides the wrap-nudge. False → text events are
   * delivery-inert and the final result stays the single delivery door.
   */
  modeOrEmitsMidTurnText: DeliveryMode | boolean = 'envelope',
  explicitDeliveryMode: DeliveryMode = 'envelope',
): Promise<QueryResult> {
  const midTurnCompleteDelivery = typeof modeOrEmitsMidTurnText === 'boolean' ? modeOrEmitsMidTurnText : false;
  const deliveryMode = typeof modeOrEmitsMidTurnText === 'string' ? modeOrEmitsMidTurnText : explicitDeliveryMode;
  // The active route changes when a long-lived query advances to a pushed
  // follow-up. Copy it so the caller's batch route (used by its outer error
  // notice) stays unchanged.
  routing = { ...routing };
  // Task runs already deliver through tools only, with the final text reserved
  // for the run log — they keep that path whatever the group's mode is, so the
  // turn-end validator below covers chat turns only.
  const toolsOnly = deliveryMode === 'tools-only' && !routing.taskRun;
  let queryContinuation: string | undefined;
  let done = false;
  let unwrappedNudged = false;
  let taskBlockNudged = false;
  // ── Tools-only turn accounting ──
  // A FIFO of correspondents still owed something, oldest first, deliberately
  // NOT reset by follow-up pushes — that is what separates it from the per-turn
  // guards around it. Each entry carries its own correction budget, so closing
  // one out never spends or discards another's, and a busy channel can neither
  // postpone an answer forever nor collapse two questions into one placeholder.
  const outstanding: OutstandingReply[] = [];
  // Every request this query has ever held on the hook — still open or already
  // settled. Reconciliation attributes a row stamped for one of them to THAT
  // request and nothing else (a send_file after the send_message that paid it
  // off, a stamp a tool read before a follow-up refresh), so a late row for a
  // settled request can never fall through to the address match and settle
  // somebody else's question. Filled by settleDeliveries.
  const knownRequests = new Map<string, KnownRequest>();
  // Delivered-seq as of the last judgment. Anything above it is this span's work.
  let lastJudgedSeq = getMaxOutboundSeq();
  // ── Exchange bookkeeping ──
  // Prompts enter the provider in push order and every 'result' event answers
  // the oldest unanswered prompt, so a prompt's push ordinal identifies its
  // exchange: the opening prompt is exchange 0, each pushPrompt() takes the
  // next ordinal, and the n-th result belongs to exchange n. A request is
  // judged (correction, placeholder) only at a result whose exchange is at or
  // past the prompt that carries it. Live-observed otherwise: a follow-up
  // pushed while the previous turn was live was judged dry at THAT turn's
  // result, before its own prompt had run, and the queued correction made
  // the model send the reply twice. A row stamped for a queued request
  // settles it whenever it appears; matching by address is gated the same
  // way as judging (see settleDeliveries). `promptsPushed` only moves
  // through pushPrompt(), so ordinal and push cannot drift apart. The model
  // rests on one 'result' per prompt; a provider that ever answered two
  // queued prompts with one result would put every later judgment and
  // stamp one exchange off, which the log line in the result handler and
  // at query end reports rather than hides.
  let promptsPushed = initialPrompt === '' ? 0 : 1;
  let resultsSeen = 0;
  // What each exchange's tool sends must carry: the current reply route that
  // send_message / send_file read from session_state, and whether the
  // exchange opens a new turn (a follow-up batch, a tools-only correction —
  // the tools' per-turn send budget restarts) or continues the one in
  // progress (an envelope retry, which has no tool budget to restart). Exchange
  // 0 is what runPollLoop published before the query started. An exchange's
  // stamp is published only when the provider actually starts running it: at
  // push time if the provider is idle, otherwise at the result that ends the
  // exchange ahead of it. Live-observed otherwise: a follow-up pushed during
  // a live turn re-pointed the stamp at once, so a send the LIVE turn made
  // after the push carried the queued request's id — the exact-stamp match
  // then paid off the queued request and the live one was never settled.
  // Each record also keeps the user prompt the exchange answers, which the
  // exchange hook reports: a correction or retry answers the prompt of the
  // exchange it retries, never its own nudge text.
  interface Exchange {
    routing: RoutingContext;
    newTurn: boolean;
    prompt: string;
    handedOver: boolean;
    unwrappedNudged: boolean;
    taskBlockNudged: boolean;
  }
  const exchanges = new Map<number, Exchange>();
  if (initialPrompt !== '') {
    exchanges.set(0, {
      routing: { ...routing },
      newTurn: true,
      prompt: initialPrompt,
      handedOver: true,
      unwrappedNudged: false,
      taskBlockNudged: false,
    });
  }
  const promptOf = (exchange: number): string => exchanges.get(exchange)?.prompt ?? initialPrompt;
  const handOver = (exchange: number): void => {
    const next = exchanges.get(exchange);
    if (!next || next.handedOver) return;
    next.handedOver = true;
    // Replace the object so optional fields absent from this exchange do not
    // leak from the previous one (for example, B's replyTargets into A's retry).
    routing = { ...next.routing };
    unwrappedNudged = next.unwrappedNudged;
    taskBlockNudged = next.taskBlockNudged;
    publishReplyRoute(routing);
    // A new turn moves the tools' view of the boundary with it; an envelope
    // retry continues the turn already in progress and keeps its budget.
    if (next.newTurn) setTurnOutboundBaseline(getMaxOutboundSeq());
  };
  // Seqs of rows this loop wrote itself (placeholders, error notices). They
  // are skipped by settling rather than jumped over with the baseline: a
  // tool row the next exchange commits while a placeholder write is awaited
  // would otherwise sit below the advanced baseline and never be settled.
  const loopWritten = new Set<number>();

  /**
   * The one way a prompt enters the provider after the opening one. Takes the
   * next exchange ordinal, records what that exchange's tool sends must carry,
   * and — only if the provider is idle, i.e. every pushed prompt already has
   * its result — publishes it now, because the provider starts this prompt
   * immediately. While a turn is live the stamp stays with the live exchange;
   * the result handler hands over once this prompt becomes current. Returns
   * the ordinal.
   */
  const pushPrompt = (
    text: string,
    nextRouting: RoutingContext,
    newTurn: boolean,
    prompt: string,
    guards: { unwrappedNudged: boolean; taskBlockNudged: boolean } = {
      unwrappedNudged: false,
      taskBlockNudged: false,
    },
  ): number => {
    const exchange = promptsPushed++;
    exchanges.set(exchange, {
      routing: { ...nextRouting },
      newTurn,
      prompt,
      handedOver: false,
      ...guards,
    });
    if (resultsSeen === exchange) handOver(exchange);
    query.push(text);
    return exchange;
  };

  /**
   * Record what a batch put on the hook: one entry per waiting person, each
   * with its own address and its own correction budget. An agent-channel wake
   * contributes a single targetless entry instead — one correspondent, however
   * many notices arrived in the batch.
   */
  const trackOutstanding = (targets: ReplyTarget[], agentWake: boolean, exchange: number): void => {
    for (const target of targets) outstanding.push({ target, nudged: false, exchange });
    if (targets.length === 0 && agentWake) outstanding.push({ nudged: false, exchange });
  };

  trackOutstanding(routing.replyTargets ?? [], routing.agentWake === true, 0);
  // How many <message> blocks were delivered from 'text' events this turn
  // (chat runs, mid-turn delivery providers only). A frame-local count, never
  // keyed by content: it feeds the result door's nudge decision ("did this
  // turn deliver anything?"). Reset at the turn boundary (the 'result'
  // event) — NOT at the follow-up push seam: query.push() does not end the
  // in-flight turn, and its result's nudge decision still describes the
  // turn that is streaming.
  let midTurnSent = 0;
  // Outbound seq high-water mark at the turn boundary — a frame-local NUMBER,
  // not a content record. Two uses: (1) the mid-turn door recognizes a block
  // that is a verbatim repeat of a message already written to outbound.db
  // EARLIER THIS TURN by a previous streamed segment (live-observed: the
  // model re-emits the identical block as its final text after a trailing
  // tool call; delivering both copies is the double-send this design must
  // not reintroduce); (2) the result-door nudge decision asks "did ANYTHING
  // user-visible go out this turn?" — which must also see MCP send_message
  // rows the frame-local midTurnSent count never observes. The "have we sent
  // this?" truth lives in the outbound DB the door already writes to — no
  // in-process delivery ledger. Reset alongside midTurnSent at each result.
  let turnStartSeq = maxOutboundSeq();
  // Cross-segment assembly buffer: the unresolved TAIL of the previous text
  // event — an unclosed <message …> block (or a bare open-tag prefix like
  // "<mess" literally split mid-token), or an unclosed <internal span. Frame-
  // local and turn-local: it carries a fragment forward so a block opened in
  // one assistant message and closed in a later one delivers ONCE, mid-turn,
  // when its close arrives. Only the unresolved tail is ever carried —
  // settled text is consumed exactly once, so already-delivered blocks are
  // never re-matched. Dropped at the turn boundary: a block that never
  // closes anywhere is the wrap-nudge's job, not the buffer's.
  let midTurnTail = '';

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
  let mailboxFailureStreak = 0;
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
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
        // Accumulated trigger=0 context rows must never be pushed into a live
        // turn on their own — the agent would answer ambient context that was
        // not addressed to it. They ride along only when a real trigger=1
        // follow-up is also pending; otherwise they stay pending for a future
        // batch (mirrors the two-phase initial-batch selection in
        // db/messages-in.ts).
        const hasFollowUpTrigger = pending.some((m) => m.kind !== 'system' && m.trigger === 1);
        const newMessages = pending.filter((m) => m.kind !== 'system' && (m.trigger === 1 || hasFollowUpTrigger));
        if (newMessages.length === 0) return;

        // Accumulated context must not engage a warm query by itself.
        if (!newMessages.some((m) => m.trigger === 1)) return;

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

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
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim sweep.
        if (done) return;

        const keptIds = keep.map((m) => m.id);
        const prompt = formatMessages(keep);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        // A follow-up batch is a new turn: its tool sends must carry ITS
        // request id (tools-only reconciliation matches the stamp against
        // the follow-up's reply target; the a2a return path resolves the
        // origin session from it), and the tools' view of the turn boundary
        // moves with it. The envelope door already attributes a block to the
        // latest inbound row on its channel; this keeps the tool door on the
        // same policy. pushPrompt decides WHEN: now if the provider is idle,
        // else when the live turn's result hands over — a stamp re-pointed
        // mid-turn would land on the live turn's own late sends.
        const nextRouting = extractRouting(keep);
        const exchange = pushPrompt(prompt, nextRouting, true, prompt);
        // A follow-up puts its own correspondent on the hook, queued behind any
        // already waiting. The queue and the judged-seq mark deliberately
        // survive the push: clearing either here is what would let a steady
        // stream of messages postpone an answer indefinitely, or erase a send
        // that already happened.
        trackOutstanding(replyTargetsFor(keep), keep.some(isAgentChannelTrigger), exchange);
        markCompleted(keptIds);
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

  /**
   * Settle whatever the outbound rows show delivered since the last judgment.
   * Read even when nobody is waiting: a late second send can land after an
   * earlier result cleared the queue, and if its seq were left unjudged the
   * next person's dry turn would inherit that stale delivery and skip its
   * correction. One scan answers both "who was reached?" and "where does the
   * baseline move to?", so a row committed between two reads cannot go
   * uncounted. `exchange` is the one whose result is being judged: a row
   * stamped for a queued request answers it whenever it appears, but a row
   * matched by address can only answer requests whose prompt has run.
   */
  const settle = (exchange: number): void => {
    const { maxSeq, deliveries } = getDeliveriesSince(lastJudgedSeq);
    settleDeliveries(
      outstanding,
      knownRequests,
      deliveries.filter((row) => !loopWritten.has(row.seq)),
      exchange,
    );
    // The baseline advances past everything judged, answered or not: a send
    // that discharged nobody must not be inherited by whoever asks next.
    if (maxSeq > 0) lastJudgedSeq = maxSeq;
  };

  /**
   * Judge a finished tools-only result. Delivery is read off the outbound rows
   * rather than off anything in the text, so a tool the loop never saw counts.
   *
   * Only the requests this result's exchange has answered are judged
   * (`entry.exchange <= exchange`); a request whose prompt is still queued
   * behind this result is left alone — its own result judges it. Nothing is
   * judged when nobody due is on the hook: a webhook wake that produces no
   * output is a legitimate ending, not a failure. Otherwise every due request
   * still dry after settling is corrected — one correction covers all of them,
   * and re-homes them onto its own exchange so they are re-judged at ITS
   * result, not at a follow-up's result queued ahead of it — or, once its
   * correction is spent, closed out with the placeholder at its own address.
   * Each entry keeps its own budget, so closing one out never spends or
   * discards another's.
   */
  const judgeToolsOnlyResult = async (
    exchange: number,
    text: string,
    inertBlocks: TaskMessageBlock[],
  ): Promise<void> => {
    const due = outstanding.filter((entry) => entry.exchange <= exchange);
    settle(exchange);
    const stillDue = due.filter((entry) => outstanding.includes(entry));
    const spent = stillDue.filter((entry) => entry.nudged);
    const dry = stillDue.filter((entry) => !entry.nudged);
    notifyExchangeComplete(onExchangeComplete, {
      prompt: promptOf(exchange),
      result: text,
      continuation: queryContinuation ?? initialContinuation,
      status: dry.length > 0 ? 'undelivered' : spent.length > 0 ? 'fallback' : 'completed',
    });
    for (const entry of spent) {
      outstanding.splice(outstanding.indexOf(entry), 1);
      if (entry.target) {
        loopWritten.add(await deliverToolsOnlyPlaceholder(entry.target));
      } else {
        // Documented residual: a model still dry after its agent-wake correction
        // ends in silence. The batch has no human endpoint to write to, so the
        // never-silent guarantee cannot apply here — writing anything would be
        // unsolicited output into an agent loop. Deliberate, and bounded by the
        // one correction the entry already spent.
        log('Agent-channel wake stayed dry after its correction — nothing emitted');
      }
    }
    if (dry.length === 0) return;
    const names = getAllDestinations()
      .map((d) => d.name)
      .join(', ');
    log(`Tools-only turn delivered nothing for ${dry.length} request(s) — correcting once`);
    // The correction's sends answer the dry request(s): it carries the last
    // one's route, the same "last triggering row" policy a batch uses, and
    // opens a fresh send budget — the turn may already have
    // sent to this address for someone else, and a correction the budget then
    // refuses would only ever end in the placeholder. The correction answers
    // the SAME prompt, which the exchange hook reports for its result.
    const last = dry[dry.length - 1];
    // A targetless (agent-wake) entry keeps its batch route: the a2a return
    // path resolves the origin session from it. A human target supplies the
    // exact thread as well as the stamp.
    const sourceRouting = exchanges.get(last.exchange)?.routing ?? routing;
    const correctionRouting = last.target ? routingForTarget(last.target, sourceRouting) : sourceRouting;
    const correction = pushPrompt(
      buildToolsOnlyNudge(text, inertBlocks, names),
      correctionRouting,
      true,
      promptOf(exchange),
    );
    for (const entry of dry) {
      entry.nudged = true;
      entry.exchange = correction;
    }
  };

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();

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
        // Assistant text emitted mid-turn (e.g. between tool calls). The
        // final result only carries the LAST assistant text, so complete
        // <message> blocks composed here would otherwise be lost — deliver
        // them now (chat runs only; task runs stay one-door). Gated on the
        // provider contract: for a provider that does not declare mid-turn
        // delivery the result stays the only delivery door, so a stray text
        // event must not open a second one.
        if (midTurnCompleteDelivery && !toolsOnly) {
          const scan = await deliverMidTurnBlocks(event.text, routing, turnStartSeq, midTurnTail);
          midTurnSent += scan.delivered;
          midTurnTail = scan.tail;
        }
      } else if (event.type === 'result') {
        // A result — with or without text — means the turn is done. Mark
        // the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for
        // follow-up pushes. The agent may have responded via MCP
        // (send_message) mid-turn, or the message may not need a response
        // at all — either way the turn is finished.
        markCompleted(initialBatchIds);
        // The exchange this result answers — see promptsPushed / resultsSeen.
        const exchange = resultsSeen++;
        if (exchange >= promptsPushed) {
          log(
            `Result #${exchange} arrived with only ${promptsPushed} prompt(s) pushed — this provider answers ` +
              'more than once per prompt, and the per-exchange accounting below is now one exchange off',
          );
        }
        const resultText = event.text ?? '';
        const failed = event.isError === true;
        if (toolsOnly && failed) {
          // Only the requests this exchange answered get the notice — after
          // settling, so a send that landed before the failure is not doubled
          // up on. A follow-up whose prompt is still queued runs afterwards
          // and is judged at its own result.
          settle(exchange);
          const failed = outstanding.filter((entry) => entry.exchange <= exchange);
          for (const entry of failed) outstanding.splice(outstanding.indexOf(entry), 1);
          const targets = failed.flatMap((entry) => (entry.target ? [entry.target] : []));
          if (failed.length > 0 && targets.length === 0) {
            log('Errored tools-only turn had no human endpoint — no notice sent');
          }
          for (const seq of await handleToolsOnlyError(resultText, targets)) loopWritten.add(seq);
          notifyExchangeComplete(onExchangeComplete, {
            prompt: promptOf(exchange),
            result: [resultText, event.error].filter(Boolean).join('\n'),
            continuation: queryContinuation ?? initialContinuation,
            status: 'error',
          });
        } else if (resultText || failed) {
          const { hasUnwrapped, taskBlocks } = await dispatchResultText(resultText, routing, {
            midTurnSent,
            // For mid-turn delivery providers the result door NEVER delivers
            // content (error results excepted, below): mid-turn streaming is
            // the single content door. The result door's remaining job is
            // the nudge decision — see turnDelivered.
            suppressDelivery: midTurnCompleteDelivery,
            // "Did anything user-visible go out this turn?" — door
            // deliveries (midTurnSent) plus any chat row written since the
            // turn boundary (which also sees MCP send_message calls the
            // frame-local count can't). When false and the result still
            // carries content, the wrap-nudge fires so the model re-sends
            // and the retry streams through the mid-turn door.
            turnDelivered: midTurnCompleteDelivery ? midTurnSent > 0 || chatRowWrittenSince(turnStartSeq) : undefined,
            deliveryMode,
          });
          const willRetryTaskBlocks = !failed && shouldNudgeTaskBlocks(routing.taskRun, taskBlocks, taskBlockNudged);
          // One-door task delivery: the final text becomes the run log entry
          // while explicit append-log calls remain optional additive notes.
          // Errors included: a failed run's text belongs in its log, not chat.
          // A corrective retry handles delivery only; its result is not a
          // second run summary.
          const archivedResult = [resultText, failed ? event.error : undefined].filter(Boolean).join('\n');
          if (routing.taskRun && !taskBlockNudged) await autoAppendTaskLog(archivedResult);
          if (failed && !routing.taskRun) {
            // A failed turn needs a visible notice even after partial output.
            // Only the provider's dedicated error field is channel content;
            // unwrapped model output and raw diagnostics remain private.
            await deliverErrorResult(event.error ?? 'The agent run failed. Check the logs for details.', routing);
          }
          if (toolsOnly) {
            await judgeToolsOnlyResult(exchange, resultText, taskBlocks);
          } else {
            // An unwrapped final text only warrants the wrap-nudge when NOTHING
            // was delivered this turn — hasUnwrapped already folds in the
            // turn's mid-turn sent count. If a reply already went out as a
            // mid-turn block, the unwrapped tail is a self-summary; nudging
            // coaxes a redundant second message (live-observed). It stays in
            // the scratchpad log.
            const willRetryWrapping = !failed && hasUnwrapped && !unwrappedNudged;
            // Envelope mode has no never-silent fallback: an unwrapped turn is
            // nudged once and then stays scratchpad, exactly as on main. The
            // never-silent guarantee is a tools-only feature (correction, then
            // TOOLS_ONLY_PLACEHOLDER); shipping stripped scratchpad to the user
            // is the one thing envelope mode has always refused to do, and
            // `bare text produces no outbound messages` asserts it.
            notifyExchangeComplete(onExchangeComplete, {
              prompt: promptOf(exchange),
              result: archivedResult,
              continuation: queryContinuation ?? initialContinuation,
              status: failed ? 'error' : hasUnwrapped || willRetryTaskBlocks ? 'undelivered' : 'completed',
            });
            if (willRetryWrapping) {
              unwrappedNudged = true;
              const destinations = getAllDestinations();
              const names = destinations.map((d) => d.name).join(', ');
              // A retry answers the same request: it inherits this exchange's route.
              pushPrompt(
                `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                  `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
                  `Your destinations: ${names}. ` +
                  `Please re-send your response with the correct wrapping.</system>`,
                { ...routing },
                false,
                promptOf(exchange),
                { unwrappedNudged, taskBlockNudged },
              );
            }
            if (willRetryTaskBlocks) {
              taskBlockNudged = true;
              const names = getAllDestinations()
                .map((d) => d.name)
                .join(', ');
              pushPrompt(buildTaskBlockNudge(taskBlocks, names), { ...routing }, false, promptOf(exchange), {
                unwrappedNudged,
                taskBlockNudged,
              });
            }
          }
        } else if (toolsOnly) {
          // A textless result is a success only if a tool ran — otherwise it is
          // the same dry turn as one that ended in scratchpad.
          await judgeToolsOnlyResult(exchange, '', []);
        }
        // Stamp hand-over: if a prompt is queued behind this result (a
        // follow-up pushed mid-turn, or a correction just pushed), the
        // provider starts it now, so its tool sends must carry ITS request id
        // and, for a new turn, a fresh send budget. With nothing queued the
        // stamp stays on the exchange that just ended — a late send still
        // belongs to it — until the next push re-points it.
        if (promptsPushed > resultsSeen) handOver(resultsSeen);
        // Turn boundary: reset the per-turn sent count after the result's
        // nudge decision has used it. A nudge retry re-counts via its own
        // text events before the retry result, so resetting on every result
        // is safe. The seq high-water mark advances past everything written
        // this turn (door and error deliveries alike), so the next turn's
        // echo check never reaches back across the boundary — a later turn
        // genuinely re-sending the same body still delivers. The assembly
        // buffer dies with the turn: a fragment that never closed is not
        // carried into the next turn — the wrap-nudge owns that case.
        midTurnSent = 0;
        turnStartSeq = maxOutboundSeq();
        midTurnTail = '';
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    notifyExchangeComplete(onExchangeComplete, {
      prompt: promptOf(resultsSeen),
      result: `Error: ${errMsg}`,
      continuation: queryContinuation ?? initialContinuation,
      status: 'error',
    });
    throw err;
  } finally {
    done = true;
    clearInterval(pollHandle);
    if (!endedForCommand && promptsPushed > resultsSeen) {
      log(`Query ended with ${promptsPushed - resultsSeen} pushed prompt(s) never answered by a result`);
    }
  }

  return { continuation: queryContinuation };
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

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
  }
}

/**
 * Deliver a provider-owned user-facing error, or the generic fallback selected
 * by the caller, straight to the channel the batch arrived on. Model output and
 * raw provider diagnostics never enter this path.
 */
async function deliverErrorResult(text: string, routing: RoutingContext): Promise<void> {
  log('Provider error result — delivering safe notice to channel');
  await writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text: stripHarnessTagArtifacts(text) }),
  });
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 */
export interface TaskMessageBlock {
  to: string;
  body: string;
  /** `to` matched no destination. Set only where the name is resolved, so a
   *  correction can say which name failed rather than only which door did. */
  unknownDestination?: boolean;
}

/** Options for `dispatchResultText`, describing the turn it closes. */
export interface ResultDispatchOptions {
  deliveryMode?: DeliveryMode;
  /**
   * How many <message> blocks were already delivered from streamed text
   * events this turn. Folds into the returned `sent` total so a bare final
   * text after a mid-turn delivery reads as a self-summary, not an
   * undelivered reply.
   */
  midTurnSent?: number;
  /**
   * Providers declaring `textDelivery: 'mid-turn-complete'`: the result door NEVER delivers
   * content. Mid-turn streaming (parse-time block delivery plus cross-
   * segment assembly) is the single content door; a complete <message>
   * block in the result text is at best a repeat of a mid-turn delivery and
   * at worst content the streaming door missed — either way it is not sent
   * from here. The result door keeps exactly two jobs: surfacing error
   * results (see the isError branch in processQuery) and the wrap-nudge
   * decision (`turnDelivered` below). Task runs, unknown destinations and
   * empty bodies keep their existing result-door handling, none of which
   * delivers content.
   */
  suppressDelivery?: boolean;
  /**
   * Did anything user-visible go out this turn? True when the mid-turn door
   * delivered (midTurnSent > 0) OR any chat row landed in outbound.db since
   * the turn boundary (covers MCP send_message calls the frame-local count
   * cannot see). Only meaningful with `suppressDelivery`. When false and the
   * result carries content — wrapped blocks or unwrapped prose — the turn
   * counts as undelivered and the wrap-nudge fires, so the model re-sends
   * and the retry streams through the mid-turn door. This is the deliberate
   * degradation path for streaming-door misses (SDK drift, a destination
   * appearing only after streaming, a block that never closed): nudge and
   * retry, never a direct result-door send.
   */
  turnDelivered?: boolean;
}
/**
 * `<internal>…</internal>` spans are explicitly not-for-delivery scratchpad.
 * Broader than `stripInternalTags` (which the scratchpad log uses): it also
 * matches an opening tag carrying attributes, and is case-insensitive, so a
 * draft quoted inside one can never be promoted to a real send by the
 * mid-turn scan.
 */
const INTERNAL_SPAN_RE = /<internal\b[\s\S]*?<\/internal>/gi;
/**
 * Deliver complete <message to="...">...</message> blocks found in a mid-turn
 * assistant text segment. The SDK's final result carries only the last
 * assistant text, so a wrapped reply composed before a trailing tool call
 * would otherwise never be seen (and the unwrapped-nudge would coax out only
 * a mangled re-send of the final fragment). Chat runs only — in task runs
 * mid-turn blocks stay inert exactly like final-text blocks (one-door: only
 * the send_message tool delivers). Blocks inside an <internal> span are never
 * delivered. Blocks to unknown destinations are left for the result path,
 * which logs the drop into the scratchpad and lets the nudge decide.
 *
 * Cross-segment assembly: `carry` is the unresolved tail of the previous
 * text event (frame-local, turn-local — see midTurnTail in processQuery).
 * The scan runs over carry + text, delivers every complete block in the
 * SETTLED prefix, and returns the new unresolved tail: an unclosed
 * <message …> open (or a bare tag prefix literally split mid-token, e.g.
 * "<mess" / "age to=…"), or an unclosed <internal span — a draft quoted
 * inside one must never be promoted to a send by assembly, so judgment on
 * everything from an open <internal is deferred until it closes. Settled
 * text is consumed exactly once: already-delivered blocks are never inside
 * the carried tail, so they cannot re-match. Net effect: mid-turn parsing
 * behaves as if run over the concatenation of all streamed text, delivered
 * incrementally. A block that never closes anywhere stays in the tail until
 * the turn ends and is then dropped — the wrap-nudge owns that case.
 *
 * Failure ordering: a writeMessageOut failure here propagates and fails the
 * whole turn loudly — the result door never delivers content, so swallowing
 * the error would silently lose the block. An outbound write failure means
 * the session DB is broken; loud is correct.
 */
export interface MidTurnScanResult {
  delivered: number;
  tail: string;
}

export async function deliverMidTurnBlocks(
  text: string,
  routing: RoutingContext,
  turnStartSeq?: number,
  carry = '',
): Promise<MidTurnScanResult> {
  if (routing.taskRun) return { delivered: 0, tail: '' };
  const input = carry + text;
  const tailStart = unresolvedTailStart(input);
  const settled = input.slice(0, tailStart);
  const tail = input.slice(tailStart);
  if (tail && carry !== tail) {
    log(`Mid-turn scan: carrying ${tail.length}-char unresolved tail to the next segment`);
  }
  // Seq high-water mark at THIS scan's start: the echo check below only
  // looks at rows written by EARLIER segments of the same turn — a verbatim
  // duplicate within one settled scan (two identical blocks in one text) is
  // an explicit double-send and still delivers twice, exactly as the result
  // door always treated it.
  const segStartSeq = turnStartSeq === undefined ? 0 : maxOutboundSeq();
  const visible = settled.replace(INTERNAL_SPAN_RE, '');
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;
  let match: RegExpExecArray | null;
  let delivered = 0;
  while ((match = MESSAGE_RE.exec(visible)) !== null) {
    const toName = match[1];
    const rawBody = match[2];
    const body = stripHarnessTagArtifacts(rawBody.trim());
    const dest = findByName(toName);
    if (!dest) continue;
    // Never deliver a blank message: a body that is empty (or was only
    // harness-tag artifacts) is skipped here; the result path logs it.
    if (!body) {
      log(`Mid-turn <message to="${toName}"> empty after sanitization — skipped`);
      continue;
    }
    // Cross-segment echo guard (live-captured shape, SDK battery s03): after
    // a tool call the model often re-emits the ALREADY-SENT block verbatim as
    // its final text. That final text streams as its own text event, so
    // without this check the door would deliver the same message twice. The
    // check consults the outbound DB — the durable record of what this turn
    // actually wrote — over the frame-local seq window (turnStartSeq,
    // segStartSeq]: identical body, same destination, written this turn by an
    // earlier segment ⇒ echo, skip. No in-process content ledger; cross-turn
    // repeats are out of the window and deliver normally.
    if (turnStartSeq !== undefined && wasWrittenInSeqWindow(dest, body, turnStartSeq, segStartSeq)) {
      log(`Mid-turn <message to="${toName}"> is a verbatim repeat of a message already sent this turn — skipped`);
      continue;
    }
    await sendToDestination(dest, body, routing);
    delivered++;
    log(`Mid-turn delivery: <message to="${toName}"> (${body.length} chars)`);
  }
  return { delivered, tail };
}

const OPEN_INTERNAL_RE = /<internal\b/i;
const OPEN_MESSAGE_RE = /<message\b/;

/**
 * Index where the UNRESOLVED tail of a mid-turn scan begins — everything
 * before it is settled (safe to parse and deliver now), everything from it
 * on must wait for the next text event. input.length when fully settled.
 *
 * Unresolved constructs, earliest wins:
 *  - an unclosed <internal span (case-insensitive, attributes allowed):
 *    blocks quoted inside must not deliver until the span closes and the
 *    exclusion can apply — assembly must never promote a draft;
 *  - an unclosed <message open after the last </message>: the growing block
 *    the assembly exists for. Opens with a close somewhere after them are
 *    finished text (a complete block, or malformed-and-done) — settled;
 *  - a bare tag prefix at the very end ("<mess", "<inter"): a tag literally
 *    split mid-token at the event boundary.
 *
 * Complete <internal> spans are blanked (same length, positions preserved)
 * before looking: an unclosed construct inside a COMPLETED span is settled
 * garbage, not a reason to buffer.
 */
export function unresolvedTailStart(input: string): number {
  const masked = input.replace(INTERNAL_SPAN_RE, (m) => ' '.repeat(m.length));
  const candidates: number[] = [];
  const internalOpen = OPEN_INTERNAL_RE.exec(masked);
  if (internalOpen) candidates.push(internalOpen.index);
  const lastClose = masked.lastIndexOf('</message>');
  const searchFrom = lastClose === -1 ? 0 : lastClose + '</message>'.length;
  const msgOpen = OPEN_MESSAGE_RE.exec(masked.slice(searchFrom));
  if (msgOpen) candidates.push(searchFrom + msgOpen.index);
  if (candidates.length > 0) return Math.min(...candidates);
  const prefixStart = trailingTagPrefixStart(masked);
  return prefixStart === -1 ? input.length : prefixStart;
}

/**
 * Start index of a proper prefix of '<message' (case-sensitive, mirroring
 * MESSAGE_RE) or '<internal' (case-insensitive, mirroring INTERNAL_SPAN_RE)
 * sitting at the very end of the string; -1 when the string does not end
 * mid-token. Longest prefix wins.
 */
function trailingTagPrefixStart(masked: string): number {
  const maxK = Math.min('<internal'.length - 1, masked.length);
  for (let k = maxK; k >= 1; k--) {
    const tailK = masked.slice(masked.length - k);
    if (tailK === '<message'.slice(0, k)) return masked.length - k;
    if (tailK.toLowerCase() === '<internal'.slice(0, k)) return masked.length - k;
  }
  return -1;
}

/** Current outbound seq high-water mark (0 when the table is empty). */
function maxOutboundSeq(): number {
  return getUndeliveredMessages().reduce((max, message) => Math.max(max, message.seq ?? 0), 0);
}

/**
 * Has ANY chat row been written to outbound.db after `afterSeq`? Feeds the
 * result door's nudge decision: unlike the frame-local midTurnSent count,
 * this also sees MCP send_message / send_file deliveries made this turn, so
 * an agent that already replied via tools is not nudged into repeating
 * itself. Fail-open to false: if the lookup breaks, the nudge may fire
 * spuriously (a repeat coax), never silently swallow an undelivered turn.
 */
function chatRowWrittenSince(afterSeq: number): boolean {
  try {
    // ponytail: reuse the existing semantic read; add a cursor operation only if history scans show up in profiles.
    return getUndeliveredMessages().some((message) => (message.seq ?? 0) > afterSeq && message.kind === 'chat');
  } catch (err) {
    log(`chatRowWrittenSince failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Does messages_out already hold a chat row with this exact destination and
 * body, written in the seq window (afterSeq, uptoSeq]? Used by the mid-turn
 * door's cross-segment echo guard. Content equality is exact: the door writes
 * `JSON.stringify({ text: body })` after the same trim/sanitize pipeline, so
 * a true door-written duplicate always matches; a body differing by even one
 * character is a different message and delivers.
 */
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
    // The guard is an anti-duplication refinement; if the lookup itself
    // fails, fall through to delivery (the write will surface any real DB
    // breakage loudly).
    log(`Echo-guard lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function dispatchResultText(
  text: string,
  routing: RoutingContext,
  options?: ResultDispatchOptions | DeliveryMode,
): Promise<{ sent: number; hasUnwrapped: boolean; taskBlocks: TaskMessageBlock[]; resultBlocks: number }> {
  const dispatchOptions = typeof options === 'string' ? { deliveryMode: options } : options;
  const deliveryMode = dispatchOptions?.deliveryMode ?? 'envelope';
  // <internal> spans are not-for-delivery scratchpad. Remove them BEFORE block
  // extraction so a <message> drafted inside one is never delivered from the
  // final text either — the mid-turn seam already guarantees this; without the
  // same strip here the guarantee had a final-text hole. Span content still
  // never reaches the user (the closing stripInternalTags pass removed it from
  // the scratchpad already), so nudge/scratchpad semantics are unchanged.
  text = text.replace(INTERNAL_SPAN_RE, '');
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  // Blocks delivered mid-turn count toward this turn's sent total — a final
  // text with no (new) blocks after a mid-turn delivery is scratchpad, not an
  // undelivered reply.
  let sent = dispatchOptions?.midTurnSent ?? 0;
  // <message> blocks present in THIS result text (delivered, stripped, task
  // or dropped alike) — drives the bare-error-text delivery gate, which must
  // key on the error result itself, not on earlier mid-turn deliveries.
  let resultBlocks = 0;
  // <message to> blocks left inert in a task run — drives the same-turn
  // "use send_message" nudge in processQuery.
  const taskBlocks: TaskMessageBlock[] = [];
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = stripHarnessTagArtifacts(match[2].trim());
    lastIndex = MESSAGE_RE.lastIndex;
    resultBlocks++;

    // One-door delivery in task sessions: only the send_message tool delivers.
    // A final-text <message to> block here is either an echo of a tool send the
    // agent already made (the double-delivery class) or a send down the wrong
    // path — never deliver it, keep it visible in the scratchpad/run log.
    if (routing.taskRun) {
      log(`Task run: <message to="${toName}"> block not delivered — task sessions send only via explicit tools`);
      scratchpadParts.push(
        `[not delivered — task sessions send only via the send_message tool; to="${toName}"] ${body}`,
      );
      taskBlocks.push({ to: toName, body });
      continue;
    }
    if (deliveryMode === 'tools-only') {
      // Correction text needs an exact configured-name check so it can tell
      // the model which misspelled destination failed.
      const unknownDestination = !getAllDestinations().some((destination) => destination.name === toName);
      log(
        `<message to="${toName}"> block not delivered — this group sends only via explicit tools` +
          (unknownDestination ? ' (and that destination does not exist)' : ''),
      );
      scratchpadParts.push(
        unknownDestination
          ? `[not delivered — unknown destination "${toName}", and this group sends only via the send tools] ${body}`
          : `[not delivered — this group sends only via the send tools; to="${toName}"] ${body}`,
      );
      taskBlocks.push({ to: toName, body, unknownDestination });
      continue;
    }
    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    // Never deliver a blank message: a body that is empty (or was only
    // harness-tag artifacts stripped by sanitization) goes to the scratchpad
    // log instead of writing an empty chat row.
    if (!body) {
      log(`Empty <message to="${toName}"> body after sanitization — not delivered`);
      scratchpadParts.push(`[not delivered — empty after sanitization; to="${toName}"]`);
      continue;
    }
    // One content door: with a mid-turn delivery provider the result door
    // never sends. A deliverable block here is either a repeat of a mid-turn
    // delivery (turnDelivered — keep it out of the scratchpad so it does not
    // read as an undelivered reply) or content the streaming door missed —
    // then it goes to the scratchpad as undelivered content, which makes the
    // turn count as undelivered and fires the wrap-nudge: the model re-sends
    // and the retry streams through the mid-turn door.
    if (dispatchOptions?.suppressDelivery) {
      if (dispatchOptions.turnDelivered) {
        log(`<message to="${toName}"> in final result after a same-turn delivery — repeat, result door does not send`);
      } else {
        log(
          `<message to="${toName}"> in final result but nothing was delivered this turn — nudging for a mid-turn resend`,
        );
        scratchpadParts.push(`[not delivered — the result door does not send; to="${toName}"] ${body}`);
      }
      continue;
    }
    await sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  // In a task run, plain final text is the NORMAL ending (it becomes the run
  // log) — never treat it as an undelivered reply or nudge the agent to wrap it.
  // With suppressDelivery the delivered-this-turn question is answered by
  // turnDelivered (door deliveries + DB-visible sends like MCP send_message);
  // otherwise by this dispatch's own send count.
  const anythingDelivered = dispatchOptions?.suppressDelivery ? dispatchOptions.turnDelivered === true : sent > 0;
  const hasUnwrapped = !routing.taskRun && deliveryMode !== 'tools-only' && !anythingDelivered && !!scratchpad;
  if (hasUnwrapped) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
  return { sent, hasUnwrapped, taskBlocks, resultBlocks };
}

/**
 * Should this task-run result get the same-turn "your <message> block was
 * not delivered — use send_message" nudge? True at most once per turn
 * (mirrors the unwrappedNudged flag for chat turns).
 */
export function shouldNudgeTaskBlocks(
  taskRun: boolean,
  taskBlocks: TaskMessageBlock[],
  alreadyNudged: boolean,
): boolean {
  return taskRun && taskBlocks.length > 0 && !alreadyNudged;
}

export function buildTaskBlockNudge(taskBlocks: TaskMessageBlock[], destinationNames: string): string {
  const blocks = taskBlocks
    .map(
      ({ to, body }) =>
        `<undelivered_message to="${escapePromptXml(to)}">${escapePromptXml(body)}</undelivered_message>`,
    )
    .join('\n');
  return (
    '<system>The final-output content below was not delivered from this task run:\n' +
    `${blocks}\n` +
    'If and only if any of it still needs to be sent, call send_message with an explicit to destination. ' +
    'If it was already sent or no notification is required, do not send it again. ' +
    `Your destinations: ${escapePromptXml(destinationNames)}. ` +
    'The original task result is already recorded in the run log; do not repeat it.</system>'
  );
}

/**
 * True when a turn's undelivered text contains markup shaped like a tool
 * invocation — an XML-style tag or a function-call form naming a tool.
 *
 * This only chooses the wording of a correction. Delivery was already decided
 * by whether an outbound row appeared, so a miss here costs nothing beyond a
 * more generic sentence, and the set of shapes it recognizes is deliberately
 * allowed to be incomplete.
 */
export function looksLikeToolMarkup(text: string): boolean {
  return (
    /<\s*\/?\s*(?:call|invoke|tool_call|tool_use|function_call|antml:invoke)\b/i.test(text) ||
    /<[^>\n]*\bmcp__/.test(text)
  );
}

/**
 * Correction for a tools-only chat turn that delivered nothing. Names the
 * specific thing the turn did instead of calling a tool: a generic "you didn't
 * deliver" reads as noise, and the observed shape is what the agent has to
 * recognize in its own output to avoid repeating it.
 */
export function buildToolsOnlyNudge(text: string, inertBlocks: TaskMessageBlock[], destinationNames: string): string {
  const unknown = inertBlocks.filter((b) => b.unknownDestination);
  let observed: string;
  if (unknown.length > 0) {
    // A wrong name is a different mistake from the wrong door, and the agent can
    // only fix it if the correction says which name failed.
    const names = unknown.map((b) => `"${escapePromptXml(b.to)}"`).join(', ');
    observed =
      `You addressed ${names}, which ${unknown.length === 1 ? 'is not a destination' : 'are not destinations'} here, ` +
      'and you addressed it in a <message to="…"> block, which delivers nothing either.';
  } else if (inertBlocks.length > 0) {
    const label =
      inertBlocks.length === 1 ? 'a <message to="…"> block' : `${inertBlocks.length} <message to="…"> blocks`;
    observed = `You wrote ${label}; those deliver nothing here.`;
  } else if (looksLikeToolMarkup(text)) {
    observed = 'You wrote text shaped like a tool call instead of calling the tool; written markup is never executed.';
  } else {
    observed = 'Your whole response stayed in the private scratchpad, so nothing reached anyone.';
  }
  return (
    `<system>Nothing from your last turn was delivered. ${observed} ` +
    'To reach the user, call send_message with an explicit to destination — that is the only door. ' +
    `Your destinations: ${destinationNames ? escapePromptXml(destinationNames) : '(none configured)'}.</system>`
  );
}

/**
 * Stands in for a provider error in a tools-only group. The provider's own error
 * text is model-side output like any other and is never forwarded, so this
 * carries the news without it and leaves the detail to the log.
 */
export const TOOLS_ONLY_ERROR_NOTICE = "Something went wrong on my side and I couldn't finish that one.";

/**
 * Report an errored tools-only turn to the people it was still owed to. The
 * caller has already settled whatever the turn delivered before failing, so
 * every target here is one the failure left unanswered — an error arriving
 * after a successful tool send does not double up on the reply. One notice per
 * address: two questions waiting in the same place get one "something went
 * wrong", not two. Returns the seqs written.
 */
export async function handleToolsOnlyError(text: string, targets: ReplyTarget[]): Promise<number[]> {
  log(`Tools-only error result (not forwarded): ${text.slice(0, 500)}`);
  const noticed: ReplyTarget[] = [];
  const written: number[] = [];
  for (const target of targets) {
    if (noticed.some((done) => sameDestination(done, target))) continue;
    noticed.push(target);
    written.push(await writeToReplyTarget(target, TOOLS_ONLY_ERROR_NOTICE));
  }
  return written;
}

/** The full reply route the MCP tools should use for the active exchange. */
function replyTargetForRouting(routing: RoutingContext): ReplyTarget | null {
  const targets = routing.replyTargets ?? [];
  if (targets.length > 0) return targets[targets.length - 1];
  return routing.inReplyTo
    ? {
        inReplyTo: routing.inReplyTo,
        channelType: routing.channelType,
        platformId: routing.platformId,
        threadId: routing.threadId,
      }
    : null;
}

/** Re-home a correction on one exact correspondent while retaining turn kind. */
function routingForTarget(target: ReplyTarget, fallback: RoutingContext): RoutingContext {
  return {
    ...fallback,
    inReplyTo: target.inReplyTo,
    channelType: target.channelType,
    platformId: target.platformId,
    threadId: target.threadId,
    taskRun: false,
    replyTargets: [target],
    agentWake: false,
  };
}

/** A request this query has held on the hook, with the exchange that carried it last. */
export interface KnownRequest {
  target: ReplyTarget;
  exchange: number;
}

/**
 * Drop from `outstanding` every request the given deliveries answered.
 * `exchange` is the one whose result is being judged: no prompt past it has
 * run, so a row can only have been meant for a request that prompt or an
 * earlier one carried.
 *
 * An obligation is discharged by output addressed AT IT, not by any chat row
 * at all. A send to a peer agent, or to a second destination in a
 * multi-destination group, writes the same `kind: 'chat'` row as a reply —
 * crediting it would mark the asker's question answered while the asker hears
 * nothing. Two readings, in order:
 *
 * 1. Exact stamp. A row whose `in_reply_to` names a request this query has
 *    held — still open, or settled earlier (a send_file after the
 *    send_message that paid it off) — and that sits on that request's chat
 *    answers THAT request, whatever its exchange. It never falls through to
 *    the address match, so it can never settle another asker's question on
 *    the same chat. It also answers everyone waiting at exactly its address
 *    whose prompt is the same one that carried the stamped request: they all
 *    see it there, and the tools allow that prompt one plain send per address
 *    anyway. Not a same-address request from a later prompt — that prompt
 *    gets its own budget and its own judgment (live shape: a DM, where every
 *    request shares one address). The chat condition keeps the stamp from
 *    over-reaching: the tools stamp every row of a turn, a send to a peer
 *    agent or to another destination included, and those are not replies
 *    this person received.
 * 2. Address, for every other row (a stale stamp, none, or a stamp for a
 *    request on some other chat), among requests whose prompt has run. A row
 *    answers everyone waiting at exactly its address: which of two
 *    same-address questions it answered is not knowable, and holding one back
 *    would post a placeholder over a reply already given. A THREAD-LESS row
 *    that reaches nobody that way answers the oldest request waiting in a
 *    thread of that chat: `send_message` stamps its thread from
 *    session_routing, which is NULL in a shared session even when the request
 *    arrived in a thread, so the row is still a visible reply on the
 *    requesting surface — but one reply answers ONE such request; any other
 *    threaded asker stays on the hook so the correction (and, failing that,
 *    the placeholder) still reaches them rather than being silently dropped.
 *
 * A targetless (agent-wake) entry has no address to match, so it keeps the
 * address-blind reading: anything landing anywhere counts, once its prompt
 * has run. Deliveries are taken oldest first, and stamped rows before
 * unstamped ones, so a stamped reply always claims its own request before an
 * unstamped one is matched by address.
 */
export function settleDeliveries(
  outstanding: OutstandingReply[],
  knownRequests: Map<string, KnownRequest>,
  deliveries: Delivery[],
  exchange: number,
): void {
  for (const entry of outstanding) {
    if (entry.target?.inReplyTo)
      knownRequests.set(entry.target.inReplyTo, { target: entry.target, exchange: entry.exchange });
  }
  if (deliveries.length === 0) return;
  const answered = new Set<OutstandingReply>();
  const open = (): OutstandingReply[] => outstanding.filter((entry) => !answered.has(entry));
  const ran = (entry: OutstandingReply): boolean => entry.exchange <= exchange;
  const sameChat = (a: Delivery, b: ReplyTarget): boolean =>
    a.platformId === b.platformId && a.channelType === b.channelType;
  const atAddress = (row: Delivery): OutstandingReply[] =>
    open().filter((entry) => entry.target !== undefined && sameDestination(row, entry.target));
  const stampedRequest = (row: Delivery): KnownRequest | undefined => {
    const request = row.inReplyTo === null ? undefined : knownRequests.get(row.inReplyTo);
    return request && sameChat(row, request.target) ? request : undefined;
  };
  const stamped = deliveries.filter((row) => stampedRequest(row) !== undefined);
  const unstamped = deliveries.filter((row) => !stamped.includes(row));
  for (const row of stamped) {
    const request = stampedRequest(row)!;
    for (const entry of open()) {
      if (entry.target?.inReplyTo === row.inReplyTo) answered.add(entry);
    }
    for (const entry of atAddress(row)) {
      if (entry.exchange === request.exchange) answered.add(entry);
    }
  }
  for (const row of unstamped) {
    const exact = atAddress(row).filter(ran);
    for (const entry of exact) answered.add(entry);
    if (exact.length === 0 && row.threadId === null) {
      const oldestInThread = open().find(
        (entry) => entry.target !== undefined && ran(entry) && sameChat(row, entry.target),
      );
      if (oldestInThread) answered.add(oldestInThread);
    }
  }
  for (const entry of open()) {
    if (!entry.target && ran(entry)) answered.add(entry);
  }
  for (let i = outstanding.length - 1; i >= 0; i--) {
    if (answered.has(outstanding[i])) outstanding.splice(i, 1);
  }
}

/**
 * Sent when a tools-only chat turn spends its correction and still delivers
 * nothing. Someone is waiting on a reply, so the failure surfaces as a short,
 * plain message rather than as silence or as agent text never addressed to them.
 */
export const TOOLS_ONLY_PLACEHOLDER = "I couldn't put a reply together for that one. Try asking again.";

/** Returns the seq written, so the caller can keep it out of the next judgment. */
export function deliverToolsOnlyPlaceholder(target: ReplyTarget): Promise<number> {
  log('Tools-only turn delivered nothing after a correction — sending the placeholder');
  return writeToReplyTarget(target, TOOLS_ONLY_PLACEHOLDER);
}

/**
 * Address one outbound message at the correspondent still waiting on it, rather
 * than at the batch's first row — on a threaded platform those differ, and a
 * batch that mixed a host notice with a user question would otherwise answer
 * into the agent channel.
 */
function writeToReplyTarget(target: ReplyTarget, text: string): Promise<number> {
  return writeMessageOut({
    id: generateId(),
    in_reply_to: target.inReplyTo,
    kind: 'chat',
    platform_id: target.platformId,
    channel_type: target.channelType,
    thread_id: target.threadId,
    content: JSON.stringify({ text }),
  });
}

function escapePromptXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Task runs: the final text is the automatic run summary. Explicit
 * `ncl tasks append-log` calls are additive mid-run notes. Written as a
 * `task_log` outbound row; the host appends it to the series' tasks/<id>.md
 * with its usual timestamp stamp. Never delivered to anyone.
 */
export async function autoAppendTaskLog(text: string): Promise<void> {
  // Run-log hygiene: an inert <message to> block never belongs in the log as
  // raw XML — replace each with its inner text, marked undelivered, so the
  // log stays readable prose.
  const prose = text.replace(
    /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g,
    (_m, to: string, body: string) => `[undelivered → ${to}] ${body.trim()}`,
  );
  const line = stripInternalTags(prose).replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!line) return;
  await writeMessageOut({
    id: generateId(),
    kind: 'task_log',
    content: JSON.stringify({ text: line }),
  });
  log('Task run log auto-appended from final text');
}

async function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): Promise<void> {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Thread per destination: the batch's own thread when the destination is the
  // channel being answered, else that channel's latest inbound thread. In
  // agent-shared sessions different destinations have different thread
  // contexts — stamping routing.threadId on every send would put one channel's
  // thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId, routing);
  await writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: body }),
  });
}

/** Publish the active exchange's exact reply route for out-of-process MCP tools. */
function publishReplyRoute(routing: RoutingContext): void {
  const target = replyTargetForRouting(routing);
  setCurrentReplyRoute(
    target?.inReplyTo
      ? {
          inReplyTo: target.inReplyTo,
          channelType: target.channelType,
          platformId: target.platformId,
          threadId: target.threadId,
        }
      : null,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
