/**
 * Test for persisting an approval card's delivery target onto its row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { closeDb, initTestDb, runMigrations } from './index.js';
import { createPendingApproval, getPendingApproval, updatePendingApprovalDelivery } from './sessions.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('updatePendingApprovalDelivery', () => {
  it('records channel_type / platform_id / platform_message_id on the row', () => {
    createPendingApproval({
      approval_id: 'appr-1',
      request_id: 'appr-1',
      action: 'cli_command',
      payload: '{}',
      created_at: now(),
      title: 'CLI: members-add',
      options_json: '[]',
    });
    // Created without a target — columns start NULL.
    expect(getPendingApproval('appr-1')).toMatchObject({
      channel_type: null,
      platform_id: null,
      platform_message_id: null,
    });

    updatePendingApprovalDelivery('appr-1', 'whatsapp', '6594599775@s.whatsapp.net', 'wamid-1');

    expect(getPendingApproval('appr-1')).toMatchObject({
      channel_type: 'whatsapp',
      platform_id: '6594599775@s.whatsapp.net',
      platform_message_id: 'wamid-1',
    });
  });

  it('accepts a null platform_message_id (adapter returned no id)', () => {
    createPendingApproval({
      approval_id: 'appr-2',
      request_id: 'appr-2',
      action: 'cli_command',
      payload: '{}',
      created_at: now(),
      title: 'CLI: groups-restart',
      options_json: '[]',
    });

    updatePendingApprovalDelivery('appr-2', 'telegram', '12345', null);

    expect(getPendingApproval('appr-2')).toMatchObject({
      channel_type: 'telegram',
      platform_id: '12345',
      platform_message_id: null,
    });
  });
});
