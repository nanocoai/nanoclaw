/**
 * Apple Pages MCP tools — container-side bridge.
 *
 * Each verb is exposed as its own MCP tool so Claude's tool-picker sees
 * distinct names (pages_create, pages_open, etc.). On invocation the tool
 * writes a `pages_request` system message to outbound.db carrying a
 * requestId + verb + args, then polls inbound.db for a matching
 * `pages_response`. The host module (src/modules/pages/index.ts) does the
 * actual osascript work and writes the response back.
 *
 * Mirrors the cli_request / cli_response pattern in cli/ncl.ts.
 */
import { openInboundDb, getOutboundDb } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[pages] ${msg}`);
}

function generateRequestId(): string {
  return `pages-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/**
 * Write a pages_request to outbound.db and wait for the matching
 * pages_response on inbound.db. Default timeout 60s — pages_export_pdf can
 * take a while.
 */
async function requestVerb(
  verb: string,
  args: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const requestId = generateRequestId();
  writeMessageOut({
    id: requestId,
    kind: 'system',
    content: JSON.stringify({ action: 'pages_request', requestId, verb, args }),
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inDb = openInboundDb();
    try {
      const row = inDb
        .prepare("SELECT id, content FROM messages_in WHERE content LIKE ?")
        .get(`%"requestId":"${requestId}"%`) as { id: string; content: string } | undefined;

      if (row) {
        // Mark as completed so the regular poll loop ignores it.
        getOutboundDb()
          .prepare(
            "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'completed', datetime('now'))",
          )
          .run(row.id);

        const parsed = JSON.parse(row.content) as {
          type?: string;
          frame?: { ok: boolean; result?: unknown; error?: string };
        };
        return parsed.frame ?? { ok: false, error: 'malformed response' };
      }
    } finally {
      inDb.close();
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, error: `pages request timed out after ${timeoutMs}ms` };
}

function pagesTool(name: string, description: string, schema: Record<string, unknown>): McpToolDefinition {
  return {
    tool: {
      name,
      description,
      inputSchema: {
        type: 'object' as const,
        ...(schema as { properties: Record<string, unknown>; required?: string[] }),
      },
    },
    async handler(args) {
      log(`${name} ${JSON.stringify(args).slice(0, 200)}`);
      const frame = await requestVerb(name, args as Record<string, unknown>);
      if (!frame.ok) return err(`${name} failed: ${frame.error ?? 'unknown error'}`);
      if (frame.result === undefined || frame.result === null) return ok(`${name} ok`);
      if (typeof frame.result === 'string') return ok(frame.result);
      return ok(JSON.stringify(frame.result, null, 2));
    },
  };
}

const PARAGRAPH_SCHEMA = {
  type: 'object' as const,
  properties: {
    text: { type: 'string' },
    style: {
      type: 'string',
      enum: ['title', 'heading', 'subheading', 'heading-2', 'heading-3', 'body', 'caption'],
    },
    font: { type: 'string' },
    fontSize: { type: 'number' },
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    underline: { type: 'boolean' },
    alignment: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
    colorHex: { type: 'string', description: '6 hex digits, no leading #' },
  },
  required: ['text'],
};

const FORMATTING_SCHEMA = {
  type: 'object' as const,
  properties: {
    style: PARAGRAPH_SCHEMA.properties.style,
    font: PARAGRAPH_SCHEMA.properties.font,
    fontSize: PARAGRAPH_SCHEMA.properties.fontSize,
    bold: PARAGRAPH_SCHEMA.properties.bold,
    italic: PARAGRAPH_SCHEMA.properties.italic,
    underline: PARAGRAPH_SCHEMA.properties.underline,
    alignment: PARAGRAPH_SCHEMA.properties.alignment,
    colorHex: PARAGRAPH_SCHEMA.properties.colorHex,
  },
};

export const pagesCreate = pagesTool(
  'pages_create',
  'Create a new Apple Pages document with formatted paragraphs and save it under the group folder.',
  {
    properties: {
      filename: { type: 'string', description: 'Filename (with or without .pages extension)' },
      paragraphs: { type: 'array', items: PARAGRAPH_SCHEMA },
    },
    required: ['filename', 'paragraphs'],
  },
);

export const pagesOpen = pagesTool('pages_open', 'Open an existing Apple Pages document (activates Pages.app).', {
  properties: { filename: { type: 'string' } },
  required: ['filename'],
});

export const pagesSave = pagesTool('pages_save', 'Save the currently open document.', {
  properties: { filename: { type: 'string' } },
  required: ['filename'],
});

export const pagesClose = pagesTool('pages_close', 'Close a document. Pass save=false to discard changes.', {
  properties: { filename: { type: 'string' }, save: { type: 'boolean' } },
  required: ['filename'],
});

export const pagesGetText = pagesTool(
  'pages_get_text',
  'Return the plain-text body of a Pages document. Opens it if not already open.',
  { properties: { filename: { type: 'string' } }, required: ['filename'] },
);

export const pagesInsertText = pagesTool(
  'pages_insert_text',
  'Insert text into a Pages document. position = "start" | "end" | "replace-all" (default "end").',
  {
    properties: {
      filename: { type: 'string' },
      text: { type: 'string' },
      opts: {
        type: 'object',
        properties: {
          position: { type: 'string', enum: ['start', 'end', 'replace-all'] },
          formatting: FORMATTING_SCHEMA,
        },
      },
    },
    required: ['filename', 'text'],
  },
);

export const pagesReplaceText = pagesTool(
  'pages_replace_text',
  'Literal find & replace (all occurrences, no regex) in a Pages document.',
  {
    properties: {
      filename: { type: 'string' },
      find: { type: 'string' },
      replaceWith: { type: 'string' },
    },
    required: ['filename', 'find', 'replaceWith'],
  },
);

export const pagesFormatParagraph = pagesTool(
  'pages_format_paragraph',
  'Apply formatting to the Nth paragraph (1-indexed).',
  {
    properties: {
      filename: { type: 'string' },
      paragraphNumber: { type: 'integer', minimum: 1 },
      formatting: FORMATTING_SCHEMA,
    },
    required: ['filename', 'paragraphNumber', 'formatting'],
  },
);

export const pagesExportPdf = pagesTool('pages_export_pdf', 'Export to PDF alongside the .pages file.', {
  properties: { filename: { type: 'string' }, outFilename: { type: 'string' } },
  required: ['filename'],
});

export const pagesList = pagesTool('pages_list', 'List .pages and .pdf files in the group folder.', {
  properties: {},
});

export const pagesDelete = pagesTool('pages_delete', 'Delete a .pages or .pdf file from the group folder.', {
  properties: { filename: { type: 'string' } },
  required: ['filename'],
});

registerTools([
  pagesCreate,
  pagesOpen,
  pagesSave,
  pagesClose,
  pagesGetText,
  pagesInsertText,
  pagesReplaceText,
  pagesFormatParagraph,
  pagesExportPdf,
  pagesList,
  pagesDelete,
]);
