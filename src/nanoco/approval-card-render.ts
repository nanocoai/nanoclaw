import type { NormalizedOption } from '../channels/ask-question.js';
import {
  parseApprovalPresentation,
  type ApprovalPresentationField,
  type GatewayApproval,
} from './approval-contract.js';

const LONG_TEXT_PREVIEW_MAX_CHARACTERS = 480;
const LONG_TEXT_PREVIEW_MAX_LINES = 8;
const FULL_TITLE_HEADING = '*Full approval title*';
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Stay below Slack's 3,000-character section/context text ceiling. */
export const APPROVAL_CARD_TEXT_LIMIT = 2800;
/** Leave room below Slack's 150-character header text ceiling. */
export const APPROVAL_CARD_TITLE_LIMIT = 140;
/** Match the persisted approval-card wire validation before platform delivery. */
export const APPROVAL_CARD_TITLE_UTF8_BYTE_LIMIT = 256;

export interface PersistedApprovalCardEvidence {
  deadline: string;
  presentation_json: string;
}

export function approvalCardTitle(presentation: GatewayApproval['presentation']): string {
  return channelSafeApprovalCardTitle(semanticApprovalCardTitle(presentation));
}

/**
 * Normalize an arbitrary approval title for channel headers. The complete
 * title remains decision evidence in the CardText body whenever this shortens
 * it; callers must use approvalCardSurface rather than the header alone.
 */
export function channelSafeApprovalCardTitle(title: string): string {
  const graphemes = graphemeSegments(title);
  if (
    graphemes.length <= APPROVAL_CARD_TITLE_LIMIT &&
    Buffer.byteLength(title) <= APPROVAL_CARD_TITLE_UTF8_BYTE_LIMIT
  ) {
    return title;
  }

  const suffix = '…';
  const byteBudget = APPROVAL_CARD_TITLE_UTF8_BYTE_LIMIT - Buffer.byteLength(suffix);
  let prefix = '';
  for (const grapheme of graphemes.slice(0, APPROVAL_CARD_TITLE_LIMIT - 1)) {
    if (Buffer.byteLength(prefix) + Buffer.byteLength(grapheme) > byteBudget) break;
    prefix += grapheme;
  }
  return `${prefix.trimEnd()}${suffix}`;
}

/** Keep the full title visible while the channel header uses its safe form. */
export function approvalCardSurface(title: string, question: string): {
  header: string;
  body: string;
} {
  const header = channelSafeApprovalCardTitle(title);
  return {
    header,
    body: header === title ? question : [renderFullTitle(title), question].filter(Boolean).join('\n\n'),
  };
}

export const GATEWAY_APPROVAL_CARD_OPTIONS: NormalizedOption[] = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
];

/**
 * Render only Gateway-authored, bounded semantic presentation fields. Provider
 * request URLs and payloads are enforcement evidence, not human decision UI.
 */
export function approvalCardQuestion(row: PersistedApprovalCardEvidence): string {
  const presentation = parseApprovalPresentation(JSON.parse(row.presentation_json));
  const semanticTitle = semanticApprovalCardTitle(presentation);
  const sections = [
    ...(channelSafeApprovalCardTitle(semanticTitle) === semanticTitle ? [] : [renderFullTitle(semanticTitle)]),
    renderOperationClass(presentation.class),
    presentation.description ?? presentation.title,
  ];
  for (const field of presentation.fields) sections.push(renderField(field));
  sections.push(`_Approval expires: ${formatDeadline(row.deadline)}_`);
  return sections.join('\n\n');
}

/**
 * Split semantic approval text into channel-safe CardText values. Paragraphs
 * (one presentation field each) are kept together when possible; an oversized
 * field splits at line boundaries before words or hard characters. Nothing is
 * truncated, including Gateway's exact `… and N more` list disclosure.
 */
export function approvalCardTextChunks(text: string): string[] {
  return splitSemanticText(text, APPROVAL_CARD_TEXT_LIMIT);
}

/**
 * Keep adapter fallback text bounded as well. If the complete text is too
 * large, preserve full-title evidence independently, retain as much leading
 * semantic context as fits, and point to the lossless structured card. The
 * fallback never infers omission counts from rendered strings.
 */
export function approvalFallbackText(spec: {
  title: string;
  question: string;
  tail: string;
}): string {
  const fallbackTitle = renderSlackLiteralTitle(spec.title);
  const { fullTitleEvidence, remainingQuestion } = partitionFallbackQuestion(spec.question);
  const fallbackHeader = fullTitleEvidence.length > 0 ? '' : fallbackTitle;
  const complete = [fallbackHeader, ...fullTitleEvidence, remainingQuestion, spec.tail]
    .filter(Boolean)
    .join('\n\n');
  if (complete.length <= APPROVAL_CARD_TEXT_LIMIT) return complete;

  const suffix = [
    '_Approval details, including any list continuation, remain in the structured card._',
    spec.tail,
  ].filter(Boolean);
  const required = [fallbackHeader, ...fullTitleEvidence, ...suffix].filter(Boolean).join('\n\n');
  if (required.length > APPROVAL_CARD_TEXT_LIMIT) {
    throw new Error('approval fallback required content exceeds channel-safe limit');
  }

  const prefixBudget = APPROVAL_CARD_TEXT_LIMIT - required.length - (required ? 2 : 0);
  const prefix = prefixBudget > 0 ? splitSemanticText(remainingQuestion, prefixBudget)[0] ?? '' : '';
  return [fallbackHeader, ...fullTitleEvidence, prefix, ...suffix].filter(Boolean).join('\n\n');
}

export function persistedApprovalCardOptions(value: string): NormalizedOption[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error('invalid persisted approval card options');
  const options = parsed as Array<Partial<NormalizedOption>>;
  if (
    options[0]?.value !== 'approve' ||
    options[1]?.value !== 'reject' ||
    options.some(
      (option) =>
        typeof option.label !== 'string' ||
        !option.label ||
        typeof option.selectedLabel !== 'string' ||
        !option.selectedLabel ||
        (option.style !== undefined &&
          option.style !== 'primary' &&
          option.style !== 'danger' &&
          option.style !== 'default'),
    )
  ) {
    throw new Error('invalid persisted approval card options');
  }
  return options as NormalizedOption[];
}

function renderField(field: ApprovalPresentationField): string {
  if (field.kind === 'list') {
    return `*${field.label}*\n${field.value.map((value) => `• ${value}`).join('\n')}`;
  }
  if (field.kind === 'long_text') {
    const preview = boundedLongTextPreview(field.value);
    return `*${field.label} preview*\n${preview.text
      .split('\n')
      .map((line) => `> ${line || ' '}`)
      .join('\n')}${preview.truncated ? '\n> … _(preview truncated)_' : ''}`;
  }
  return `*${field.label}*\n${field.value}`;
}

function semanticApprovalCardTitle(presentation: GatewayApproval['presentation']): string {
  return `${presentation.appLabel} · ${presentation.title}`;
}

function renderFullTitle(title: string): string {
  return `${FULL_TITLE_HEADING}\n${renderSlackLiteralTitle(title)}`;
}

/**
 * CardText becomes Slack mrkdwn. Use a code block for titles containing Slack
 * syntax so mentions, links, and emphasis remain literal. Slack decodes only
 * these three documented entities for display; separating embedded backticks
 * with an invisible word joiner keeps them from closing the literal fence.
 */
function renderSlackLiteralTitle(title: string): string {
  if (!/[&<>*_~`]|(?:https?:\/\/|mailto:)/iu.test(title)) return title;
  const escaped = title
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, '`\u2060');
  return `\`\`\`\n${escaped}\n\`\`\``;
}

function partitionFallbackQuestion(question: string): {
  fullTitleEvidence: string[];
  remainingQuestion: string;
} {
  const sections = question.split('\n\n');
  const first = sections[0] ?? '';
  const fullTitleEvidence = first.startsWith(`${FULL_TITLE_HEADING}\n`) ? [first] : [];
  const remainingSections = fullTitleEvidence.length > 0 ? sections.slice(1) : sections;

  return { fullTitleEvidence, remainingQuestion: remainingSections.filter(Boolean).join('\n\n') };
}

function graphemeSegments(value: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(value), ({ segment }) => segment);
}

function boundedLongTextPreview(value: string): {
  text: string;
  truncated: boolean;
} {
  const lines = value.split('\n');
  let text = lines.slice(0, LONG_TEXT_PREVIEW_MAX_LINES).join('\n');
  let truncated = lines.length > LONG_TEXT_PREVIEW_MAX_LINES;
  if (text.length > LONG_TEXT_PREVIEW_MAX_CHARACTERS) {
    text = text.slice(0, LONG_TEXT_PREVIEW_MAX_CHARACTERS).trimEnd();
    truncated = true;
  }
  return { text, truncated };
}

function renderOperationClass(operationClass: string): string {
  const normalized = operationClass.toLowerCase();
  const icon = normalized === 'write' ? '✏️' : normalized === 'read' ? '🔎' : '⚙️';
  const label = `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
  return `${icon} *${label} operation*`;
}

function formatDeadline(deadline: string): string {
  const date = new Date(deadline);
  if (!Number.isFinite(date.getTime())) return deadline;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(date);
}

function splitSemanticText(text: string, limit: number): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('approval card text limit must be positive');
  if (!text) return [];
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
