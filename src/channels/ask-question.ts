/**
 * Shared ask_question payload schema + normalization.
 *
 * Producers (host-side approvals, container-side ask_user_question MCP tool)
 * emit an `ask_question` payload. Options may be bare strings for ergonomics,
 * but are normalized here into a consistent shape before delivery, persistence,
 * and rendering.
 */

/** Chat SDK button styles — Slack maps primary→green, danger→red; platforms
 *  without button colors (Telegram) ignore it. */
export type OptionStyle = 'primary' | 'danger' | 'default';

export interface OptionInput {
  label: string;
  selectedLabel?: string;
  value?: string;
  style?: OptionStyle;
}

export type RawOption = string | OptionInput;

export interface NormalizedOption {
  label: string;
  selectedLabel: string;
  value: string;
  style?: OptionStyle;
}

export function normalizeOption(raw: RawOption): NormalizedOption {
  if (typeof raw === 'string') {
    return { label: raw, selectedLabel: raw, value: raw };
  }
  const label = raw.label;
  return {
    label,
    selectedLabel: raw.selectedLabel ?? label,
    value: raw.value ?? label,
    style: raw.style === 'primary' || raw.style === 'danger' || raw.style === 'default' ? raw.style : undefined,
  };
}

export function normalizeOptions(raws: RawOption[]): NormalizedOption[] {
  return raws.map(normalizeOption);
}

export interface AskQuestionPayload {
  type: 'ask_question';
  questionId: string;
  title: string;
  question: string;
  options: NormalizedOption[];
}

/**
 * Render every control/format/invisible/bidi character — and backtick, so a
 * payload can never close a card's code fence — as a visible \uXXXX
 * escape. Applied to JSON-encoded payload fields: JSON.stringify already
 * escapes chars below 0x20, this covers the rest (Cf bidi/zero-width chars,
 * U+2028/U+2029 line separators, private-use, lone surrogates).
 */
export function escapeInvisibles(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029`]/gu, (c) => {
    const cp = c.codePointAt(0) ?? 0;
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
  });
}

/** Quote an untrusted name or value for card text: one line, no fence or hidden characters. */
export function quoteForCard(value: string): string {
  return escapeInvisibles(JSON.stringify(value));
}
