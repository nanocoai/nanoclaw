import { describe, expect, test } from 'bun:test';

import { createToolDefinitions } from './server.js';

describe('ND Expense MCP server', () => {
  test('registers exactly the nine approved tools', () => {
    const definitions = createToolDefinitions({ call: async () => ({}) });
    expect(definitions.map((tool) => tool.name)).toEqual([
      'submit_receipt_media',
      'submit_text_expense',
      'get_pending_intakes',
      'clarify_intake',
      'update_receipt',
      'trash_receipt',
      'restore_receipt',
      'list_recent_receipts',
      'get_spending_summary',
    ]);
  });

  test('returns backend output unchanged as concise structured JSON', async () => {
    const outcome = { intakeId: 'i1', status: 'saved', receiptId: 'r1' };
    const definitions = createToolDefinitions({ call: async () => outcome });
    const tool = definitions.find((candidate) => candidate.name === 'submit_text_expense')!;

    const result = await tool.handler({ sourceKey: 'm1', text: 'expense: tea 20' });

    expect(result.structuredContent).toEqual(outcome);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(outcome) }]);
  });

  test('redacts tool errors returned to the model', async () => {
    const definitions = createToolDefinitions({
      call: async () => {
        throw new Error('Bearer nde_live_secret body={"text":"private"}');
      },
    });
    const tool = definitions.find((candidate) => candidate.name === 'get_pending_intakes')!;

    const result = await tool.handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain('nde_live_secret');
    expect(result.content[0]?.text).not.toContain('private');
  });
});
