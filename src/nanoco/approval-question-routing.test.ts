import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

test('routes only Gateway approval ids through the approval presentation renderer', () => {
  const source = readFileSync(new URL('../channels/chat-sdk-bridge.ts', import.meta.url), 'utf8');

  expect(source).toContain('const message = routeQuestionMessage(');
  expect(source).toContain('questionId,\n          () => ({\n              card: Card({');
  expect(source).toContain('() => approvalQuestionMessage({ title, question, questionId, options })');
  expect(source).toContain('fallbackText: `${title}\\n\\n${question}\\nOptions:');
  expect(source.match(/approvalQuestionMessage\(\{ title, question, questionId, options \}\)/g)).toHaveLength(1);
});
