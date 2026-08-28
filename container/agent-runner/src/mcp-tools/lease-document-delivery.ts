/**
 * Lease document-delivery submission tool -- fire-and-forget, same shape as
 * lease-manager-generate's submit_lease_generation_plan: the tool writes a
 * system action row and returns immediately; the host resolves the
 * reference, re-verifies the file, and delivers it, notifying this agent
 * via a chat message when done.
 *
 * This tool is visible to every agent's container (MCP tools register
 * globally -- there is no per-agent-group tool visibility mechanism), but
 * functionally useless to anyone but Pepper: the host-side handler
 * hardcodes the required calling agent group. There is no field anywhere in
 * this schema for a filesystem path, directory, or filename -- the only
 * input is the opaque reference a Lease Manager generation success message
 * gave you. The host resolves that reference to a real, already-verified
 * file itself; this tool has no way to substitute an arbitrary path even if
 * one were supplied, because none is ever read from the arguments.
 *
 * Ported from old commit 59de60dc, adapted to await writeMessageOut (now
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

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const deliverLeaseDocument: McpToolDefinition = {
  tool: {
    name: 'deliver_lease_document',
    description:
      'Send Kirk a copy of a Lease Manager-generated draft lease PDF, as an attachment in his existing Telegram ' +
      'conversation. Only usable by Pepper -- the host rejects calls from any other agent group. Requires a ' +
      'document_reference: the opaque token a Lease Manager generation-success message gave you -- never a file ' +
      'path, filename, or directory (there is no such field here, and none would be honored). The host ' +
      'independently re-verifies the reference resolves to a real, verified PDF inside the configured Drafts ' +
      'folder before sending anything, and always delivers to Kirk\'s own trusted Telegram conversation only -- ' +
      'never any other chat. Fire-and-forget: you will get a chat message reporting success or failure. A failure ' +
      'never changes the saved file in Drafts -- tell Kirk plainly if delivery fails.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        document_reference: {
          type: 'string',
          description: 'The opaque document reference from a Lease Manager generation-success message. Not a path.',
        },
        caption: {
          type: 'string',
          description:
            'Optional short plain-language message to send alongside the file (e.g. "Here\'s the draft lease for ' +
            '123 Main St for your review."). If omitted, a minimal default caption is used.',
        },
      },
      required: ['document_reference'],
    },
  },
  async handler(args) {
    const documentReference = args.document_reference;
    if (typeof documentReference !== 'string' || !documentReference.trim()) {
      return err('document_reference is required and must be a non-empty string.');
    }
    const caption = args.caption;
    if (caption !== undefined && typeof caption !== 'string') {
      return err('caption must be a string if provided.');
    }

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'lease_document_deliver', document_reference: documentReference, caption }),
    });

    log(`lease_document_deliver: ${requestId} -> ${documentReference}`);
    return { content: [{ type: 'text' as const, text: 'Delivery requested. You will be notified when it completes.' }] };
  },
};

registerTools([deliverLeaseDocument]);
