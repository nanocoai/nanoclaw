/**
 * Startup-hook registry (ADR 0006 contract #1) — INERT on pristine core.
 *
 * The composition root (`src/index.ts`) is a thin orchestrator. Install-overlays
 * (e.g. /add-taskflow) that need to run extra boot steps register a startup hook
 * here instead of editing `index.ts` inline. `index.ts` drains two named phases:
 *
 *   - `'post-db'`     — after central DB init + migrations + container-config
 *                       backfill, BEFORE container runtime / channel adapters /
 *                       delivery polls. Use for one-time DB bootstrap/migrations
 *                       and for state that MUST exist before delivery starts
 *                       (e.g. the TaskFlow service session whose outbound.db the
 *                       sweep drains).
 *   - `'post-services'` — after delivery polls + host sweep are running, BEFORE
 *                       the CLI socket server. Use for background feeders/timers
 *                       that depend on the rest of the host being up.
 *
 * Core ships with an EMPTY registry: `runStartupPhase(phase, ctx)` is a no-op for
 * both phases, so pristine upstream boots with only the default orchestration. An
 * overlay adds a hook by creating a module with a top-level
 * `registerStartupHook(...)` call and appending `import './<mod>.js';` to its
 * module barrel (which `index.ts` already imports for side effects via
 * `src/modules/index.js`).
 *
 * Ordering + failure semantics:
 *   - Within a phase, hooks run sorted by ascending `order` (default 100), then by
 *     registration order for ties. This is sequential and deterministic.
 *   - A hook may be async; the phase `await`s each hook before the next.
 *   - `critical: true` ⇒ a throw RE-THROWS and aborts startup (fail-loud). Used for
 *     invariants the rest of boot depends on (the TaskFlow service session must
 *     exist before the delivery polls start, or FastAPI-originated rows have no
 *     drain). `critical: false` (default) ⇒ a throw is logged and skipped so a
 *     best-effort feeder can't take down the host.
 *
 * Keep this file dependency-light (only `log.js`). It must not import from
 * modules/* or index.ts (registry-before-registration ordering + no cycles).
 */
import { log } from './log.js';

export type StartupPhase = 'post-db' | 'post-services';

/**
 * Context handed to every startup hook. Intentionally minimal — hooks that need
 * to register a shutdown callback import `onShutdown` from `response-registry.js`
 * directly (same as the inline blocks did).
 */
export interface StartupContext {
  /** `DATA_DIR` — root for host-owned shared DBs (v2.db, taskflow, embeddings). */
  dataDir: string;
}

export type StartupHookFn = (ctx: StartupContext) => void | Promise<void>;

export interface StartupHookOptions {
  /** Lower runs first within the phase. Default 100. */
  order?: number;
  /** When true, a throw aborts startup instead of being logged + skipped. */
  critical?: boolean;
}

interface StartupHook {
  phase: StartupPhase;
  name: string;
  fn: StartupHookFn;
  order: number;
  critical: boolean;
}

const startupHooks: StartupHook[] = [];

export function registerStartupHook(
  phase: StartupPhase,
  name: string,
  fn: StartupHookFn,
  opts: StartupHookOptions = {},
): void {
  if (startupHooks.some((h) => h.phase === phase && h.name === name)) {
    throw new Error(`Startup hook already registered: ${phase}/${name}`);
  }
  startupHooks.push({
    phase,
    name,
    fn,
    order: opts.order ?? 100,
    critical: opts.critical ?? false,
  });
}

/** Test/introspection helper — registered hooks for a phase in run order. */
export function getStartupHooks(
  phase: StartupPhase,
): ReadonlyArray<{ name: string; order: number; critical: boolean }> {
  return startupHooks
    .filter((h) => h.phase === phase)
    .sort((a, b) => a.order - b.order)
    .map(({ name, order, critical }) => ({ name, order, critical }));
}

/**
 * Run every hook registered for `phase`, in ascending `order` then registration
 * order. No-op on pristine core (no hooks). A non-critical hook that throws is
 * logged and skipped; a critical hook that throws re-throws (fail-loud) so
 * `main()` aborts before the host is declared running.
 */
export async function runStartupPhase(phase: StartupPhase, ctx: StartupContext): Promise<void> {
  const hooks = startupHooks.filter((h) => h.phase === phase).sort((a, b) => a.order - b.order);
  for (const hook of hooks) {
    try {
      await hook.fn(ctx);
    } catch (err) {
      if (hook.critical) {
        log.fatal('Critical startup hook failed', { phase, name: hook.name, err });
        throw err;
      }
      log.error('Startup hook threw (skipped)', { phase, name: hook.name, err });
    }
  }
}
