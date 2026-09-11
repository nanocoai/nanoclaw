/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 *
 * Installed feature modules can additively extend an already-registered
 * tool via `extendTool()` instead of editing the base tool's source —
 * see the doc comment on `extendTool` below. With no extensions
 * registered, tool definitions and behavior are byte-identical to the
 * base modules.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { withOutboundPassthrough } from '../db/messages-out.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

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

/** Additive extension of an already-registered tool. All fields optional. */
export interface ToolExtension {
  /**
   * Extra `inputSchema.properties` merged into the base tool's schema.
   * Keys must not collide with base properties or earlier extensions —
   * a collision throws so a bad install fails loudly and deterministically.
   */
  properties?: Record<string, unknown>;
  /**
   * Arg keys copied verbatim from the call args into any system-action
   * JSON payload the base handler writes via `writeMessageOut` during the
   * call (see `withOutboundPassthrough` in ../db/messages-out.ts). Keys the
   * handler already set in its payload are never overwritten.
   */
  passthroughKeys?: string[];
  /** Text appended (space-separated) to the base tool's description. */
  descriptionSuffix?: string;
}

const passthroughKeysByTool = new Map<string, Set<string>>();

/**
 * Extend a registered tool's input schema, description, and outbound
 * payload additively — the mechanism feature modules use instead of
 * editing base tool files. The base tool's source stays channel-neutral;
 * an installed module (e.g. dropped in by an /add-<channel> skill) calls
 * `extendTool` at import time to enrich it.
 *
 * Extensions are additive and deterministic: description suffixes append
 * in call order, schema properties merge (collisions throw), and
 * passthrough key sets union. Calling `extendTool` twice for the same
 * tool never stacks handler wrappers.
 *
 * Must be called after the base tool's module has registered it (the
 * barrel imports base tool modules before extension modules).
 */
export function extendTool(name: string, extension: ToolExtension): void {
  const def = toolMap.get(name);
  if (!def) {
    throw new Error(`extendTool: unknown tool "${name}" — the base tool must be registered before it can be extended`);
  }

  const { properties, passthroughKeys, descriptionSuffix } = extension;

  if (properties) {
    const schema = def.tool.inputSchema as { type: 'object'; properties?: Record<string, unknown> };
    const existing = (schema.properties ??= {});
    for (const [key, value] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(existing, key)) {
        throw new Error(`extendTool: property "${key}" already exists on tool "${name}"`);
      }
      existing[key] = value;
    }
  }

  if (descriptionSuffix) {
    def.tool.description = def.tool.description ? `${def.tool.description} ${descriptionSuffix}` : descriptionSuffix;
  }

  if (passthroughKeys && passthroughKeys.length > 0) {
    const known = passthroughKeysByTool.get(name);
    if (known) {
      // Already wrapped — the wrapper reads the live key set, so a second
      // extension only needs to add its keys (no wrapper stacking).
      for (const key of passthroughKeys) known.add(key);
      return;
    }
    passthroughKeysByTool.set(name, new Set(passthroughKeys));

    const base = def.handler;
    def.handler = (args) => {
      const entries: Record<string, unknown> = {};
      for (const key of passthroughKeysByTool.get(name) ?? []) {
        if (Object.prototype.hasOwnProperty.call(args, key) && args[key] !== undefined) {
          entries[key] = args[key];
        }
      }
      if (Object.keys(entries).length === 0) return base(args);
      return withOutboundPassthrough(entries, () => base(args));
    };
  }
}

export async function startMcpServer(
  run: <T>(action: () => T | Promise<T>) => Promise<T> = async (action) => action(),
): Promise<void> {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    return run(() => tool.handler(args ?? {}));
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server started with ${allTools.length} tools: ${allTools.map((t) => t.tool.name).join(', ')}`);
}
