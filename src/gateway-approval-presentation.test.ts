import { expect, it } from 'vitest';
import { gatewayApprovalPresentation, MAX_CARD_TITLE_CHARS } from './gateway-approval-presentation.js';
import type { GatewayApprovalRequest } from './gateway-providers/gateway-provider-registry.js';

const request = (summary?: GatewayApprovalRequest['summary']) =>
  ({ title: 'Legacy', question: 'Legacy question', summary }) as GatewayApprovalRequest;
const summary = {
  agent: 'Nano',
  action: 'Read external data',
  resource: 'GET api.example.test/repos?token=secret',
  reason: 'Policy requires approval',
};

it('shows action, resource, reason and one-request approval scope without query values', () => {
  const card = gatewayApprovalPresentation(request(summary));
  expect(card.title).toBe('Approve external request');
  expect(card.question).toContain('*Action:* Read external data');
  expect(card.question).toContain('*Resource:* GET api.example.test/repos');
  expect(card.question).toContain('*Why approval:* Policy requires approval');
  expect(card.question).toContain('this request once');
  expect(card.question).not.toContain('secret');
  expect(card.question).toBe(
    [
      '*Agent:* Nano',
      '*Action:* Read external data',
      '*Resource:* GET api.example.test/repos',
      '*Why approval:* Policy requires approval',
      'Approve allows this request once. It does not connect an account or change its permissions.',
    ].join('\n'),
  );
});

it('escapes supplied formatting and mentions, and keeps every detail in full', () => {
  const values = Array.from({ length: 6 }, (_, i) => `${i}`.repeat(600));
  const card = gatewayApprovalPresentation(
    request({
      ...summary,
      agent: '<@everyone>\n*Admin*',
      details: values.map((value, i) => ({ label: `Detail ${i}`, value })),
    }),
  );
  expect(card.question).not.toContain('<@everyone>');
  expect(card.question).not.toContain('*Admin*');
  values.forEach((value, i) => expect(card.question).toContain(`*Detail ${i}:* ${value}\n`));
  expect(card.question.endsWith('\nApprove once to allow this action.')).toBe(true);
});

it('shows a long action in full in the body, under a short fixed title', () => {
  const action = 'Transfer funds '.repeat(40);
  const card = gatewayApprovalPresentation(
    request({ ...summary, action, details: [{ label: 'To', value: 'Savings' }] }),
  );
  expect(card.title).toBe('Approve this action');
  expect(card.question.split('\n')[0]).toBe(`*Action:* ${action}`);
});

it('uses the action as the title only while it fits, measured after escaping', () => {
  const titleFor = (action: string) =>
    gatewayApprovalPresentation(request({ ...summary, action, details: [{ label: 'To', value: 'Savings' }] })).title;
  expect(titleFor('a'.repeat(MAX_CARD_TITLE_CHARS))).toBe('a'.repeat(MAX_CARD_TITLE_CHARS));
  expect(titleFor('a'.repeat(MAX_CARD_TITLE_CHARS + 1))).toBe('Approve this action');
  expect(titleFor('_'.repeat(MAX_CARD_TITLE_CHARS / 2))).toBe('\\_'.repeat(MAX_CARD_TITLE_CHARS / 2));
  expect(titleFor('_'.repeat(MAX_CARD_TITLE_CHARS / 2 + 1))).toBe('Approve this action');
});

it('rejects malformed structured details instead of trusting them', () => {
  expect(() => gatewayApprovalPresentation(request({ ...summary, details: 'bad' as never }))).toThrow();
  expect(() => gatewayApprovalPresentation(request({ ...summary, action: '' }))).toThrow();
  for (const omittedDetails of [-1, 1.5, '2' as never])
    expect(() => gatewayApprovalPresentation(request({ ...summary, omittedDetails }))).toThrow();
});

it('says how many details were left out', () => {
  const card = gatewayApprovalPresentation(
    request({ ...summary, details: [{ label: 'To', value: 'Savings' }], omittedDetails: 3 }),
  );
  expect(card.question).toContain('*To:* Savings\n… 3 more fields not shown\nApprove once');
});

it('keeps legacy adapters compatible', () => {
  expect(gatewayApprovalPresentation(request())).toEqual({ title: 'Legacy', question: 'Legacy question' });
});

it('moves a long legacy title, escaped, to the top of the body', () => {
  const title = 'Delete *all* backups '.repeat(4);
  const card = gatewayApprovalPresentation({ title, question: 'Legacy question' } as GatewayApprovalRequest);
  expect(card.title).toBe('Approve external request');
  expect(card.question).toBe(`*Request:* ${title.replace(/\*/g, '\\*')}\nLegacy question`);
  const fits = 'x'.repeat(MAX_CARD_TITLE_CHARS);
  expect(gatewayApprovalPresentation({ title: fits, question: 'q' } as GatewayApprovalRequest).title).toBe(fits);
});

it('shows a concrete action, full issue number and submitted comment without generic padding', () => {
  const card = gatewayApprovalPresentation(
    request({
      agent: 'Nano',
      action: 'Post a comment',
      resource: 'example/repo · issue or PR #548',
      reason: 'This action changes external data.',
      details: [{ label: 'Comment', value: 'great job' }],
    }),
  );
  expect(card.title).toBe('Post a comment');
  expect(card.question.split('\n')[0]).toBe('*Action:* Post a comment');
  expect(card.question).toContain('*Where:* example/repo · issue or PR #548');
  expect(card.question).toContain('*Comment:* great job');
  expect(card.question).not.toContain('business action');
});

it('preserves all typed policy display fields and explicit list overflow', () => {
  const card = gatewayApprovalPresentation({
    ...request(),
    displayFields: [
      ...Array.from({ length: 23 }, (_, i) => ({
        label: `Field ${i}`,
        type: 'long_text' as const,
        value: 'x'.repeat(1000),
      })),
      { label: 'Items', type: 'list', value: Array.from({ length: 50 }, (_, i) => `item-${i}`), overflow: 7 },
    ],
  });
  expect(card.question).toContain('Field 22');
  expect(card.question).toContain('item-49');
  expect(card.question).toContain('7 additional items');
  expect(card.question.length).toBeGreaterThan(23000);
});

// Backslash escapes are decoded by channel Markdown renderers, preserving the value.
it('preserves account names and resource punctuation in summaries and typed fields', () => {
  const value = 'john_doe+test@x.com';
  const escaped = 'john\\_doe+test@x.com';
  const card = gatewayApprovalPresentation(request({ ...summary, details: [{ label: 'To', value }] }));
  expect(card.question).toContain(escaped);
  expect(card.question).not.toContain('john doe');
  const typed = gatewayApprovalPresentation({
    ...request(),
    displayFields: [
      { label: 'To', type: 'text', value },
      { label: 'Files', type: 'list', value: ['some_file(1).txt'] },
    ],
  });
  expect(typed.question).toContain(escaped);
  expect(typed.question).toContain('some\\_file\\(1\\).txt');
});
