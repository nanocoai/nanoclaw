/**
 * Offline tests for cal.ts. Run: bun test container/skills/agentmail-calendar/
 * No network: deps.api is replaced with a fake that records every call.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-test-'));
process.env.CAL_HOME = TMP;

const cal = await import('./cal.ts');

const INBOX = 'assistant@agentmail.to';
const CONFIG = {
  inbox: INBOX,
  api: 'https://api.agentmail.to/v0',
  owner_name: 'Alex',
  owner: { work: 'alex@acme.example', personal: 'alex.r@mail.example' },
  known: { researcher: 'researcher@agentmail.to' },
  lookalike: ['alex'],
};
const NOW = new Date('2026-11-03T16:55:00Z');

class FakeApi {
  calls: [string, string, any][] = [];
  events: any[] = [];
  agenda: any[] = [];
  byId: Record<string, any> = {};
  call = async (_cfg: unknown, method: string, p: string, opts: any = {}) => {
    this.calls.push([method, p, opts]);
    if (method === 'GET' && p === '') return { status: 200, json: { timezone: 'America/New_York', event_count: 1 } };
    if (method === 'GET' && p === '/agenda') return { status: 200, json: { events: this.agenda } };
    if (method === 'GET' && p === '/events') return { status: 200, json: { events: this.events } };
    if (method === 'GET' && p.startsWith('/events/')) return { status: 200, json: this.byId[decodeURIComponent(p.slice(8))] };
    if (method === 'POST' && p === '/events') return { status: 201, json: { event: { event_id: 'new1', ...opts.body, start_at: '2026-11-04T14:00:00Z', end_at: '2026-11-04T15:00:00Z' }, operation_id: 'op1' } };
    if (method === 'DELETE') return { status: 202, json: { deletion_id: 'd1' } };
    if (method === 'POST' && p.endsWith('/respond')) return { status: 200, json: {} };
    throw new Error(`unexpected ${method} ${p}`);
  };
  writes = () => this.calls.filter(([m]) => m !== 'GET');
}

let fake: FakeApi;
let out: string[];
const cfg = CONFIG as any;
const run = (...argv: string[]) => cal.main(argv);
const ledger = () =>
  fs
    .readFileSync(path.join(TMP, 'calendar', 'ledger.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

beforeEach(() => {
  fs.rmSync(path.join(TMP, 'calendar'), { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'email'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'email', 'config.json'), JSON.stringify(CONFIG));
  fake = new FakeApi();
  cal.deps.api = fake.call as any;
  cal.deps.now = () => NOW;
  out = [];
  cal.deps.print = (s: string) => void out.push(s);
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('send guard', () => {
  it('lets owner and known addresses through', () => {
    expect(cal.guard(['Alex@acme.example', 'researcher@agentmail.to'], cfg, undefined, 't')).toEqual([]);
  });
  it('refuses outsiders without an approval', () => {
    expect(() => cal.guard(['jane@other.example'], cfg, undefined, 't')).toThrow(/needs Alex's OK/);
  });
  it('accepts outsiders with an approval and returns them', () => {
    expect(cal.guard(['jane@other.example'], cfg, 'Alex in chat 11/3: invite Jane', 't')).toEqual(['jane@other.example']);
  });
  it('refuses owner lookalikes even with an approval', () => {
    expect(() => cal.guard(['alex@acme-mail.example'], cfg, 'Alex in chat 11/3: ok', 't')).toThrow(/looks like Alex/);
  });
});

describe('writes', () => {
  it('create without invites needs no approval, uses the calendar timezone, and is logged', async () => {
    expect(await run('create', '--title', 'Dentist', '--start', '2026-11-04T09:00', '--end', '2026-11-04T10:00', '--attendee', 'jane@other.example')).toBe(0);
    const [, , opts] = fake.writes()[0];
    expect(opts.body).toMatchObject({ title: 'Dentist', start: '2026-11-04T09:00:00', timezone: 'America/New_York' });
    expect(opts.body.send_invites).toBeUndefined();
    expect(ledger()[0]).toMatchObject({ cmd: 'create', result: 201, event_id: 'new1', send_invites: false });
  });

  it('create --send-invites to an outsider is refused before any API call', async () => {
    expect(await run('create', '--title', 'Lunch', '--start', '2026-11-04T12:00', '--end', '2026-11-04T13:00', '--attendee', 'jane@other.example', '--send-invites')).toBe(2);
    expect(fake.writes()).toEqual([]);
  });

  it('create --send-invites with an approval sends and records it', async () => {
    const ok = 'Alex in chat 11/3 9am: invite Jane to lunch';
    expect(await run('create', '--title', 'Lunch', '--start', '2026-11-04T12:00', '--end', '2026-11-04T13:00', '--attendee', 'jane@other.example', '--send-invites', '--approved-by-owner', ok)).toBe(0);
    expect(fake.writes()[0][2].body.send_invites).toBe(true);
    expect(ledger()[0]).toMatchObject({ external: ['jane@other.example'], approval: ok });
  });

  it('delete --send-invites guards the stored attendees and sends If-Match', async () => {
    fake.byId.e1 = { event_id: 'e1', title: 'Sync', etag: '"rv-3"', attendees: [{ email: 'jane@other.example' }] };
    expect(await run('delete', 'e1', '--send-invites')).toBe(2);
    expect(fake.writes()).toEqual([]);
    expect(await run('delete', 'e1')).toBe(0);
    expect(fake.writes()[0][2].headers).toEqual({ 'If-Match': '"rv-3"' });
  });

  it('respond emails the organizer only when allowed; --no-reply sends nothing', async () => {
    fake.byId.inv = { event_id: 'inv', title: 'Pitch', etag: '"rv-0"', organizer_email: 'sales@vendor.example', source: 'email' };
    expect(await run('respond', 'inv', 'accepted')).toBe(2);
    expect(fake.writes()).toEqual([]);
    expect(await run('respond', 'inv', 'declined', '--no-reply')).toBe(0);
    expect(fake.writes()[0][2].body).toEqual({ status: 'declined', send_reply: false });
  });
});

describe('due gate', () => {
  const lastLine = () => JSON.parse(out.at(-1)!);

  it('baselines old invites, alerts on starting events once, then on new invites', async () => {
    fake.agenda = [{ event_id: 's1', title: 'Standup', start_at: '2026-11-03T17:00:00Z', end_at: '2026-11-03T17:15:00Z' }];
    fake.events = [{ event_id: 'old', source: 'email', created_at: '2026-11-01T00:00:00Z', start_at: '2026-11-05T15:00:00Z', end_at: '2026-11-05T16:00:00Z' }];
    expect(await run('due')).toBe(0);
    expect(lastLine()).toMatchObject({ wakeAgent: true, data: { new_invites: [] } });
    expect(lastLine().data.starting[0]).toMatchObject({ id: 's1', in_min: 5 });

    out = [];
    fake.events.unshift({ event_id: 'fresh', source: 'email', organizer_email: 'sam@other.example', created_at: '2026-11-03T16:54:00Z', start_at: '2026-11-06T15:00:00Z', end_at: '2026-11-06T16:00:00Z' });
    await run('due');
    expect(lastLine().data.starting).toEqual([]);
    expect(lastLine().data.new_invites.map((i: any) => i.id)).toEqual(['fresh']);

    out = [];
    await run('due');
    expect(lastLine()).toEqual({ wakeAgent: false, data: { starting: [], new_invites: [] } });
  });

  it('prints JSON and exits 0 when the API fails or config is missing', async () => {
    cal.deps.api = (async () => {
      throw new cal.CalError('AgentMail unreachable: test');
    }) as any;
    expect(await run('due')).toBe(0);
    expect(lastLine()).toEqual({ wakeAgent: false, data: { error: 'AgentMail unreachable: test' } });
    fs.rmSync(path.join(TMP, 'email', 'config.json'));
    expect(await run('due')).toBe(0);
    expect(lastLine().data.error).toMatch(/cannot read/);
  });
});

describe('time', () => {
  it('converts wall clock across a DST change', () => {
    expect(cal.wallToDate('2026-11-01T00:30', 'America/New_York').toISOString()).toBe('2026-11-01T04:30:00.000Z');
    expect(cal.wallToDate('2026-11-02T09:00', 'America/New_York').toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });
  it('formats in the given zone', () => {
    expect(cal.fmtWhen({ start_at: '2026-11-04T14:00:00Z', end_at: '2026-11-04T15:30:00Z' }, 'America/New_York')).toBe('Wed Nov 4 9:00am-10:30am EST');
    expect(cal.fmtWhen({ all_day: true, start: '2026-11-02', end: '2026-11-04' }, 'UTC')).toBe('Mon Nov 2 to Wed Nov 4 (all day)');
  });
});
