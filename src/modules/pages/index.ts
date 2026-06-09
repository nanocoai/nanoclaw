/**
 * Pages module — host-side bridge for the container Pages MCP tool.
 *
 * Container side (mcp-tools/pages.ts) writes:
 *   kind = 'system'
 *   content = { action: 'pages_request', requestId, verb, args }
 *
 * The delivery poll picks it up and calls our handler below, which
 * dispatches to ./applescript.ts and writes a response back to
 * inbound.db with:
 *   kind = 'system'
 *   content = { type: 'pages_response', requestId, frame: { ok, ...result } }
 *
 * The container side polls inbound.db for a matching requestId. Mirrors
 * the cli_request / cli_response shape in ../../cli/delivery-action.ts.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { insertMessage } from '../../db/session-db.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import * as pages from './applescript.js';

type VerbHandler = (folder: string, args: Record<string, unknown>) => Promise<unknown> | unknown;

const VERBS: Record<string, VerbHandler> = {
  pages_create: (folder, a) =>
    pages.createDocument(folder, a.filename as string, (a.paragraphs as pages.ParagraphSpec[]) ?? []),
  pages_open: (folder, a) => pages.openDocument(folder, a.filename as string),
  pages_save: (folder, a) => pages.saveDocument(folder, a.filename as string),
  pages_close: (folder, a) => pages.closeDocument(folder, a.filename as string, (a.save as boolean) ?? true),
  pages_get_text: (folder, a) => pages.getDocumentText(folder, a.filename as string),
  pages_insert_text: (folder, a) =>
    pages.insertText(folder, a.filename as string, a.text as string, (a.opts as pages.InsertOptions) ?? {}),
  pages_replace_text: (folder, a) =>
    pages.replaceText(folder, a.filename as string, a.find as string, a.replaceWith as string),
  pages_format_paragraph: (folder, a) =>
    pages.formatParagraph(
      folder,
      a.filename as string,
      a.paragraphNumber as number,
      (a.formatting as Omit<pages.ParagraphSpec, 'text'>) ?? {},
    ),
  pages_export_pdf: (folder, a) => pages.exportToPdf(folder, a.filename as string, a.outFilename as string),
  pages_list: (folder) => pages.listDocuments(folder),
  pages_delete: (folder, a) => {
    pages.deleteDocument(folder, a.filename as string);
    return { ok: true };
  },
};

registerDeliveryAction('pages_request', async (content, session, inDb) => {
  const requestId = content.requestId as string;
  const verb = content.verb as string;
  const args = (content.args as Record<string, unknown>) ?? {};

  if (!requestId || !verb) {
    log.warn('pages_request missing requestId or verb', { sessionId: session.id });
    return;
  }

  const handler = VERBS[verb];
  const group = getAgentGroup(session.agent_group_id);
  if (!group) {
    writeResponse(inDb, requestId, { ok: false, error: `unknown agent group: ${session.agent_group_id}` });
    return;
  }
  if (!handler) {
    writeResponse(inDb, requestId, { ok: false, error: `unknown pages verb: ${verb}` });
    return;
  }

  log.info('Pages request from agent', { verb, requestId, sessionId: session.id, folder: group.folder });

  try {
    const result = await handler(group.folder, args);
    writeResponse(inDb, requestId, { ok: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('Pages request failed', { verb, requestId, err: msg });
    writeResponse(inDb, requestId, { ok: false, error: msg });
  }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function writeResponse(inDb: any, requestId: string, frame: { ok: boolean; result?: unknown; error?: string }): void {
  insertMessage(inDb, {
    id: `pages-resp-${requestId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ type: 'pages_response', requestId, frame }),
    processAfter: null,
    recurrence: null,
    trigger: 0,
  });
}
