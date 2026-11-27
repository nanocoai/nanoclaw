/**
 * Turn-lifecycle hook registry for the poll loop.
 *
 * A module calls `registerTurnHook()` at top level and is imported from the
 * capability barrel (`modules/index.ts`) for its side effect. Every hook point
 * is optional; with nothing registered the poll loop behaves exactly as it
 * does without this file.
 *
 * Hook points, in the order a turn reaches them:
 *
 * - `beforeTurn(ctx)` — the batch is claimed and past pre-task scripts, not
 *   yet formatted. Runs for the opening batch and for follow-ups pushed into
 *   a live query (`ctx.followUp`). Hooks may rewrite rows in `ctx.messages`
 *   in place (e.g. enrich an attachment); every claimed row is still acked
 *   with its batch.
 * - `prepareQuery(input, ctx)` — opening batch only, right before
 *   `provider.query()`. Return a replacement `QueryInput` or nothing to keep
 *   the current one.
 * - `onProviderEvent(event, routing)` — every provider event, after the loop
 *   has handled it. Observational and fire-and-forget: never awaited, so a
 *   slow hook cannot stall the stream. `routing` is the turn being answered.
 * - `onError(err, ctx)` — the query threw. Runs before continuation recovery.
 *
 * Hooks run in registration order. A hook that throws (or rejects) is logged
 * and skipped; it never breaks the turn or the hooks after it.
 */
import type { MessageInRow } from './db/messages-in.js';
import type { RoutingContext } from './formatter.js';
import type { ProviderEvent, QueryInput } from './providers/types.js';

export interface TurnContext {
  /** Rows about to be formatted into the prompt. */
  messages: MessageInRow[];
  routing: RoutingContext;
  /** True when the rows are pushed into an already-running query. */
  followUp: boolean;
}

export interface TurnHook {
  name: string;
  beforeTurn?(ctx: TurnContext): void | Promise<void>;
  prepareQuery?(input: QueryInput, ctx: TurnContext): QueryInput | void | Promise<QueryInput | void>;
  onProviderEvent?(event: ProviderEvent, routing: RoutingContext): void | Promise<void>;
  onError?(err: unknown, ctx: TurnContext): void | Promise<void>;
}

const hooks: TurnHook[] = [];

function log(msg: string): void {
  console.error(`[turn-hooks] ${msg}`);
}

function logFailure(hook: TurnHook, point: string, err: unknown): void {
  log(`${hook.name}.${point} failed: ${err instanceof Error ? err.message : String(err)}`);
}

/** Register a hook. Returns a function that unregisters it. */
export function registerTurnHook(hook: TurnHook): () => void {
  if (hooks.some((h) => h.name === hook.name)) {
    throw new Error(`Turn hook already registered: ${hook.name}`);
  }
  hooks.push(hook);
  return () => {
    const index = hooks.indexOf(hook);
    if (index !== -1) hooks.splice(index, 1);
  };
}

export async function runBeforeTurn(ctx: TurnContext): Promise<void> {
  for (const hook of [...hooks]) {
    if (!hook.beforeTurn) continue;
    try {
      await hook.beforeTurn(ctx);
    } catch (err) {
      logFailure(hook, 'beforeTurn', err);
    }
  }
}

export async function runPrepareQuery(input: QueryInput, ctx: TurnContext): Promise<QueryInput> {
  let current = input;
  for (const hook of [...hooks]) {
    if (!hook.prepareQuery) continue;
    try {
      current = (await hook.prepareQuery(current, ctx)) ?? current;
    } catch (err) {
      logFailure(hook, 'prepareQuery', err);
    }
  }
  return current;
}

export function runProviderEvent(event: ProviderEvent, routing: RoutingContext): void {
  for (const hook of [...hooks]) {
    if (!hook.onProviderEvent) continue;
    try {
      const pending = hook.onProviderEvent(event, routing);
      if (pending) pending.catch((err: unknown) => logFailure(hook, 'onProviderEvent', err));
    } catch (err) {
      logFailure(hook, 'onProviderEvent', err);
    }
  }
}

export async function runOnError(err: unknown, ctx: TurnContext): Promise<void> {
  for (const hook of [...hooks]) {
    if (!hook.onError) continue;
    try {
      await hook.onError(err, ctx);
    } catch (hookErr) {
      logFailure(hook, 'onError', hookErr);
    }
  }
}
