import { describe, it, expect } from 'vitest';

import { formatInboundText, outboundText, parseInboundAllow, senderAllowed } from './agentmail.js';

describe('agentmail inbound allowlist', () => {
  it('routes every sender when unset or empty', () => {
    expect(parseInboundAllow(undefined)).toBeNull();
    expect(parseInboundAllow(' , ')).toBeNull();
    expect(senderAllowed('anyone@example.com', null)).toBe(true);
  });

  it('matches exact addresses case-insensitively and @domain suffixes', () => {
    const allow = parseInboundAllow('Owner@Example.com, @partner.example');
    expect(senderAllowed('owner@example.com', allow)).toBe(true);
    expect(senderAllowed('Someone@partner.example', allow)).toBe(true);
    expect(senderAllowed('owner@example.com.evil.com', allow)).toBe(false);
    expect(senderAllowed('vendor@other.example', allow)).toBe(false);
  });
});

describe('agentmail inbound formatting', () => {
  it('prefixes a header and prefers extracted text', () => {
    const text = formatInboundText({
      messageId: 'm1',
      threadId: 't1',
      from: 'Owner <owner@example.com>',
      subject: 'Quote',
      text: 'new\n\n> quoted history',
      extractedText: 'new',
      attachments: [{ attachmentId: 'a1', filename: 'q.pdf', size: 2_500_000 }],
    });
    expect(text).toBe(
      '[email] From: Owner <owner@example.com>\nSubject: Quote\nthread_id: t1 | message_id: m1\n' +
        'Attachments: q.pdf (2.4 MB, id a1)\n\nnew',
    );
  });

  it('falls back to full text and a placeholder subject', () => {
    const text = formatInboundText({ messageId: 'm2', from: 'x@y.z', text: 'hello' });
    expect(text).toContain('Subject: (no subject)');
    expect(text.endsWith('\n\nhello')).toBe(true);
  });
});

describe('agentmail outbound text', () => {
  it('sends plain chat text and skips empty content', () => {
    expect(outboundText({ text: 'hello' })).toBe('hello');
    expect(outboundText({ text: '' })).toBeNull();
    expect(outboundText({})).toBeNull();
    expect(outboundText(undefined)).toBeNull();
  });

  it('refuses an approval card loudly instead of dropping it', () => {
    const card = {
      type: 'ask_question',
      questionId: 'appr-1',
      title: 'Approve?',
      question: 'Restart the agent?',
      options: [{ label: 'Approve', value: 'approve' }],
    };
    expect(() => outboundText(card)).toThrow(/cannot deliver interactive questions/);
  });
});
