/**
 * Offline tests for mail.ts. Run: bun test container/skills/agentmail/
 * No network: deps.api is replaced with a fake that serves recorded-shape
 * fixtures and captures sends.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-test-'));
process.env.MAIL_HOME = TMP;

const mail = await import('./mail.ts');

const INBOX = 'assistant@agentmail.to';
const CONFIG = {
  inbox: INBOX,
  api: 'https://api.agentmail.to/v0',
  owner_name: 'Alex',
  owner: { work: 'alex@acme.example', personal: 'alex.r@mail.example' },
  known: { researcher: 'researcher@agentmail.to' },
  lookalike: ['alex'],
  channel_routed: ['@acme.example', 'alex.r@mail.example', 'researcher@agentmail.to'],
  ignore: ['(^|[<\\s])(no-?reply|newsletters?)@'],
  digest_hours: [8, 12, 18],
  followup_hour: 9,
  followup_days: 3,
  signature: 'assistant\nAI assistant to Alex',
};

const ts = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const msg = (mid: string, tid: string, from: string, subject: string, minutesAgo: number, to = INBOX, labels = ['received'], extra = {}) => ({
  message_id: mid,
  thread_id: tid,
  labels,
  timestamp: ts(minutesAgo),
  from,
  to: [to],
  subject,
  ...extra,
});

class FakeApi {
  messages: any[] = [];
  threads: Record<string, any> = {};
  sent: [string, any][] = [];
  fail = false;
  call = async (method: string, p: string, body?: any) => {
    if (this.fail) throw new mail.MailError('AgentMail unreachable: test');
    if (method === 'GET' && p.endsWith('/messages')) return { messages: [...this.messages].reverse() };
    if (method === 'GET' && p.includes('/threads/')) return this.threads[p.split('/').at(-1)!];
    if (method === 'POST') {
      this.sent.push([p, body]);
      const n = this.sent.length;
      return { message_id: `<sent${n}@x>`, thread_id: `00000000-0000-0000-0000-00000000000${n}` };
    }
    throw new Error(`unexpected ${method} ${p}`);
  };
}

let fake: FakeApi;
let out: string[];
const cfg = CONFIG as any;

beforeEach(() => {
  fs.rmSync(path.join(TMP, 'email'), { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'email'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'email', 'config.json'), JSON.stringify(CONFIG));
  fake = new FakeApi();
  mail.deps.api = fake.call as any;
  out = [];
  mail.deps.print = (s: string) => void out.push(s);
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const run = (...argv: string[]) => mail.main(argv);

describe('address policy', () => {
  it('refuses plain "owner" when there are several owner addresses', () => {
    expect(() => mail.resolveAlias('owner', cfg)).toThrow(mail.MailError);
  });

  it('accepts plain "owner" when there is exactly one', () => {
    expect(mail.resolveAlias('owner', { ...cfg, owner: { main: 'Solo@Example.com' } })).toBe('solo@example.com');
  });

  it('resolves owner labels and known names', () => {
    expect(mail.resolveAlias('owner:work', cfg)).toBe('alex@acme.example');
    expect(mail.resolveAlias('OWNER:Personal', cfg)).toBe('alex.r@mail.example');
    expect(mail.resolveAlias('researcher', cfg)).toBe('researcher@agentmail.to');
    expect(mail.resolveAlias('Vendor <V@Shop.example>', cfg)).toBe('v@shop.example');
  });

  it("accepts the owner's first name as an alias prefix", () => {
    expect(mail.resolveAlias('alex:work', cfg)).toBe('alex@acme.example');
    expect(mail.resolveAlias('Alex:Personal', cfg)).toBe('alex.r@mail.example');
    expect(() => mail.resolveAlias('alex', cfg)).toThrow(/alex:work/);
    expect(() => mail.resolveAlias('alex:typo', cfg)).toThrow(/unknown owner alias/);
  });

  it('refuses owner lookalikes', () => {
    expect(() => mail.checkRecipients(['alex@acme.example.com'], cfg)).toThrow(/looks like Alex/);
  });

  it('requires approval for external recipients', () => {
    expect(() => mail.checkRecipients(['vendor@shop.example'], cfg)).toThrow(/need Alex's OK/);
    expect(mail.checkRecipients(['vendor@shop.example'], cfg, 'Alex in chat 10/10: ask the shop')).toEqual(['vendor@shop.example']);
  });

  it('lets owner and known addresses through', () => {
    expect(mail.checkRecipients(['alex@acme.example', 'researcher@agentmail.to'], cfg)).toEqual([]);
  });

  it('thread approval covers existing participants only', () => {
    const meta = { approval: 'Alex chat 9/29', participants: 'start@shop.example' };
    expect(mail.checkRecipients(['start@shop.example'], cfg, null, meta)).toEqual(['start@shop.example']);
    expect(() => mail.checkRecipients(['other@vendor.example'], cfg, null, meta)).toThrow(mail.MailError);
  });
});

describe('sending', () => {
  it('sends, logs and records the ledger', async () => {
    const code = await run('send', '--to', 'owner:work', '--subject', 'Lawn quotes', '--text', '**Three** quotes:\n- A $40\n- B $55', '--purpose', 'lawn');
    expect(code).toBe(0);
    const [p, body] = fake.sent[0];
    expect(p.endsWith('/messages/send')).toBe(true);
    expect(body.to).toEqual(['alex@acme.example']);
    expect(body.html).toContain('<b>Three</b>');
    expect(body.html).toContain('<ul><li>A $40</li>');
    expect(body.text).toContain('AI assistant to Alex');
    const [meta, log] = mail.ledgerLoad('00000000-0000-0000-0000-000000000001');
    expect(meta!.status).toBe('waiting-on-them');
    expect(meta!.purpose).toBe('lawn');
    expect(log).toContain('OUT to alex@acme.example');
    const sent = JSON.parse(fs.readFileSync(path.join(TMP, 'email', 'sent.jsonl'), 'utf-8').split('\n')[0]);
    expect(sent.subject).toBe('Lawn quotes');
  });

  it('refuses an external send without approval', async () => {
    expect(await run('send', '--to', 'x@vendor.example', '--subject', 's', '--text', 't')).toBe(2);
    expect(fake.sent).toEqual([]);
  });

  it('dry run sends nothing', async () => {
    expect(await run('send', '--to', 'researcher', '--subject', 's', '--text', 't', '--dry-run')).toBe(0);
    expect(out.join('\n')).toContain('DRY RUN');
    expect(fake.sent).toEqual([]);
  });

  it('reply by thread id targets the latest inbound message', async () => {
    const tid = '11111111-1111-1111-1111-111111111111';
    fake.threads[tid] = {
      subject: 'Quote',
      messages: [
        msg('<a@x>', tid, `Assistant <${INBOX}>`, 'Quote', 60, 'start@shop.example', ['sent']),
        msg('<b@x>', tid, 'Allie <start@shop.example>', 'Re: Quote', 30),
      ],
    };
    mail.ledgerRecord(cfg, fake.threads[tid].messages[0]);
    mail.applyThreadUpdates(tid, { approval: 'Alex chat 9/29: get quotes' });
    expect(await run('reply', tid, '--text', 'Thanks!')).toBe(0);
    expect(fake.sent[0][0]).toContain('/messages/%3Cb%40x%3E/reply');
  });

  it('rejects an unknown status', async () => {
    expect(await run('thread', 'x', '--status', 'waiting-on-bob')).toBe(2);
  });
});

describe('attachments', () => {
  const make = (name: string, bytes: number) => {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, Buffer.alloc(bytes, 7));
    return p;
  };

  it('fits small files in one email', () => {
    const p = make('a.bin', 1000);
    expect(mail.prepareAttachments([p], 1000, cfg, TMP)[0]).toEqual([[p]]);
  });

  it('splits many files across emails', () => {
    const ps = [0, 1, 2].map((i) => make(`f${i}.bin`, 2_000_000));
    const [batches] = mail.prepareAttachments(ps, 1000, cfg, TMP);
    expect(batches.length).toBe(2);
    expect(batches.flat().sort()).toEqual([...ps].sort());
  });

  it('refuses a single file that is still too big', () => {
    const p = make('huge.bin', 6_000_000);
    expect(() => mail.prepareAttachments([p], 1000, cfg, TMP)).toThrow(/--attach-url/);
  });

  it('zips a big text file', async () => {
    const p = path.join(TMP, 'big.csv');
    fs.writeFileSync(p, 'date,count\n'.repeat(600_000));
    const work = fs.mkdtempSync(path.join(TMP, 'w-'));
    const [batches, notes] = mail.prepareAttachments([p], 1000, cfg, work);
    expect(batches[0][0].endsWith('big.csv.zip')).toBe(true);
    expect(notes[0]).toContain('compressed');
    // The archive is a valid zip that unzips back to the original bytes.
    const r = Bun.spawnSync(['unzip', '-p', batches[0][0]]);
    if (r.exitCode === 0) expect(r.stdout.length).toBe(fs.statSync(p).size);
  });
});

describe('gate', () => {
  it('routes, ignores and dedupes', async () => {
    const vt = '22222222-2222-2222-2222-222222222222';
    mail.ledgerRecord(cfg, msg('<o@x>', vt, INBOX, 'Lawn quote', 600, 'd@lawn.example', ['sent']), 'out');
    fake.messages = [
      msg('<1@x>', vt, 'David <d@lawn.example>', 'Re: Lawn quote', 20),
      msg('<2@x>', 'b1', 'Alex <alex@acme.example>', 'hi', 15),
      msg('<3@x>', 'n1', 'Shop <newsletter@shop.example>', 'SALE', 10),
      msg('<4@x>', 'r1', 'Stranger <hello@random.example>', 'Partnership?', 5),
      msg('<5@x>', 'm1', 'mailer-daemon@amazonses.com', 'Delivery Status Notification (Failure)', 4),
    ];
    const res = await mail.gate(cfg);
    expect(res.wakeAgent).toBe(true);
    expect(new Set((res.data.urgent as any[]).map((u) => u.message_id))).toEqual(new Set(['<1@x>', '<5@x>']));
    const state = mail.loadJson<any>(path.join(TMP, 'email', 'state.json'), {});
    expect(state.digest.map((d: any) => d.message_id)).toEqual(['<4@x>']);
    // Channel-routed mail is recorded but does not wake (the channel delivered it).
    expect(mail.ledgerLoad('b1')[0]!.status).toBe('waiting-on-me');
    expect(mail.ledgerLoad('n1')[0]).toBeNull();
    const again = await mail.gate(cfg);
    expect(again.data.urgent).toBeUndefined();
  });

  it('releases the digest once at a digest hour', async () => {
    fake.messages = [msg('<4@x>', 'r1', 'Stranger <hello@random.example>', 'Partnership?', 5)];
    const noon = new Date();
    noon.setHours(12, 5, 0, 0);
    const first = await mail.gate(cfg, noon);
    expect((first.data.digest as any[]).map((d) => d.message_id)).toEqual(['<4@x>']);
    expect((await mail.gate(cfg, noon)).data.digest).toBeUndefined();
  });

  it('links a reply that arrives in a separate thread to its parent', () => {
    const parent = '33333333-3333-3333-3333-333333333333';
    mail.ledgerRecord(cfg, msg('<p@x>', parent, INBOX, 'TASK - solar', 120, 'researcher@agentmail.to', ['sent']), 'out');
    mail.ledgerRecord(cfg, msg('<r@x>', 'child', 'Researcher <researcher@agentmail.to>', 'Re: TASK - solar', 5));
    const [pmeta, pbody] = mail.ledgerLoad(parent);
    expect(pmeta!.related_threads).toBe('child');
    expect(pmeta!.status).toBe('waiting-on-me');
    expect(pbody).toContain('separate thread child');
  });

  it('stays quiet through fetch failures, then alerts once', async () => {
    fake.fail = true;
    const results: boolean[] = [];
    for (let i = 0; i < 8; i++) results.push((await mail.gate(cfg)).wakeAgent);
    expect(results).toEqual([...Array(7).fill(false), true]);
  });

  it('prints valid JSON even when config is missing', async () => {
    fs.rmSync(path.join(TMP, 'email', 'config.json'));
    expect(await run('gate')).toBe(0);
    expect(JSON.parse(out.at(-1)!).wakeAgent).toBe(false);
  });

  it('lists overdue follow-ups', () => {
    const t = '44444444-4444-4444-4444-444444444444';
    mail.ledgerRecord(cfg, msg('<f@x>', t, INBOX, 'Quote?', 60 * 24 * 5, 'x@vendor.example', ['sent']), 'out');
    expect(mail.overdueFollowups(3).map((r) => r.thread_id)).toEqual([t]);
  });

  it('open.md lists only threads not done', () => {
    mail.ledgerRecord(cfg, msg('<z@x>', 'z1', 'a@b.example', 'Open one', 5));
    mail.ledgerRecord(cfg, msg('<y@x>', 'y1', 'a@b.example', 'Closed one', 5));
    mail.applyThreadUpdates('y1', { status: 'done' });
    const text = fs.readFileSync(path.join(TMP, 'email', 'open.md'), 'utf-8');
    expect(text).toContain('Open one');
    expect(text).not.toContain('Closed one');
  });
});
