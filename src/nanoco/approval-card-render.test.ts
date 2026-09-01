import { describe, expect, it } from 'vitest';

import {
  APPROVAL_CARD_TITLE_LIMIT,
  APPROVAL_CARD_TITLE_UTF8_BYTE_LIMIT,
  APPROVAL_CARD_TEXT_LIMIT,
  approvalCardQuestion,
  approvalCardSurface,
  approvalCardTextChunks,
  approvalCardTitle,
  approvalFallbackText,
} from './approval-card-render.js';
import type { GatewayApproval } from './approval-contract.js';

describe('Gateway approval card presentation', () => {
  it('renders a compact human Gmail decision without transport internals', () => {
    const question = approvalCardQuestion({
      deadline: '2026-08-10T08:44:00.000Z',
      presentation_json: JSON.stringify({
        appId: 'gmail',
        appLabel: 'Gmail',
        operationId: 'gmail:send-email',
        title: 'Send email',
        description: "Send a new email on the user's behalf.",
        class: 'write',
        fields: [
          { label: 'To', kind: 'list', value: ['avital@nanoco.ai'] },
          { label: 'Subject', kind: 'text', value: 'Template release' },
          {
            label: 'Message',
            kind: 'long_text',
            value: 'Hi Avital,\n\nWhere does the release stand?',
          },
        ],
      }),
    });

    expect(question).toBe(
      [
        '✏️ *Write operation*',
        "Send a new email on the user's behalf.",
        '*To*\n• avital@nanoco.ai',
        '*Subject*\nTemplate release',
        '*Message preview*\n> Hi Avital,\n>  \n> Where does the release stand?',
        '_Approval expires: 10 Aug 2026, 08:44 UTC_',
      ].join('\n\n'),
    );
    expect(question).not.toContain('_Request:');
  });

  it('bounds long semantic text while retaining the start of the trusted projection', () => {
    const message = Array.from({ length: 20 }, (_, index) => `Line ${index + 1}: ${'x'.repeat(90)}`).join('\n');
    const question = approvalCardQuestion({
      deadline: '2026-08-10T08:44:00.000Z',
      presentation_json: JSON.stringify({
        appId: 'gmail',
        appLabel: 'Gmail',
        operationId: 'gmail:send-email',
        title: 'Send email',
        class: 'write',
        fields: [{ label: 'Message', kind: 'long_text', value: message }],
      }),
    });

    expect(question).toContain('> Line 1:');
    expect(question).not.toContain('Line 20:');
    expect(question).toContain('… _(preview truncated)_');
    expect(question.length).toBeLessThan(700);
  });

  it('uses a bounded header and keeps the complete maximum-length semantic title in the body', () => {
    const presentation: GatewayApproval['presentation'] = {
      appId: 'gmail',
      appLabel: 'A'.repeat(256),
      operationId: 'gmail:send-email',
      title: 'T'.repeat(256),
      description: 'Send a message.',
      class: 'write',
      fields: [],
    };
    const fullTitle = `${presentation.appLabel} · ${presentation.title}`;
    const header = approvalCardTitle(presentation);
    const question = approvalCardQuestion({
      deadline: '2026-08-10T08:44:00.000Z',
      presentation_json: JSON.stringify(presentation),
    });
    const genericSurface = approvalCardSurface(fullTitle, 'Allow this operation?');

    expect(header.length).toBeLessThanOrEqual(APPROVAL_CARD_TITLE_LIMIT);
    expect(header).toMatch(/…$/);
    expect(question).toContain(`*Full approval title*\n${fullTitle}`);
    expect(genericSurface).toEqual({
      header,
      body: `*Full approval title*\n${fullTitle}\n\nAllow this operation?`,
    });
  });

  it('omits a redundant shortened header in a compact fallback while leaving normal short titles unchanged', () => {
    const fullTitle = `${'A'.repeat(256)} · ${'T'.repeat(256)}`;
    const surface = approvalCardSurface(fullTitle, 'Allow this operation?');
    const fallback = approvalFallbackText({
      title: surface.header,
      question: surface.body,
      tail: 'Options: Approve, Reject',
    });
    const shortFallback = approvalFallbackText({
      title: 'Gmail · Send email',
      question: 'Allow this operation?',
      tail: 'Options: Approve, Reject',
    });

    expect(fallback.length).toBeLessThan(APPROVAL_CARD_TEXT_LIMIT);
    expect(fallback).toMatch(/^\*Full approval title\*/);
    expect(fallback.startsWith(surface.header)).toBe(false);
    expect(fallback.split(fullTitle)).toHaveLength(2);
    expect(shortFallback).toBe('Gmail · Send email\n\nAllow this operation?\n\nOptions: Approve, Reject');
  });

  it.each([
    ['CJK', '漢'.repeat(85), '語'.repeat(85)],
    ['emoji graphemes', '👩🏽‍💻'.repeat(17), '👨‍👩‍👧‍👦'.repeat(10)],
  ])('truncates a contract-valid %s title only at grapheme boundaries and within the wire budget', (_, appLabel, title) => {
    const fullTitle = `${appLabel} · ${title}`;
    const header = approvalCardTitle({
      appId: 'gmail',
      appLabel,
      operationId: 'gmail:send-email',
      title,
      description: 'Send a message.',
      class: 'write',
      fields: [],
    });
    const prefix = header.slice(0, -1);
    const prefixGraphemes = graphemes(prefix);

    expect(graphemes(header)).toHaveLength(prefixGraphemes.length + 1);
    expect(graphemes(header).length).toBeLessThanOrEqual(APPROVAL_CARD_TITLE_LIMIT);
    expect(Buffer.byteLength(header)).toBeLessThanOrEqual(APPROVAL_CARD_TITLE_UTF8_BYTE_LIMIT);
    expect(header).toMatch(/…$/);
    expect(prefix).toBe(graphemes(fullTitle).slice(0, prefixGraphemes.length).join(''));
    expect(header).not.toContain('\uFFFD');
  });

  it('reserves full-title evidence without reparsing rendered omission text in a bounded fallback', () => {
    const fullTitle = `Governance · ${'review context '.repeat(12)}Review … and 5 more`;
    const surface = approvalCardSurface(fullTitle, [
      '*Messages*',
      ...Array.from({ length: 80 }, (_, index) => `• Message ${index + 1}: ${'context '.repeat(12)}`),
      '• … and 950 more',
    ].join('\n'));
    const fallback = approvalFallbackText({
      title: surface.header,
      question: surface.body,
      tail: 'Options: Approve, Reject',
    });

    expect(surface.body.length).toBeGreaterThan(APPROVAL_CARD_TEXT_LIMIT);
    expect(approvalCardTextChunks(surface.body).join('\n')).toContain('• … and 950 more');
    expect(fallback.length).toBeLessThanOrEqual(APPROVAL_CARD_TEXT_LIMIT);
    expect(fallback.split(fullTitle)).toHaveLength(2);
    expect(fallback.match(/Review … and 5 more/g)).toHaveLength(1);
    expect(fallback).toContain(
      '_Approval details, including any list continuation, remain in the structured card._',
    );
    expect(fallback).not.toContain('*List disclosure*');
    expect(fallback).not.toContain('• … and 950 more');
  });

  it('does not treat a later field-label collision as renderer-owned full-title evidence', () => {
    const fallback = approvalFallbackText({
      title: 'Governance · Review change',
      question: [`*Notes*\n${'context '.repeat(500)}`, '*Full approval title*\nfield value'].join('\n\n'),
      tail: 'Options: Approve, Reject',
    });

    expect(fallback.length).toBeLessThanOrEqual(APPROVAL_CARD_TEXT_LIMIT);
    expect(fallback).toMatch(/^Governance · Review change/);
    expect(fallback).toContain('any list continuation');
  });

  it.each([1, 50, 51, 1000])(
    'keeps a %i-item source list channel-safe without losing its exact disclosure',
    (sourceCount) => {
      const question = approvalCardQuestion(listPresentation(sourceCount));
      const chunks = approvalCardTextChunks(question);
      const fallback = approvalFallbackText({
        title: 'Gmail · Modify messages',
        question,
        tail: 'Options: Approve, Reject',
      });

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every((chunk) => chunk.length <= APPROVAL_CARD_TEXT_LIMIT)).toBe(true);
      expect(fallback.length).toBeLessThanOrEqual(APPROVAL_CARD_TEXT_LIMIT);
      if (sourceCount > 50) {
        const disclosure = `… and ${sourceCount - 50} more`;
        expect(chunks.join('\n')).toContain(disclosure);
        expect(fallback).not.toContain(disclosure);
        expect(fallback).toContain('any list continuation');
      } else {
        expect(chunks.join('\n')).not.toMatch(/… and \d+ more/);
        expect(fallback).not.toMatch(/… and \d+ more/);
      }
      expect(fallback).not.toContain('*List disclosure*');
    },
  );
});

function listPresentation(sourceCount: number) {
  const visibleCount = Math.min(sourceCount, 50);
  const values = Array.from(
    { length: visibleCount },
    (_, index) => `Message ${index + 1}: ${String(index + 1).padStart(4, '0')} ${'label-context '.repeat(20)}`,
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

function graphemes(value: string): string[] {
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), ({ segment }) => segment);
}
