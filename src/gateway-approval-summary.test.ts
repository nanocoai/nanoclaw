import { expect, it } from 'vitest';
import { gatewayApprovalPresentation } from './gateway-approval-presentation.js';
import { markedCut, normalizeGatewayApprovalSummary } from './gateway-approval-summary.js';
import type { GatewayApprovalRequest } from './gateway-providers/gateway-provider-registry.js';

const request = { agent: 'Nano', method: 'POST', host: 'api.example.test', path: '/issues/1/comments?token=x' };
const MARKER = / … \((\d+) more characters not shown\)$/;

it('keeps short values and every detail unchanged', () => {
  const summary = normalizeGatewayApprovalSummary(request, {
    action: 'Post a comment',
    details: [{ label: 'Comment', value: 'great job' }],
  });
  expect(summary).toStrictEqual({
    agent: 'Nano',
    action: 'Post a comment',
    resource: 'POST api.example.test/issues/1/comments',
    reason: 'The gateway policy requires human approval for this request.',
    details: [{ label: 'Comment', value: 'great job' }],
  });
});

it('marks a cut value instead of dropping its tail silently', () => {
  const comment = 'c'.repeat(614);
  const { details } = normalizeGatewayApprovalSummary(request, {
    action: 'Post a comment',
    details: [{ label: 'Comment', value: comment }],
  });
  const value = details![0].value;
  expect(value.length).toBeLessThanOrEqual(600);
  const kept = value.indexOf(' …');
  expect(value).toBe(`${comment.slice(0, kept)} … (${614 - kept} more characters not shown)`);
});

it('counts the details it leaves out', () => {
  const details = Array.from({ length: 8 }, (_, i) => ({ label: `F${i}`, value: `${i}` }));
  const summary = normalizeGatewayApprovalSummary(request, { action: 'Update', details });
  expect(summary.details).toEqual(details.slice(0, 6));
  expect(summary.omittedDetails).toBe(2);
});

it('marks every cut field and still passes card validation', () => {
  const long = 'x'.repeat(5000);
  const summary = normalizeGatewayApprovalSummary(
    { ...request, agent: long, path: `/${long}` },
    { action: long, details: [{ label: long, value: long }] },
  );
  const cut = [summary.agent, summary.action, summary.resource, summary.details![0].label, summary.details![0].value];
  for (const value of cut) expect(value).toMatch(MARKER);
  expect(summary.agent.length).toBeLessThanOrEqual(120);
  expect(summary.details![0].label.length).toBeLessThanOrEqual(80);
  expect(() =>
    gatewayApprovalPresentation({ title: 't', question: 'q', summary } as GatewayApprovalRequest),
  ).not.toThrow();
});

it('never splits a surrogate pair at the cut', () => {
  const cut = markedCut('a'.repeat(559) + '😀'.repeat(30), 600);
  expect(cut.length).toBeLessThanOrEqual(600);
  expect(cut).toMatch(/^a{559} … /);
});

it('shows the cut marker and the left-out count on the card', () => {
  const card = gatewayApprovalPresentation({
    title: 't',
    question: 'q',
    summary: normalizeGatewayApprovalSummary(request, {
      action: 'Post a comment',
      details: Array.from({ length: 7 }, (_, i) => ({ label: `F${i}`, value: i ? `${i}` : 'c'.repeat(614) })),
    }),
  } as GatewayApprovalRequest);
  expect(card.question).toMatch(/\*F0:\* c+ … \\\(\d+ more characters not shown\\\)\n/);
  expect(card.question).toContain('\n… 1 more field not shown\n');
});
