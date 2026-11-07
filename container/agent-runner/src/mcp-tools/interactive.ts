/**
 * Interactive MCP tools: ask_user_question, send_card.
 *
 * ask_user_question is a blocking tool call — it writes a messages_out row
 * with a question card, then polls messages_in for the response.
 */
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { setTimeout as sleep } from 'node:timers/promises';

import { findQuestionResponse, markCompleted } from '../db/messages-in.js';
import { getDeliveryStatus, writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting, resolveDestinationThread } from '../db/session-routing.js';
import { getCurrentReplyRoute } from '../db/session-state.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Cards thread like send_message / send_file (see resolveDestinationThread),
 * except that the bound thread is the last resort where the send tools use
 * none: it is what a per-thread session should stay in.
 */
function routing() {
  const session = getSessionRouting();
  const thread =
    session.channel_type && session.platform_id
      ? resolveDestinationThread(session.channel_type, session.platform_id, getCurrentReplyRoute())
      : null;
  return { ...session, thread_id: thread?.threadId ?? session.thread_id };
}

/**
 * The one definition of a send_card action: send_card is fire-and-forget, so
 * only a link button survives (src/channels/chat-sdk-bridge.ts). It is both
 * advertised in the tool's inputSchema and enforced on the payload, so the
 * agent is never told about a shape the bridge will not render.
 *
 * `style` carries no constraint at all, not even a type: the bridge maps
 * anything it does not recognize — including `null`, which is a common way for
 * a model to fill an optional field — to the default button styling. A schema
 * stricter than the bridge would cost the agent the whole button over its
 * color. The allowed values live in the description, which is what the model
 * reads.
 *
 * Frozen because the same object is the advertised schema and the source the
 * validator was compiled from; a later mutation would silently desync them.
 */
export const LINK_ACTION_SCHEMA = Object.freeze({
  type: 'object' as const,
  description: 'URL link button. Callback buttons are unsupported; use ask_user_question for choices.',
  properties: {
    label: { type: 'string' as const, minLength: 1 },
    // A link button has to go somewhere. A placeholder like '#' or a bare path
    // renders as a dead link, and an agent asked for an approval card reaches
    // for exactly that: it cannot make a callback button, so it fakes one.
    // http and https are the only schemes every adapter can turn into a button,
    // and the agent does not pick the channel, so the tool promises no more
    // than that. The pattern is deliberately fussy: the scheme is matched
    // case-insensitively (RFC 3986 makes it so, and a url lifted verbatim out
    // of a document may be uppercase), a host character is required so a
    // hostless 'https://' cannot satisfy the retry advice the drop message
    // gives, and the anchors reject whitespace, which would otherwise break out
    // of '[label](url)' on an adapter that degrades a card to markdown.
    // Rejected: '#', '/docs', 'localhost:3000', 'javascript:', 'mailto:'.
    // Printable-ASCII ranges stand in for \s and \S: llama.cpp's
    // schema-to-grammar converter rejects those escapes and fails every request
    // that carries this tool. The classes also leave out '"' and '\\', which
    // the converter would otherwise copy into the JSON string rule. The first
    // host character excludes '#', '/' and '?'. Non-ASCII URLs are normalized
    // with `new URL()` before validation (see normalizeLinkUrl).
    url: {
      type: 'string' as const,
      pattern: '^[hH][tT][tT][pP][sS]?://[!$-.0->@-[\\]-~][!#-[\\]-~]*$',
      description: "Web link (http or https), e.g. 'https://example.com'.",
    },
    style: {
      description: "One of 'primary', 'danger' or 'default'; any other value renders as 'default'.",
    },
  },
  required: ['label', 'url'],
});

/** Compiled once: the handler runs it per action on every send_card call. */
const validateLinkAction = new AjvJsonSchemaValidator().getValidator<Record<string, unknown>>(LINK_ACTION_SCHEMA);

/**
 * Split a card's actions into the ones the bridge will render and a count of
 * the ones it would drop. Invalid entries — including `null`, which would
 * crash the bridge's property reads — never reach the payload.
 */
const NON_ASCII = /[^\x00-\x7F]/;

/**
 * The pattern is ASCII-only, so a link like `https://de.wikipedia.org/wiki/München`
 * would be dropped. `new URL()` percent-encodes the path and punycodes the host,
 * which keeps such links. Only non-ASCII URLs are rewritten; everything else is
 * validated exactly as the agent sent it.
 */
function normalizeLinkUrl(action: unknown): unknown {
  if (typeof action !== 'object' || action === null) return action;
  const url = (action as { url?: unknown }).url;
  if (typeof url !== 'string' || !NON_ASCII.test(url)) return action;
  try {
    return { ...action, url: new URL(url).href };
  } catch {
    return action;
  }
}

function partitionActions(card: Record<string, unknown>): { card: Record<string, unknown>; dropped: number } {
  const actions = card.actions;
  if (!Array.isArray(actions)) return { card, dropped: 0 };

  const normalized = actions.map(normalizeLinkUrl);
  const valid = normalized.filter((action) => validateLinkAction(action).valid);
  const changed = normalized.some((action, index) => action !== actions[index]);
  if (valid.length === actions.length && !changed) return { card, dropped: 0 };

  return { card: { ...card, actions: valid }, dropped: actions.length - valid.length };
}

/**
 * Per card, so every platform takes the whole card. The chart limits are what
 * Slack draws natively; past 10,000 characters Slack swaps a table for plain
 * text cut at 3,000; text and fields stay well under Slack's 3,000 and 2,000
 * (its adapter adds markup after this check); 10 parts, 30 table rows and 12,000 characters keep the largest card
 * near 75 KB of the 100 KB a Teams bot message may hold (counted as UTF-16),
 * and inside Slack's 50 blocks.
 */
const CARD_LIMITS = {
  parts: 10,
  fields: 10,
  tables: 1,
  tableRows: 30,
  tableColumns: 6,
  tableText: 10_000,
  charts: 2,
  chartPoints: 20,
  chartSeries: 12,
  title: 50,
  label: 20,
  text: 2_500,
  fieldText: 1_500,
  cardText: 12_000,
};

type CardPart = Record<string, unknown> & { type: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isLabel = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/** A child with a type is a part; a text child keeps its old shape. */
function isCardPart(child: unknown): child is CardPart {
  return isRecord(child) && typeof child.type === 'string' && typeof child.text !== 'string';
}

/**
 * Why the card's parts can't be sent, each naming the child to fix; empty when
 * they can. Parts are allowed by name, so none can carry a callback button.
 */
function cardPartProblems(children: unknown[]): string[] {
  const problems: string[] = [];
  const count = { parts: 0, fields: 0, tables: 0, charts: 0, text: 0 };
  children.forEach((child, i) => {
    if (!isCardPart(child)) return;
    count.parts++;
    const at = `children[${i}]`;
    const fail = (why: string) => problems.push(`${at}: ${why}`);
    const props = isRecord(child.props) ? child.props : {};
    switch (child.type) {
      case 'Text': {
        if (!isLabel(props.content, CARD_LIMITS.text)) fail(`props.content must be text of at most ${CARD_LIMITS.text} characters`);
        else count.text += props.content.length;
        if (props.style !== undefined && !['plain', 'bold', 'muted'].includes(props.style as string)) {
          fail('props.style must be plain, bold or muted');
        }
        return;
      }
      case 'Fields': {
        const fields = Array.isArray(child.children) ? child.children : [];
        if (fields.length === 0) return fail('Fields needs at least one Field in children');
        count.fields += fields.length;
        fields.forEach((field, j) => {
          const where = `${at}.children[${j}]`;
          if (!isRecord(field) || field.type !== 'Field') return problems.push(`${where}: Fields holds only Field parts`);
          const fieldProps = isRecord(field.props) ? field.props : {};
          const value = Number.isFinite(fieldProps.value) ? String(fieldProps.value) : fieldProps.value;
          if (!isLabel(fieldProps.label, CARD_LIMITS.fieldText) || !isLabel(value, CARD_LIMITS.fieldText)) {
            return problems.push(`${where}: a Field needs props.label and props.value`);
          }
          const length = fieldProps.label.length + value.length;
          if (length > CARD_LIMITS.fieldText) return problems.push(`${where}: at most ${CARD_LIMITS.fieldText} characters`);
          count.text += length;
        });
        return;
      }
      case 'Table': {
        count.tables++;
        const { headers, rows, align, caption } = props;
        if (!Array.isArray(headers) || headers.length === 0 || !headers.every((h) => typeof h === 'string')) {
          return fail('props.headers must be a list of column names');
        }
        if (headers.length > CARD_LIMITS.tableColumns) return fail(`at most ${CARD_LIMITS.tableColumns} columns`);
        if (!Array.isArray(rows)) return fail('props.rows must be a list of rows');
        if (rows.length > CARD_LIMITS.tableRows) return fail(`at most ${CARD_LIMITS.tableRows} rows`);
        let text = headers.join('').length;
        for (const [r, row] of rows.entries()) {
          if (!Array.isArray(row)) return fail(`row ${r} must be a list of cells`);
          if (row.length !== headers.length) return fail(`row ${r} has ${row.length} cells, expected ${headers.length}`);
          if (!row.every((cell) => typeof cell === 'string' || Number.isFinite(cell))) {
            return fail(`row ${r}: a cell must be text or a number`);
          }
          text += row.map(String).join('').length;
        }
        const aligns = ['left', 'center', 'right'];
        if (align !== undefined && (!Array.isArray(align) || align.length > headers.length || !align.every((a) => aligns.includes(a as string)))) {
          return fail('props.align must list left, center or right, one per column at most');
        }
        if (caption !== undefined && typeof caption !== 'string') return fail('props.caption must be text');
        text += typeof caption === 'string' ? caption.length : 0;
        if (text > CARD_LIMITS.tableText) {
          return fail(`the table holds ${text} characters of text; at most ${CARD_LIMITS.tableText}`);
        }
        count.text += text;
        return;
      }
      case 'Chart': {
        count.charts++;
        const chart = isRecord(props.chart) ? props.chart : {};
        if (!isLabel(props.title, CARD_LIMITS.title)) return fail(`props.title must be text of at most ${CARD_LIMITS.title} characters`);
        let labels: unknown[];
        if (chart.type === 'pie') {
          const segments = Array.isArray(chart.segments) ? chart.segments : [];
          if (segments.length === 0 || segments.length > CARD_LIMITS.chartSeries) {
            return fail(`props.chart.segments must list 1 to ${CARD_LIMITS.chartSeries} slices`);
          }
          const bad = segments.findIndex((s) => !isRecord(s) || !Number.isFinite(s.value) || !((s.value as number) > 0));
          if (bad !== -1) return fail(`props.chart.segments[${bad}].value must be a number above 0`);
          labels = segments.map((s) => (s as Record<string, unknown>).label);
          if (new Set(labels).size !== labels.length) return fail('slice labels must not repeat');
        } else if (chart.type === 'bar' || chart.type === 'line' || chart.type === 'area') {
          const { categories, series, xLabel, yLabel } = chart;
          if (!Array.isArray(categories) || categories.length === 0 || categories.length > CARD_LIMITS.chartPoints) {
            return fail(`props.chart.categories must list 1 to ${CARD_LIMITS.chartPoints} categories`);
          }
          if (!Array.isArray(series) || series.length === 0 || series.length > CARD_LIMITS.chartSeries) {
            return fail(`props.chart.series must list 1 to ${CARD_LIMITS.chartSeries} series`);
          }
          for (const s of series) {
            const values = isRecord(s) && Array.isArray(s.values) ? s.values : [];
            const name = isRecord(s) ? s.name : undefined;
            if (values.length !== categories.length) {
              return fail(`series "${String(name)}" has ${values.length} values, expected ${categories.length}`);
            }
            if (!values.every((v) => Number.isFinite(v))) return fail(`series "${String(name)}": values must be numbers`);
          }
          const names = series.map((s) => (s as Record<string, unknown>).name);
          if (new Set(categories).size !== categories.length || new Set(names).size !== names.length) {
            return fail('categories and series names must not repeat');
          }
          for (const axis of [xLabel, yLabel]) {
            if (axis !== undefined && !isLabel(axis, CARD_LIMITS.title)) {
              return fail(`axis labels must be text of at most ${CARD_LIMITS.title} characters`);
            }
          }
          labels = [...categories, ...names];
        } else {
          return fail('props.chart.type must be pie, bar, line or area');
        }
        if (!labels.every((label) => isLabel(label, CARD_LIMITS.label))) {
          return fail(`each label must be text of at most ${CARD_LIMITS.label} characters`);
        }
        count.text += props.title.length + labels.join('').length;
        return;
      }
      case 'Divider':
        return;
      default:
        fail(`unknown part "${child.type}"; use Text, Fields, Table, Chart, Divider`);
    }
  });
  if (count.parts > CARD_LIMITS.parts) problems.push(`at most ${CARD_LIMITS.parts} parts per card`);
  if (count.fields > CARD_LIMITS.fields) problems.push(`at most ${CARD_LIMITS.fields} fields per card`);
  if (count.tables > CARD_LIMITS.tables) problems.push(`at most ${CARD_LIMITS.tables} Table per card`);
  if (count.charts > CARD_LIMITS.charts) problems.push(`at most ${CARD_LIMITS.charts} Charts per card`);
  if (count.text > CARD_LIMITS.cardText) {
    problems.push(`the parts hold ${count.text} characters of text; at most ${CARD_LIMITS.cardText} per card`);
  }
  return problems;
}

/**
 * A part as the tool advertises it: its name, not its fields. The send_card
 * schema reaches every provider on every request, so it stays small and plain;
 * the fields are in the tool's instructions, and a refusal names what to fix.
 */
const CARD_PART_SCHEMA = Object.freeze({
  type: 'object' as const,
  description: 'A card part: { type, props } (Fields: { type, children: Field parts }). Fields per part are in the send_card instructions.',
  properties: {
    type: { type: 'string' as const, enum: ['Text', 'Fields', 'Table', 'Chart', 'Divider'] },
    props: { type: 'object' as const },
    children: { type: 'array' as const, items: { type: 'object' as const } },
  },
  required: ['type'],
});

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/** Same as MAX_CARD_QUESTION_LENGTH in the host's src/channels/ask-question.ts. */
export const MAX_CARD_QUESTION_LENGTH = 2000;

export const askUserQuestion: McpToolDefinition = {
  tool: {
    name: 'ask_user_question',
    description:
      'Ask the user a multiple-choice question and wait for their response. This is a blocking call — execution pauses until the user responds or the timeout expires. Provide a short card title (e.g. "Confirm deletion") and an array of options — each option may be a plain string (used as both button label and result value) or an object { label, selectedLabel?, value? } where selectedLabel is the text shown on the card after the user clicks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short card title shown above the question' },
        question: {
          type: 'string',
          description: 'The question to ask. Title and question together: at most 2000 characters',
        },
        options: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  selectedLabel: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['label'],
              },
            ],
          },
          description: 'Options for the user to choose from (string or {label, selectedLabel?, value?})',
        },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 300)' },
      },
      required: ['title', 'question', 'options'],
    },
  },
  async handler(args, context) {
    if (context?.signal.aborted) return err('Question cancelled');
    const title = args.title as string;
    const question = args.question as string;
    const rawOptions = args.options as unknown[];
    const timeout = ((args.timeout as number) || 300) * 1000;
    if (!title || !question || !rawOptions?.length) {
      return err('title, question, and options are required');
    }
    // The host refuses longer cards; say so now instead of waiting out the timeout.
    if (title.length + question.length > MAX_CARD_QUESTION_LENGTH) {
      return err(
        `title and question are too long to show in full on a card (${title.length + question.length} characters, limit ${MAX_CARD_QUESTION_LENGTH}). Shorten the question.`,
      );
    }

    const options = rawOptions.map((o) => {
      if (typeof o === 'string') return { label: o, selectedLabel: o, value: o };
      const obj = o as { label: string; selectedLabel?: string; value?: string };
      return {
        label: obj.label,
        selectedLabel: obj.selectedLabel ?? obj.label,
        value: obj.value ?? obj.label,
      };
    });

    const questionId = generateId();
    const r = routing();

    // Write question card to outbound.db
    await writeMessageOut({
      id: questionId,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        type: 'ask_question',
        questionId,
        title,
        question,
        options,
      }),
    });

    log(`ask_user_question: ${questionId} → "${question}" [${options.join(', ')}]`);

    // Poll for response in inbound.db (host writes the response there)
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (context?.signal.aborted) return err('Question cancelled');
      // Read the delivery outcome before the answer, so an answer that lands
      // between the two reads still wins.
      const deliveryFailed = getDeliveryStatus(questionId) === 'failed';
      const response = findQuestionResponse(questionId);

      if (response) {
        const parsed = JSON.parse(response.content);
        // Mark the response as completed via processing_ack (outbound.db)
        markCompleted([response.id]);

        log(`ask_user_question response: ${questionId} → ${parsed.selectedOption}`);
        return ok(parsed.selectedOption);
      }

      // The host gave up delivering the card: stop waiting for an answer.
      if (deliveryFailed) {
        log(`ask_user_question undeliverable: ${questionId}`);
        return err(
          'The question card could not be delivered, so no answer will be collected. Shorten the title, question or option labels, or ask in a plain message.',
        );
      }

      try {
        await sleep(1000, undefined, { signal: context?.signal });
      } catch (error) {
        if (context?.signal.aborted) return err('Question cancelled');
        throw error;
      }
    }

    log(`ask_user_question timeout: ${questionId}`);
    return err(`Question timed out after ${timeout / 1000}s`);
  },
};

export const sendCard: McpToolDefinition = {
  tool: {
    name: 'send_card',
    description: 'Send a display card with optional URL link buttons to the current conversation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        card: {
          type: 'object',
          description:
            'Display card with optional title, description, children (text and card parts) and URL link actions. Each action requires a non-empty label and a url that is a web link (http or https); invalid actions are dropped. Callback buttons are unsupported; use ask_user_question for choices.',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            children: {
              type: 'array',
              description:
                'Text (strings or objects with a text field) and card parts: Text, Fields, Table, Chart, Divider. At most 10 parts, 1 Table (30 rows, 6 columns) and 2 Charts per card. A card with an invalid part is not sent; the result says what to fix. Nested action blocks are unsupported.',
              items: {
                anyOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: { text: { type: 'string' } },
                    required: ['text'],
                  },
                  CARD_PART_SCHEMA,
                ],
              },
            },
            actions: {
              type: 'array',
              items: LINK_ACTION_SCHEMA,
            },
          },
        },
        fallbackText: {
          type: 'string',
          description:
            'Plain-text version of the card for channels that render cards as text. Not related to buttons: send_card never renders callback buttons anywhere.',
        },
      },
      required: ['card'],
    },
  },
  async handler(args) {
    const card = args.card as Record<string, unknown>;
    if (!card) return err('card is required');

    const id = generateId();
    const r = routing();
    const { card: renderable, dropped } = partitionActions(card);
    const problems = cardPartProblems(Array.isArray(renderable.children) ? renderable.children : []);
    if (problems.length > 0) return err(`Card not sent. Fix these and send it again: ${problems.join('; ')}`);

    await writeMessageOut({
      id,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ type: 'card', card: renderable, fallbackText: (args.fallbackText as string) || '' }),
    });

    log(`send_card: ${id}`);
    if (dropped > 0) {
      return ok(
        `Card sent (id: ${id}). ${dropped} invalid action(s) were dropped: send_card link actions need a non-empty label and a url that is a web link (http or https), such as https://example.com. Use ask_user_question for callback buttons.`,
      );
    }
    return ok(`Card sent (id: ${id})`);
  },
};

registerTools([askUserQuestion, sendCard]);
