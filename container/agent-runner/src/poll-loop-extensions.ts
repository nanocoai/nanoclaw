// Generic poll-loop extension seam (Route-C hook). INERT on pristine core: with
// no registrant, every apply* returns its input unchanged, so the poll loop
// behaves byte-identically to upstream. An overlay may register hooks that
// transform the pending-message batch or the turn lifecycle. This module holds
// the poll-loop registries (one per extraction); each is independently inert.
//
// First registry (cluster 5, #387 runner-gating): a message filter applied to
// the pending batch right after it is read from getPendingMessages — e.g. a
// state-gated suppression of scheduled-runner (standup/digest/review) messages
// when the board is idle/stale. Composed left-to-right in registration order.
import type { MessageInRow } from './db/messages-in.js';
import type { RoutingContext } from './formatter.js';

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

// Second registry (cluster 4): a prompt transform applied to the formatted turn
// prompt right before provider.query — e.g. prepend an embedding-ranked board
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

// Third registry (cluster 7, #407): a prefilter side-effect run over the freshly
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

// Fourth registry (clusters 2/3 + 6): turn lifecycle hooks. registerTurnStart runs
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

// Fifth registry (M4 turn-interceptor — the WOVEN trio: web-origin fail-closed,
// confined-external, actor-domain split). Unlike the transform/side-effect seams
// above, an interceptor has CONTROL-FLOW AUTHORITY over the turn, expressed as a
// returned decision the poll loop interprets. Registration order is load-bearing
// (web → external → split); a terminal `handled` short-circuits later interceptors.
// No registrant ⇒ applyTurnInterceptor returns {handled:undefined, keep, routing,
// deferIds:[]} — byte-identical upstream control flow.
export interface TurnInterceptorCtx {
  /** Post-filter wake batch (kind!=='system' removed, message-filter applied,
   *  markProcessing already called on all ids). */
  readonly keep: MessageInRow[];
  /** RAW pre-filter batch incl kind==='system' rows — needed for a fail-closed
   *  check on a co-batched system row (confined-external). */
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
  // + continue (no normal query). Terminal — SEC-critical.
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

const turnInterceptors: TurnInterceptor[] = [];

export function registerTurnInterceptor(fn: TurnInterceptor): void {
  turnInterceptors.push(fn);
}

/**
 * Fold the interceptors in registration order, threading keep/routing/deferIds.
 * `rewrite` updates threaded state; `defer` accumulates ids + narrows keep;
 * `handled` is TERMINAL (returns immediately, later interceptors do not run).
 * No registrant ⇒ {handled:undefined, keep:input, routing, deferIds:[]} (inert).
 */
export async function applyTurnInterceptor(ctx: TurnInterceptorCtx): Promise<TurnInterceptorResult> {
  let keep = ctx.keep;
  let routing = ctx.routing;
  const deferIds: string[] = [];
  for (const fn of turnInterceptors) {
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

export function __resetTurnInterceptorForTest(): void {
  turnInterceptors.length = 0;
}
