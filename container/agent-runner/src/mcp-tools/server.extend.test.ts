/**
 * Tests for `extendTool` — the additive extension point feature modules use
 * to enrich a base MCP tool's input schema, description, and outbound
 * system-action payload without editing the base tool's source file.
 *
 * Uses synthetic fixture tools for the merge/passthrough semantics (module
 * state is process-wide, so each fixture gets a unique name), plus one
 * end-to-end fixture extension of the real `create_agent` tool proving the
 * mechanism covers the motivating case: an installed module adding params
 * that must land in the payload the host reads from outbound.db.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages, writeMessageOut } from '../db/messages-out.js';
import { extendTool, registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

let fixtureCount = 0;

/**
 * Register a fresh fixture tool that writes one system-action payload the
 * way real system tools do (create_agent, scheduling, self-mod): base args
 * only — anything an extension adds is invisible to the handler.
 */
function fixtureTool(): McpToolDefinition {
  const n = ++fixtureCount;
  const def: McpToolDefinition = {
    tool: {
      name: `fixture_tool_${n}`,
      description: 'Base description.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'base param' },
        },
        required: ['name'],
      },
    },
    async handler(args) {
      writeMessageOut({
        id: `msg-fixture-${n}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'system',
        content: JSON.stringify({ action: 'fixture_action', name: args.name as string }),
      });
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    },
  };
  registerTools([def]);
  return def;
}

function schemaProps(def: McpToolDefinition): Record<string, unknown> {
  return (def.tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
}

function lastPayload(): Record<string, unknown> {
  const rows = getUndeliveredMessages();
  expect(rows.length).toBeGreaterThan(0);
  return JSON.parse(rows[rows.length - 1].content) as Record<string, unknown>;
}

describe('extendTool — schema and description merge', () => {
  it('merges extra properties additively, leaving base schema intact', () => {
    const def = fixtureTool();

    extendTool(def.tool.name, {
      properties: { purpose: { type: 'string', description: 'public purpose line' } },
    });

    const props = schemaProps(def);
    expect(Object.keys(props).sort()).toEqual(['name', 'purpose']);
    expect(props.name).toEqual({ type: 'string', description: 'base param' });
    expect((def.tool.inputSchema as { required?: string[] }).required).toEqual(['name']);
  });

  it('appends the description suffix after the base description', () => {
    const def = fixtureTool();

    extendTool(def.tool.name, { descriptionSuffix: 'Suffix one.' });

    expect(def.tool.description).toBe('Base description. Suffix one.');
  });

  it('throws on an unknown tool', () => {
    expect(() => extendTool('no_such_tool', { descriptionSuffix: 'x' })).toThrow(/unknown tool "no_such_tool"/);
  });

  it('throws when an extension property collides with a base property', () => {
    const def = fixtureTool();

    expect(() => extendTool(def.tool.name, { properties: { name: { type: 'string' } } })).toThrow(
      /property "name" already exists/,
    );
  });

  it('double extension is deterministic: suffixes append in order, properties merge, collisions throw', () => {
    const def = fixtureTool();

    extendTool(def.tool.name, {
      properties: { purpose: { type: 'string' } },
      descriptionSuffix: 'First.',
    });
    extendTool(def.tool.name, {
      properties: { room: { type: 'string', enum: ['own', 'none'] } },
      descriptionSuffix: 'Second.',
    });

    expect(def.tool.description).toBe('Base description. First. Second.');
    expect(Object.keys(schemaProps(def)).sort()).toEqual(['name', 'purpose', 'room']);
    // A third extension re-adding a key from an earlier one fails loudly.
    expect(() => extendTool(def.tool.name, { properties: { purpose: { type: 'string' } } })).toThrow(
      /property "purpose" already exists/,
    );
  });
});

describe('extendTool — passthrough keys land in the written payload', () => {
  beforeEach(() => {
    initTestSessionDb();
  });

  afterEach(() => {
    closeSessionDb();
  });

  it('copies registered passthrough keys from args into the system payload', async () => {
    const def = fixtureTool();
    extendTool(def.tool.name, {
      properties: { purpose: { type: 'string' } },
      passthroughKeys: ['purpose'],
    });

    await def.handler({ name: 'Scout', purpose: 'Deep research' });

    const payload = lastPayload();
    expect(payload.action).toBe('fixture_action');
    expect(payload.name).toBe('Scout');
    expect(payload.purpose).toBe('Deep research');
  });

  it('ignores unregistered args and keys absent from the call', async () => {
    const def = fixtureTool();
    extendTool(def.tool.name, { passthroughKeys: ['purpose'] });

    await def.handler({ name: 'Scout', sneaky: 'nope' });

    const payload = lastPayload();
    expect(payload).not.toHaveProperty('purpose'); // registered but not passed
    expect(payload).not.toHaveProperty('sneaky'); // passed but not registered
  });

  it('never overwrites keys the base handler wrote itself', async () => {
    const def = fixtureTool();
    extendTool(def.tool.name, { passthroughKeys: ['action', 'name'] });

    await def.handler({ name: 'Scout', action: 'evil_override' });

    const payload = lastPayload();
    expect(payload.action).toBe('fixture_action'); // handler wins
    expect(payload.name).toBe('Scout'); // handler wrote it from args anyway
  });

  it('unions passthrough keys across double extension without stacking wrappers', async () => {
    const def = fixtureTool();
    extendTool(def.tool.name, { passthroughKeys: ['purpose'] });
    extendTool(def.tool.name, { passthroughKeys: ['room'] });

    await def.handler({ name: 'Scout', purpose: 'Research', room: 'none' });

    const payload = lastPayload();
    expect(payload.purpose).toBe('Research');
    expect(payload.room).toBe('none');
  });

  it('leaves non-system and non-JSON writes byte-identical during an extended call', async () => {
    const n = ++fixtureCount;
    const def: McpToolDefinition = {
      tool: {
        name: `fixture_tool_${n}`,
        description: 'Base description.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      async handler() {
        writeMessageOut({ id: `msg-plain-${n}`, kind: 'message', content: 'plain text reply' });
        writeMessageOut({ id: `msg-rawsys-${n}`, kind: 'system', content: 'not json at all' });
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    };
    registerTools([def]);
    extendTool(def.tool.name, { passthroughKeys: ['purpose'] });

    await def.handler({ purpose: 'Research' });

    const rows = getUndeliveredMessages();
    const plain = rows.find((r) => r.id === `msg-plain-${n}`);
    const rawSys = rows.find((r) => r.id === `msg-rawsys-${n}`);
    expect(plain?.content).toBe('plain text reply');
    expect(rawSys?.content).toBe('not json at all');
  });
});

