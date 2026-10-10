/**
 * Message formatting.
 *
 * Mattermost renders GitHub-flavoured markdown natively, so the Chat SDK's
 * markdown AST is very nearly the wire format: `renderFormatted` is
 * `stringifyMarkdown`, and `parseMessage` is `parseMarkdown`. No dialect
 * conversion layer is needed here (Slack needs one for mrkdwn; we do not).
 */

import {
  convertEmojiPlaceholders,
  defaultEmojiResolver,
  isCardElement,
  markdownToPlainText,
  parseMarkdown,
  stringifyMarkdown,
} from 'chat';
import type {
  AdapterPostableMessage,
  ButtonElement,
  CardChild,
  CardElement,
  EmojiValue,
  FileUpload,
  FormattedContent,
  RadioSelectElement,
  SelectElement,
  TableElement,
} from 'chat';

import type {
  MattermostActionStyle,
  MattermostMessageAttachment,
  MattermostPost,
  MattermostPostAction,
  MattermostPostProps,
} from './types.js';

/**
 * Resolve the SDK's emoji placeholders to Mattermost shortcodes.
 *
 * `EmojiValue.toString()` yields `{{emoji:name}}`, so any emoji an agent or
 * the host interpolates into a string reaches the adapter as that literal.
 * Mattermost's emoji set uses Slack-style names, so the Slack projection is
 * the right one (`:white_check_mark:`).
 */
export function emojify(text: string): string {
  return convertEmojiPlaceholders(text, 'slack');
}

/** Render a Chat SDK markdown AST to a Mattermost message string. */
export function renderFormatted(content: FormattedContent): string {
  return emojify(stringifyMarkdown(content));
}

/** Render a `TableElement` as a GitHub-flavoured markdown table, which Mattermost renders natively. */
export function renderGfmTable(table: TableElement): string {
  const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const width = Math.max(table.headers.length, ...table.rows.map((row) => row.length));
  if (width === 0) {
    return '';
  }
  const pad = (row: string[]) => [...row, ...Array<string>(width - row.length).fill('')];
  const align = (index: number) => {
    switch (table.align?.[index]) {
      case 'center':
        return ':---:';
      case 'right':
        return '---:';
      default:
        return '---';
    }
  };
  const lines = [
    `| ${pad(table.headers).map(cell).join(' | ')} |`,
    `| ${Array.from({ length: width }, (_, index) => align(index)).join(' | ')} |`,
    ...table.rows.map((row) => `| ${pad(row).map(cell).join(' | ')} |`),
  ];
  return lines.join('\n');
}

/**
 * Markdown for the card children the SDK's own fallback renderer drops or
 * flattens: images and dividers (it returns null for both), links (it yields
 * `label (url)`, not a link), fields and tables (it yields plain text where
 * Mattermost can render the real thing). `null` defers to the SDK helper.
 */
function richChildToMarkdown(child: CardChild): string | null {
  switch (child.type) {
    case 'image':
      return `![${child.alt ?? ''}](${child.url})`;
    case 'divider':
      return '---';
    case 'link':
      return `[${child.label}](${child.url})`;
    case 'fields':
      return child.children.map((field) => `**${field.label}**: ${field.value}`).join('\n');
    case 'table':
      return renderGfmTable(child);
    default:
      return null;
  }
}

/** Plain-text projection of a Mattermost message body. */
export function toPlainTextFromMarkdown(markdown: string): string {
  return markdownToPlainText(markdown);
}

/** Parse a Mattermost message body into the Chat SDK's markdown AST. */
export function toAst(markdown: string): FormattedContent {
  return parseMarkdown(markdown);
}

/**
 * Degrade a `CardElement` to plain markdown.
 *
 * This is the no-callback-URL path: without an externally reachable URL for
 * Mattermost to POST clicks back to, a button cannot be bound to anything, so
 * buttons become a bullet list of their labels. When a callback URL *is*
 * configured, {@link cardToAttachment} is used instead.
 */
/**
 * Tolerant read of a `description` field that is not part of `CardElement`.
 *
 * Agent-built cards frequently arrive as `{ title, description }` — the
 * agent-side send_card tool describes the card that way — and the SDK type
 * simply has no such field. For that common shape the description IS the
 * card body, so dropping it would post a title with no content.
 */
function cardDescription(card: CardElement): string | undefined {
  const value = (card as { description?: unknown }).description;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function cardToMarkdown(card: CardElement): string {
  const lines: string[] = [];
  if (card.title) {
    lines.push(`**${card.title}**`);
  }
  if (card.subtitle) {
    lines.push(`_${card.subtitle}_`);
  }
  const description = cardDescription(card);
  if (description) {
    lines.push(description);
  }
  if (card.imageUrl) {
    lines.push(`![](${card.imageUrl})`);
  }
  for (const child of card.children ?? []) {
    const block = cardChildToMarkdown(child);
    if (block) {
      lines.push(block);
    }
  }
  return lines.join('\n\n').trim();
}

function cardChildToMarkdown(child: CardChild): string | null {
  // The SDK's own `cardChildToFallbackText` drops actions, sections, images
  // and dividers and flattens links, fields and tables to plain text, so every
  // child type is rendered here in the markdown Mattermost displays natively.
  if (child.type === 'actions') {
    const lines: string[] = [];
    for (const action of child.children) {
      if (action.type === 'link-button') {
        lines.push(`- [${action.label}](${action.url})`);
        continue;
      }
      if (action.type === 'button') {
        if (action.label) {
          lines.push(`- ${action.label}`);
        }
        continue;
      }
      // A select has no clickable form without a callback URL either, so it
      // degrades to its choices — losing them entirely would drop the only
      // information the card carried.
      for (const option of action.options ?? []) {
        lines.push(`- ${option.label}`);
      }
    }
    return lines.length > 0 ? lines.join('\n') : null;
  }
  if (child.type === 'section') {
    const nested = child.children.map(cardChildToMarkdown).filter((block): block is string => Boolean(block));
    return nested.length > 0 ? nested.join('\n\n') : null;
  }
  if (child.type === 'text') {
    return child.content;
  }
  return richChildToMarkdown(child);
}

// ---------------------------------------------------------------------------
// Interactive cards → message attachments
// ---------------------------------------------------------------------------

/**
 * Map a Chat SDK `ButtonStyle` onto a Mattermost `PostAction.Style`.
 *
 * `default` is omitted rather than sent: Mattermost's `default` renders as a
 * distinct grey chip, whereas the SDK means "no special styling".
 */
function toActionStyle(style: ButtonElement['style']): MattermostActionStyle | undefined {
  if (style === 'primary' || style === 'danger') {
    return style;
  }
  return undefined;
}

/**
 * Mattermost routes a click as `POST /posts/{post_id}/actions/{action_id}`,
 * and the `action_id` path variable is constrained to `[A-Za-z0-9]+` — an id
 * with any other character (the SDK's own `ncq:<questionId>:<index>`, say) is
 * simply unroutable and every click on it 404s. Live-verified 2026-07-24.
 */
const ROUTE_SAFE_ACTION_ID = /^[A-Za-z0-9]+$/;

/**
 * Translate one `ButtonElement` into a Mattermost `PostAction`.
 *
 * `integration.context` carries what comes back to us on click: Mattermost
 * echoes it verbatim in the `PostActionIntegrationRequest`, and it is the only
 * channel for the SDK's `actionId` / `value` pair (the wire format has no
 * dedicated field for either — and the server strips `integration` from the
 * copies of the post it serves to clients, so the context never leaks).
 *
 * `PostAction.id` is therefore *not* where the SDK action id goes. It is set
 * only when the SDK id happens to be route-safe; otherwise it is omitted and
 * Mattermost generates a unique id of its own. Mangling the id into shape was
 * rejected: two distinct SDK ids can sanitize to the same string, and a
 * collision would silently route a click to the wrong button.
 */
function buttonToAction(button: ButtonElement, callbackUrl: string, secret: string | undefined): MattermostPostAction {
  const style = toActionStyle(button.style);
  return {
    ...(ROUTE_SAFE_ACTION_ID.test(button.id) ? { id: button.id } : {}),
    name: emojify(button.label),
    type: 'button',
    ...(style ? { style } : {}),
    integration: {
      url: button.callbackUrl || callbackUrl,
      context: {
        action_id: button.id,
        ...(button.value === undefined ? {} : { value: button.value }),
        ...secretContext(secret),
      },
    },
  };
}

/**
 * Key under which the callback secret rides in `integration.context`.
 *
 * Mattermost POSTs no signature on action callbacks, so without this anyone
 * who learns the callback URL can forge a click — an approval, say. The
 * server strips `integration` from every copy of a post it serves to clients
 * (live-verified; see `PostActionIntegrationRequest`), so the context is a
 * server-to-adapter channel and a secret placed in it never reaches a
 * browser. `handleWebhook` rejects callbacks whose context lacks the
 * configured secret.
 */
export const CALLBACK_SECRET_KEY = 'callback_token';

function secretContext(secret: string | undefined): Record<string, string> {
  return secret ? { [CALLBACK_SECRET_KEY]: secret } : {};
}

/**
 * Translate a `Select` / `RadioSelect` into a Mattermost `select` PostAction.
 *
 * Mattermost has one dropdown control and no radio-group control, so both SDK
 * elements land on the same `type: 'select'` action — a radio group degrades to
 * a dropdown, which keeps the choice set and the single-answer semantics and
 * loses only the always-visible layout.
 *
 * `name` is what the control shows before a choice is made, so the SDK's
 * `placeholder` is preferred over `label` there. `default_option` carries
 * `initialOption`.
 *
 * The click comes back through `integration.context` exactly as a button's
 * does, plus the server-added `context.selected_option` holding the chosen
 * `value` (see `PostActionIntegrationRequest`). No `value` is written into the
 * context here: the answer is the selection, and a static `value` would
 * shadow it in `toActionEvent`.
 */
function selectToAction(
  element: RadioSelectElement | SelectElement,
  callbackUrl: string,
  secret: string | undefined,
): MattermostPostAction {
  const placeholder = 'placeholder' in element ? element.placeholder : undefined;
  return {
    ...(ROUTE_SAFE_ACTION_ID.test(element.id) ? { id: element.id } : {}),
    name: emojify(placeholder || element.label),
    type: 'select',
    options: (element.options ?? []).map((option) => ({
      text: emojify(option.label),
      value: option.value,
    })),
    ...(element.initialOption ? { default_option: element.initialOption } : {}),
    integration: {
      url: callbackUrl,
      context: { action_id: element.id, ...secretContext(secret) },
    },
  };
}

/** Accumulator for the recursive card walk. */
interface CardWalk {
  actions: MattermostPostAction[];
  blocks: string[];
  /** Native key/value grid; Mattermost lays `short` fields out two per row. */
  fields: { short: boolean; title: string; value: string }[];
  /** First image seen; an attachment renders exactly one `image_url`. */
  imageUrl?: string;
  secret: string | undefined;
}

function walkCardChild(child: CardChild, callbackUrl: string, out: CardWalk): void {
  if (child.type === 'actions') {
    for (const action of child.children) {
      if (action.type === 'button') {
        if (action.disabled) {
          // Mattermost has no disabled state for a PostAction; showing the
          // label without a control is the honest rendering.
          out.blocks.push(`_${action.label}_`);
          continue;
        }
        out.actions.push(buttonToAction(action, callbackUrl, out.secret));
        continue;
      }
      if (action.type === 'link-button') {
        // Mattermost has no link-button action type — a PostAction always
        // POSTs back to an integration URL. A markdown link is the honest
        // degradation: same destination, one extra click affordance lost.
        out.blocks.push(`[${action.label}](${action.url})`);
        continue;
      }
      // `select` / `radio_select`. A choice-less select is not renderable as a
      // control, so it degrades to its labels rather than shipping an empty
      // dropdown.
      if ((action.options ?? []).length > 0) {
        out.actions.push(selectToAction(action, callbackUrl, out.secret));
        continue;
      }
      out.blocks.push(`_${action.label}_`);
    }
    return;
  }
  if (child.type === 'section') {
    for (const nested of child.children) {
      walkCardChild(nested, callbackUrl, out);
    }
    return;
  }
  if (child.type === 'fields') {
    const short = child.children.length > 1;
    for (const field of child.children) {
      out.fields.push({ short, title: field.label, value: field.value });
    }
    return;
  }
  if (child.type === 'image' && !out.imageUrl) {
    out.imageUrl = child.url;
    return;
  }
  const text = cardChildToMarkdown(child);
  if (text) {
    out.blocks.push(text);
  }
}

/**
 * Translate a `CardElement` into a Mattermost message attachment.
 *
 * The card's title becomes the attachment title, its non-action children
 * become the attachment text (markdown — Mattermost renders it natively), and
 * every `Button` becomes a `PostAction` bound to `callbackUrl`. Non-button
 * children degrade to markdown inside the same attachment.
 *
 * Returns `null` when the card produced no actions: an attachment with no
 * buttons buys nothing over a plain markdown post, and a plain post keeps the
 * text searchable and notifiable.
 */
export function cardToAttachment(
  card: CardElement,
  callbackUrl: string,
  callbackSecret?: string,
): MattermostMessageAttachment | null {
  const walk: CardWalk = { actions: [], blocks: [], fields: [], secret: callbackSecret };
  if (card.subtitle) {
    walk.blocks.push(`_${card.subtitle}_`);
  }
  const description = cardDescription(card);
  if (description) {
    walk.blocks.push(description);
  }
  if (card.imageUrl) {
    walk.imageUrl = card.imageUrl;
  }
  for (const child of card.children ?? []) {
    walkCardChild(child, callbackUrl, walk);
  }
  if (walk.actions.length === 0) {
    return null;
  }
  const text = emojify(walk.blocks.join('\n\n').trim());
  return {
    ...(card.title ? { title: emojify(card.title) } : {}),
    ...(text ? { text } : {}),
    ...(walk.fields.length > 0
      ? { fields: walk.fields.map((field) => ({ ...field, title: emojify(field.title), value: emojify(field.value) })) }
      : {}),
    ...(walk.imageUrl ? { image_url: walk.imageUrl } : {}),
    actions: walk.actions,
    fallback: markdownToPlainText(emojify(cardToMarkdown(card))),
  };
}

/** The result of flattening an `AdapterPostableMessage` for the REST API. */
export interface RenderedMessage {
  /** The Mattermost `message` body (markdown). Empty when `props` carries a card. */
  message: string;
  /**
   * Post props to write. Present only when the postable rendered into an
   * interactive attachment; absent postables leave existing props alone.
   */
  props?: MattermostPostProps;
}

/** Options for {@link renderPostable}. */
export interface RenderOptions {
  /** Shared secret written into every action's context; see {@link CALLBACK_SECRET_KEY}. */
  callbackSecret?: string;
  /**
   * Fully-qualified URL Mattermost POSTs button clicks to. Without it, cards
   * degrade to markdown (see {@link cardToMarkdown}).
   */
  callbackUrl?: string;
}

function renderCard(card: CardElement, fallbackText: string | undefined, options: RenderOptions): RenderedMessage {
  if (options.callbackUrl) {
    const attachment = cardToAttachment(card, options.callbackUrl, options.callbackSecret);
    if (attachment) {
      // The attachment carries title, body and buttons, so the post body is
      // left empty rather than duplicating the same text above the card.
      return { message: '', props: { attachments: [attachment] } };
    }
  }
  const markdown = cardToMarkdown(card) || fallbackText || '';
  if (!markdown) {
    // A card with no renderable content and no fallback would post a bare
    // ">" quote marker — near-silence the sender believes was a card.
    // Deliver an honest placeholder instead.
    return { message: '_[card had no displayable content]_' };
  }
  // Blockquote the degraded card: Mattermost renders `>` with a left accent
  // bar, so an actionless (or callback-less) card still reads as a distinct
  // card-like block while staying searchable and previewable in
  // notifications — the two properties a props-attachment rendering loses.
  const quoted = markdown
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
  return { message: quoted };
}

/**
 * Flatten an `AdapterPostableMessage` into the fields `CreatePost` needs.
 *
 * Handles `string`, `{ raw }`, `{ markdown }`, `{ ast }`, `{ card }` and a
 * bare `CardElement`. Files ride a separate path: they must be uploaded before
 * the post exists, so `postMessage` pulls them off with {@link extractFiles}
 * and turns them into `file_ids`.
 */
export function renderPostable(message: AdapterPostableMessage, options: RenderOptions = {}): RenderedMessage {
  const rendered = renderPostableInner(message, options);
  return { ...rendered, message: emojify(rendered.message) };
}

function renderPostableInner(message: AdapterPostableMessage, options: RenderOptions): RenderedMessage {
  if (typeof message === 'string') {
    return { message };
  }
  if (isCardElement(message)) {
    return renderCard(message, undefined, options);
  }
  if ('raw' in message && typeof message.raw === 'string') {
    return { message: message.raw };
  }
  if ('markdown' in message && typeof message.markdown === 'string') {
    return { message: message.markdown };
  }
  if ('ast' in message && message.ast) {
    return { message: renderFormatted(message.ast) };
  }
  if ('card' in message && message.card) {
    return renderCard(message.card, message.fallbackText, options);
  }
  return { message: '' };
}

/**
 * Whether a postable is a card (bare element or `{ card }`), regardless of
 * what it renders to — an actionless card degrades to a blockquote with no
 * `props`, and `editMessage` needs to tell that apart from a plain text edit.
 */
export function carriesCard(message: AdapterPostableMessage): boolean {
  if (typeof message === 'string') return false;
  if (isCardElement(message)) return true;
  return 'card' in message && Boolean(message.card);
}

/**
 * Files to upload alongside a postable, or `[]` when it carries none.
 *
 * Mirrors `@chat-adapter/shared`'s `extractFiles` (which the Slack adapter
 * uses): only `files` is read. `attachments` on a postable is the *inbound*
 * shape — already-downloaded or downloadable data, without the `filename` an
 * upload needs — and no first-party adapter treats it as an upload source.
 */
export function extractFiles(message: AdapterPostableMessage): FileUpload[] {
  if (typeof message === 'object' && message !== null && 'files' in message) {
    return message.files ?? [];
  }
  return [];
}

/**
 * ASCII shortcode/name shape: word characters plus the two symbols Slack's
 * own names use (`+1`, `-1`). Anything outside this — a raw unicode
 * character, a multi-codepoint glyph with a variation selector — is not a
 * name at all and needs the unicode branch below.
 */
const SHORTCODE_PATTERN = /^[+\-\w]+$/;

/**
 * Normalize an emoji to a Mattermost `emoji_name` (no wrapping colons).
 *
 * Mattermost's reaction API 400s (`api.reaction.save_reaction.invalid.app_error`)
 * on anything that is not a bare registered name, so every representation the
 * `add_reaction` tool or the SDK can hand an adapter has to collapse onto one:
 *
 *  - an `EmojiValue` — its `.name` is projected through
 *    {@link defaultEmojiResolver}'s `toSlack`, same as a bare name below;
 *  - a `:shortcode:` or bare `shortcode` — colons stripped, then `toSlack`
 *    (a no-op for names the resolver doesn't recognise, e.g. a Mattermost
 *    custom emoji, which is exactly the identity passthrough we want);
 *  - raw unicode (`✅`, `👍`) — colons don't apply, and it fails the ASCII
 *    shortcode shape, so it goes through the resolver's `fromGChat` (its one
 *    unicode→name reverse map, keyed by Google Chat's raw unicode formats)
 *    to normalize, then `toSlack` to land on the Slack-style name Mattermost's
 *    own emoji set uses (mirrors `@chat-adapter/slack`'s `addReaction`, which
 *    runs the same `toSlack` call — Mattermost emoji names are Slack-style
 *    shortcodes, per {@link import("./adapter.js").MattermostAdapter}'s inbound
 *    reaction handling).
 *
 * Unicode with no entry in the resolver's map has no name to send — sending
 * the raw character would just relocate today's 400 to a different caller —
 * so it throws instead of guessing.
 */
/**
 * Folk names LLM callers emit that exist in no platform's emoji set. Kept
 * deliberately tiny: only spellings observed from real agents (or their
 * obvious variants) whose canonical target is unambiguous. Anything not
 * listed passes through untouched — Mattermost rejects unknown names with
 * a 400 and the delivery layer surfaces it.
 */
const EMOJI_NAME_ALIASES: Record<string, string> = {
  check: 'white_check_mark',
  checkmark: 'white_check_mark',
  tick: 'white_check_mark',
  cross: 'x',
  x_mark: 'x',
};

export function toEmojiName(emoji: EmojiValue | string): string {
  if (typeof emoji !== 'string') {
    return defaultEmojiResolver.toSlack(emoji.name);
  }
  const trimmed = emoji.replace(/^:+|:+$/g, '');
  if (SHORTCODE_PATTERN.test(trimmed)) {
    const alias = EMOJI_NAME_ALIASES[trimmed.toLowerCase()];
    return defaultEmojiResolver.toSlack(alias ?? trimmed);
  }
  const normalized = defaultEmojiResolver.fromGChat(trimmed);
  if (normalized.name === trimmed) {
    throw new Error(
      `Mattermost adapter: cannot map emoji "${emoji}" to a Mattermost emoji name. ` +
        `Pass a shortcode (e.g. "white_check_mark") instead of a raw unicode character.`,
    );
  }
  return defaultEmojiResolver.toSlack(normalized);
}

/** Whether a post is a Mattermost system message (joins, header changes, ...). */
export function isSystemPost(post: Pick<MattermostPost, 'type'>): boolean {
  return typeof post.type === 'string' && post.type.startsWith('system_');
}
