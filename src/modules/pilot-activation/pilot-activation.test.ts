/**
 * Tests for pilot activation: code lifecycle (create → consume → burn),
 * 24h expiry, one-active-agent-per-user, and the START handler's feedback
 * paths. The happy provisioning path (agent group + wiring + welcome) runs
 * against live infra and is verified in the live smoke test, not here.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import {
  createActivation,
  consumeActivation,
  findActivePilotByUser,
  generatePilotCode,
  getActivation,
  isExpired,
  looksLikePilotCode,
} from './db.js';
import { extractPilotCode, tryActivatePilot } from './activation.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('pilot codes', () => {
  it('generates 20-char codes that pass their own format check', () => {
    const code = generatePilotCode();
    expect(code).toHaveLength(20);
    expect(looksLikePilotCode(code)).toBe(true);
  });

  it('does not mistake 4-digit pairing codes for pilot codes', () => {
    expect(looksLikePilotCode('1234')).toBe(false);
  });

  it('creates a pending activation with a 24h expiry', () => {
    const a = createActivation({ lang: 'he', metadata: { email: 'x@y.z' } });
    expect(a.status).toBe('pending');
    const hours = (Date.parse(a.expires_at) - Date.parse(a.created_at)) / 3600_000;
    expect(hours).toBeCloseTo(24, 1);
  });

  it('consume burns the code and stamps a 10-day pilot window', () => {
    const a = createActivation({ lang: 'he' });
    const consumed = consumeActivation(a.code, { userId: 'telegram:111', agentGroupId: 'ag-1' });
    expect(consumed?.status).toBe('used');
    expect(consumed?.used_by_user_id).toBe('telegram:111');
    const days = (Date.parse(consumed!.pilot_ends_at!) - Date.parse(consumed!.pilot_started_at!)) / 86_400_000;
    expect(days).toBeCloseTo(10, 1);

    // Second consume of the same code loses.
    expect(consumeActivation(a.code, { userId: 'telegram:222', agentGroupId: 'ag-2' })).toBeNull();
  });

  it('refuses to consume an expired code', () => {
    const a = createActivation({ lang: 'en' });
    getDb()
      .prepare('UPDATE pilot_activations SET expires_at = ? WHERE code = ?')
      .run(new Date(Date.now() - 1000).toISOString(), a.code);
    expect(isExpired(getActivation(a.code)!)).toBe(true);
    expect(consumeActivation(a.code, { userId: 'telegram:111', agentGroupId: 'ag-1' })).toBeNull();
  });

  it('findActivePilotByUser sees only in-window pilots', () => {
    const a = createActivation({ lang: 'he' });
    consumeActivation(a.code, { userId: 'telegram:111', agentGroupId: 'ag-1' });
    expect(findActivePilotByUser('telegram:111')?.code).toBe(a.code);
    expect(findActivePilotByUser('telegram:999')).toBeUndefined();

    // Push the window into the past — no longer active.
    getDb()
      .prepare('UPDATE pilot_activations SET pilot_ends_at = ? WHERE code = ?')
      .run(new Date(Date.now() - 1000).toISOString(), a.code);
    expect(findActivePilotByUser('telegram:111')).toBeUndefined();
  });
});

describe('extractPilotCode', () => {
  it('extracts from /start deep-link payloads and bare pastes', () => {
    const code = generatePilotCode();
    expect(extractPilotCode(`/start ${code}`)).toBe(code);
    expect(extractPilotCode(code)).toBe(code);
    expect(extractPilotCode(`  /start ${code}  `)).toBe(code);
  });

  it('returns null for chatter, pairing codes, and malformed starts', () => {
    expect(extractPilotCode('hello there')).toBeNull();
    expect(extractPilotCode('/start')).toBeNull();
    expect(extractPilotCode('/start 1234')).toBeNull();
    expect(extractPilotCode('1234')).toBeNull();
  });
});

describe('tryActivatePilot — feedback paths', () => {
  function makeInput(text: string, overrides: Record<string, unknown> = {}) {
    const sent: string[] = [];
    return {
      sent,
      input: {
        text,
        platformId: 'telegram:111',
        authorUserId: '111',
        displayName: 'Test User',
        isGroup: false,
        sendText: async (t: string) => {
          sent.push(t);
        },
        ...overrides,
      },
    };
  }

  it('falls through (false) on non-code text', async () => {
    const { input } = makeInput('sup');
    expect(await tryActivatePilot(input)).toBe(false);
  });

  it('unknown code → friendly request-new-link message', async () => {
    const { input, sent } = makeInput(`/start ${generatePilotCode()}`);
    expect(await tryActivatePilot(input)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('לא מוכר');
  });

  it('expired code → friendly expiry message in the code language', async () => {
    const a = createActivation({ lang: 'en' });
    getDb()
      .prepare('UPDATE pilot_activations SET expires_at = ? WHERE code = ?')
      .run(new Date(Date.now() - 1000).toISOString(), a.code);
    const { input, sent } = makeInput(`/start ${a.code}`);
    expect(await tryActivatePilot(input)).toBe(true);
    expect(sent[0]).toContain('expired');
  });

  it('used code (by someone else) → already-used message', async () => {
    const a = createActivation({ lang: 'he' });
    consumeActivation(a.code, { userId: 'telegram:999', agentGroupId: 'ag-x' });
    const { input, sent } = makeInput(`/start ${a.code}`);
    expect(await tryActivatePilot(input)).toBe(true);
    expect(sent[0]).toContain('כבר נוצל');
  });

  it('user with an active pilot → routed to existing agent, new code NOT burned', async () => {
    const first = createActivation({ lang: 'he' });
    consumeActivation(first.code, { userId: 'telegram:111', agentGroupId: 'ag-1' });

    const second = createActivation({ lang: 'he' });
    const { input, sent } = makeInput(`/start ${second.code}`);
    expect(await tryActivatePilot(input)).toBe(true);
    expect(sent[0]).toContain('כבר פעילה');
    expect(getActivation(second.code)?.status).toBe('pending'); // untouched
  });

  it('group chats are ignored (handled, no provisioning, no reply)', async () => {
    const a = createActivation({ lang: 'he' });
    const { input, sent } = makeInput(`/start ${a.code}`, { isGroup: true });
    expect(await tryActivatePilot(input)).toBe(true);
    expect(sent).toHaveLength(0);
    expect(getActivation(a.code)?.status).toBe('pending');
  });
});
