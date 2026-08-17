import { describe, expect, it } from 'vitest';

import { extractSlackRawText } from './slack-raw-text.js';

// Trimmed from a real Slack event: user pasted a table into the message.
// Slack delivers it as attachments[].blocks[] of type "table" — absent from
// event.text and event.files. Header row cells are rich_text (nested
// elements), data row cells are raw_text (flat).
const tableEvent = {
  text: 'can you tell me which devices support remote firmware upgrades from this list?',
  attachments: [
    {
      id: 1,
      fallback: '[no preview available]',
      blocks: [
        {
          type: 'table',
          rows: [
            [
              {
                type: 'rich_text',
                elements: [
                  {
                    type: 'rich_text_section',
                    elements: [{ type: 'text', text: 'Manufacturer', style: { bold: true } }],
                  },
                ],
              },
              {
                type: 'rich_text',
                elements: [
                  {
                    type: 'rich_text_section',
                    elements: [{ type: 'text', text: 'Hardware Type', style: { bold: true } }],
                  },
                ],
              },
            ],
            [
              { type: 'raw_text', text: 'Samsung' },
              { type: 'raw_text', text: 'Video display' },
            ],
            [
              { type: 'raw_text', text: 'Neat' },
              { type: 'raw_text', text: 'Video bar' },
            ],
          ],
        },
      ],
    },
  ],
};

describe('extractSlackRawText', () => {
  it('flattens a pasted table from attachments[].blocks into pipe-separated rows', () => {
    const out = extractSlackRawText(tableEvent);
    expect(out).toBe(
      ['Manufacturer | Hardware Type', 'Samsung | Video display', 'Neat | Video bar'].join('\n'),
    );
  });

  it('returns null when there is nothing to extract', () => {
    expect(extractSlackRawText({ text: 'hi' })).toBeNull();
    expect(extractSlackRawText({ attachments: [{ id: 1, fallback: 'x' }] })).toBeNull();
    // link-unfurl attachments (title/text, no blocks) are not pasted content
    expect(
      extractSlackRawText({ attachments: [{ from_url: 'https://x.com', title: 't', text: 'd' }] }),
    ).toBeNull();
  });

  it('caps output size', () => {
    const bigRows = Array.from({ length: 20000 }, (_, i) => [
      { type: 'raw_text', text: `row-${i}-cell-with-some-padding-text` },
    ]);
    const out = extractSlackRawText({
      attachments: [{ blocks: [{ type: 'table', rows: bigRows }] }],
    });
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(100_000);
    expect(out).toContain('truncated');
  });
});

// Bridge-side wiring: appendRawText is what messageToInbound calls with the
// configured extractRawText hook, right before serialized.raw is dropped.
import { appendRawText } from './chat-sdk-bridge.js';

describe('appendRawText', () => {
  it('appends extractor output to serialized.text', () => {
    const serialized: Record<string, unknown> = { text: 'question?' };
    appendRawText(serialized, { attachments: [] }, () => 'a | b');
    expect(serialized.text).toBe('question?\n\na | b');
  });

  it('leaves text untouched when extractor returns null or is absent', () => {
    const serialized: Record<string, unknown> = { text: 'question?' };
    appendRawText(serialized, {}, () => null);
    appendRawText(serialized, {}, undefined);
    expect(serialized.text).toBe('question?');
  });

  it('sets text when message had none (paste-only message)', () => {
    const serialized: Record<string, unknown> = { text: '' };
    appendRawText(serialized, {}, () => 'a | b');
    expect(serialized.text).toBe('a | b');
  });
});
