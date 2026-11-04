/**
 * Canvas MCP tools: canvas_update, canvas_read.
 *
 * canvas_update is fire-and-forget (self-mod.ts pattern): it writes a
 * `canvas_edit` system action and returns immediately — the host applies the
 * edit as this session's bot identity and the outcome arrives later as a
 * system note (a `canvas_response` inbound row).
 *
 * canvas_read is blocking (ncl / ask_user_question pattern): it writes a
 * `canvas_read` system action, then polls the mailbox by requestId for the
 * host's response row and returns the canvas text inline.
 */
import { findCliResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EDIT_OPS = ['append', 'replace_section', 'insert_after_section'] as const;
type EditOp = (typeof EDIT_OPS)[number];

export const canvasUpdate: McpToolDefinition = {
  tool: {
    name: 'canvas_update',
    description:
      "Edit a Slack canvas by id — append markdown at the end, replace one named section, or insert new content after a section. Section targeting uses section_text: for section-wide edits the target section's EXACT heading text (from a fresh canvas_read); for a single checklist item, the item's exact text (that deliberately targets just the item — how you mark items done, since checkbox tick state is UI-only and cannot be set via the API). Fire-and-forget: the host applies the edit as your bot identity; a failure wakes you with a system note explaining why, a success note rides along silently on your next wake. Whole-document replace is not possible — edits are always section-scoped. Discipline (canvas-work skill): canvas_read first; replace_section for updating existing content; insert_after_section for new sections or new checklist items; never a heading the canvas already has.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvas_id: {
          type: 'string',
          description:
            "Canvas id (F…) — for a room canvas, it is in your destinations list ('<room> canvas comments (canvas F…)')",
        },
        op: {
          type: 'string',
          enum: [...EDIT_OPS],
          description: 'append (at document end), replace_section, or insert_after_section',
        },
        markdown: { type: 'string', description: 'Markdown content for the edit' },
        section_text: {
          type: 'string',
          description: "Required for replace_section / insert_after_section: the target section's exact heading text",
        },
      },
      required: ['canvas_id', 'op', 'markdown'],
    },
  },
  async handler(args) {
    const canvasId = args.canvas_id as string;
    const op = args.op as EditOp;
    const markdown = args.markdown as string;
    const sectionText = (args.section_text as string) || '';

    if (!canvasId || !markdown) return err('canvas_id and markdown are required');
    if (!EDIT_OPS.includes(op)) return err(`op must be one of: ${EDIT_OPS.join(', ')}`);
    if (op !== 'append' && !sectionText) {
      return err(`section_text is required for ${op} — the target section's exact heading text`);
    }

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'canvas_edit',
        requestId,
        canvas_id: canvasId,
        op,
        section_text: sectionText || undefined,
        markdown,
      }),
    });

    log(`canvas_update: ${requestId} → ${op} on ${canvasId}`);
    return ok(
      'Edit submitted. If it fails you will be woken with a system note saying why; verify structural changes with canvas_read.',
    );
  },
};

export const canvasRead: McpToolDefinition = {
  tool: {
    name: 'canvas_read',
    description:
      'Read a Slack canvas as text (blocking, default 20s; timeout is in SECONDS). A timeout error can fire while the host read still succeeds — on timeout, retry once with a larger timeout. Output over ~8000 chars is truncated with an explicit marker: never conclude a section is absent from a truncated read. Read-before-write is mandatory (canvas-work skill): call this before EVERY edit — human edits produce no events, so your last view is stale by default.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        canvas_id: { type: 'string', description: 'Canvas id (F…) to read' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 20)' },
      },
      required: ['canvas_id'],
    },
  },
  async handler(args) {
    const canvasId = args.canvas_id as string;
    if (!canvasId) return err('canvas_id is required');
    const timeout = ((args.timeout as number) || 20) * 1000;

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'canvas_read',
        requestId,
        canvas_id: canvasId,
      }),
    });

    log(`canvas_read: ${requestId} → ${canvasId}`);

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const response = findCliResponse(requestId);
      if (response) {
        markCompleted([response.id]);
        const parsed = JSON.parse(response.content) as {
          status?: string;
          result?: { text?: string; error?: string };
        };
        if (parsed.status === 'ok' && typeof parsed.result?.text === 'string') {
          log(`canvas_read response: ${requestId} (${parsed.result.text.length} chars)`);
          return ok(parsed.result.text);
        }
        return err(parsed.result?.error || 'canvas read failed');
      }
      await sleep(500);
    }

    log(`canvas_read timeout: ${requestId}`);
    return err(`Canvas read timed out after ${timeout / 1000}s`);
  },
};

registerTools([canvasUpdate, canvasRead]);
