/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 */
import { basename } from 'path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

/**
 * ADR 0006 dispatch extension point. By default these
 * registries are EMPTY/identity, so `tools/call` behaves exactly like upstream.
 * A downstream overlay registers into them (via a side-effect import appended to
 * the `mcp-tools/index.ts` barrel by a downstream installer — NOT present in core;
 * do not add it to the core barrel) WITHOUT importing downstream modules into core:
 *
 *  - `registerDispatchGuard` — a central, default-deny capability gate run on
 *    every `tools/call` AFTER the unknown-tool / allowlist / argGuard checks and
 *    BEFORE the handler. An overlay can register an external-actor deny here: an
 *    authenticated external turn is default-denied every tool but a narrow
 *    grant-scoped flow.
 *    A guard returning a `CallToolResult` short-circuits dispatch with it.
 *  - `registerResultTransform` — rewrites every text exit of `tools/call`
 *    (unknown-tool, argGuard deny, external deny, AND handler success). An overlay
 *    can register a lone-surrogate sanitizer so a lone
 *    UTF-16 surrogate in tool output can't poison the next request's tool_result
 *    block (Anthropic API 400 "no low surrogate ...").
 *  - `registerErrorTransform` — rewrites a THROWN handler error before it
 *    propagates (the SDK's PostToolUseFailure path has no output-rewrite hook).
 *
 * Single-slot transforms (last registration wins; one consumer each). The guard
 * list composes in registration order. */
type DispatchGuard = (name: string, args: Record<string, unknown>) => CallToolResult | null;
const dispatchGuards: DispatchGuard[] = [];
let resultTransform: <T>(value: T) => T = (value) => value;
let errorTransform: (err: unknown) => unknown = (err) => err;

export function registerDispatchGuard(guard: DispatchGuard): void {
  dispatchGuards.push(guard);
}

/**
 * ADR 0006 per-tool EMIT-hook extension point — the in-handler
 * counterpart of the central dispatch guards above. The central guards run at
 * the `tools/call` seam, BEFORE the handler, with only the raw tool name + args.
 * The send/file/edit/react gates instead need the RESOLVED
 * routing tuple (which conversation this send actually targets) — a value only
 * the core handler computes (resolveRouting / getRoutingBySeq). So core.ts calls
 * these runners AFTER routing; by default they ship with NO registered hook,
 * making each runner a no-op / identity, so upstream behaves exactly as before.
 *
 * A downstream overlay (whose side-effect import is
 * appended to the `mcp-tools/index.ts` barrel by a downstream installer —
 * NOT present in core; do not add it to the core barrel)
 * registers one `EmitHook` per gated tool WITHOUT core importing any overlay module:
 *
 *  - `preEmit(args, routing)` — short-circuit a write before it happens. An
 *    overlay may park a cross-conversation send on a confined session
 *    for admin approval. Returning a `CallToolResult`
 *    aborts the handler with it; null proceeds.
 *  - `sourceGuard(resolvedPath)` — send_file source-path confinement: on a
 *    confined session, refuse a realpath outside the session's own workspace +
 *    delivered-attachment dirs (shared host DBs / session DBs /
 *    /workspace/global are the exfil targets). Returning a result aborts; null
 *    proceeds.
 *  - `safeFilename(requested, sourcePath)` — the outbox DISPLAY filename. The
 *    default reproduces upstream (`requested || basename(sourcePath)`); an overlay
 *    may force a single basename segment so a
 *    crafted `../../shared/data.db` can't direct the copy WRITE outside the
 *    per-message outbox dir.
 *  - `postEmit(routing)` — a side effect AFTER the write. An overlay may register a
 *    same-conversation dedup mark.
 *  - `externalTargetGuard(routing)` — edit_message/add_reaction route by
 *    HISTORICAL message seq, so the resolved routing may point at an EXTERNAL
 *    conversation; an overlay may refuse the cross-conversation edit/react here (the
 *    exfil bypass of the broadcast gate). Returning a result aborts.
 *
 * One hook object per tool (last registration wins; one consumer each). All slots
 * are optional — an unset slot keeps the upstream identity behavior. */
type EmitRouting = { channel_type: string | null; platform_id: string | null; resolvedName?: string };
export interface EmitHook {
  preEmit?: (args: Record<string, unknown>, routing: EmitRouting) => CallToolResult | null;
  sourceGuard?: (resolvedPath: string) => CallToolResult | null;
  safeFilename?: (requested: string | undefined, sourcePath: string) => string;
  postEmit?: (routing: EmitRouting) => void;
  externalTargetGuard?: (routing: EmitRouting) => CallToolResult | null;
}
const emitHooks = new Map<string, EmitHook>();

export function registerEmitHook(tool: string, hook: EmitHook): void {
  emitHooks.set(tool, hook);
}

/** Pre-write short-circuit (e.g. a broadcast park). null ⇒ proceed. */
export function runEmitPreHook(
  tool: string,
  args: Record<string, unknown>,
  routing: EmitRouting,
): CallToolResult | null {
  return emitHooks.get(tool)?.preEmit?.(args, routing) ?? null;
}

/** send_file source-path confinement. null ⇒ proceed. */
export function runEmitSourceGuard(tool: string, resolvedPath: string): CallToolResult | null {
  return emitHooks.get(tool)?.sourceGuard?.(resolvedPath) ?? null;
}

/** Outbox display filename. Default = upstream `requested || basename(sourcePath)`. */
export function runEmitFilename(tool: string, requested: string | undefined, sourcePath: string): string {
  const hook = emitHooks.get(tool)?.safeFilename;
  if (hook) return hook(requested, sourcePath);
  return requested || basename(sourcePath);
}

/** Post-write side effect (e.g. same-conv dedup mark). */
export function runEmitPostHook(tool: string, routing: EmitRouting): void {
  // BEST-EFFORT: the post-hook runs AFTER the outbound row is written. A throw here must NOT
  // propagate — it would fail the already-completed tool call and invite a retry that
  // double-sends. (The PRE / source / external-target / filename hooks stay fail-closed.)
  try {
    emitHooks.get(tool)?.postEmit?.(routing);
  } catch (err) {
    console.error(`emit post-hook threw for ${tool} (ignored, best-effort):`, err);
  }
}

/** edit_message/add_reaction external-conversation guard. null ⇒ proceed. */
export function runEmitExternalTargetGuard(tool: string, routing: EmitRouting): CallToolResult | null {
  return emitHooks.get(tool)?.externalTargetGuard?.(routing) ?? null;
}

export function registerResultTransform(fn: <T>(value: T) => T): void {
  resultTransform = fn;
}

export function registerErrorTransform(fn: (err: unknown) => unknown): void {
  errorTransform = fn;
}

/** The MCP server identity announced in `initialize` — also the `serverInfo`
 *  the published contract pins (`contract.ts`), so both can't drift. */
export const SERVER_INFO = { name: 'nanoclaw', version: '2.0.0' } as const;

/** Every tool registered so far (registration order). Used by the contract
 *  generator (`contract.ts`) to publish the restricted external surface; the
 *  running server filters this same set by the allowlist. */
export function getAllRegisteredTools(): McpToolDefinition[] {
  return allTools.slice();
}

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      log(`Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

/** Test-only: fetch the REGISTERED (post-wrap) tool definition by name. Used by
 *  chat-actor-guard.test.ts to assert every chat-mutating tool's registered
 *  handler is gated by requiresChatActor (the per-turn actor channel). */
export function getRegisteredToolForTesting(name: string): McpToolDefinition | undefined {
  return toolMap.get(name);
}

/**
 * ADR 0006 tools/list extension point. A filter applied to the
 * EXPOSED tool set right before `tools/list` is answered, so an overlay can hide
 * a registered tool from certain sessions WITHOUT core importing any overlay module
 * (the in-handler dispatch guards still gate `tools/call`; this is the matching
 * advertisement-side control). An overlay may register a filter that drops
 * `create_agent` on a confined session (defense-in-depth atop its dispatch-guard
 * denial). Composed in registration order; empty with no registrant ⇒ the exposed
 * set is announced unchanged (upstream behavior). Evaluated per `tools/list` call
 * so an env-gated filter sees the live session state. */
type ToolListFilter = (tools: McpToolDefinition[]) => McpToolDefinition[];
const toolListFilters: ToolListFilter[] = [];

export function registerToolListFilter(fn: ToolListFilter): void {
  toolListFilters.push(fn);
}

/**
 * Per-tool argument guard for the restricted external surface: keyed by
 * tool name, returns a rejection reason string to deny the call, or null
 * to allow it. Used to gate sub-modes of an otherwise-allowlisted tool
 * (e.g. an org-wide cross-conversation read mode) that the
 * tool-name-granular `allow` set can't express.
 */
export type ToolArgGuard = (args: Record<string, unknown>) => string | null;

/**
 * `allow` restricts the exposed surface to the named tools, gating BOTH
 * `tools/list` AND the `tools/call` path (a registered-but-disallowed
 * tool must be unlisted *and* uncallable — `tools/call` resolves from
 * `toolMap`, not the listed set). Omit `allow` for the full in-container
 * barrel; a downstream service entrypoint passes its restricted external
 * allowlist so the subprocess can't reach `api_admin`/hierarchy/etc.
 *
 * `argGuards` (only consulted when `allow` is set, i.e. the restricted external
 * surface) reject specific argument shapes of an allowlisted tool. The
 * in-container barrel passes neither, so its tools are never arg-gated.
 */
export async function startMcpServer(
  allow?: ReadonlySet<string>,
  argGuards?: ReadonlyMap<string, ToolArgGuard>,
): Promise<void> {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  const exposed = allow ? allTools.filter((t) => allow.has(t.tool.name)) : allTools;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Apply any overlay list-filters (e.g. hide create_agent on a confined session) over the
    // allow-restricted exposed set. No registrant ⇒ `exposed` is announced unchanged (upstream).
    const listed = toolListFilters.reduce((acc, fn) => fn(acc), exposed);
    return { tools: listed.map((t) => t.tool) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    // Every tools/call text exit is run through `resultTransform`: a downstream
    // overlay may register a lone-surrogate sanitizer there — a lone UTF-16
    // surrogate in tool output (often DB/API text via JSON.stringify, or a
    // model-supplied tool name) would otherwise poison the next request's
    // tool_result block and make the Anthropic API reject the whole request
    // (400 "no low surrogate ..."). Identity with no registrant.
    if (!tool || (allow && !allow.has(name))) {
      return resultTransform({ content: [{ type: 'text', text: `Unknown tool: ${name}` }] });
    }
    if (allow && argGuards) {
      const reason = argGuards.get(name)?.((args ?? {}) as Record<string, unknown>);
      if (reason) {
        return resultTransform({
          content: [
            { type: 'text', text: JSON.stringify({ success: false, error_code: 'permission_denied', error: reason }) },
          ],
        });
      }
    }
    // ADR 0006 central dispatch guards (default-deny capability
    // gate). An overlay may register an external-safe gate here:
    // when the turn resolves to an authenticated external actor, default-deny
    // every tool but the narrow grant-scoped flow — a content-confinement
    // control. Empty (no deny) with no registrant; no-op on normal (chat/system)
    // turns and on the restricted-external/replay surfaces.
    for (const guard of dispatchGuards) {
      const denial = guard(name, (args ?? {}) as Record<string, unknown>);
      if (denial) return resultTransform(denial);
    }
    // A handler that THROWS bypasses `resultTransform`: the error propagates and
    // the SDK records it (PostToolUseFailure has no output-rewrite hook), so a
    // lone surrogate in the message would poison the next request. An overlay's
    // `errorTransform` sanitizes the thrown message here — the only reachable
    // point for the tools. Identity with no registrant.
    try {
      return resultTransform(await tool.handler(args ?? {}));
    } catch (err) {
      throw errorTransform(err);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server started with ${exposed.length} tools: ${exposed.map((t) => t.tool.name).join(', ')}`);
}
