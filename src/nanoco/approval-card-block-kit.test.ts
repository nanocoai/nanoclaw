import { cardToBlockKit } from '@chat-adapter/slack';
import { describe, expect, it } from 'vitest';

import { approvalQuestionMessage, terminalApprovalMessage } from '../channels/chat-sdk-bridge.js';
import {
  APPROVAL_CARD_TITLE_LIMIT,
  APPROVAL_CARD_TITLE_UTF8_BYTE_LIMIT,
  APPROVAL_CARD_TEXT_LIMIT,
  approvalCardQuestion,
  approvalCardTitle,
  type PersistedApprovalCardEvidence,
} from './approval-card-render.js';
import type { GatewayApproval } from './approval-contract.js';

describe('Gateway approval Slack Block Kit presentation', () => {
  it.each([1, 50, 51, 1000])(
    'keeps initial and terminal cards within Slack limits for %i source items',
    (sourceCount) => {
      const question = approvalCardQuestion(listPresentation(sourceCount));
      const initial = approvalQuestionMessage({
        title: 'Gmail · Modify messages',
        question,
        questionId: 'gwq:0123456789abcdef0123456789abcdef',
        options: [
          { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
          { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
        ],
      });
      const terminal = terminalApprovalMessage({
        title: 'Gmail · Modify messages',
        question,
        resolution: '✅ Approved by the selected approver',
      });

      for (const message of [initial, terminal]) {
        const blocks = cardToBlockKit(message.card);
        const headers = slackHeaderTexts(blocks);
        const texts = slackSectionAndContextTexts(blocks);
        expect(headers).toEqual(['Gmail · Modify messages']);
        expect(headers[0]!.length).toBeLessThanOrEqual(150);
        expect(texts.length).toBeGreaterThan(0);
        expect(texts.join('\n')).not.toContain('*Full approval title*');
        expect(texts.every((text) => text.length <= APPROVAL_CARD_TEXT_LIMIT)).toBe(true);
        expect(texts.every((text) => text.length <= 3000)).toBe(true);
        expect(message.fallbackText.length).toBeLessThanOrEqual(APPROVAL_CARD_TEXT_LIMIT);
        if (sourceCount > 50) {
          const disclosure = `… and ${sourceCount - 50} more`;
          expect(texts.join('\n')).toContain(disclosure);
          expect(message.fallbackText).not.toContain(disclosure);
          expect(message.fallbackText).toContain('any list continuation');
        }
        expect(message.fallbackText).not.toContain('*List disclosure*');
      }
    },
  );

  it('bounds a maximum-length Gateway title without hiding its full decision evidence', () => {
    const presentation: GatewayApproval['presentation'] = {
      appId: 'gmail',
      appLabel: 'A'.repeat(256),
      operationId: 'gmail:modify-messages',
      title: 'T'.repeat(256),
      description: "Change labels on the user's messages.",
      class: 'write',
      fields: [
        {
          label: 'Messages',
          kind: 'list',
          value: [...Array.from({ length: 50 }, (_, index) => `message-${index + 1}`), '… and 950 more'],
        },
      ],
    };
    const fullTitle = `${presentation.appLabel} · ${presentation.title}`;
    const title = approvalCardTitle(presentation);
    const question = approvalCardQuestion({
      deadline: '2026-08-10T08:44:00.000Z',
      presentation_json: JSON.stringify(presentation),
    });
    const initial = approvalQuestionMessage({
      title,
      question,
      questionId: 'gwq:0123456789abcdef0123456789abcdef',
      options: [
        { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
        { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
      ],
    });
    const terminal = terminalApprovalMessage({
      title,
      question,
      resolution: '✅ Approved by the selected approver',
    });

    expect(title.length).toBeLessThanOrEqual(APPROVAL_CARD_TITLE_LIMIT);
    for (const message of [initial, terminal]) {
      const blocks = cardToBlockKit(message.card);
      const headers = slackHeaderTexts(blocks);
      const body = slackSectionAndContextTexts(blocks).join('\n');
      expect(headers).toHaveLength(1);
      expect(headers[0]!.length).toBeLessThanOrEqual(150);
      expect(body).toContain(fullTitle);
      expect(body.split(fullTitle)).toHaveLength(2);
      expect(message.fallbackText).toContain(fullTitle);
      expect(message.fallbackText.split(fullTitle)).toHaveLength(2);
      expect(message.fallbackText.length).toBeLessThanOrEqual(APPROVAL_CARD_TEXT_LIMIT);
      expect(slackSectionAndContextTexts(blocks).every((text) => text.length <= 3000)).toBe(true);
    }
  });

  it('fits the worst-case escapable title in initial and terminal fallbacks without a redundant short header', () => {
    const presentation: GatewayApproval['presentation'] = {
      appId: 'governance',
      appLabel: '&'.repeat(256),
      operationId: 'governance:review',
      title: '&'.repeat(256),
      description: 'Review a change.',
      class: 'write',
      fields: [],
    };
    const fullTitle = `${presentation.appLabel} · ${presentation.title}`;
    const title = approvalCardTitle(presentation);
    const question = approvalCardQuestion({
      deadline: '2026-08-10T08:44:00.000Z',
      presentation_json: JSON.stringify(presentation),
    });
    const messages = [
      approvalQuestionMessage({
        title,
        question,
        questionId: 'gwq:0123456789abcdef0123456789abcdef',
        options: [
          { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
          { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
        ],
      }),
      terminalApprovalMessage({ title, question, resolution: '✅ Approved by the selected approver' }),
    ];

    for (const message of messages) {
      const blocks = cardToBlockKit(message.card);
      expect(slackHeaderTexts(blocks)).toEqual([title]);
      expect(message.fallbackText.length).toBeLessThanOrEqual(APPROVAL_CARD_TEXT_LIMIT);
      expect(message.fallbackText).toMatch(/^\*Full approval title\*/);
      expect(message.fallbackText).toMatch(/Options: Approve, Reject|Approved by the selected approver/);
      expect(decodedSlackLiteralFullTitle(message.fallbackText)).toBe(fullTitle);
      expect(slackSectionAndContextTexts(blocks).every((text) => text.length <= 3000)).toBe(true);
    }
  });

  it.each([
    ['CJK', '漢'.repeat(85), '語'.repeat(85)],
    ['emoji graphemes', '👩🏽‍💻'.repeat(17), '👨‍👩‍👧‍👦'.repeat(10)],
  ])('keeps contract-valid %s titles safe in initial and terminal Slack blocks', (_, appLabel, operationTitle) => {
    const presentation: GatewayApproval['presentation'] = {
      appId: 'gmail',
      appLabel,
      operationId: 'gmail:send-email',
      title: operationTitle,
      description: 'Send a message.',
      class: 'write',
      fields: [],
    };
    const fullTitle = `${appLabel} · ${operationTitle}`;
    const title = approvalCardTitle(presentation);
    const question = approvalCardQuestion({
      deadline: '2026-08-10T08:44:00.000Z',
      presentation_json: JSON.stringify(presentation),
    });
    const messages = [
      approvalQuestionMessage({
        title,
        question,
        questionId: 'gwq:0123456789abcdef0123456789abcdef',
        options: [
          { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
          { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
        ],
      }),
      terminalApprovalMessage({ title, question, resolution: '✅ Approved by the selected approver' }),
    ];

    for (const message of messages) {
      const blocks = cardToBlockKit(message.card);
      const header = slackHeaderTexts(blocks)[0]!;
      const body = slackSectionAndContextTexts(blocks).join('\n');
      expect(graphemes(header).length).toBeLessThanOrEqual(APPROVAL_CARD_TITLE_LIMIT);
      expect(Buffer.byteLength(header)).toBeLessThanOrEqual(APPROVAL_CARD_TITLE_UTF8_BYTE_LIMIT);
      expect(header).toMatch(/…$/);
      expect(body.split(fullTitle)).toHaveLength(2);
      expect(message.fallbackText.split(fullTitle)).toHaveLength(2);
      expect(body).not.toContain('\uFFFD');
    }
  });

  it('renders adversarial copied titles as inert, exact human-readable Slack text', () => {
    const appLabel = 'Governance <!here>';
    const operationTitle = `${'Review '.repeat(18)}<https://evil.example|trusted> *approved* _italic_ ~done~ \`code\` fence \`\`\`\` https://plain.evil.example`;
    const presentation: GatewayApproval['presentation'] = {
      appId: 'governance',
      appLabel,
      operationId: 'governance:review',
      title: operationTitle,
      description: 'Review a change.',
      class: 'write',
      fields: [],
    };
    const fullTitle = `${appLabel} · ${operationTitle}`;
    const title = approvalCardTitle(presentation);
    const question = approvalCardQuestion({
      deadline: '2026-08-10T08:44:00.000Z',
      presentation_json: JSON.stringify(presentation),
    });
    const messages = [
      approvalQuestionMessage({
        title,
        question,
        questionId: 'gwq:0123456789abcdef0123456789abcdef',
        options: [
          { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
          { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
        ],
      }),
      terminalApprovalMessage({ title, question, resolution: '❌ Rejected by the selected approver' }),
    ];

    for (const message of messages) {
      const blocks = cardToBlockKit(message.card);
      const body = slackSectionAndContextTexts(blocks).join('\n');
      expect(slackHeaderTexts(blocks)).toEqual([title]);
      const headerBlock = blocks.find((block) => block.type === 'header');
      expect((headerBlock?.text as { type?: unknown } | undefined)?.type).toBe('plain_text');
      expectSlackLiteralFullTitle(body, fullTitle);
      expectSlackLiteralFullTitle(message.fallbackText, fullTitle);
    }
  });
});

function listPresentation(sourceCount: number): PersistedApprovalCardEvidence {
  const values = Array.from(
    { length: Math.min(sourceCount, 50) },
    (_, index) => `Message ${index + 1}: ${'semantic label context '.repeat(14)}`,
  );
  if (sourceCount > 50) values.push(`… and ${sourceCount - 50} more`);
  return {
    deadline: '2026-08-10T08:44:00.000Z',
    presentation_json: JSON.stringify({
      appId: 'gmail',
      appLabel: 'Gmail',
      operationId: 'gmail:modify-messages',
      title: 'Modify messages',
      description: "Change labels on the user's messages.",
      class: 'write',
      fields: [{ label: 'Messages', kind: 'list', value: values }],
    }),
  };
}

function slackHeaderTexts(blocks: Array<Record<string, unknown>>): string[] {
  return blocks.flatMap((block) => {
    if (block.type !== 'header') return [];
    const text = block.text as { text?: unknown } | undefined;
    return typeof text?.text === 'string' ? [text.text] : [];
  });
}

function slackSectionAndContextTexts(blocks: Array<Record<string, unknown>>): string[] {
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'section') {
      const text = block.text as { text?: unknown } | undefined;
      if (typeof text?.text === 'string') texts.push(text.text);
    }
    if (block.type !== 'context') continue;
    const elements = block.elements;
    if (Array.isArray(elements)) {
      for (const element of elements) {
        if (element && typeof element === 'object' && typeof (element as { text?: unknown }).text === 'string') {
          texts.push((element as { text: string }).text);
        }
      }
    }
  }
  return texts;
}

function graphemes(value: string): string[] {
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), ({ segment }) => segment);
}

function expectSlackLiteralFullTitle(container: string, fullTitle: string): void {
  expect(decodedSlackLiteralFullTitle(container)).toBe(fullTitle);
  const matches = [...container.matchAll(/\*Full approval title\*\n```\n([\s\S]*?)\n```/g)];
  const encoded = matches[0]![1]!;
  expect(encoded).not.toContain('<!here>');
  expect(encoded).not.toContain('<https://evil.example|trusted>');
  expect(encoded).not.toContain('```');
  const outsideLiteralBlock = container.replace(matches[0]![0], '');
  expect(outsideLiteralBlock).not.toContain('*approved* _italic_ ~done~');
  expect(outsideLiteralBlock).not.toContain('https://plain.evil.example');
}

function decodedSlackLiteralFullTitle(container: string): string {
  const matches = [...container.matchAll(/\*Full approval title\*\n```\n([\s\S]*?)\n```/g)];
  expect(matches).toHaveLength(1);
  const encoded = matches[0]![1]!;
  return decodeSlackLiteral(encoded);
}

function decodeSlackLiteral(value: string): string {
  return value
    .replace(/`\u2060/g, '`')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}
