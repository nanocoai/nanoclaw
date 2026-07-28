import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import {
  getPendingMessages,
  markProcessing,
  markCompleted,
  requeueMessages,
  type MessageInRow,
} from './db/messages-in.js';
import { writeMessageOut, getMaxOutSeq, countChatSendsSince } from './db/messages-out.js';
import { getInboundDb, touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import {
  clearContinuation,
  clearLastTurnProvider,
  clearThreadTokens,
  getContinuation,
  getLastTurnProvider,
  getQuotaWarnedWindow,
  getThreadTokens,
  setLastTurnProvider,
  isFallbackFailureNotified,
  isQuotaDegraded,
  migrateLegacyContinuation,
  setContinuation,
  setFallbackFailureNotified,
  setQuotaDegraded,
  setQuotaWarnedWindow,
} from './db/session-state.js';
import { QuotaExhaustedError, isGenuineQuotaError, isTransientLimit } from './quota.js';
import { buildHandoffRecap } from './handoff.js';
import { clearCurrentInReplyTo, setCurrentInReplyTo, setCurrentRouting } from './current-batch.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isRunnerCommand,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PollLoopConfig {
  provider: AgentProvider;
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
   * Optional overflow provider. When the primary provider fails a turn with
   * a quota-exhaustion error, the unanswered prompt is retried once on this
   * provider and the user is notified of the switch. Every new turn starts
   * on the primary again, so recovery back to the primary is automatic.
   */
  fallback?: {
    provider: AgentProvider;
    providerName: string;
  };
  /**
   * Optional cheap-model override for turns whose batch consists solely of
   * scheduled tasks (kind='task'). Watcher wakes pay a large fixed context
   * floor per turn; routing them to a cheaper model caps that cost without
   * touching user-conversation quality. Ignored when a batch mixes task and
   * chat rows — the user's message wins the stronger model.
   */
  taskModel?: string;
}

// User-facing notices for the fallback flow. Sent to the same destination
// the failed turn was routed to.
const FALLBACK_SWITCH_NOTICE =
  '⚠️ מכסת Claude נגמרה כרגע — ממשיך לענות דרך Codex (OpenAI). אחזור ל-Claude אוטומטית כשהמכסה תתחדש.';
const FALLBACK_RETURN_NOTICE = '✅ מכסת Claude התחדשה — חזרתי לענות דרך Claude.';
const FALLBACK_FAILED_NOTICE = '❌ גם מנוע הגיבוי (Codex) לא הצליח לענות כרגע. נסו שוב מאוחר יותר.';
// Genuine quota exhaustion when NO fallback provider is configured. Shown
// once (deduped via the quota-degraded flag) instead of dumping the raw
// English "You've hit your session limit" banner on every message.
const NO_FALLBACK_QUOTA_NOTICE =
  '⚠️ מכסת Claude נגמרה כרגע. אנסה שוב אוטומטית כשהמכסה תתחדש — נסו שוב מאוחר יותר.';
// Sent once when the primary recovers and no fallback was involved (mirror of
// FALLBACK_RETURN_NOTICE for the no-fallback path).
const QUOTA_RENEWED_NOTICE = '✅ מכסת Claude התחדשה — חזרתי לפעול כרגיל.';

// Proactive heads-up sent ONCE per plan window when usage crosses the warning
// threshold, BEFORE the quota actually runs out. Deduped per window via
// get/setQuotaWarnedWindow. Threshold is operator-tunable via env.
function quotaWarnThresholdPct(): number {
  const v = Number(process.env.QUOTA_WARN_THRESHOLD_PCT);
  return Number.isFinite(v) && v > 0 && v < 100 ? v : 90;
}
function nearQuotaNotice(pctText: string, hasFallback: boolean): string {
  return hasFallback
    ? `⚠️ הגעת ל-${pctText} ממכסת Claude. כשהיא תיגמר אעבור אוטומטית לענות דרך Codex (OpenAI) — שתדע.`
    : `⚠️ הגעת ל-${pctText} ממכסת Claude. כשהיא תיגמר לא אוכל לענות עד שהמכסה תתחדש.`;
}
// Shown when the primary throws a *transient* throttle (429/overload) that
// the SDK gave up retrying. This is NOT quota exhaustion — do not switch
// providers, just tell the user to retry shortly.
const TRANSIENT_BUSY_NOTICE = '⚠️ השרת עמוס כרגע (הגבלת קצב זמנית) — נסו שוב עוד רגע.';

// Timeout model for a fallback turn — two distinct guards, because "hung" and
// "working hard" must be told apart by ACTIVITY, not wall-clock time:
//
//   IDLE timeout   — trips only after a long stretch with NO streamed events.
//                    A wedged thread-resume emits nothing and trips this fast;
//                    a real work turn (editing a file, running tools) streams
//                    notifications constantly and never trips it.
//   ABSOLUTE cap   — generous backstop against a pathological event-emitting
//                    loop. Kept under the host's 30-min heartbeat ceiling.
//
// Lesson learned live (2026-07-07): the original 150s WALL-CLOCK deadline
// killed every heavy Codex turn mid-work (CV editing, file reading) while
// light chat replies squeaked through — the user saw "❌ backup engine
// failed" on precisely the messages that mattered.
// Both read at call time so tests can drive the timeout paths.
function fallbackIdleTimeoutMs(): number {
  return Number(process.env.FALLBACK_IDLE_TIMEOUT_MS) || 180_000;
}
function fallbackTurnDeadlineMs(): number {
  return Number(process.env.FALLBACK_TURN_DEADLINE_MS) || 1_200_000;
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  let isFirstPoll = true;
  // Messages already granted one fresh-thread retry after a stale/wedged
  // provider thread — a second failure surfaces as an error instead of
  // looping forever.
  const staleRetriedIds = new Set<string>();
  // Rotate to a fresh provider thread before its rollout grows into
  // resume-wedge territory (codex reached ~370k tokens and stalled on every
  // resume, 2026-07-22 — its native compaction doesn't shrink the rollout).
  // Providers that don't persist thread tokens (claude) report 0 and never
  // rotate. The fresh thread gets a conversation recap via the handoff path.
  const threadRotateTokens = Number(process.env.PROVIDER_THREAD_ROTATE_TOKENS) || 150_000;
  while (true) {
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
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
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
        clearThreadTokens(config.providerName);
        // An explicit /clear means "forget the conversation" — suppress the
        // fresh-thread recap that would otherwise resurrect it.
        clearLastTurnProvider();
        writeMessageOut({
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
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    let prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    // Proactive thread rotation: drop an oversized continuation BEFORE it
    // wedges. The recap below carries the conversation into the fresh thread.
    const threadTokens = getThreadTokens(config.providerName);
    if (continuation && threadTokens >= threadRotateTokens) {
      log(
        `Thread at ${threadTokens} tokens (>= ${threadRotateTokens}) — rotating to a fresh thread with recap`,
      );
      continuation = undefined;
      clearContinuation(config.providerName);
      clearThreadTokens(config.providerName);
    }

    // Conversation recap (handoff): prepend a recent-exchange recap when the
    // engine answering this turn may not have seen the latest turns —
    //   • quota-degraded: recent turns were answered by the fallback engine;
    //   • engine switch (manual or config-driven): the last turn was answered
    //     by a different provider whose thread this engine never saw;
    //   • fresh thread mid-conversation (post-rotation or stale-clear): the
    //     new thread starts empty even though the conversation didn't.
    // First-ever runs have no lastTurnProvider and /clear resets it, so
    // neither gets a recap.
    const lastTurnProvider = getLastTurnProvider();
    const needsRecap =
      isQuotaDegraded() ||
      (lastTurnProvider !== undefined && (lastTurnProvider !== config.providerName.toLowerCase() || !continuation));
    if (needsRecap) {
      prompt = buildHandoffRecap() + prompt;
    }

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    // Task-only turns run on the cheap task model when configured.
    const taskOnly = keep.every((m) => m.kind === 'task');
    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
      model: taskOnly ? config.taskModel : undefined,
    });

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped);
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
    // can stamp it on outbound rows — needed for a2a return-path routing.
    // The routing itself is published too, so a destination-less
    // send_message defaults to the triggering message's chat instead of the
    // session's sticky first-channel routing.
    setCurrentInReplyTo(routing.inReplyTo);
    setCurrentRouting({
      channelType: routing.channelType,
      platformId: routing.platformId,
      threadId: routing.threadId,
    });
    try {
      const result = await processQuery(
        query,
        routing,
        processingIds,
        config.providerName,
        prompt,
        Boolean(config.fallback),
      );
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
      }
      // Backstop only — processQuery already stamps the provider on every
      // `result` event. Stamping here alone was a live bug (2026-07-28): the
      // fallback path stamps 'codex' per turn, but this line only runs when
      // the primary's long-lived query CLOSES, so after one fallback episode
      // last_turn_provider stayed 'codex' across healthy Claude turns and
      // needsRecap prepended an "Engine handoff" recap on every single new
      // query (46+ recaps in one session's transcript).
      setLastTurnProvider(config.providerName);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      // Quota exhaustion on the primary → retry the unanswered prompt on the
      // fallback provider. QuotaExhaustedError carries the exact prompt
      // segment that went unanswered; a plain thrown error that reads like a
      // GENUINE usage-limit (SDK subprocess died on a usage-limit response)
      // retries the batch's initial prompt. A transient 429/overload is
      // explicitly excluded here — it must NOT switch providers.
      const quotaPrompt =
        err instanceof QuotaExhaustedError ? err.lastPrompt : isGenuineQuotaError(errMsg) ? prompt : null;

      if (quotaPrompt !== null && config.fallback) {
        // Announce the switch to the user only on the TRANSITION into fallback
        // mode. During a multi-hour outage the primary is exhausted on every
        // turn, so an unconditional notice here spammed the user with the same
        // "switched to Codex" banner after every single message (observed live
        // 2026-07-06). The persisted flag makes it fire exactly once per
        // outage; the matching return notice fires once when the primary
        // recovers (see the result path in processQuery).
        const isFirstFallbackOfOutage = !isQuotaDegraded();
        if (isFirstFallbackOfOutage) {
          log(`Primary quota exhausted — switching to fallback provider '${config.fallback.providerName}'`);
          writeNotice(routing, FALLBACK_SWITCH_NOTICE);
          setQuotaDegraded(true);
        } else {
          log(
            `Primary still quota-exhausted — continuing on fallback '${config.fallback.providerName}' (notice suppressed)`,
          );
        }
        // Conversation handoff: the fallback engine has its own private
        // thread and never saw the primary-era turns. On the first fallback
        // turn of an outage — or whenever the fallback thread is fresh (none
        // stored, e.g. after a self-heal wipe) — prepend a recap of the
        // recent exchange so the switch doesn't read as "a different person
        // who remembers nothing" (reported live 2026-07-08). Mid-outage turns
        // resume the fallback's own thread, which already saw them.
        // Rotation guard for the FALLBACK thread. The outer-loop rotation
        // above only watches the primary provider, and codex's own
        // mid-stream rotation needs a long-lived query — fallback turns are
        // one-shot. Without this check the fallback thread grew unboundedly
        // (observed live 2026-07-28: 475k tokens, 3× the ceiling) and every
        // resume wedged into the 180s idle abort.
        rotateFallbackThreadIfOversized(config.fallback.providerName, threadRotateTokens);
        const fallbackHasThread = getContinuation(config.fallback.providerName) !== undefined;
        const fbPrompt =
          isFirstFallbackOfOutage || !fallbackHasThread ? buildHandoffRecap() + quotaPrompt : quotaPrompt;
        try {
          await runFallbackTurn(config.fallback, fbPrompt, routing, config.cwd, config.systemContext);
          // A fallback turn just answered — end any ❌-notice streak so a
          // future failure is announced again.
          setFallbackFailureNotified(false);
          setLastTurnProvider(config.fallback.providerName);
        } catch (fbErr) {
          const fbMsg = fbErr instanceof Error ? fbErr.message : String(fbErr);
          log(`Fallback turn failed (after fresh-thread retry): ${fbMsg}`);
          // Backstop self-heal: runFallbackTurn already retried once on a
          // fresh thread; make sure no poisoned continuation survives into
          // the next turn either (skip when it's the fallback's own quota —
          // the thread is fine, just out of budget).
          if (!/quota exhausted/i.test(fbMsg)) {
            clearContinuation(config.fallback.providerName);
          }
          // Tell the user ONCE per failure streak — repeated failures during
          // one outage were spamming a ❌ banner on every message.
          if (!isFallbackFailureNotified()) {
            setFallbackFailureNotified(true);
            writeNotice(routing, FALLBACK_FAILED_NOTICE);
          } else {
            log('Fallback failed again — ❌ notice suppressed (already sent this streak)');
          }
        }
      } else {
        // Stale/corrupt continuation recovery: ask the provider whether
        // this error means the stored continuation is unusable, and clear
        // it so the next attempt starts fresh.
        let staleRetry = false;
        // The local `continuation` can lag the persisted one: processQuery
        // stores the id at `init` time, but a turn that errors never returns
        // it to this scope. Consult the persisted value too, or a failed
        // retry would leave its own poisoned id behind.
        const storedContinuation = continuation ?? getContinuation(config.providerName);
        if (storedContinuation && config.provider.isSessionInvalid(err)) {
          log(`Stale session detected (${storedContinuation}) — clearing for next retry`);
          continuation = undefined;
          clearContinuation(config.providerName);
          // Retry the SAME batch on the fresh thread instead of dropping it
          // with a raw error dump (observed live 2026-07-22: a wedged codex
          // thread stalled, the user's message was completed-with-error and
          // lost). One retry per message — a batch that also fails on a
          // fresh thread falls through to the error notice below.
          const retriable = processingIds.filter((id) => !staleRetriedIds.has(id));
          if (retriable.length > 0) {
            for (const id of retriable) staleRetriedIds.add(id);
            requeueMessages(processingIds);
            staleRetry = true;
            log(`Requeued ${processingIds.length} message(s) for a fresh-thread retry`);
          }
        }

        // Genuine quota exhaustion but no fallback provider configured
        // (quotaPrompt was set yet config.fallback is undefined). Show a
        // friendly Hebrew notice ONCE — deduped via the same quota-degraded
        // flag — instead of dumping the raw English "session limit" banner on
        // every message for the whole outage (observed live 2026-07-06).
        if (quotaPrompt !== null && !config.fallback) {
          if (!isQuotaDegraded()) {
            log('Primary quota exhausted, no fallback configured — notifying user once');
            writeNotice(routing, NO_FALLBACK_QUOTA_NOTICE);
            setQuotaDegraded(true);
          } else {
            log('Primary still quota-exhausted, no fallback — notice suppressed');
          }
        } else if (!staleRetry) {
          // Write error response so the user knows something went wrong. A
          // transient throttle (429/overload the SDK exhausted its retries on)
          // gets a friendly "try again" notice rather than a raw error dump —
          // it is NOT a provider-switch condition.
          const userText = isTransientLimit(errMsg) ? TRANSIENT_BUSY_NOTICE : `Error: ${errMsg}`;
          writeMessageOut({
            id: generateId(),
            kind: 'chat',
            platform_id: routing.platformId,
            channel_type: routing.channelType,
            thread_id: routing.threadId,
            content: JSON.stringify({ text: userText }),
          });
        }
        if (staleRetry) {
          // Batch was requeued — leave it un-acked for the retry.
          clearCurrentInReplyTo();
          setCurrentRouting(null);
          continue;
        }
      }
    } finally {
      clearCurrentInReplyTo();
      setCurrentRouting(null);
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
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
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

// Exported for tests (last-turn-provider stamping regression).
export async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  initialPrompt: string,
  hasFallback: boolean,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;
  let unwrappedNudged = false;
  // Most recent user-content prompt segment sent into the query (initial
  // batch or follow-up push — not system nudges). On quota exhaustion this
  // is the segment that went unanswered, handed to the fallback provider.
  let lastPrompt = initialPrompt;
  // Seq snapshot at the start of the current prompt segment. If the agent
  // sends anything via MCP tools during the segment (send_message,
  // send_file, ...), countChatSendsSince(promptSeqMark) > 0 and an
  // unwrapped final text is just scratchpad — nudging the agent to
  // "re-send" would produce a duplicate reply, not a missing one.
  let promptSeqMark = getMaxOutSeq();

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
        // the SDK never runs them. End the stream and leave the rows
        // pending; the outer loop handles them on next iteration via the
        // canonical command path + formatMessagesWithCommands.
        if (pending.some((m) => isRunnerCommand(m))) {
          log('Pending slash command — ending stream so outer loop can process');
          endedForCommand = true;
          query.end();
          return;
        }

        // Skip system messages (MCP tool responses).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        const newMessages = pending.filter((m) => m.kind !== 'system');
        if (newMessages.length === 0) return;

        // Mirror the outer loop's wake gate (line ~193): a follow-up batch
        // with no trigger=1 row is accumulate-only context (e.g. a WhatsApp
        // group message that didn't @mention the agent). The container is
        // already warm from an earlier trigger=1 turn, but that's a host
        // wake decision, not agent-side license to reply to everything that
        // arrives while it happens to be awake — the engage_mode/trigger
        // contract has to hold regardless of container warmth. Leave them
        // unacked/pending (same as the outer gate) so they ride along as
        // context the next time a real trigger=1 message lands, instead of
        // pushing a turn for them now.
        if (!newMessages.some((m) => m.trigger === 1)) return;

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: string[] = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markCompleted(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.join(', ')}`);
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim sweep.
        if (done) return;

        const keptIds = keep.map((m) => m.id);
        const prompt = formatMessages(keep);
        // Re-anchor reply routing on the follow-up's triggering message —
        // in a shared session the follow-up may come from a different chat
        // than the batch that opened this turn, and both the plain-text
        // reply path (dispatchResultText via `routing`) and the MCP
        // send_message default must follow it.
        const followUpRouting = extractRouting(keep);
        Object.assign(routing, followUpRouting);
        setCurrentInReplyTo(followUpRouting.inReplyTo);
        setCurrentRouting({
          channelType: followUpRouting.channelType,
          platformId: followUpRouting.platformId,
          threadId: followUpRouting.threadId,
        });
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        unwrappedNudged = false;
        promptSeqMark = getMaxOutSeq();
        lastPrompt = prompt;
        query.push(prompt);
        markCompleted(keptIds);
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

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
      } else if (event.type === 'error' && event.classification === 'quota') {
        // Provider is out of quota — this query cannot answer the current
        // segment. Abort and surface to runPollLoop, which retries the
        // segment on the fallback provider (when one is configured).
        query.abort();
        throw new QuotaExhaustedError(event.message, lastPrompt);
      } else if (event.type === 'error' && !event.retryable) {
        // Non-retryable, non-quota provider failure — observed live as a
        // wedged codex thread ("Turn stalled: no app-server events"): the
        // stream survives the error and later yields an empty result, so
        // the user's message was silently swallowed and the poisoned
        // thread resumed (and re-stalled) on every subsequent turn. Abort
        // and rethrow instead: the batch stays 'processing' (host sweep
        // re-pends it) and runPollLoop clears the continuation via
        // isSessionInvalid, so the retry starts on a fresh thread.
        query.abort();
        throw new Error(event.message);
      } else if (event.type === 'quota_status') {
        // Informational plan-usage update. Warn the user ONCE per window when
        // they cross the threshold, before the quota actually runs out.
        maybeWarnApproachingQuota(event, routing, hasFallback);
      } else if (event.type === 'result') {
        // A result — with or without text — means the turn is done. Mark
        // the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for
        // follow-up pushes. The agent may have responded via MCP
        // (send_message) mid-turn, or the message may not need a response
        // at all — either way the turn is finished.
        markCompleted(initialBatchIds);
        // The session was quota-degraded and the primary just produced a real
        // result — quota recovered. Clear the flag and tell the user once,
        // with the message that matches how they were notified going in
        // (fallback → "back to Claude"; no fallback → "quota renewed").
        // Persisted, so this fires even if the container restarted mid-outage.
        // (Quota exhaustion never reaches this branch: claude.ts emits it as
        // an `error`/quota event, which processQuery rethrows as
        // QuotaExhaustedError before we get here.)
        if (isQuotaDegraded()) {
          setQuotaDegraded(false);
          setFallbackFailureNotified(false);
          writeNotice(routing, hasFallback ? FALLBACK_RETURN_NOTICE : QUOTA_RENEWED_NOTICE);
        }
        // Stamp the answering engine NOW, per result — not only when the
        // query eventually closes. The primary's query stays open across
        // many turns, so waiting for it to close left a stale 'codex' stamp
        // (from a past fallback turn) in place while Claude answered turn
        // after turn, and every new query prepended a bogus handoff recap.
        setLastTurnProvider(providerName);
        if (event.text) {
          const { hasUnwrapped } = dispatchResultText(event.text, routing);
          // Only nudge when the turn produced NO delivery at all. If the
          // agent already sent messages via MCP tools this segment, the
          // bare final text is a summary/scratchpad — nudging would make
          // the agent re-send and the user would get duplicates.
          const alreadySentThisTurn = countChatSendsSince(promptSeqMark) > 0;
          if (hasUnwrapped && !alreadySentThisTurn && !unwrappedNudged) {
            unwrappedNudged = true;
            const destinations = getAllDestinations();
            const names = destinations.map((d) => d.name).join(', ');
            query.push(
              `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
                `Your destinations: ${names}. ` +
                `Please re-send your response with the correct wrapping.</system>`,
            );
          }
        }
      }
    }
  } finally {
    done = true;
    clearInterval(pollHandle);
  }

  return { continuation: queryContinuation };
}

/**
 * Send the proactive "approaching quota" heads-up at most once per plan
 * window. Fires when reported utilization crosses the configured threshold
 * (default 90%) or the SDK itself flags the window as warning. The window's
 * reset timestamp is the de-dup key, so a fresh window re-arms the warning.
 *
 * Exported for tests.
 */
export function maybeWarnApproachingQuota(
  event: { utilization?: number; warning?: boolean; resetsAt?: number | null; window?: string },
  routing: RoutingContext,
  hasFallback: boolean,
): void {
  // Only the 5-hour SESSION window maps to the "about to run out and switch to
  // Codex" experience — it's the window whose exhaustion produces "You've hit
  // your session limit". The 7-day / per-model weekly windows are a slower,
  // separate budget; warning on them produced confusing false alarms (observed
  // live: a longer window at 95% firing while the session window was nearly
  // empty, so the user was genuinely far from the limit that matters).
  if (event.window !== 'five_hour') return;

  const threshold = quotaWarnThresholdPct();
  // Utilization is a straight 0-100 percentage (confirmed live: a 1% window
  // reports `1`). Do NOT rescale — an earlier 0-1 "fraction guard" turned a
  // genuine `1` (1%) into 100% and false-alarmed.
  const pct = event.utilization;

  // Require a real utilization reading at/over the threshold. The SDK's
  // `allowed_warning` status is NOT a trigger on its own — observed firing on
  // the seven_day window at 1% utilization, which would spam a bogus warning.
  if (pct === undefined || pct < threshold) return;

  // One warning per window: key on the reset timestamp so the key naturally
  // changes each new session window and re-arms the warning.
  const windowKey = event.resetsAt != null ? `r:${event.resetsAt}` : 'five_hour';
  if (getQuotaWarnedWindow() === windowKey) return;
  setQuotaWarnedWindow(windowKey);

  const pctText = `${Math.round(pct)}%`;
  log(`Approaching quota (${pctText}, five_hour window ${windowKey}) — sending one-time heads-up`);
  writeNotice(routing, nearQuotaNotice(pctText, hasFallback));
}

/**
 * Rotation guard for the FALLBACK provider's thread. The outer-loop rotation
 * only watches the PRIMARY provider, and codex's own mid-stream rotation
 * needs a long-lived query — fallback turns are one-shot. Without this the
 * fallback thread grew unboundedly (observed live 2026-07-28: 475k tokens,
 * 3× the ceiling) and every resume wedged into the 180s idle abort.
 *
 * Exported for tests.
 */
export function rotateFallbackThreadIfOversized(providerName: string, rotateTokens: number): void {
  const tokens = getThreadTokens(providerName);
  if (tokens >= rotateTokens && getContinuation(providerName) !== undefined) {
    log(`Fallback thread at ${tokens} tokens (>= ${rotateTokens}) — rotating to a fresh thread with recap`);
    clearContinuation(providerName);
    clearThreadTokens(providerName);
  }
}

/** Write a short system notice to the turn's origin destination. */
function writeNotice(routing: RoutingContext, text: string): void {
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text }),
  });
}

/**
 * Run a single turn on the fallback provider: retry the unanswered prompt,
 * dispatch the result, persist the fallback's own continuation (kept in its
 * own per-provider slot so the fallback conversation also has memory), and
 * close the query so the outer loop returns to the primary provider on the
 * next batch.
 *
 * Resilience: the first attempt resumes the stored fallback thread (so the
 * fallback conversation keeps its memory). If that attempt fails for any
 * reason other than the fallback's own quota, the stored thread is presumed
 * poisoned (the live failure mode: a resume that wedges) — it is cleared and
 * the SAME turn is retried once on a fresh thread before giving up. The user
 * only sees ❌ if the fresh attempt also fails.
 *
 * Exported for tests.
 */
export async function runFallbackTurn(
  fallback: { provider: AgentProvider; providerName: string },
  prompt: string,
  routing: RoutingContext,
  cwd: string,
  systemContext?: { instructions?: string },
): Promise<void> {
  const stored = getContinuation(fallback.providerName);
  try {
    await fallbackAttempt(fallback, prompt, routing, cwd, systemContext, stored);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Quota on the fallback itself: retrying won't help, and the thread is
    // fine — keep its memory for when credit returns.
    if (stored === undefined || /quota exhausted/i.test(msg)) throw err;
    log(`Fallback attempt on stored thread failed (${msg}) — clearing thread, retrying once fresh`);
    clearContinuation(fallback.providerName);
    await fallbackAttempt(fallback, prompt, routing, cwd, systemContext, undefined);
  }
}

/** One fallback attempt against a specific continuation (or a fresh thread). */
async function fallbackAttempt(
  fallback: { provider: AgentProvider; providerName: string },
  prompt: string,
  routing: RoutingContext,
  cwd: string,
  systemContext: { instructions?: string } | undefined,
  continuation: string | undefined,
): Promise<void> {
  const promptSeqMark = getMaxOutSeq();
  const query = fallback.provider.query({ prompt, continuation, cwd, systemContext });

  let nudged = false;
  let gotResult = false;
  // Liveness guards (see the comment block at the timeout functions above):
  // idle timer trips on prolonged SILENCE — the signature of a wedged
  // resume/init — while a genuinely working turn streams events and stays
  // alive. The absolute cap is a generous backstop. abort() tears down the
  // provider process, so a stuck await rejects immediately and the primary
  // path recovers on the next turn instead of the whole poll-loop freezing.
  let timedOut: string | null = null;
  const idleMs = fallbackIdleTimeoutMs();
  const capMs = fallbackTurnDeadlineMs();
  let lastEventAt = Date.now();
  const idleTimer = setInterval(
    () => {
      if (timedOut) return; // already aborted — don't re-log every tick
      if (Date.now() - lastEventAt >= idleMs) {
        timedOut = `no events for ${idleMs}ms`;
        log(`Fallback turn stalled (${timedOut}) — aborting`);
        query.abort();
      }
    },
    Math.min(Math.max(idleMs / 4, 50), 5_000),
  );
  const capTimer = setTimeout(() => {
    timedOut = `exceeded ${capMs}ms deadline`;
    log(`Fallback turn ${timedOut} — aborting`);
    query.abort();
  }, capMs);
  try {
    try {
      for await (const event of query.events) {
        lastEventAt = Date.now();
        touchHeartbeat();
        if (event.type === 'init') {
          setContinuation(fallback.providerName, event.continuation);
        } else if (event.type === 'error' && event.classification === 'quota') {
          query.abort();
          throw new Error(`Fallback provider quota exhausted: ${event.message}`);
        } else if (event.type === 'result') {
          gotResult = true;
          if (event.text) {
            const { hasUnwrapped } = dispatchResultText(event.text, routing);
            const alreadySentThisTurn = countChatSendsSince(promptSeqMark) > 0;
            if (hasUnwrapped && !alreadySentThisTurn && !nudged) {
              // Same one-shot re-wrap nudge as the primary path — give the
              // fallback one chance to deliver, then close regardless.
              nudged = true;
              gotResult = false;
              const names = getAllDestinations()
                .map((d) => d.name)
                .join(', ');
              query.push(
                `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                  `Your destinations: ${names}. Please re-send your response with the correct wrapping.</system>`,
              );
              continue;
            }
          }
          // Turn answered — close the stream so control returns to the
          // primary provider for the next batch.
          query.end();
        }
      }
    } catch (err) {
      // A stream error AFTER the answer was delivered (e.g. codex's
      // post-turn housekeeping — a hung thread/compact request — rejecting
      // out of the generator) must not fail the turn: the user already has
      // their reply, and failing here sent a bogus ❌ "backup engine failed"
      // banner right after a successful answer (observed live 2026-07-28).
      if (!gotResult) throw err;
      log(
        `Fallback stream errored after result was delivered (${err instanceof Error ? err.message : String(err)}) — treating turn as answered`,
      );
    }
  } finally {
    clearInterval(idleTimer);
    clearTimeout(capTimer);
    if (!gotResult) query.abort();
  }
  if (timedOut) {
    throw new Error(`Fallback provider timed out: ${timedOut}`);
  }
  if (!gotResult) {
    throw new Error('Fallback provider produced no result');
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
    case 'quota_status':
      log(
        `Quota status: ${event.utilization !== undefined ? `${Math.round(event.utilization)}%` : 'n/a'}` +
          `${event.warning ? ' (warning)' : ''}${event.window ? ` [${event.window}]` : ''}`,
      );
      break;
  }
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 */
function dispatchResultText(text: string, routing: RoutingContext): { sent: number; hasUnwrapped: boolean } {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  const hasUnwrapped = sent === 0 && !!scratchpad;
  if (hasUnwrapped) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
  return { sent, hasUnwrapped };
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  const content = JSON.stringify({ text: body });

  // Duplicate sends (same text already sent via the send_message MCP tool
  // this turn) are suppressed centrally in writeMessageOut — see
  // findRecentDuplicateSeq in db/messages-out.ts.

  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId);
  writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content,
  });
}

/**
 * Find the thread_id and message id from the most recent inbound message
 * matching the given channel+platform. Returns null if no match found.
 */
function resolveDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  try {
    const db = getInboundDb();
    const row = db
      .prepare(
        `SELECT thread_id, id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { thread_id: string | null; id: string } | undefined;
    if (row) return { threadId: row.thread_id, inReplyTo: row.id };
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
