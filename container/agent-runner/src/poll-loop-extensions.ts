// Generic poll-loop extension seam. INERT with no registrant: with
// no registrant, every apply* returns its input unchanged, so the poll loop
// behaves byte-identically to upstream. A downstream overlay may register hooks
// that transform the pending-message batch or the turn lifecycle. This module
// holds the poll-loop registries (one per extraction); each is independently inert.
//
// First registry (runner-gating): a message filter applied to
// the pending batch right after it is read from getPendingMessages — e.g. a
// state-gated suppression of scheduled-runner (recurring job) messages
// when the conversation is idle/stale. Composed left-to-right in registration order.
import type { MessageInRow } from './db/messages-in.js';
import type { RoutingContext } from './formatter.js';
import type { AgentProvider } from './providers/types.js';

export type MessageFilter = (messages: MessageInRow[]) => MessageInRow[];

const messageFilters: MessageFilter[] = [];

export function registerMessageFilter(fn: MessageFilter): void {
  messageFilters.push(fn);
}

/** Left-fold over registrants. No registrant ⇒ returns `messages` unchanged. */
export function applyMessageFilter(messages: MessageInRow[]): MessageInRow[] {
  return messageFilters.reduce((acc, fn) => fn(acc), messages);
}

export function __resetMessageFilterForTest(): void {
  messageFilters.length = 0;
}

// Second registry: a prompt transform applied to the formatted turn
// prompt right before provider.query — e.g. prepend an embedding-ranked
// context preamble. Async + composed left-to-right; no registrant ⇒ the prompt
// is returned unchanged.
export type PromptTransform = (prompt: string, messages: MessageInRow[]) => Promise<string> | string;

const promptTransforms: PromptTransform[] = [];

export function registerPromptTransform(fn: PromptTransform): void {
  promptTransforms.push(fn);
}

/** Left-fold over registrants. No registrant ⇒ resolves to `prompt` unchanged. */
export async function applyPromptTransform(prompt: string, messages: MessageInRow[]): Promise<string> {
  let current = prompt;
  for (const fn of promptTransforms) current = await fn(current, messages);
  return current;
}

export function __resetPromptTransformForTest(): void {
  promptTransforms.length = 0;
}

// Third registry: a prefilter side-effect run over the freshly
// read pending batch BEFORE the kind!=='system' filter — e.g. replay approved
// actions. Hooks run in order; no registrant ⇒ no-op. Side-effect only (void).
export type PrefilterStep = (messages: MessageInRow[]) => Promise<void> | void;

const prefilterSteps: PrefilterStep[] = [];

export function registerPrefilterStep(fn: PrefilterStep): void {
  prefilterSteps.push(fn);
}

/** Run each registrant over the batch in order. No registrant ⇒ no-op. */
export async function applyPrefilterSteps(messages: MessageInRow[]): Promise<void> {
  for (const fn of prefilterSteps) await fn(messages);
}

export function __resetPrefilterStepsForTest(): void {
  prefilterSteps.length = 0;
}

// Idle-iteration side-effect hook: runs at an early `continue` where the loop takes NO agent
// turn this iteration — an empty wake batch, or an accumulate-only (trigger=0) batch. Those branches
// sleep+continue without reaching the turn body or turn-end, so a per-turn drain never fires for a
// conversation that stays idle / keeps receiving context-only messages. An overlay may register a
// deferred cross-conversation notification drain here. Side-effect only (void); hooks run in order.
// No registrant ⇒ no-op ⇒ byte-identical upstream (an awaited empty loop).
export type IdleStep = () => void | Promise<void>;

const idleSteps: IdleStep[] = [];

export function registerIdleStep(fn: IdleStep): void {
  idleSteps.push(fn);
}

/** Run each idle hook in order at a no-turn early-continue. No registrant ⇒ no-op. */
export async function applyIdleSteps(): Promise<void> {
  for (const fn of idleSteps) await fn();
}

export function __resetIdleStepsForTest(): void {
  idleSteps.length = 0;
}

// Fourth registry: turn lifecycle hooks. registerTurnStart runs
// just before provider.query with the batch (e.g. pin the per-turn actor channel
// for anti-spoof binding); registerTurnEnd runs after the turn completes (e.g.
// clear the actor channel + drain deferred notifications). No registrant ⇒ no-op.
export type TurnStartHook = (messages: MessageInRow[]) => void;
export type TurnEndHook = () => void | Promise<void>;

const turnStartHooks: TurnStartHook[] = [];
const turnEndHooks: TurnEndHook[] = [];

export function registerTurnStart(fn: TurnStartHook): void {
  turnStartHooks.push(fn);
}

export function registerTurnEnd(fn: TurnEndHook): void {
  turnEndHooks.push(fn);
}

/** Run turn-start hooks in order. No registrant ⇒ no-op. */
export function applyTurnStart(messages: MessageInRow[]): void {
  for (const fn of turnStartHooks) fn(messages);
}

/** Run turn-end hooks in order. No registrant ⇒ no-op. */
export async function applyTurnEnd(): Promise<void> {
  for (const fn of turnEndHooks) await fn();
}

export function __resetTurnHooksForTest(): void {
  turnStartHooks.length = 0;
  turnEndHooks.length = 0;
}

// Run-start hook (the turn-interceptor group's REGISTRATION keystone). The interceptor /
// follow-up / post-reconcile registrants below are PER-RUN, config-bound: a
// confined-external interceptor closes over `config.provider` (the confined provider
// is overlay-owned — ADR-0002 — and the seam ctx deliberately never exposes it), and
// per-turn routing re-derivation needs `config.assistantName`/`agentGroupId`. The other
// seams self-register at module load (config-free); these cannot. So an overlay
// registers ONE run-start hook at module load, and the base calls applyRunStart(config)
// ONCE at the top of each runPollLoop — the hook then production-resets its own
// registrants and re-registers them bound to THIS run's config. Running it per-run (not
// per-poll) means a 2nd runPollLoop in the same process rebinds cleanly instead of
// appending a 2nd stale-config interceptor whose terminal `handled` would win first.
// No registrant ⇒ no-op ⇒ byte-identical upstream.
export interface RunStartConfig {
  provider: AgentProvider;
  providerName: string;
  cwd: string;
  assistantName?: string;
  agentGroupId?: string;
}

export type RunStartHook = (config: RunStartConfig) => void;

const runStartHooks: RunStartHook[] = [];

export function registerRunStart(fn: RunStartHook): void {
  runStartHooks.push(fn);
}

/** Run each registrant once with this run's config, in order. No registrant ⇒ no-op. */
export function applyRunStart(config: RunStartConfig): void {
  for (const fn of runStartHooks) fn(config);
}

export function __resetRunStartForTest(): void {
  runStartHooks.length = 0;
}

// Result-dispatch REPLACEMENT seam. Unlike the transform/fold seams, the agent's final-text
// dispatch (parse `<message to="...">` blocks → deliver each) is a whole-function concern an
// overlay may need to REPLACE wholesale — e.g. to add model-final send-gating (deny an agent
// exfiltrating via `<message to="other-conversation">`), same-turn mutation-card dedup, or to
// confine an external turn's reply to its originating conversation. So this seam is a REPLACE,
// not a fold: if an overlay
// registers a dispatcher, the loop calls it INSTEAD of the base dispatch; the last registrant wins
// (a config-free overlay registers exactly one at module load). The dispatcher must honor the base
// contract — return {sent, hasUnwrapped} — so the unwrapped-nudge retry + ack status are unchanged.
// No registrant ⇒ applyResultDispatch returns null ⇒ the caller falls back to the base dispatch ⇒
// byte-identical upstream.
export interface ResultDispatchOutcome {
  /** Number of `<message>` blocks actually delivered. */
  sent: number;
  /** True when the agent produced no deliverable block (sent===0) but non-empty scratchpad —
   *  drives the base's one-shot re-wrap nudge + the 'undelivered' ack status. */
  hasUnwrapped: boolean;
}

export type ResultDispatcher = (text: string, routing: RoutingContext) => ResultDispatchOutcome;

const resultDispatchers: ResultDispatcher[] = [];

export function registerResultDispatch(fn: ResultDispatcher): void {
  resultDispatchers.push(fn);
}

/** Last registrant wins (replace, not fold). No registrant ⇒ null ⇒ caller uses the base dispatch. */
export function applyResultDispatch(text: string, routing: RoutingContext): ResultDispatchOutcome | null {
  if (resultDispatchers.length === 0) return null;
  return resultDispatchers[resultDispatchers.length - 1](text, routing);
}

export function __resetResultDispatchForTest(): void {
  resultDispatchers.length = 0;
}

// Fifth registry (turn-interceptor — a group of cooperating interceptors: a
// routing-context fail-closed check, a confined-external check, a routing-domain split).
// Unlike the transform/side-effect seams above, an interceptor has CONTROL-FLOW
// AUTHORITY over the turn, expressed as a returned decision the poll loop interprets.
// Registration order is load-bearing (routing-check → external → split); a terminal
// `handled` short-circuits later interceptors. No registrant ⇒ applyTurnInterceptor
// returns {handled:undefined, keep, routing, deferIds:[]} — byte-identical upstream control flow.
export interface TurnInterceptorCtx {
  /** Post-filter wake batch (kind!=='system' removed, message-filter applied,
   *  markProcessing already called on all ids). */
  readonly keep: MessageInRow[];
  /** RAW pre-filter batch incl kind==='system' rows — needed for a fail-closed
   *  check on a co-scheduled system row (confined-external). */
  readonly allPending: MessageInRow[];
  /** Loop-local routing as derived from `keep`. */
  readonly routing: RoutingContext;
  readonly isFirstPoll: boolean;
  readonly assistantName?: string;
  readonly agentGroupId?: string;
}

export type TurnDecision =
  | { kind: 'proceed' }
  // Rewrite loop-local state; omitted field ⇒ unchanged. The registrant re-derives
  // routing off its new keep.
  | { kind: 'rewrite'; keep?: MessageInRow[]; routing?: RoutingContext }
  // Exclude rows from THIS turn, leave them PENDING (caller un-marks). deferIds ⊆ ids.
  | { kind: 'defer'; deferIds: string[]; routing?: RoutingContext }
  // MODEL-BYPASS: registrant fully handled/drained the batch; caller markCompleted
  // + continue (no normal query). Terminal — security-critical.
  | { kind: 'handled'; completedIds: string[] };

export type TurnInterceptor = (ctx: TurnInterceptorCtx) => Promise<TurnDecision> | TurnDecision;

export interface TurnInterceptorResult {
  /** handled ⇒ caller markCompleted(completedIds) + continue; else proceed with
   *  the (possibly rewritten/narrowed) keep + routing, un-marking deferIds. */
  handled?: { completedIds: string[] };
  keep: MessageInRow[];
  routing: RoutingContext;
  deferIds: string[];
}

// TWO interceptor SITES, each its own registry but sharing the fold + reconcileTurn.
// SITE 1 (turnInterceptors) runs BEFORE the command loop + pre-task scripts — for the
//   EARLY drains: a routing-context fail-closed check + confined-external (both terminate
//   the turn early, so they belong before anything reads/gates the batch).
// SITE 2 (postTaskInterceptors) runs AFTER pre-task gating, on the narrowed `keep` — for
//   decisions that must see the post-pre-task batch: a routing-domain
//   split (defer co-scheduled system rows + rewrite routing) and, later, a deterministic fast-path.
// Registering the split at SITE 1 would fire it on batches a pre-task script would have
// gated and re-derive routing off the wrong (wider) keep — hence the second site.
const turnInterceptors: TurnInterceptor[] = [];
const postTaskInterceptors: TurnInterceptor[] = [];

export function registerTurnInterceptor(fn: TurnInterceptor): void {
  turnInterceptors.push(fn);
}

export function registerPostTaskInterceptor(fn: TurnInterceptor): void {
  postTaskInterceptors.push(fn);
}

/**
 * Fold the interceptors in registration order, threading keep/routing/deferIds.
 * `rewrite` updates threaded state; `defer` accumulates ids + narrows keep;
 * `handled` is TERMINAL (returns immediately, later interceptors do not run).
 * No registrant ⇒ {handled:undefined, keep:input, routing, deferIds:[]} (inert).
 */
async function foldInterceptors(
  list: TurnInterceptor[],
  ctx: TurnInterceptorCtx,
): Promise<TurnInterceptorResult> {
  let keep = ctx.keep;
  let routing = ctx.routing;
  const deferIds: string[] = [];
  for (const fn of list) {
    const decision = await fn({ ...ctx, keep, routing });
    if (decision.kind === 'handled') {
      return { handled: { completedIds: decision.completedIds }, keep, routing, deferIds };
    }
    if (decision.kind === 'rewrite') {
      if (decision.keep !== undefined) keep = decision.keep;
      if (decision.routing !== undefined) routing = decision.routing;
    } else if (decision.kind === 'defer') {
      const deferSet = new Set(decision.deferIds);
      for (const id of decision.deferIds) if (!deferIds.includes(id)) deferIds.push(id);
      keep = keep.filter((m) => !deferSet.has(m.id));
      if (decision.routing !== undefined) routing = decision.routing;
    }
    // 'proceed' ⇒ no change.
  }
  return { keep, routing, deferIds };
}

/** SITE 1 — pre-command interceptors (routing-context check / confined-external). Reconcile the
 *  result against the full owned batch via reconcileTurn at the call site. Inert ⇒ identity. */
export async function applyTurnInterceptor(ctx: TurnInterceptorCtx): Promise<TurnInterceptorResult> {
  return foldInterceptors(turnInterceptors, ctx);
}

/** SITE 2 — post-pre-task interceptors (routing-domain split; later a deterministic fast-path). Same
 *  fold; the call site reconciles against the post-pre-task `keep` owned set. Inert ⇒ identity. */
export async function applyPostTaskInterceptor(ctx: TurnInterceptorCtx): Promise<TurnInterceptorResult> {
  return foldInterceptors(postTaskInterceptors, ctx);
}

export function __resetTurnInterceptorForTest(): void {
  turnInterceptors.length = 0;
}

export function __resetPostTaskInterceptorForTest(): void {
  postTaskInterceptors.length = 0;
}

export interface ReconciledTurn {
  /** True when a registrant returned a terminal `handled` (model-bypass). */
  handled: boolean;
  /** The working batch for this turn — the interceptor `keep`, clamped to OWNED
   *  rows. Empty when handled (the turn is over). */
  keep: MessageInRow[];
  /** Rows the registrant drained, to markCompleted (handled path only). */
  completedIds: string[];
  /** Rows to un-mark back to pending (explicit defers + auto-deferred unaccounted). */
  deferIds: string[];
  /** Owned ids the registrant dropped WITHOUT defer/complete — auto-deferred here so
   *  they are re-read next poll rather than orphaned in 'processing'. Non-empty ⇒ a
   *  registrant bug; the caller should fail-loud log it. */
  unaccounted: string[];
}

/**
 * Reconcile an interceptor result against the OWNED (already markProcessing'd) id set
 * so no row can leak past the model-bypass surface. This is the security chokepoint: the
 * fold itself accepts whatever a registrant returns, so the partition is enforced HERE,
 * not trusted. Guarantees, for the original owned set:
 *   - every owned id ends as exactly ONE of: kept (processed this turn) | completed
 *     (handled-drained) | deferred (un-marked → re-read next poll);
 *   - defer/complete ids OUTSIDE the owned set are dropped — a registrant must never
 *     touch a row it doesn't own (deferProcessing blindly DELETEs an ack and could
 *     resurrect an already-completed row; markCompleted could consume a foreign row);
 *   - defer loses to keep AND to completed (a row about to be processed or already
 *     drained is never also un-marked — prevents completed-while-deferred / a deferred
 *     row leaking back into the live batch via a later rewrite);
 *   - any owned id the registrant silently dropped is AUTO-DEFERRED (fail-safe:
 *     at-least-once + visible, never silently lost).
 */
export function reconcileTurn(ownedIds: string[], result: TurnInterceptorResult): ReconciledTurn {
  const owned = new Set(ownedIds);

  if (result.handled) {
    const completedIds = result.handled.completedIds.filter((id) => owned.has(id));
    const completedSet = new Set(completedIds);
    const deferSet = new Set(result.deferIds.filter((id) => owned.has(id) && !completedSet.has(id)));
    const accounted = new Set([...completedSet, ...deferSet]);
    const unaccounted = ownedIds.filter((id) => !accounted.has(id));
    for (const id of unaccounted) deferSet.add(id);
    return { handled: true, keep: [], completedIds, deferIds: [...deferSet], unaccounted };
  }

  const keep = result.keep.filter((m) => owned.has(m.id));
  const keepSet = new Set(keep.map((m) => m.id));
  const deferSet = new Set(result.deferIds.filter((id) => owned.has(id) && !keepSet.has(id)));
  const accounted = new Set([...keepSet, ...deferSet]);
  const unaccounted = ownedIds.filter((id) => !accounted.has(id));
  for (const id of unaccounted) deferSet.add(id);
  return { handled: false, keep, completedIds: [], deferIds: [...deferSet], unaccounted };
}

// Post-reconcile hook. A side-effect run AFTER reconcileTurn
// has finalized the turn's surviving batch — narrowed by Site-1 + Site-2 reconcile, command
// handling, and pre-task gating — and BEFORE the provider query, keyed off the FINAL `keep`.
// An overlay uses it to re-derive per-turn loop-local state that must track the queried batch
// EXACTLY, e.g. a per-turn routing key: setting that inside an interceptor body would read the
// interceptor's (wider) keep, which a later reconcile/site can narrow, desyncing the reply's
// route. Re-deriving here keys it off the rows that actually reach the query.
// No registrant ⇒ no-op ⇒ byte-identical upstream.
export type PostReconcileHook = (keep: MessageInRow[]) => void;

const postReconcileHooks: PostReconcileHook[] = [];

export function registerPostReconcile(fn: PostReconcileHook): void {
  postReconcileHooks.push(fn);
}

/** Run each registrant with the finalized surviving batch, in order. No registrant ⇒ no-op. */
export function applyPostReconcile(keep: MessageInRow[]): void {
  for (const fn of postReconcileHooks) fn(keep);
}

export function __resetPostReconcileForTest(): void {
  postReconcileHooks.length = 0;
}

// Follow-up poll seam (the turn-interceptor's cross-turn partner). processQuery's
// inner poll pushes newly-arrived rows INTO the active stream. Two inert hooks let an
// overlay intervene at the two ORDERED points the follow-up logic needs — the
// order is: external-DROP → slash-command(abort, base) → boundary END-STREAM.
//   - DROP runs BEFORE the slash-command abort check: ids to markComplete + withhold from
//     the push (e.g. external-actor rows that belong to a CONFINED turn, not this conversation's
//     stream). Union of registrants; the caller clamps to the current batch.
//   - END-STREAM runs AFTER the slash-command abort check: true ⇒ end() the active query
//     (let the in-flight turn FINISH + deliver) and leave the batch PENDING for the outer
//     loop to re-route (e.g. the batch crosses a routing-domain boundary).
//     NOT abort — abort would discard the in-flight reply (a known regression). OR-fold.
// No registrant ⇒ DROP returns [] and END-STREAM returns false ⇒ the follow-up poll
// behaves byte-identically to upstream.
export interface FollowupCtx {
  /** The freshly-read follow-up batch (pre system-filter) seen by the inner poll. */
  readonly pending: MessageInRow[];
  /** The ACTIVE turn's routing (captured when processQuery started). */
  readonly routing: RoutingContext;
}

export type FollowupDropHook = (ctx: FollowupCtx) => string[];
export type FollowupEndStreamHook = (ctx: FollowupCtx) => boolean;

const followupDropHooks: FollowupDropHook[] = [];
const followupEndStreamHooks: FollowupEndStreamHook[] = [];

export function registerFollowupDrop(fn: FollowupDropHook): void {
  followupDropHooks.push(fn);
}

export function registerFollowupEndStream(fn: FollowupEndStreamHook): void {
  followupEndStreamHooks.push(fn);
}

/** Union of every registrant's drop ids (deduped). No registrant ⇒ []. The CALLER must
 *  clamp to the current batch — a drop hook must never markComplete a row outside it. */
export function applyFollowupDrop(ctx: FollowupCtx): string[] {
  if (followupDropHooks.length === 0) return [];
  const ids = new Set<string>();
  for (const fn of followupDropHooks) for (const id of fn(ctx)) ids.add(id);
  return [...ids];
}

/** OR-fold — any registrant ⇒ end the stream. No registrant ⇒ false (never ends). */
export function applyFollowupEndStream(ctx: FollowupCtx): boolean {
  for (const fn of followupEndStreamHooks) if (fn(ctx)) return true;
  return false;
}

export function __resetFollowupHooksForTest(): void {
  followupDropHooks.length = 0;
  followupEndStreamHooks.length = 0;
}

// Pre-task-script guard. `applyPreTaskScripts` (scheduling/task-script.ts) consults
// each guard for a task message that carries a pre-agent `script` BEFORE writing+executing it; a
// guard returning a reason string SKIPS that task (it lands in `skipped`, so neither the script nor
// the prompt runs). A downstream overlay may register a veto here (a pre-agent script is a
// delayed bash shell-exec primitive that bypasses the Bash/Write/Read denylist; confined scheduled
// tasks may be prompt-only). No registrant ⇒ null ⇒ every scripted task runs exactly as upstream.
export type PreTaskScriptGuard = (msg: MessageInRow) => string | null;

const preTaskScriptGuards: PreTaskScriptGuard[] = [];

export function registerPreTaskScriptGuard(fn: PreTaskScriptGuard): void {
  preTaskScriptGuards.push(fn);
}

/** First guard returning a reason wins (skip that task). No registrant ⇒ null ⇒ run the script. */
export function applyPreTaskScriptGuards(msg: MessageInRow): string | null {
  for (const fn of preTaskScriptGuards) {
    const reason = fn(msg);
    if (reason) return reason;
  }
  return null;
}

export function __resetPreTaskScriptGuardsForTest(): void {
  preTaskScriptGuards.length = 0;
}
