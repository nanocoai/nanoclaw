/**
 * Maintenance Coordinator worker-facing tools + Pepper's status query.
 * All fire-and-forget, same shape as every other module: the tool
 * writes a system action row and returns immediately; the host processes
 * it and notifies the agent via a chat message when done.
 *
 * These tools are visible to every agent's container (MCP tools register
 * globally — there's no per-agent-group visibility mechanism), but the
 * host-side handler hardcodes the required calling agent group for each,
 * so they're functionally useless to any agent but the intended one.
 *
 * Ported from old commit 824318ff, adapted to await writeMessageOut (now
 * async).
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

async function fireAndForget(action: string, payload: Record<string, unknown>, ackText: string) {
  const id = generateId();
  await writeMessageOut({ id, kind: 'system', content: JSON.stringify({ action, ...payload }) });
  log(`${action}: ${id}`);
  return ok(ackText);
}

// This is what a fireAndForget call itself returns to the model, synchronously,
// before the host has actually looked anything up. It is NOT the answer -- the
// real answer always arrives moments later as a separate message from "system".
// A generic "Checking..." here was previously misread by the agent as if it
// WERE the (empty/negative) answer, causing it to narrate "no data" or
// "unconfirmed" even when the real follow-up (which had already arrived)
// said otherwise. Being explicit here is a structural fix, not just an
// instruction -- it's the one piece of text every read tool call is
// guaranteed to produce.
const AWAIT_FOLLOWUP_ACK =
  "(Looking that up now -- this is not the answer. The real result arrives as a separate message a moment later. Wait for it and read it before concluding anything.)";

const SOURCE_MESSAGE_ID_DESC =
  'Required in a shared conversation with more than one person: the id shown on the message you\'re acting on (the id="..." attribute on that <message> tag) -- this is how the right person gets credited instead of whoever the group chat itself would otherwise resolve to. Not needed in a private one-on-one conversation.';

export const recordTimeEvent: McpToolDefinition = {
  tool: {
    name: 'record_time_event',
    description:
      "Record that you clocked in or out. Use when a worker's message clearly means they're starting or ending their paid work day (e.g. \"good morning\", \"I'm here\" -> clock in; \"leaving\", \"done for the day\" -> clock out; same for Spanish equivalents). If it's not clearly one or the other, ask instead of guessing.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        event_type: { type: 'string', enum: ['clock_in', 'clock_out'] },
        note: { type: 'string', description: 'Optional short note.' },
        source_message_id: { type: 'string', description: SOURCE_MESSAGE_ID_DESC },
      },
      required: ['event_type'],
    },
  },
  async handler(args) {
    if (args.event_type !== 'clock_in' && args.event_type !== 'clock_out') {
      return err("event_type must be 'clock_in' or 'clock_out'");
    }
    return fireAndForget(
      'record_time_event',
      { event: { event_type: args.event_type, note: args.note, source_message_id: args.source_message_id } },
      'Recorded.',
    );
  },
};

export const reportWorkerStatus: McpToolDefinition = {
  tool: {
    name: 'report_worker_status',
    description:
      'Record a location/destination/transport update for yourself, or for a co-worker you are transporting (set about_worker to their name, e.g. when dropping someone off). Use for things like "we\'re going to High Point", "leaving Edgewood", "going to Lowe\'s", "dropping Ivan at Edgewood". Only set awaiting_pickup=true if the worker will need someone to come get them or take them elsewhere later.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        about_worker: { type: 'string', description: 'Name of the worker this update is about, if not the reporting worker themself.' },
        location: { type: 'string', description: 'Where they are or are headed.' },
        active_job_reference: { type: 'string', description: 'Their current assignment, if known.' },
        transport_mode: { type: 'string', enum: ['self_driven', 'transported'] },
        transported_by: { type: 'string', description: "Name of the worker driving them, if transport_mode is 'transported'." },
        awaiting_pickup: { type: 'boolean', description: 'True if they will need to be picked up / transported elsewhere later.' },
        note: { type: 'string' },
        source_message_id: { type: 'string', description: SOURCE_MESSAGE_ID_DESC },
        trello_suggestion_shown: {
          type: 'object',
          description:
            'Call this on its own (no other fields needed) right after you actually told the worker about relevant Trello cards at their destination -- records what was shown so the same suggestion is not repeated next time nothing has changed. Never set this preemptively.',
          properties: {
            destination_key: {
              type: 'string',
              description:
                'The destination_key given back in the property-match follow-up for this destination -- always required. Same key works whether the destination resolved to a known property or not, so dedup applies either way.',
            },
            property_id: {
              type: 'string',
              description:
                'The property_id given back in the property-match follow-up, only when the destination resolved to a known property. Omit entirely for a raw-text/unmatched destination -- never invent one.',
            },
            card_ids: { type: 'array', items: { type: 'string' }, description: 'The Trello card ids you actually mentioned to the worker.' },
          },
          required: ['destination_key', 'card_ids'],
        },
      },
    },
  },
  async handler(args) {
    return fireAndForget(
      'report_worker_status',
      {
        status: {
          about_worker: args.about_worker,
          location: args.location,
          active_job_reference: args.active_job_reference,
          transport_mode: args.transport_mode,
          transported_by: args.transported_by,
          awaiting_pickup: args.awaiting_pickup,
          note: args.note,
          source_message_id: args.source_message_id,
          trello_suggestion_shown: args.trello_suggestion_shown,
        },
      },
      'Status recorded. (Not the full answer -- if this included a destination change, a property-match / Trello-suggestion-history follow-up arrives as a separate message a moment later. Wait for it before deciding whether to search Trello or mention anything.)',
    );
  },
};

export const recordJobCompletion: McpToolDefinition = {
  tool: {
    name: 'record_job_completion',
    description:
      '"listo" (or "done"/"finished") + a photo is a completion report. Use the active job reference if there is exactly one clearly active job for this worker; otherwise ask which job it belongs to before calling this.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        job_reference: { type: 'string', description: 'The job this completion belongs to.' },
        attachment_path: {
          type: 'string',
          description:
            'If a photo was sent, copy the path EXACTLY as it appears in this conversation next to the attachment (e.g. "inbox/msg-abc123/photo.jpg") -- do not retype or guess it.',
        },
        source_message_id: { type: 'string', description: SOURCE_MESSAGE_ID_DESC },
      },
      required: ['job_reference'],
    },
  },
  async handler(args) {
    if (typeof args.job_reference !== 'string' || !args.job_reference.trim()) {
      return err('job_reference is required');
    }
    return fireAndForget(
      'record_job_completion',
      {
        completion: {
          job_reference: args.job_reference,
          attachment_path: args.attachment_path,
          source_message_id: args.source_message_id,
        },
      },
      'Completion recorded.',
    );
  },
};

export const getWorkerInfo: McpToolDefinition = {
  tool: {
    name: 'get_worker_info',
    description:
      "Look up a worker's language, role, and whether they drive independently or are usually transported by someone else. Omit `worker` (or pass \"self\") for the worker you're currently talking to. This is how you know transportation dependencies -- never assume or hardcode who can drive.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        worker: { type: 'string', description: 'A worker\'s name, or omit for the current worker.' },
        source_message_id: {
          type: 'string',
          description: SOURCE_MESSAGE_ID_DESC + ' Only relevant when worker is omitted/"self".',
        },
      },
    },
  },
  async handler(args) {
    return fireAndForget('get_worker_info', { info: { worker: args.worker, source_message_id: args.source_message_id } }, AWAIT_FOLLOWUP_ACK);
  },
};

export const getWorkerActivity: McpToolDefinition = {
  tool: {
    name: 'get_worker_activity',
    description:
      'The ONLY way to check whether a specific worker has actually clocked in, reported status, or done anything today -- get_worker_info does not cover this, it only gives static language/role/transport facts. Read-only, one worker at a time. Use this before deciding whether someone has "not checked in yet" or whether your picture of them is stale -- never guess or infer this from what you remember saying earlier; ask this tool. Reports "unknown" plainly when there is no data, never as if that meant good or bad.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        worker: { type: 'string', description: "The worker's name, e.g. \"Ivan\"." },
      },
      required: ['worker'],
    },
  },
  async handler(args) {
    if (typeof args.worker !== 'string' || !args.worker.trim()) return err('worker is required');
    return fireAndForget('get_worker_activity', { query: { worker: args.worker } }, AWAIT_FOLLOWUP_ACK);
  },
};

export const reportMaintenanceIssueTool: McpToolDefinition = {
  tool: {
    name: 'report_maintenance_issue',
    description:
      'Capture a NEW maintenance issue a worker just told you about (not a status update on an existing assignment). Always include property_reference and a clear description. Set urgency to "urgent" only for things like an active water leak, broken pipe, flooding, or a serious safety/electrical issue -- otherwise "normal". This never authorizes a trip, purchase, or reprioritization by itself -- Kirk is notified and decides what happens next.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        property_reference: { type: 'string' },
        unit: { type: 'string' },
        description: { type: 'string' },
        urgency: { type: 'string', enum: ['normal', 'urgent'] },
        attachment_path: {
          type: 'string',
          description:
            'If a photo was sent, copy the path EXACTLY as it appears in this conversation next to the attachment (e.g. "inbox/msg-abc123/photo.jpg") -- do not retype or guess it.',
        },
        source_message_id: { type: 'string', description: SOURCE_MESSAGE_ID_DESC },
      },
      required: ['property_reference', 'description'],
    },
  },
  async handler(args) {
    if (typeof args.property_reference !== 'string' || !args.property_reference.trim()) return err('property_reference is required');
    if (typeof args.description !== 'string' || !args.description.trim()) return err('description is required');
    return fireAndForget(
      'report_maintenance_issue',
      {
        report: {
          property_reference: args.property_reference,
          unit: args.unit,
          description: args.description,
          urgency: args.urgency,
          attachment_path: args.attachment_path,
          source_message_id: args.source_message_id,
        },
      },
      'Issue recorded. Notifying Kirk now.',
    );
  },
};

export const recordKeyBinderCustody: McpToolDefinition = {
  tool: {
    name: 'record_key_binder_custody',
    description:
      "Record who currently has one of the three portable key binders (Binder 1/2/3) -- e.g. a worker saying \"I have Binder 3\", or Kirk saying he's carrying binders on a run (relayed to you). 140 Richard Road is each binder's normal HOME location, not where it necessarily is right now -- never assume a binder is at the office just because nothing was reported. Use holder_type 'unknown' rather than guessing if it's unclear.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        binder: { type: 'string', description: "e.g. 'Binder 1'." },
        holder_type: { type: 'string', enum: ['office', 'kirk', 'worker', 'other', 'unknown'] },
        holder_worker: { type: 'string', description: "Worker name, if holder_type is 'worker'." },
        holder_note: { type: 'string', description: "Who ('other'), or extra detail." },
        note: { type: 'string' },
        source_message_id: { type: 'string', description: SOURCE_MESSAGE_ID_DESC },
      },
      required: ['binder', 'holder_type'],
    },
  },
  async handler(args) {
    if (typeof args.binder !== 'string' || !args.binder.trim()) return err('binder is required');
    if (typeof args.holder_type !== 'string') return err('holder_type is required');
    return fireAndForget(
      'record_key_binder_custody',
      {
        custody: {
          binder: args.binder,
          holder_type: args.holder_type,
          holder_worker: args.holder_worker,
          holder_note: args.holder_note,
          note: args.note,
          source_message_id: args.source_message_id,
        },
      },
      'Recorded.',
    );
  },
};

export const getKeyBinderStatus: McpToolDefinition = {
  tool: {
    name: 'get_key_binder_status',
    description:
      "Check where a key binder actually is before telling anyone to drive to the office for it. Pass `property` to resolve that property's normally-assigned binder and its current custody in one call, or `binder` for a specific binder by name, or neither for all three. 140 Richard Road is each binder's normal home location, not necessarily where it is right now -- an 'unknown' result means exactly that, not 'at the office'.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        binder: { type: 'string', description: "e.g. 'Binder 1'. Omit if using property." },
        property: { type: 'string', description: "A property address/alias. Omit if using binder." },
      },
    },
  },
  async handler(args) {
    return fireAndForget('get_key_binder_status', { info: { binder: args.binder, property: args.property } }, AWAIT_FOLLOWUP_ACK);
  },
};

export const getWorkdayStatus: McpToolDefinition = {
  tool: {
    name: 'get_workday_status',
    description:
      "Check what kind of day today is before doing anything proactive about attendance. Mon-Fri are always normal workdays. Saturday (and any other conditional day) starts unconfirmed -- call this first; if it comes back unconfirmed, do NOT proactively ask Ivan or Elehazar whether they're coming in. Only real evidence (Kirk says so, a worker checks in, a known assignment) should lead you to call mark_workday_active -- never assume, never guess from it just being a certain time.",
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    return fireAndForget('get_workday_status', {}, AWAIT_FOLLOWUP_ACK);
  },
};

export const markWorkdayActive: McpToolDefinition = {
  tool: {
    name: 'mark_workday_active',
    description:
      'Record that today (a conditional day like Saturday) is actually an active workday, because you have real evidence -- Kirk said so, a worker checked in, or there\'s a known assignment for today. Never call this on a guess or because it\'s "probably" a workday. Once called, treat the rest of today like a normal workday -- no need to re-derive this on later checks today.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reason: { type: 'string', description: 'The actual evidence, briefly -- e.g. "Kirk said the crew is working today" or "Ivan clocked in".' },
        source_message_id: { type: 'string', description: SOURCE_MESSAGE_ID_DESC },
      },
      required: ['reason'],
    },
  },
  async handler(args) {
    if (typeof args.reason !== 'string' || !args.reason.trim()) return err('reason is required');
    return fireAndForget('mark_workday_active', { confirmation: { reason: args.reason, source_message_id: args.source_message_id } }, 'Noted.');
  },
};

export const queryMaintenanceStatus: McpToolDefinition = {
  tool: {
    name: 'query_maintenance_status',
    description:
      "Get a structured summary of Maintenance Coordinator's current state: who's clocked in, where they are, what they're working on, and any open (not-yet-decided) reported issues. Only usable by Pepper. Never receives raw worker chat -- only this summary.",
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    return fireAndForget('query_maintenance_status', {}, AWAIT_FOLLOWUP_ACK);
  },
};

registerTools([
  recordTimeEvent,
  reportWorkerStatus,
  recordJobCompletion,
  getWorkerInfo,
  getWorkerActivity,
  reportMaintenanceIssueTool,
  recordKeyBinderCustody,
  getKeyBinderStatus,
  getWorkdayStatus,
  markWorkdayActive,
  queryMaintenanceStatus,
]);
