/**
 * Room management MCP tools: create_room, add_to_room.
 *
 * A "room" is one Slack group conversation shared by the user and N agents.
 * create_room is the team primitive — the multi-agent pattern is N
 * create_agent calls with room:'none', then ONE create_room naming all of
 * them. Both tools are fire-and-forget (create_agent pattern): they write an
 * outbound system row and return; the host resolves names, opens the
 * conversation, wires everyone, and reports back as a system note.
 *
 * Authorization is enforced host-side by the guard (same trust split as
 * create_agent: trusted global-scope groups act directly, confined groups
 * hold for admin approval) — the container is untrusted and cannot be relied
 * on to gate itself.
 *
 * This module also extends the base `create_agent` tool (see the extendTool
 * call at the bottom): the Slack flow adds `purpose` / `allow_guests` /
 * `room` params and the acknowledge-now guidance without touching the base
 * tool's source. The barrel imports this module after the base agents
 * module, which is what makes the extension legal.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const createRoom: McpToolDefinition = {
  tool: {
    name: 'create_room',
    description:
      "Open ONE shared Slack room (group conversation) with the user and several agents at once — the team primitive. Use after creating the agents (create_agent with room:'none' for teams): one room with ALL of them, never one room per agent. May require admin approval. Fire-and-forget: the call returns immediately; you will get a system note when the room is live, telling you how to post the intro there.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Room name (also names the Slack conversation and its canvas)' },
        purpose: {
          type: 'string',
          description:
            'One short PUBLIC line (under 80 chars) saying what the room is for — shown on the room canvas. Never include private details.',
        },
        agents: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Agent names to include — the same names you use with send_message (agents you created or can already message).',
        },
        include_me: {
          type: 'boolean',
          description: 'Include yourself in the room. Default true — keep it unless the user explicitly excludes you.',
        },
      },
      required: ['name', 'agents'],
    },
  },
  async handler(args) {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return err('name is required');
    const agents = Array.isArray(args.agents) ? args.agents.filter((a) => typeof a === 'string' && a.trim()) : [];
    if (agents.length === 0) return err('agents must list at least one agent name');

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_room',
        requestId,
        name,
        agents,
        ...(typeof args.purpose === 'string' && args.purpose.trim()
          ? { purpose: (args.purpose as string).trim() }
          : {}),
        ...(args.include_me === false ? { include_me: false } : {}),
      }),
    });

    log(`create_room: ${requestId} → "${name}" (${agents.length} agents)`);
    return ok(`Creating room "${name}". You will be notified when it is live.`);
  },
};

export const addToRoom: McpToolDefinition = {
  tool: {
    name: 'add_to_room',
    description:
      'Add one agent to an existing shared room. Slack group conversations never grow in place — this moves the room to a NEW conversation containing everyone plus the new agent (the old one keeps working). For a planned team, prefer creating the room once, complete, via create_room. May require admin approval. Fire-and-forget: a system note reports the outcome.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        room: { type: 'string', description: 'Room name (as the room was created/named)' },
        agent: { type: 'string', description: 'Agent name to add — the same name you use with send_message' },
      },
      required: ['room', 'agent'],
    },
  },
  async handler(args) {
    const room = typeof args.room === 'string' ? args.room.trim() : '';
    const agent = typeof args.agent === 'string' ? args.agent.trim() : '';
    if (!room) return err('room is required');
    if (!agent) return err('agent is required');

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'add_to_room', requestId, room, agent }),
    });

    log(`add_to_room: ${requestId} → "${agent}" into "${room}"`);
    return ok(`Adding "${agent}" to room "${room}". You will be notified when it is done.`);
  },
};

registerTools([createRoom, addToRoom]);

