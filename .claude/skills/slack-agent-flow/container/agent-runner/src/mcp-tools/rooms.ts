/**
 * Slack room MCP tools: create_room, add_to_room, handoff.
 *
 * Each writes an outbound system action for the trusted host to validate and
 * execute. The container performs argument validation only.
 *
 * This module also extends the base `create_agent` tool (see the extendTool
 * call at the bottom): the Slack flow adds `purpose` / `allow_guests` /
 * `room` params and the acknowledge-now guidance without touching the base
 * tool's source. The barrel imports this module after the base agents
 * module, which is what makes the extension legal.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { extendTool, registerTools } from './server.js';
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

export const handoff: McpToolDefinition = {
  tool: {
    name: 'handoff',
    description:
      'Post one visible Slack message that engages exactly the named sibling agent(s). Use when the user wants room members to respond there, even if they say "ask"; use send_message for private or cross-surface A2A. Omit room on the current shared surface to preserve its thread, or pass a named room from another session. Never write raw <@...> mentions yourself.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }],
          description: 'One agent destination name, or an explicit list of agent destination names.',
        },
        text: { type: 'string', description: 'The message for the selected agents, without raw Slack mentions.' },
        room: {
          type: 'string',
          description:
            'Optional room destination name. Omit inside the room; provide it when handing off from another session.',
        },
      },
      required: ['to', 'text'],
    },
  },
  async handler(args) {
    const to = typeof args.to === 'string' ? [args.to] : Array.isArray(args.to) ? args.to : [];
    if (to.length === 0 || !to.every((name) => typeof name === 'string' && name.trim())) {
      return err('to must be one agent name or a non-empty list of agent names');
    }
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) return err('text is required');
    if (/<(?:@|!)[^>]+>/.test(text)) return err('text must not contain raw Slack mention markup');
    const room = typeof args.room === 'string' ? args.room.trim() : '';

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'handoff',
        requestId,
        to: to.map((name) => (name as string).trim()),
        text,
        ...(room ? { room } : {}),
      }),
    });

    log(`handoff: ${requestId} → ${to.length} agent(s)`);
    return ok(`Handing off to ${to.length} agent${to.length === 1 ? '' : 's'}.`);
  },
};

registerTools([createRoom, addToRoom, handoff]);

extendTool('send_message', {
  descriptionSuffix:
    'In a Slack construct, use handoff when an agent should respond visibly on a shared surface; use send_message for private or cross-surface A2A.',
});

// ── create_agent extension (Slack agent flow) ──
//
// Additive extension of the base create_agent tool: on a Slack-wired install
// each created agent also gets a dedicated Slack bot, so the tool grows the
// flow's three params and the acknowledge-now guidance. The registered
// passthrough keys are copied verbatim into the system-action payload the
// base handler writes — the host reads them exactly as it reads name and
// instructions (room:'own' and allow_guests:false travel explicitly and read
// as the defaults host-side).
extendTool('create_agent', {
  properties: {
    purpose: {
      type: 'string',
      description:
        'One short PUBLIC line (under 80 chars) saying what this agent is for — shown to everyone in the shared room intro and canvas. ALWAYS provide it. Never include private details from the instructions; without it the room states no purpose at all.',
    },
    allow_guests: {
      type: 'boolean',
      description:
        'Set true ONLY if Slack workspace guests must be able to DM this agent — guests cannot access agent-mode bots, so this provisions a plain bot without the agent DM experience. Default false.',
    },
    room: {
      type: 'string',
      enum: ['own', 'none'],
      description:
        "Shared-room policy. 'own' (default) opens a room with you, the user, and the new agent — right for a single create. 'none' skips the room (the agent still gets its DM) — REQUIRED when creating several agents for one team: create each with room:'none', then call create_room ONCE with all of them. Never open per-agent rooms for a team.",
    },
  },
  passthroughKeys: ['purpose', 'allow_guests', 'room'],
  descriptionSuffix:
    'The call returns immediately. Creation takes about a minute (a unique avatar is generated and a dedicated Slack bot is provisioned); when ready, the new agent introduces itself via DM and a shared room. You MUST acknowledge the user in this SAME turn, before or alongside this call — say you are on it, set the ~1-minute expectation, and mention the agent will introduce itself.',
});
