/**
 * Lease Manager's scoped filesystem tools -- fire-and-forget, same shape as
 * every other module tonight: the tool writes a system action row and
 * returns immediately; the host processes it (including admin approval for
 * the three write tools) and notifies the agent via a chat message when
 * done.
 *
 * These tools are visible to every agent's container (MCP tools register
 * globally -- there's no per-agent-group visibility mechanism), but the
 * host-side handler hardcodes the required calling agent group for each,
 * so they're functionally useless to any agent but the intended one.
 *
 * lease_fs_move / lease_fs_copy / lease_fs_mkdir take RELATIVE paths only,
 * always resolved and containment-checked against the Lease Manager root
 * host-side -- there is no way to reach anything outside that root, no
 * matter what path is supplied. All three always require admin approval.
 * There is no overwrite option anywhere in these schemas: a destination
 * that already exists always fails closed.
 *
 * stage_signed_lease_upload is Pepper-only: hands off a file Kirk uploaded
 * so Lease Manager can file it, without Pepper's own container ever
 * touching the file's bytes.
 *
 * Ported from old commit 59de60dc, adapted to await writeMessageOut (now
 * async, returns Promise<number> instead of writing synchronously).
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

const PATH_DESCRIPTION =
  'Relative to the Lease Manager root -- e.g. "Leases/Incoming/abc123 - lease.pdf" or ' +
  '"Leases/Current/1407 East Commerce Ave Apt C Signed Lease.pdf". Never an absolute path, never a ".." segment, ' +
  'never a path outside the root -- none of those are accepted, and the host independently verifies containment ' +
  'regardless of what you send.';

export const leaseFsMoveTool: McpToolDefinition = {
  tool: {
    name: 'lease_fs_move',
    description:
      'Move or rename a file inside the Lease Manager folder tree. Only usable by Lease Manager. Requires admin ' +
      'approval every time -- fire-and-forget, you will be notified of the result. The destination must NOT ' +
      'already exist -- if it does, this fails closed and you should tell Kirk (via Pepper) about the conflict ' +
      'rather than picking a different name yourself or assuming what to do. Use this (not a special-purpose ' +
      'tool) for placing a staged signed lease into Current, or any other reorganization.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_relative_path: { type: 'string', description: `Current location. ${PATH_DESCRIPTION}` },
        dest_relative_path: { type: 'string', description: `New location. ${PATH_DESCRIPTION}` },
        context_note: {
          type: 'string',
          description:
            'Optional plain-language context for the approval card, e.g. "Signed lease for 1407 East Commerce ' +
            'Ave Apt C, uploaded via Pepper." Shown to Kirk as-is, not independently verified by the host.',
        },
      },
      required: ['source_relative_path', 'dest_relative_path'],
    },
  },
  async handler(args) {
    if (typeof args.source_relative_path !== 'string' || !args.source_relative_path.trim()) return err('source_relative_path is required');
    if (typeof args.dest_relative_path !== 'string' || !args.dest_relative_path.trim()) return err('dest_relative_path is required');
    return fireAndForget(
      'lease_fs_move',
      { source_relative_path: args.source_relative_path, dest_relative_path: args.dest_relative_path, context_note: args.context_note },
      'Move requested. You will be notified when admin approves or rejects.',
    );
  },
};

export const leaseFsCopyTool: McpToolDefinition = {
  tool: {
    name: 'lease_fs_copy',
    description:
      'Copy a file inside the Lease Manager folder tree (source stays in place). Only usable by Lease Manager. ' +
      'Requires admin approval every time. The destination must NOT already exist -- if it does, this fails ' +
      'closed and you should tell Kirk (via Pepper) about the conflict rather than guessing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_relative_path: { type: 'string', description: `File to copy. ${PATH_DESCRIPTION}` },
        dest_relative_path: { type: 'string', description: `New copy's location. ${PATH_DESCRIPTION}` },
        context_note: { type: 'string', description: 'Optional plain-language context for the approval card, shown to Kirk as-is.' },
      },
      required: ['source_relative_path', 'dest_relative_path'],
    },
  },
  async handler(args) {
    if (typeof args.source_relative_path !== 'string' || !args.source_relative_path.trim()) return err('source_relative_path is required');
    if (typeof args.dest_relative_path !== 'string' || !args.dest_relative_path.trim()) return err('dest_relative_path is required');
    return fireAndForget(
      'lease_fs_copy',
      { source_relative_path: args.source_relative_path, dest_relative_path: args.dest_relative_path, context_note: args.context_note },
      'Copy requested. You will be notified when admin approves or rejects.',
    );
  },
};

export const leaseFsMkdirTool: McpToolDefinition = {
  tool: {
    name: 'lease_fs_mkdir',
    description:
      'Create a new subfolder inside the Lease Manager folder tree. Only usable by Lease Manager. Requires admin ' +
      'approval every time. Fails closed if the folder already exists or its parent does not.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        relative_path: { type: 'string', description: `Folder to create. ${PATH_DESCRIPTION}` },
        context_note: { type: 'string', description: 'Optional plain-language context for the approval card, shown to Kirk as-is.' },
      },
      required: ['relative_path'],
    },
  },
  async handler(args) {
    if (typeof args.relative_path !== 'string' || !args.relative_path.trim()) return err('relative_path is required');
    return fireAndForget('lease_fs_mkdir', { relative_path: args.relative_path, context_note: args.context_note }, 'Folder creation requested. You will be notified when admin approves or rejects.');
  },
};

export const stageSignedLeaseUploadTool: McpToolDefinition = {
  tool: {
    name: 'stage_signed_lease_upload',
    description:
      'Hand off a PDF Kirk sent you (e.g. a signed lease) to Lease Manager. Only usable by Pepper. No approval ' +
      'needed -- this only copies the file into a private staging area, nothing consequential happens yet.\n\n' +
      'attachment_path: copy this EXACTLY as it appears in this conversation next to the attachment -- when Kirk ' +
      'sends a file, you\'ll see a line like "[document: lease.pdf — saved to /workspace/inbox/<id>/lease.pdf]". ' +
      'Copy the full "saved to ..." path verbatim. Do NOT construct, guess, or substitute any other identifier -- ' +
      'not a message id, not a platform/Telegram message id, not anything you infer. If you don\'t see a ' +
      '"saved to ..." path for the file, the attachment hasn\'t actually landed yet; ask Kirk to resend it rather ' +
      'than guessing a path. Only PDFs are accepted here -- anything else is rejected with an explanation.\n\n' +
      'You will get back a reference and a relative path -- relay both, plus anything Kirk told you about which ' +
      'property/unit this is for, to Lease Manager so it can read the file and file it correctly. You never see ' +
      'or need the file\'s actual bytes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        attachment_path: {
          type: 'string',
          description: 'The exact "saved to ..." path shown next to the attachment in this conversation, e.g. "/workspace/inbox/abc123/lease.pdf".',
        },
        note: { type: 'string', description: "Optional: anything Kirk said about this file (e.g. \"for 1407C\") -- relayed to Lease Manager as-is." },
      },
      required: ['attachment_path'],
    },
  },
  async handler(args) {
    if (typeof args.attachment_path !== 'string' || !args.attachment_path.trim()) return err('attachment_path is required');
    return fireAndForget('stage_signed_lease_upload', { attachment_path: args.attachment_path, note: args.note }, 'Staging requested. You will be notified with a reference shortly.');
  },
};

registerTools([leaseFsMoveTool, leaseFsCopyTool, leaseFsMkdirTool, stageSignedLeaseUploadTool]);
