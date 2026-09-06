/**
 * Unit tests for the proton-mail adapter's pure helpers — the parts that decide
 * what reaches the agent (quote stripping, auto-reply filtering) and how replies
 * thread back (subjects, slash-command answers). No network.
 */
import { describe, it, expect } from 'vitest';

import {
  classifyAttachment,
  htmlToText,
  matchCommandReply,
  normalizeAddress,
  optionToCommand,
  renderAskQuestion,
  replySubject,
  shouldSkipInbound,
  stripQuotedReply,
} from './proton-mail.js';
import { normalizeOptions } from './ask-question.js';

describe('normalizeAddress', () => {
  it('lowercases and trims', () => {
    expect(normalizeAddress('  Someone@Example.COM ')).toBe('someone@example.com');
  });
});

describe('replySubject', () => {
  it('prefixes Re: once', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('Re: Hello')).toBe('Re: Hello');
    expect(replySubject('RE: Hello')).toBe('RE: Hello');
    expect(replySubject('AW: Hallo')).toBe('AW: Hallo');
  });
  it('handles a missing subject', () => {
    expect(replySubject(undefined)).toBe('Re: (no subject)');
    expect(replySubject('   ')).toBe('Re: (no subject)');
  });
});

describe('stripQuotedReply', () => {
  it('cuts at an "On … wrote:" marker', () => {
    const text = 'Yes, do it.\n\nOn Mon, 1 Sep 2026 at 10:00, Agent <a@x.com> wrote:\n> Shall I proceed?\n> Thanks';
    expect(stripQuotedReply(text)).toBe('Yes, do it.');
  });
  it('cuts at an Outlook "Original Message" marker', () => {
    const text = 'Approved\r\n\r\n-----Original Message-----\r\nFrom: Agent\r\nSubject: Plan';
    expect(stripQuotedReply(text)).toBe('Approved');
  });
  it('cuts at an Outlook web rule followed by a From: header block', () => {
    const text =
      'Hello testing your reply. \n\n\nS\n\n\n\n' +
      '-'.repeat(80) +
      '\n\nFrom: agentsmk@proton.me <agentsmk@proton.me>\nSent: Sunday, 06 September 2026 06:29\nTo: Kennedy\nSubject: Message\n\nHi Steven';
    expect(stripQuotedReply(text)).toBe('Hello testing your reply. \n\n\nS'.trimEnd());
  });
  it('cuts at a bare From:/Sent: header block', () => {
    expect(stripQuotedReply('Yes\n\nFrom: A <a@x.com>\nDate: Mon\nSubject: hi\n\nold')).toBe('Yes');
  });
  it('does not treat a From: mention in prose as a quote header', () => {
    const text = 'From: my point of view this is fine.\nLet me know.';
    expect(stripQuotedReply(text)).toBe(text);
  });
  it('drops a trailing quoted block without a marker', () => {
    expect(stripQuotedReply('Sounds good\n\n> earlier\n> lines\n')).toBe('Sounds good');
  });
  it('keeps a message that is only a quote', () => {
    expect(stripQuotedReply('> just forwarding this\n> as is')).toBe('> just forwarding this\n> as is');
  });
});

describe('htmlToText', () => {
  it('flattens tags and entities', () => {
    const html = '<html><style>p{}</style><body><p>Hi &amp; bye</p><div>Line<br>two</div></body></html>';
    expect(htmlToText(html)).toBe('Hi & bye\nLine\ntwo');
  });
});

describe('shouldSkipInbound', () => {
  it('keeps ordinary mail', () => {
    expect(shouldSkipInbound({ fromAddress: 'friend@example.com' })).toBeNull();
    expect(shouldSkipInbound({ fromAddress: 'friend@example.com', autoSubmitted: 'no' })).toBeNull();
  });
  it('drops our own echo', () => {
    expect(shouldSkipInbound({ fromAddress: 'me@proton.me', loopHeader: 'proton-mail' })).toBe('own echo');
  });
  it('drops bounces and auto-replies', () => {
    expect(shouldSkipInbound({ fromAddress: 'MAILER-DAEMON@mx.proton.me' })).toBe('system sender');
    expect(shouldSkipInbound({ fromAddress: 'noreply@shop.example' })).toBe('system sender');
    expect(shouldSkipInbound({ fromAddress: 'x@y.z', autoSubmitted: 'auto-replied' })).toMatch(/auto-submitted/);
    expect(shouldSkipInbound({ fromAddress: 'x@y.z', precedence: 'bulk' })).toBe('precedence: bulk');
  });
  it('drops mail with no sender', () => {
    expect(shouldSkipInbound({})).toBe('no sender');
  });
});

describe('classifyAttachment', () => {
  it('maps content types', () => {
    expect(classifyAttachment('image/png')).toBe('image');
    expect(classifyAttachment('video/mp4')).toBe('video');
    expect(classifyAttachment('audio/ogg')).toBe('audio');
    expect(classifyAttachment('application/pdf')).toBe('document');
    expect(classifyAttachment(undefined)).toBe('document');
  });
});

describe('ask_question over email', () => {
  const options = normalizeOptions(['Approve', 'Reject all']);

  it('renders slash commands per option', () => {
    expect(optionToCommand('Reject all')).toBe('/reject-all');
    const body = renderAskQuestion('Deploy?', 'Ship v2 now?', options);
    expect(body).toContain('Deploy?');
    expect(body).toContain('Ship v2 now?');
    expect(body).toContain('  /approve');
    expect(body).toContain('  /reject-all');
  });

  it('matches the first non-empty line as a command', () => {
    expect(matchCommandReply('\n  /Approve \n\nthanks', options)?.value).toBe('Approve');
    expect(matchCommandReply('/reject-all', options)?.value).toBe('Reject all');
  });

  it('ignores prose and unknown commands', () => {
    expect(matchCommandReply('approve', options)).toBeUndefined();
    expect(matchCommandReply('/maybe', options)).toBeUndefined();
    expect(matchCommandReply('', options)).toBeUndefined();
  });
});
