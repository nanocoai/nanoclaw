/**
 * Repo self-edit MCP tool: propose_repo_edit.
 *
 * Fire-and-forget, same shape as install_packages — writes a system action
 * row and returns. The host validates the patch, cards an admin with the
 * full diff, and applies it only on approval. Nothing here touches the
 * repo: the agent never holds a writable copy of NanoClaw's source.
 *
 * The checks below only answer the agent fast; the host re-validates every
 * one of them (and more — paths, ignored files, a clean apply) before and
 * after approval.
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

const MAX_DIFF_BYTES = 3000;
const MAX_REASON_CHARS = 300;

export const proposeRepoEdit: McpToolDefinition = {
  tool: {
    name: 'propose_repo_edit',
    description:
      "Propose a change to NanoClaw's own source as a git-format patch. Requires admin approval; fire-and-forget. " +
      'The admin sees the whole patch. On approval the host commits it, runs checks, restarts what the change touches, ' +
      'and reverts it automatically if a check or the restart fails.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        diff: {
          type: 'string',
          description:
            'Unified diff in "git diff" format (with "diff --git a/<path> b/<path>" headers), paths relative to the repo root.',
        },
        reason: { type: 'string', description: 'Why this change is needed — becomes the commit message.' },
      },
      required: ['diff', 'reason'],
    },
  },
  async handler(args) {
    const diff = typeof args.diff === 'string' ? args.diff : '';
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    if (!diff.trim()) return err('diff is required');
    if (!diff.includes('diff --git a/')) return err('diff must be in "git diff" format, with "diff --git" headers');
    if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) {
      return err(
        `diff is larger than ${MAX_DIFF_BYTES} bytes — split it into smaller proposals the admin can read in full`,
      );
    }
    if (!reason) return err('reason is required');
    if (reason.length > MAX_REASON_CHARS) return err(`reason is longer than ${MAX_REASON_CHARS} characters`);

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'repo_self_edit', diff, reason }),
    });
    log(`repo_self_edit: ${requestId} (${Buffer.byteLength(diff, 'utf8')} bytes)`);
    return ok(
      'Source edit proposed. You will be notified when an admin approves or rejects it, and again with the outcome.',
    );
  },
};

registerTools([proposeRepoEdit]);
