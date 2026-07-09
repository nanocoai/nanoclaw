/**
 * Native rich rendering for outbound Telegram messages (Bot API 10.1
 * `sendRichMessage`).
 *
 * MarkdownV2 (the normal send path) cannot express several constructs an agent
 * naturally produces: GFM **tables**, ATX **headings**, collapsible
 * **`<details>`** folds, horizontal **dividers**, **block math** and GFM
 * **task lists**. Under MarkdownV2 these degrade (a table becomes an unreadable
 * monospace block, headings vanish, etc.).
 *
 * Bot API 10.1 added `sendRichMessage`, which renders RAW markdown natively —
 * real, selectable tables/headings/folds on supporting clients. We auto-route a
 * message to the rich path ONLY when it carries one of those
 * MarkdownV2-impossible constructs, and fall back transparently to the normal
 * path on ANY failure (unsupported endpoint, parser error, oversize) so a
 * message is never lost. Plain bold/italic/links/bullets/blockquotes render fine
 * under MarkdownV2 and stay on the proven path.
 *
 * Toggles (both default ON): `TELEGRAM_RICH_TABLES` (tables) and
 * `TELEGRAM_RICH_CONSTRUCTS` (headings/details/dividers/math/task-lists).
 */
import type { RawMessage } from 'chat';

import { log } from '../log.js';
import { splitForLimit } from './chat-sdk-bridge.js';

/** Effective outbound cap for the normal (MarkdownV2) path — mirrors the
 * bridge's maxTextLength for Telegram. Used when a rich-routed message falls
 * back: the adapter would otherwise silently truncate anything longer. */
export const TELEGRAM_PLAIN_MAX_CHARS = 4000;

/** A GFM table divider line, e.g. `|---|:--:|`, `--- | ---`. Requires ≥2 columns. */
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

/** Telegram Bot API 10.1 raw rich-message char cap. */
export const RICH_MESSAGE_MAX_CHARS = 32768;

/**
 * Strip fenced code blocks (``` … ```) and inline code spans (` … `) before
 * construct-detection. A message that merely *discusses* a construct inside code
 * — e.g. a sentence containing `<details>` or a divider shown in backticks —
 * must NOT route to the rich path (which would make the whole message
 * non-copyable on Telegram clients). Order: fenced first, then inline.
 */
export function stripCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

/**
 * True when the message's primary rich construct is a GFM pipe table. Needs a
 * real divider line (pipe/colon/dash structure with a run of ≥2 hyphens — this
 * rejects ambiguous single-dash rows like `| - | - |` that appear in prose).
 * Constructs requiring the broader opt-in are excluded here (handled by
 * hasRichOnlyConstruct).
 */
export function isTablePrimary(markdown: string): boolean {
  const md = stripCode(markdown);
  if (!md || md.indexOf('|') === -1) return false;
  const lines = md.split('\n');
  if (!lines.some((l) => TABLE_SEPARATOR_RE.test(l) && /-{2,}/.test(l))) return false;
  if (/(^|\n)\s*[-*]\s+\[[ xX]\]\s+/.test(md)) return false; // task list
  if (/(^|\n)\s*<\/?(details|summary)\b/i.test(md)) return false; // collapsible
  if (md.includes('$$')) return false; // block math
  return true;
}

/**
 * True when the message carries a construct MarkdownV2 simply CANNOT render but
 * Bot API 10.1 rich messages can: ATX headings, collapsible `<details>`,
 * horizontal dividers, block math, GFM task lists. Plain
 * bold/italic/links/bullets/blockquotes are intentionally NOT matched — that
 * keeps ordinary chat on the proven (copyable) MarkdownV2 path and only routes
 * messages that genuinely gain from the rich renderer.
 */
export function hasRichOnlyConstruct(markdown: string): boolean {
  if (!markdown) return false;
  const md = stripCode(markdown);
  if (/(^|\n)#{1,6}[ \t]+\S/.test(md)) return true; // ATX heading
  if (/<details\b/i.test(md)) return true; // collapsible fold
  if (/(^|\n)[ \t]*([-*_])\2{2,}[ \t]*(\n|$)/.test(md)) return true; // hr divider --- *** ___
  if (md.includes('$$')) return true; // block math
  if (/(^|\n)[ \t]*[-*][ \t]+\[[ xX]\][ \t]+/.test(md)) return true; // GFM task list
  return false;
}

/**
 * Telegram Desktop crashes on block math nested INSIDE a `<details>` fold
 * (upstream chat-adapter issue). Such messages skip the rich path and degrade to
 * MarkdownV2 rather than crash the client.
 */
export function hasTDesktopCrashShape(markdown: string): boolean {
  const block = stripCode(markdown).match(/<details\b[^>]*>[\s\S]*?<\/details>/i);
  return block ? block[0].includes('$$') : false;
}

/** Read the `TELEGRAM_RICH_TABLES` toggle (default ON). */
export function richTablesEnabled(env: Record<string, string | undefined>): boolean {
  const v = (env.TELEGRAM_RICH_TABLES ?? '').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off' && v !== 'no';
}

/** Read the `TELEGRAM_RICH_CONSTRUCTS` toggle (default ON) — broad rich routing. */
export function richConstructsEnabled(env: Record<string, string | undefined>): boolean {
  const v = (env.TELEGRAM_RICH_CONSTRUCTS ?? '').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off' && v !== 'no';
}

/**
 * True when `markdown` would route to the rich path under these toggles: carries
 * a rich-only construct, fits the rich char cap, and doesn't hit the TDesktop
 * crash shape. Shared by wrapTelegramRichSend and the bridge's per-message
 * chunk-limit hook so the two can never disagree on what counts as "rich" —
 * a rich-routable message must be chunked against RICH_MESSAGE_MAX_CHARS, not
 * the 4k plain-text limit.
 */
export function richRoutable(markdown: string, opts: { richTables: boolean; richConstructs: boolean }): boolean {
  return (
    markdown.length > 0 &&
    markdown.length <= RICH_MESSAGE_MAX_CHARS &&
    ((opts.richTables && isTablePrimary(markdown)) ||
      (opts.richConstructs && hasRichOnlyConstruct(markdown) && !hasTDesktopCrashShape(markdown)))
  );
}

/**
 * The endpoint itself is unavailable (a Bot API server without 10.1) — as
 * opposed to a per-message rejection. Callers latch rich OFF on these so they
 * don't pay a failed roundtrip on every send. NOTE: must NOT key off a bare
 * "rich" substring — our own error text contains "RichMessage", which would
 * misclassify every per-message 400 ("chat not found" etc.) as a capability
 * failure and latch rich off process-wide.
 */
export function isRichCapabilityError(e: unknown): boolean {
  const code = (e as { errorCode?: number })?.errorCode;
  const msg = String((e as { message?: string })?.message ?? e);
  if (code === 404) return true;
  return /unknown method|method not found|method is not (available|supported)/i.test(msg);
}

/**
 * Resolve a Telegram `chat_id` from the bridge thread id. The bridge passes
 * `tid` = `telegram:<chatId>`; the normal adapter strips the prefix internally,
 * and the rich endpoint needs the same. Returns a number for numeric ids.
 */
export function chatIdFromTid(tid: string): number | string {
  const raw = tid.includes(':') ? tid.split(':').slice(1).join(':') : tid;
  return /^-?\d+$/.test(raw) ? Number(raw) : raw;
}

export interface RichSendDeps {
  token: string;
  fetchImpl?: typeof fetch;
}

/**
 * Send `markdown` via Bot API 10.1 `sendRichMessage`. Returns a RawMessage in
 * the shape the chat-sdk bridge expects from `adapter.postMessage`. Throws on a
 * non-`ok` Bot API response (caller decides fallback).
 */
export async function sendRichMessageRaw(
  deps: RichSendDeps,
  tid: string,
  markdown: string,
  replyToMessageId?: number,
): Promise<RawMessage<unknown>> {
  const doFetch = deps.fetchImpl ?? fetch;
  const payload: Record<string, unknown> = {
    chat_id: chatIdFromTid(tid),
    // RAW markdown — never the MarkdownV2-escaped form, which would destroy pipes.
    rich_message: { markdown },
  };
  if (replyToMessageId != null) {
    payload.reply_parameters = { message_id: replyToMessageId };
  }
  const res = await doFetch(`https://api.telegram.org/bot${deps.token}/sendRichMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = (await res.json()) as {
    ok: boolean;
    result?: { message_id?: number };
    description?: string;
    error_code?: number;
  };
  if (!json.ok || !json.result || json.result.message_id == null) {
    const err = new Error(`sendRichMessage failed: ${json.error_code ?? res.status} ${json.description ?? ''}`.trim());
    (err as { errorCode?: number }).errorCode = json.error_code ?? res.status;
    throw err;
  }
  return { id: String(json.result.message_id), raw: json.result as unknown, threadId: tid };
}

export interface RichWrapDeps {
  token: string;
  richTables: boolean;
  richConstructs: boolean;
  /**
   * Sanitizer for the plain (legacy Markdown parse mode) path — applied to
   * sends that do NOT route rich, and to message edits. Must NOT be applied
   * upstream of this wrapper (e.g. via the bridge's transformOutboundText):
   * the rich path needs the agent's raw markdown, and the sanitizer's
   * `- item` → `• item` rewrite turns markdown lists into soft-wrapped prose
   * that the rich renderer collapses onto a single line.
   */
  sanitizeForPlain?: (text: string) => string;
}

/**
 * Wrap an adapter's `postMessage` so messages carrying a MarkdownV2-impossible
 * construct route to `sendRichMessage` (with the agent's RAW markdown), with
 * transparent fallback to the original send on any failure. A genuine
 * capability error latches rich OFF for the process.
 *
 * The plain path (non-rich sends, rich fallbacks, and message edits) gets
 * `deps.sanitizeForPlain` applied here — NOT in the bridge — so the two paths
 * can receive different text: raw markdown for the rich renderer, sanitized
 * text for the legacy Markdown parse mode.
 */
export function wrapTelegramRichSend<
  A extends {
    postMessage: (...args: any[]) => Promise<any>;
    editMessage?: (...args: any[]) => Promise<any>;
  },
>(adapter: A, deps: RichWrapDeps): A {
  const sanitize = deps.sanitizeForPlain ?? ((t: string) => t);
  const origPost = adapter.postMessage.bind(adapter) as (tid: string, m: any) => Promise<any>;
  const postPlain = (tid: string, message: any, md: string): Promise<any> =>
    origPost(tid, md ? { ...message, markdown: sanitize(md) } : message);
  let richDisabled = false;
  adapter.postMessage = (async (tid: string, message: any): Promise<any> => {
    const md = typeof message?.markdown === 'string' ? message.markdown : '';
    const hasMedia = !!(message?.attachments?.length || message?.files?.length);
    const route = !richDisabled && !hasMedia && richRoutable(md, deps);
    if (route) {
      try {
        // RAW markdown — the rich renderer needs real `- ` list items etc.
        return await sendRichMessageRaw({ token: deps.token }, tid, md);
      } catch (re: unknown) {
        const errMsg = String((re as { message?: string })?.message ?? re);
        if (isRichCapabilityError(re)) {
          richDisabled = true;
          log.warn('Telegram sendRichMessage unsupported — latching rich OFF, using MarkdownV2', { tid, err: errMsg });
        } else {
          log.warn('Telegram sendRichMessage failed — falling back to MarkdownV2', { tid, err: errMsg });
        }
        // fall through to the normal send path
      }
      // Rich-routable messages bypass the bridge's 4k chunking (the bridge's
      // per-message limit hook allows up to RICH_MESSAGE_MAX_CHARS), so on
      // fallback anything longer than the plain-path cap must be split here —
      // the underlying adapter would silently truncate it otherwise.
      if (md.length > TELEGRAM_PLAIN_MAX_CHARS) {
        const parts = splitForLimit(md, TELEGRAM_PLAIN_MAX_CHARS);
        let first: RawMessage<unknown> | undefined;
        for (let i = 0; i < parts.length; i++) {
          const res = await postPlain(tid, message, parts[i]);
          if (i === 0) first = res;
        }
        return first;
      }
    }
    return await postPlain(tid, message, md);
  }) as A['postMessage'];
  // Edits always take the plain path — sanitize them here since the bridge
  // no longer does.
  if (deps.sanitizeForPlain && typeof adapter.editMessage === 'function') {
    const origEdit = adapter.editMessage.bind(adapter) as (tid: string, id: string, m: any) => Promise<any>;
    adapter.editMessage = (async (tid: string, id: string, m: any): Promise<any> => {
      const md = typeof m?.markdown === 'string' ? m.markdown : '';
      return origEdit(tid, id, md ? { ...m, markdown: sanitize(md) } : m);
    }) as A['editMessage'];
  }
  return adapter;
}
