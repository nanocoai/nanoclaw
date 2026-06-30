/**
 * Document rendering MCP tool: render_document.
 *
 * Fire-and-forget — writes a `render` system action and returns. The host runs
 * a dedicated, network-isolated render container (Quarto + LaTeX + Chromium)
 * over this session's workspace and notifies you when the artifact is ready,
 * which you can then attach to a message. Rendering is NOT in the agent image
 * (kept lean); it happens host-side.
 *
 * Write the source (.qmd/.md, plus any assets it references) into your
 * workspace first, then call this with a workspace-relative path.
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

const FORMATS = new Set(['pdf', 'html', 'docx', 'typst']);

export const renderDocument: McpToolDefinition = {
  tool: {
    name: 'render_document',
    description:
      'Render a document you have written into your workspace (.qmd or .md) to PDF, HTML, or DOCX via Quarto. Fire-and-forget: rendering runs host-side in an isolated container and you are notified when the artifact is ready in your workspace, then you can attach it. Write the source file (and any images/assets it references) into your workspace BEFORE calling this.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source: {
          type: 'string',
          description: 'Workspace-relative path to the source file, e.g. "report.qmd" or "docs/spec.md"',
        },
        format: {
          type: 'string',
          enum: ['pdf', 'html', 'docx', 'typst'],
          description: 'Output format (default "pdf")',
        },
        output: {
          type: 'string',
          description: 'Optional output filename (defaults to the source name with the new extension)',
        },
      },
      required: ['source'],
    },
  },
  handler: async (args) => {
    const source = String(args.source ?? '').trim();
    const format = String(args.format ?? 'pdf').trim().toLowerCase();
    const output = args.output ? String(args.output).trim() : '';

    if (!source) return err('source is required');
    // Keep paths inside the workspace — no absolute paths or parent escapes.
    if (source.startsWith('/') || source.split('/').includes('..')) {
      return err('source must be a workspace-relative path (no leading / or ..)');
    }
    if (output && (output.startsWith('/') || output.split('/').includes('..'))) {
      return err('output must be a workspace-relative path (no leading / or ..)');
    }
    if (!FORMATS.has(format)) {
      return err(`unsupported format "${format}" (use ${[...FORMATS].join(', ')})`);
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'render', source, format, output, requestId }),
    });

    log(`render: ${requestId} → ${source} (${format})`);
    return ok(
      `Rendering "${source}" to ${format}. I'll let you know when it's ready in the workspace, then I can attach it.`,
    );
  },
};

registerTools([renderDocument]);
