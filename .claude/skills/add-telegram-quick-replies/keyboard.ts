/**
 * Telegram reply-keyboard construction — pure, no I/O.
 *
 * A reply keyboard is the cheap half of Telegram's button model, and the half
 * NanoClaw has no way to reach today. Tapping one sends the button's label as
 * an ordinary text message, so the answer arrives through the normal inbound
 * path with no callback_data, no 64-byte cap, and no card to update. That is
 * what makes it non-blocking: unlike `ask_user_question`, which holds the
 * container open while it polls for a response, the agent offers the options
 * and ends its turn. The reply wakes it like any other message.
 *
 * Split from index.ts so the shapes can be tested without a network or a DB.
 */

/** A button: a plain label, or a label that asks Telegram for typed data. */
export interface QuickReplyOption {
  label: string;
  /**
   * Ask for structured data instead of the label text. Telegram only honours
   * these in private chats, and only from a reply keyboard — which is why
   * this module exists at all; inline keyboards cannot request either.
   */
  request?: 'contact' | 'location';
}

export interface QuickReplySpec {
  options: QuickReplyOption[];
  /** Buttons per row. Telegram wraps anyway; this controls intent. */
  columns?: number;
  /** Keep the keyboard after a tap. Default: hide it (one-shot prompt). */
  persist?: boolean;
  /**
   * In a group, show the keyboard only to the users the message replies to or
   * mentions. Telegram ignores it in private chats.
   */
  selective?: boolean;
}

/** Telegram caps a keyboard at 300 buttons; a prompt that large is a bug. */
export const MAX_OPTIONS = 100;
/** Telegram truncates long button labels; refuse rather than ship a stub. */
export const MAX_LABEL_CHARS = 64;

export type ReplyMarkup =
  | {
      keyboard: Array<Array<{ text: string; request_contact?: true; request_location?: true }>>;
      resize_keyboard: true;
      one_time_keyboard?: true;
      is_persistent?: true;
      selective?: true;
    }
  | { remove_keyboard: true; selective?: true };

export class QuickReplyError extends Error {}

/**
 * Normalize one option. Accepts a bare string so the common case — a list of
 * labels — needs no object wrapping from the model.
 */
export function normalizeOption(raw: unknown): QuickReplyOption {
  if (typeof raw === 'string') return { label: raw };
  if (raw && typeof raw === 'object' && typeof (raw as { label?: unknown }).label === 'string') {
    const { label, request } = raw as { label: string; request?: unknown };
    if (request !== undefined && request !== 'contact' && request !== 'location') {
      throw new QuickReplyError(`option "${label}": request must be "contact" or "location", got ${String(request)}`);
    }
    return { label, ...(request ? { request: request as 'contact' | 'location' } : {}) };
  }
  throw new QuickReplyError('each option must be a string or { label, request? }');
}

/**
 * Build the `reply_markup` for a set of quick replies.
 *
 * `isGroup` is not cosmetic: Telegram silently ignores request_contact and
 * request_location outside private chats, so a "Share your number" button in
 * a group renders as a button that sends its own label. Failing loudly here
 * beats an agent waiting for a phone number that can never arrive.
 */
export function buildQuickReplyMarkup(spec: QuickReplySpec, isGroup: boolean): ReplyMarkup {
  const { options, columns = 2, persist = false, selective = false } = spec;

  if (options.length === 0) throw new QuickReplyError('options must not be empty');
  if (options.length > MAX_OPTIONS) {
    throw new QuickReplyError(`too many options (${options.length}); Telegram keyboards stay usable under ${MAX_OPTIONS}`);
  }
  if (columns < 1) throw new QuickReplyError(`columns must be at least 1, got ${columns}`);

  const rows: Array<Array<{ text: string; request_contact?: true; request_location?: true }>> = [];
  for (const option of options) {
    const label = option.label.trim();
    if (!label) throw new QuickReplyError('an option label must not be empty');
    if (label.length > MAX_LABEL_CHARS) {
      throw new QuickReplyError(`option label longer than ${MAX_LABEL_CHARS} chars: "${label.slice(0, 24)}…"`);
    }
    if (option.request && isGroup) {
      throw new QuickReplyError(
        `option "${label}" requests ${option.request}, which Telegram only honours in a private chat`,
      );
    }
    const button = {
      text: label,
      ...(option.request === 'contact' ? { request_contact: true as const } : {}),
      ...(option.request === 'location' ? { request_location: true as const } : {}),
    };
    if (rows.length === 0 || rows[rows.length - 1].length >= columns) rows.push([button]);
    else rows[rows.length - 1].push(button);
  }

  return {
    keyboard: rows,
    resize_keyboard: true,
    // one_time hides the keyboard after a tap but leaves it reachable from the
    // input field; is_persistent keeps it open. They are opposites, so only
    // ever one is set.
    ...(persist ? { is_persistent: true as const } : { one_time_keyboard: true as const }),
    ...(selective && isGroup ? { selective: true as const } : {}),
  };
}

/** Markup that takes an open keyboard away. */
export function buildRemoveMarkup(selective: boolean, isGroup: boolean): ReplyMarkup {
  return { remove_keyboard: true, ...(selective && isGroup ? { selective: true as const } : {}) };
}

/**
 * Env key holding the bot token for a channel type.
 *
 * Multi-instance Telegram appends an uppercased suffix to the key
 * (`telegram-gh-bot` → `TELEGRAM_BOT_TOKEN_GH_BOT`), matching the convention in
 * the Telegram adapter's `envKeySuffix`. The default instance is unsuffixed.
 */
export function tokenEnvKey(channelType: string): string | null {
  if (channelType === 'telegram') return 'TELEGRAM_BOT_TOKEN';
  const suffix = channelType.startsWith('telegram-') ? channelType.slice('telegram-'.length) : null;
  if (!suffix) return null;
  return `TELEGRAM_BOT_TOKEN_${suffix.toUpperCase().replace(/-/g, '_')}`;
}
