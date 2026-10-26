import type { GatewayApprovalRequest } from './gateway-providers/gateway-provider-registry.js';

// Escape Markdown syntax instead of changing the displayed account or resource.
const safeMultiline = (text: string) =>
  // eslint-disable-next-line no-control-regex -- strip control bytes from gateway-supplied display text
  text.replace(/[\x00-\x09\x0b-\x1f]/g, ' ').replace(/[\\<>&`*_~[\]()]/g, '\\$&');

const safe = (text: string) => safeMultiline(text.replace(/[\r\n]/g, ' '));

/**
 * A rough cap, counted before escaping: channels cap or clip titles (the
 * tightest at 60), some after expanding emoji names. A longer title or action
 * goes in full into the body under a fixed title; a channel with cardFits
 * measures the real title and falls back to a fixed one too.
 */
export const MAX_CARD_TITLE_CHARS = 60;

/** One renderer for every gateway; no inference of business intent from HTTP methods. */
export function gatewayApprovalPresentation(request: GatewayApprovalRequest): { title: string; question: string } {
  if (request.displayFields !== undefined) {
    if (!Array.isArray(request.displayFields) || request.displayFields.length > 24)
      throw new Error('Invalid gateway display fields');
    const lines = [request.question];
    for (const field of request.displayFields) {
      if (!field || typeof field.label !== 'string' || !field.label || field.label.length > 200)
        throw new Error('Invalid gateway display label');
      if (field.type === 'list') {
        if (
          !Array.isArray(field.value) ||
          field.value.length > 50 ||
          field.value.some((item) => typeof item !== 'string' || item.length > 8192)
        )
          throw new Error('Invalid gateway display list');
        if (field.overflow !== undefined && (!Number.isSafeInteger(field.overflow) || field.overflow < 0))
          throw new Error('Invalid gateway display overflow');
        lines.push(`*${safe(field.label)}:*`, ...field.value.map((value) => `• ${safe(value)}`));
        if (field.overflow) lines.push(`… ${field.overflow} additional items`);
      } else {
        if (
          !['text', 'long_text'].includes(field.type) ||
          typeof field.value !== 'string' ||
          field.value.length > 32768
        )
          throw new Error('Invalid gateway display value');
        lines.push(`*${safe(field.label)}:* ${safeMultiline(field.value)}`);
      }
    }
    const question = lines.join('\n');
    if (Buffer.byteLength(question, 'utf8') > 262144) throw new Error('Gateway display too large');
    return { title: request.title, question };
  }
  const summary = request.summary;
  if (!summary) {
    if (request.title.length <= MAX_CARD_TITLE_CHARS) return { title: request.title, question: request.question };
    return { title: 'Approve external request', question: `*Request:* ${safe(request.title)}\n${request.question}` };
  }
  for (const field of ['agent', 'action', 'resource', 'reason'] as const) {
    if (typeof summary[field] !== 'string' || !summary[field].trim() || summary[field].length > 600) {
      throw new Error('Invalid gateway approval summary');
    }
  }
  if (summary.details !== undefined && (!Array.isArray(summary.details) || summary.details.length > 6)) {
    throw new Error('Invalid gateway approval details');
  }
  const omitted = summary.omittedDetails;
  if (omitted !== undefined && (!Number.isSafeInteger(omitted) || omitted < 0)) {
    throw new Error('Invalid gateway approval details');
  }
  const detailed = Boolean(summary.details?.length);
  const action = safe(summary.action);
  const resource = /^(?:[A-Z]+ |https?:)/.test(summary.resource)
    ? summary.resource.split(/[?#]/, 1)[0]
    : summary.resource;
  const lines = detailed
    ? [`*Action:* ${action}`, `*Agent:* ${safe(summary.agent)}`, `*Where:* ${safe(resource)}`]
    : [
        `*Agent:* ${safe(summary.agent)}`,
        `*Action:* ${action}`,
        `*Resource:* ${safe(resource)}`,
        `*Why approval:* ${safe(summary.reason)}`,
      ];
  for (const detail of summary.details ?? []) {
    if (
      !detail ||
      typeof detail.label !== 'string' ||
      typeof detail.value !== 'string' ||
      detail.label.length > 80 ||
      detail.value.length > 600
    ) {
      throw new Error('Invalid gateway approval detail');
    }
    lines.push(`*${safe(detail.label)}:* ${safe(detail.value)}`);
  }
  if (omitted) lines.push(`… ${omitted} more field${omitted === 1 ? '' : 's'} not shown`);
  const scope = detailed
    ? 'Approve once to allow this action.'
    : 'Approve allows this request once. It does not connect an account or change its permissions.';
  let title = 'Approve external request';
  if (detailed) title = action.length <= MAX_CARD_TITLE_CHARS ? action : 'Approve this action';
  // Never cut: the bridge posts long text in several blocks.
  return { title, question: [...lines, scope].join('\n') };
}
