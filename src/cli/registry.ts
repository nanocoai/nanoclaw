/**
 * Command registry — single source of truth for what `ncl` can do.
 *
 * Most commands come from resource modules under `resources/`, which call
 * `registerResource()` (one `register()` per CRUD verb); the top-level `help`
 * command and the per-resource help commands register directly. The barrel
 * `commands/index.ts` imports the resource barrel for its side effects and then
 * registers the help commands, so the registry is populated before the host's
 * CLI server accepts connections.
 */
import { defineGuardedAction, type GuardedAction } from '../guard/index.js';
import { commandGuardSpec } from './guard.js';
import type { CallerContext } from './frame.js';

/**
 * Resources an agent under `cli_scope=group` may touch. Single source —
 * consumed by both dispatch enforcement and `ncl help` filtering, so the
 * agent is never shown a resource the gate would reject (or vice versa).
 */
export const GROUP_SCOPE_RESOURCES = new Set(['groups', 'sessions', 'destinations', 'members', 'tasks']);

export type Access = 'open' | 'approval' | 'hidden';

export type CommandDef<TArgs = unknown, TData = unknown> = {
  name: string;
  description: string;
  access: Access;
  /**
   * Operator-only: rejected for ANY container (agent) caller regardless of
   * cli_scope (even `global`) or approval. For privileged host-boundary ops
   * like mount management — the mount allowlist is the boundary cli_scope
   * itself lives inside, so an agent must never be able to alter it.
   */
  hostOnly?: boolean;
  /**
   * Dotted guard-catalog action name (e.g. `roles.grant`,
   * `groups.config.add-mcp-server`). Set by registerResource from the
   * resource + verb; commands registered directly (help) fall back to
   * `cli.<name>`.
   */
  action?: string;
  /**
   * The group-scope whitelist key. Under `cli_scope: 'group'` the dispatcher
   * only lets an agent run commands whose `resource` is on the whitelist
   * (`groups`, `sessions`, `destinations`, `members`); it also drives help
   * grouping. Omitting `resource` exempts the command from the whitelist —
   * that's how general commands like `help` stay reachable in group scope.
   */
  resource?: string;
  /**
   * Set on the auto-generated `list` / `get` handlers (see `registerResource`).
   * These return raw DB rows that carry the resource's `scopeField`, so the
   * dispatcher applies post-handler group-scope filtering to their output.
   * Custom operations return ad-hoc shapes and leave this undefined.
   */
  generic?: 'list' | 'get';
  /** Validates `frame.args` and produces the typed handler input. Throws on invalid. */
  parseArgs: (raw: Record<string, unknown>) => TArgs;
  handler: (args: TArgs, ctx: CallerContext) => Promise<TData>;
  /**
   * Optional presentational renderer. When set, dispatch attaches its output
   * as the response frame's `human` field (server-rendered once, printed
   * verbatim by every client in human mode). Runs after post-handler scope
   * filtering, so it only ever sees data the caller is allowed to see. A
   * throwing formatter is ignored — clients fall back to rendering `data`.
   */
  formatHuman?: (data: TData) => string;
};

const registry = new Map<string, CommandDef>();
const commandGuards = new Map<string, GuardedAction>();

export function register<TArgs, TData>(def: CommandDef<TArgs, TData>): void {
  if (registry.has(def.name)) {
    throw new Error(`CLI command "${def.name}" already registered`);
  }
  registry.set(def.name, def as CommandDef);
  // Declaration is registration: every command gets a guard-catalog entry
  // derived from its own definition, in the same call that registers it — a
  // command cannot exist without a guard, and dispatch consults it by value.
  commandGuards.set(def.name, defineGuardedAction(commandGuardSpec(def as CommandDef)));
}

/** The guard defined for a registered command — total for anything register() accepted. */
export function commandGuard(name: string): GuardedAction {
  const g = commandGuards.get(name);
  if (!g) {
    throw new Error(`CLI command "${name}" has no guard — was it registered through register()?`);
  }
  return g;
}

export function lookup(name: string): CommandDef | undefined {
  return registry.get(name);
}

export function listCommands(): CommandDef[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}
