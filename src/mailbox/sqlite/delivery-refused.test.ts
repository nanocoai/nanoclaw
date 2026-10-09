import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { getDeliveredIds, markDeliveryRefused } from './session-db.js';

describe('markDeliveryRefused', () => {
  it('records status refused and a caller-supplied reason code', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE delivered (
        message_out_id TEXT PRIMARY KEY,
        platform_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'delivered',
        delivered_at TEXT NOT NULL
      )
    `);
    markDeliveryRefused(db, 'out-1', 'caller-reason');
    const row = db.prepare(`SELECT status, reason_code FROM delivered WHERE message_out_id = 'out-1'`).get() as {
      status: string;
      reason_code: string;
    };
    expect(row).toEqual({ status: 'refused', reason_code: 'caller-reason' });
    expect(getDeliveredIds(db).has('out-1')).toBe(true);
    db.close();
  });
});
