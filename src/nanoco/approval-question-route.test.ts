import { expect, test, vi } from 'vitest';

import { routeQuestionMessage } from './approval-question-route.js';

test('leaves an ordinary NanoClaw Ask message unchanged', () => {
  const ordinary = {
    card: { title: 'Choose a region', children: ['Which region?'] },
    fallbackText: 'Choose a region\n\nWhich region?\nOptions: East, West',
  };
  const approvalRenderer = vi.fn(() => ({ card: {}, fallbackText: 'approval' }));

  expect(routeQuestionMessage('ordinary-question-id', () => ordinary, approvalRenderer)).toBe(ordinary);
  expect(approvalRenderer).not.toHaveBeenCalled();
});

test('uses the approval renderer only for a Gateway-owned approval id', () => {
  const approval = { card: { title: 'Gmail · Send email' }, fallbackText: 'approval' };
  const genericRenderer = vi.fn(() => ({ card: {}, fallbackText: 'generic' }));

  expect(
    routeQuestionMessage('nanoco-ask-0123456789abcdef0123456789abcdef', genericRenderer, () => approval),
  ).toBe(approval);
  expect(genericRenderer).not.toHaveBeenCalled();
});
