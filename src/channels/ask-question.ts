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
  /** Set by host delivery on questions an agent asks; their markup is the agent's own and is not escaped. */
  fromAgent?: boolean;
}

/**
 * Longest title plus question an approval request may carry, so it shows in
 * full even where a platform caps a whole card's text, with room for markup
 * escaping to double it. A channel with a lower cap declares its own.
 */
export const MAX_CARD_QUESTION_LENGTH = 2000;

/** A card refused because the platform can't show it in full; the message says why. */
export class CardTooLongError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CardTooLongError';
  }
}

/** Why a card with this title and question can't be sent, or undefined when it fits. */
export function cardQuestionTooLong(
  title: string,
  question: string,
  max = MAX_CARD_QUESTION_LENGTH,
): string | undefined {
  const length = title.length + question.length;
  if (length <= max) return undefined;
  return `the request is too long to show in full on a card (${length} characters, limit ${max})`;
}
