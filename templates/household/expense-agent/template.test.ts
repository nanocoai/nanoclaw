import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve('templates/household/expense-agent');
const tools = [
  'submit_receipt_media',
  'submit_text_expense',
  'get_pending_intakes',
  'clarify_intake',
  'update_receipt',
  'trash_receipt',
  'restore_receipt',
  'list_recent_receipts',
  'get_spending_summary',
];

describe('household expense-agent template', () => {
  it('declares the exact secret-free MCP process', () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    expect(config).toEqual({
      mcpServers: {
        ndexpense: {
          command: 'bun',
          args: ['/app/src/ndexpense-mcp/server.ts'],
          env: { NDEXPENSE_API_BASE_URL: 'https://ndexpense-api-staging.smartecom.workers.dev' },
        },
      },
    });
    const serialized = JSON.stringify(config);
    for (const forbidden of ['sk' + '-or-', 'nde' + '_live_', 'nd' + 'staging_', 'nde' + 'production_']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('locks approved tool behavior, ordering, languages, and prohibitions', () => {
    const instructions = fs.readFileSync(path.join(root, 'context/instructions.md'), 'utf8');
    for (const tool of tools) expect(instructions).toContain(`\`${tool}\``);
    for (const phrase of [
      '1/N',
      'one clarification at a time',
      'English',
      'Traditional Chinese',
      'unrelated text',
      'never claim',
      'permanently delete',
      'arbitrary shell',
      'browse the web',
      'create agents',
      'vendor',
      'date',
      'total',
      'currency',
      'category',
      'receipt ID',
    ])
      expect(instructions.toLowerCase()).toContain(phrase.toLowerCase());
  });
});
