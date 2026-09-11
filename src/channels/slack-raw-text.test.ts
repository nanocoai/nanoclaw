import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appendRawText } from './chat-sdk-bridge.js';
import { extractSlackRawText } from './slack-raw-text.js';

const pastedTableEvent = {
  text: 'Analyze this attendee list:',
  attachments: [
    {
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
                    elements: [{ type: 'text', text: 'Company', style: { bold: true } }],
                  },
                ],
              },
              {
                type: 'rich_text',
                elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Title' }] }],
              },
            ],
            [
              { type: 'raw_text', text: 'Agria Pet Insurance' },
              { type: 'raw_text', text: 'Head of IT Operations' },
            ],
            [
              { type: 'raw_text', text: 'AVEVA' },
              { type: 'raw_text', text: 'Head of Cyber Security Risk and Assurance' },
            ],
          ],
        },
      ],
    },
  ],
};

describe('Slack pasted-table ingestion', () => {
  it('flattens table attachment blocks into readable rows', () => {
    expect(extractSlackRawText(pastedTableEvent)).toBe(
      [
        'Company | Title',
        'Agria Pet Insurance | Head of IT Operations',
        'AVEVA | Head of Cyber Security Risk and Assurance',
      ].join('\n'),
    );
  });

  it('ignores ordinary attachments and malformed table blocks', () => {
    expect(extractSlackRawText({ text: 'hello' })).toBeNull();
    expect(extractSlackRawText({ attachments: [{ fallback: 'link preview' }] })).toBeNull();
    expect(extractSlackRawText({ attachments: [{ blocks: [{ type: 'table', rows: 'bad' }] }] })).toBeNull();
  });

  it('appends rescued rows to the user text before raw payload removal', () => {
    const serialized: Record<string, unknown> = { text: 'Analyze this attendee list:' };
    appendRawText(serialized, pastedTableEvent, extractSlackRawText);
    expect(serialized.text).toContain('Analyze this attendee list:\n\nCompany | Title');
    expect(serialized.text).toContain('Agria Pet Insurance | Head of IT Operations');
  });

  it('caps unexpectedly large pasted tables', () => {
    const rows = Array.from({ length: 20_000 }, (_, index) => [
      { type: 'raw_text', text: `row-${index}-with-padding` },
    ]);
    const text = extractSlackRawText({ attachments: [{ blocks: [{ type: 'table', rows }] }] });
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(100_000);
    expect(text).toContain('[table truncated]');
  });

  it('keeps the default Slack factory wired to the extractor', () => {
    const source = readFileSync(join(new URL('.', import.meta.url).pathname, 'slack.ts'), 'utf8');
    expect(source).toContain("import { extractSlackRawText } from './slack-raw-text.js';");
    expect(source).toContain('extractRawText: extractSlackRawText');
  });
});
