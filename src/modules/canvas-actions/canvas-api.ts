/**
 * Slack canvas API calls for the canvas-actions module — sections.lookup,
 * canvases.edit, and the HTML read-back path (files.info →
 * url_private_download).
 *
 * Safety property (09: whole-doc `replace` confirmed destructive): the
 * `CanvasChange` type makes an unsectioned `replace` UNREPRESENTABLE —
 * `replace` and `insert_after` structurally require a sectionId, and
 * `editCanvas` re-checks it at runtime as belt and braces. `insert_at_end`
 * (append) is the only sectionless operation this module can emit.
 *
 * JSON-body Web API calls go through `slackCall` in src/channels/slack-lib.ts
 * (same message shape: `slack <method> failed: <error>`). The files.info
 * read-back stays local — it is a legacy GET-arg method (no JSON body), and
 * the download itself is a raw file fetch, not a Web API call. Error strings
 * from Slack are safe to surface; token values never are — tokens travel
 * only in Authorization headers.
 */
import { slackCall } from '../../channels/slack-lib.js';

const SLACK_API = 'https://slack.com/api';

export type CanvasChange =
  | { operation: 'insert_at_end'; markdown: string }
  | { operation: 'replace' | 'insert_after'; sectionId: string; markdown: string }
  | { operation: 'delete'; sectionId: string };

/**
 * canvases.sections.lookup by contains_text. Returns the FIRST matching
 * section id, or null when nothing matches. Ids are ephemeral (`temp:` — 09):
 * look up fresh before every edit, never cache.
 */
export async function lookupCanvasSection(
  token: string,
  canvasId: string,
  containsText: string,
): Promise<string | null> {
  const json = await slackCall(
    token,
    'canvases.sections.lookup',
    { canvas_id: canvasId, criteria: { contains_text: containsText } },
    'canvas-section-lookup',
  );
  const sections = Array.isArray(json.sections) ? (json.sections as Array<Record<string, unknown>>) : [];
  const first = sections[0];
  return typeof first?.id === 'string' && first.id ? first.id : null;
}

/** canvases.edit with exactly one change — the API rejects multi-change
 *  arrays ("no more than 1 items allowed", live-probed), so region-scoped
 *  edits are sequences of calls. Throws on any Slack error. */
export async function editCanvas(token: string, canvasId: string, change: CanvasChange): Promise<void> {
  let payload: Record<string, unknown>;
  if (change.operation === 'insert_at_end') {
    payload = {
      operation: 'insert_at_end',
      document_content: { type: 'markdown', markdown: change.markdown },
    };
  } else if (change.operation === 'delete') {
    if (!change.sectionId) {
      throw new Error('canvases.edit refused: delete without a resolved section_id');
    }
    payload = { operation: 'delete', section_id: change.sectionId };
  } else {
    // Runtime re-check of the structural guarantee: a replace/insert_after
    // without a section id must never reach the wire (whole-doc replace).
    if (!change.sectionId) {
      throw new Error(`canvases.edit refused: ${change.operation} without a resolved section_id`);
    }
    payload = {
      operation: change.operation,
      section_id: change.sectionId,
      document_content: { type: 'markdown', markdown: change.markdown },
    };
  }
  await slackCall(token, 'canvases.edit', { canvas_id: canvasId, changes: [payload] }, 'canvas-edit');
}

/**
 * Read a canvas back as readable text: files.info → url_private_download →
 * HTML → stripped text (09: the download carries the full body; section ids
 * live in tag attributes and are stripped along with the tags). Capped at
 * `maxChars`. Throws on any failure.
 */
export async function fetchCanvasText(token: string, canvasId: string, maxChars = 8000): Promise<string> {
  const text = htmlToReadableText(await fetchCanvasHtml(token, canvasId));
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated at ${maxChars} chars]` : text;
}

/**
 * The raw canvas HTML export (files.info → url_private_download). Block ids
 * (`temp:C:…`) ride the tag attributes — this is the addressing source for
 * region-scoped edits. Throws on any failure.
 */
export async function fetchCanvasHtml(token: string, canvasId: string): Promise<string> {
  // files.info is a legacy GET-arg method (does not accept JSON bodies).
  let infoRes: Response;
  try {
    infoRes = await fetch(`${SLACK_API}/files.info?file=${encodeURIComponent(canvasId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`slack files.info failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let info: Record<string, unknown>;
  try {
    info = (await infoRes.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`slack files.info failed: HTTP ${infoRes.status}, non-JSON body`);
  }
  if (info.ok !== true) {
    throw new Error(`slack files.info failed: ${String(info.error ?? `HTTP ${infoRes.status}`)}`);
  }
  const file = info.file as Record<string, unknown> | undefined;
  const url = typeof file?.url_private_download === 'string' ? file.url_private_download : null;
  if (!url) throw new Error('slack files.info failed: no url_private_download on file');

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`canvas download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`canvas download failed: HTTP ${res.status}`);
  return res.text();
}

// ── Block/region model of the canvas HTML ──
//
// Live-observed platform fact (post-e2e fix): a Slack canvas "section" is an
// individual BLOCK — a heading and the paragraphs/lists under it are separate
// sections with separate ids. A naive `replace` on a heading match therefore
// replaces only the heading block and leaves the old body behind (observed as
// a duplicated section). The helpers below rebuild the heading-scoped REGION
// from the HTML export so handlers can edit whole sections.

export interface CanvasBlock {
  tag: 'h1' | 'h2' | 'h3' | 'p' | 'ul' | 'ol' | 'table' | 'blockquote';
  /** Slack section id (`temp:C:…`) when the block carries one. */
  id: string | null;
  /** Inner text for headings (tag-stripped, entity-decoded); '' otherwise. */
  text: string;
  /**
   * List blocks only: the per-item `<span id=…>` ids. Live-probed platform
   * fact: a list's addressable sections are its ITEMS — `canvases.edit`
   * silently no-ops (ok:true, nothing happens) when given the `<ul>`/`<ol>`
   * wrapper id, while the item span ids (the same ids sections.lookup
   * returns) delete and anchor correctly. Deleting every item collapses the
   * list wrapper automatically.
   */
  itemIds?: string[];
  /**
   * List blocks only: item ids whose `<li>` carries `class='checked'` — a
   * ticked checklist item. Live-probed: `- [x]` markdown is IGNORED by
   * canvases.edit (insert, section replace, and item replace all land
   * unticked), so tick state is UI-only and a section rewrite RESETS it.
   */
  checkedItemIds?: string[];
}

const BLOCK_TAG_RE = /<(\/?)(h1|h2|h3|p|ul|ol|table|blockquote)\b([^>]*)>/gi;

function idFromAttrs(attrs: string): string | null {
  const m = /\bid=["']([^"']+)["']/.exec(attrs);
  return m ? m[1] : null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'");
}

/**
 * Top-level blocks of a canvas HTML export, in document order. Nested
 * structure folds into its outermost block: everything inside a table is the
 * table, nested lists are the outermost ul/ol, a blockquote is addressed by
 * its inner `<p>` id (the quote tag itself carries none).
 */
export function parseCanvasBlocks(html: string): CanvasBlock[] {
  const blocks: CanvasBlock[] = [];
  let tableDepth = 0;
  let listDepth = 0;
  let openBlockquote: CanvasBlock | null = null;
  let openList: CanvasBlock | null = null;
  let openListStart = 0;
  BLOCK_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_TAG_RE.exec(html)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase() as CanvasBlock['tag'];
    const attrs = m[3] ?? '';
    if (closing) {
      if (tag === 'table') tableDepth = Math.max(0, tableDepth - 1);
      else if (tag === 'ul' || tag === 'ol') {
        listDepth = Math.max(0, listDepth - 1);
        if (listDepth === 0 && openList) {
          // The list's addressable sections are its item spans (see
          // CanvasBlock.itemIds) — harvest them from the outermost extent,
          // plus which items are ticked (li class='checked'; li id == span id).
          const inner = html.slice(openListStart, m.index);
          openList.itemIds = [...inner.matchAll(/<span id=["']([^"']+)["']/g)].map((sm) => sm[1]);
          openList.checkedItemIds = [...inner.matchAll(/<li\b[^>]*>/g)]
            .filter((lm) => /\bclass=["'][^"']*\bchecked\b/.test(lm[0]))
            .map((lm) => /\bid=["']([^"']+)["']/.exec(lm[0])?.[1])
            .filter((id): id is string => Boolean(id));
          openList = null;
        }
      } else if (tag === 'blockquote') openBlockquote = null;
      continue;
    }
    if (tag === 'table') {
      if (tableDepth === 0) blocks.push({ tag, id: idFromAttrs(attrs), text: '' });
      tableDepth++;
      continue;
    }
    if (tableDepth > 0) {
      if (tag === 'ul' || tag === 'ol') listDepth++;
      continue; // cell contents are part of the table block
    }
    if (tag === 'ul' || tag === 'ol') {
      if (listDepth === 0) {
        openList = { tag, id: idFromAttrs(attrs), text: '', itemIds: [] };
        openListStart = BLOCK_TAG_RE.lastIndex;
        blocks.push(openList);
      }
      listDepth++;
      continue;
    }
    if (listDepth > 0) continue; // paragraphs inside list items are part of the list
    if (tag === 'blockquote') {
      openBlockquote = { tag, id: idFromAttrs(attrs), text: '' };
      blocks.push(openBlockquote);
      continue;
    }
    if (tag === 'p') {
      const id = idFromAttrs(attrs);
      if (openBlockquote) {
        if (!openBlockquote.id) openBlockquote.id = id;
        continue;
      }
      blocks.push({ tag, id, text: '' });
      continue;
    }
    // h1-h3: capture inner text up to the matching close tag.
    const close = html.indexOf(`</${tag}>`, BLOCK_TAG_RE.lastIndex);
    const inner = close === -1 ? '' : html.slice(BLOCK_TAG_RE.lastIndex, close);
    blocks.push({ tag, id: idFromAttrs(attrs), text: decodeEntities(inner.replace(/<[^>]+>/g, '')).trim() });
  }
  return blocks;
}

export interface HeadingRegion {
  headingId: string;
  /** Ids of the region's body blocks (heading excluded), document order. */
  bodyIds: string[];
  /** Last id-bearing block of the region (the heading when the body is empty). */
  lastId: string;
  /** True when a body block carried no id (it cannot be edited or deleted). */
  hasUnaddressableBlocks: boolean;
  /** Ticked checklist items in the region body — state a rewrite will reset. */
  checkedItemCount: number;
}

/**
 * Resolve a heading-scoped region: the h1-h3 whose text matches `sectionText`
 * (exact first, then contains — both case-insensitive) plus every following
 * block up to the next heading. Null when no heading matches — the caller
 * falls back to single-block sections.lookup behavior.
 */
export function resolveHeadingRegion(html: string, sectionText: string): HeadingRegion | null {
  const wanted = sectionText.trim().toLowerCase();
  if (!wanted) return null;
  const blocks = parseCanvasBlocks(html);
  const isHeading = (b: CanvasBlock): boolean => b.tag === 'h1' || b.tag === 'h2' || b.tag === 'h3';
  let start = blocks.findIndex((b) => isHeading(b) && b.id !== null && b.text.toLowerCase() === wanted);
  if (start === -1) {
    start = blocks.findIndex((b) => isHeading(b) && b.id !== null && b.text.toLowerCase().includes(wanted));
  }
  if (start === -1) return null;
  const headingId = blocks[start].id as string;
  const bodyIds: string[] = [];
  let lastId = headingId;
  let hasUnaddressableBlocks = false;
  let checkedItemCount = 0;
  for (let i = start + 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (isHeading(b)) break;
    if (b.tag === 'ul' || b.tag === 'ol') {
      // Lists are addressed per ITEM: the wrapper ul/ol id is a silent no-op
      // for canvases.edit, so a list contributes its item span ids instead.
      if (b.itemIds && b.itemIds.length > 0) {
        bodyIds.push(...b.itemIds);
        lastId = b.itemIds[b.itemIds.length - 1];
      } else {
        hasUnaddressableBlocks = true;
      }
      checkedItemCount += b.checkedItemIds?.length ?? 0;
      continue;
    }
    if (b.id) {
      bodyIds.push(b.id);
      lastId = b.id;
    } else {
      hasUnaddressableBlocks = true;
    }
  }
  return { headingId, bodyIds, lastId, hasUnaddressableBlocks, checkedItemCount };
}

/**
 * Best-effort HTML → readable text: headings keep their markdown level,
 * list items get bullets, checklist items render as [ ] / [x], table cells
 * separate with pipes, all other tags (and their id attributes) drop.
 *
 * Checklists in the live export are NOT inputs: they are
 * `<div data-section-style='7'>` wrappers whose `<li>`s carry
 * `class='checked'` when ticked (live-observed — an agent that can't see
 * tick states re-issues edits it can't verify).
 */
export function htmlToReadableText(html: string): string {
  const text = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<div[^>]*data-section-style=["']?7["']?[^>]*>([\s\S]*?)<\/div>/gi, (_m, inner: string) =>
      inner.replace(/<li\b[^>]*>/gi, (tag) => (/\bclass=["'][^"']*\bchecked\b/i.test(tag) ? '\n- [x] ' : '\n- [ ] ')),
    )
    .replace(/<input\b[^>]*>/gi, (tag) => {
      if (!/type\s*=\s*["']?checkbox/i.test(tag)) return '';
      return /\bchecked\b/i.test(tag) ? '[x] ' : '[ ] ';
    })
    .replace(/<h1\b[^>]*>/gi, '\n# ')
    .replace(/<h2\b[^>]*>/gi, '\n## ')
    .replace(/<h3\b[^>]*>/gi, '\n### ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<blockquote\b[^>]*>/gi, '\n> ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<\/(h1|h2|h3|p|li|div|tr|table|ul|ol|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'");
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
