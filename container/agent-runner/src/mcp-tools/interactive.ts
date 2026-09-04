/**
 * Interactive MCP tools: ask_user_question, send_card.
 *
 * ask_user_question is a blocking tool call — it writes a messages_out row
 * with a question card, then polls messages_in for the response.
 */
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

import { findQuestionResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function routing() {
  return getSessionRouting();
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
    url: {
      type: 'string' as const,
      pattern: '^[hH][tT][tT][pP][sS]?://[^\\s/?#]\\S*$',
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
function partitionActions(card: Record<string, unknown>): { card: Record<string, unknown>; dropped: number } {
  const actions = card.actions;
  if (!Array.isArray(actions)) return { card, dropped: 0 };

  const valid = actions.filter((action) => validateLinkAction(action).valid);
  if (valid.length === actions.length) return { card, dropped: 0 };

  return { card: { ...card, actions: valid }, dropped: actions.length - valid.length };
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const askUserQuestion: McpToolDefinition = {
  tool: {
    name: 'ask_user_question',
    description:
      'Ask the user a multiple-choice question and wait for their response. This is a blocking call — execution pauses until the user responds or the timeout expires. Provide a short card title (e.g. "Confirm deletion") and an array of options — each option may be a plain string (used as both button label and result value) or an object { label, selectedLabel?, value? } where selectedLabel is the text shown on the card after the user clicks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short card title shown above the question' },
        question: { type: 'string', description: 'The question to ask' },
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
  async handler(args) {
    const title = args.title as string;
    const question = args.question as string;
    const rawOptions = args.options as unknown[];
    const timeout = ((args.timeout as number) || 300) * 1000;
    if (!title || !question || !rawOptions?.length) {
      return err('title, question, and options are required');
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
      const response = findQuestionResponse(questionId);

      if (response) {
        const parsed = JSON.parse(response.content);
        // Mark the response as completed via processing_ack (outbound.db)
        markCompleted([response.id]);

        log(`ask_user_question response: ${questionId} → ${parsed.selectedOption}`);
        return ok(parsed.selectedOption);
      }

      await sleep(1000);
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
            'Display card with optional title, description, text children, and URL link actions. Each action requires a non-empty label and a url that is a web link (http or https); invalid actions are dropped. Callback buttons are unsupported; use ask_user_question for choices.',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            children: {
              type: 'array',
              description:
                'Text content only: strings or objects with a text field. Nested action blocks are unsupported.',
              items: {
                anyOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: { text: { type: 'string' } },
                    required: ['text'],
                  },
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
