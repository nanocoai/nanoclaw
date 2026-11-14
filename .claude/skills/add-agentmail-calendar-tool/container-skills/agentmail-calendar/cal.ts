/**
 * cal: the calendar of this agent's AgentMail inbox (Bun, no dependencies).
 *
 * Config: /workspace/agent/email/config.json (written by /add-agentmail-tool):
 * "inbox", "api", "owner", "known", "lookalike" are read; nothing else.
 * State:  /workspace/agent/calendar/ledger.jsonl (every write) and seen.json (the `due` gate).
 * Auth:   the credential gateway injects the AgentMail key; this sends a placeholder.
 *
 * Anything that emails someone (--send-invites, respond) passes guard() first:
 * recipients outside the owner's addresses and `known` need --approved-by-owner.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

export class CalError extends Error {
  status?: number;
  body?: any;
}
/** A refusal by the send guard. Nothing was sent. */
export class GuardError extends CalError {}

export interface Config {
  inbox: string;
  api: string;
  owner_name?: string;
  owner: Record<string, string>;
  known?: Record<string, string>;
  lookalike?: string[];
}

type Ev = Record<string, any>;
type Args = Record<string, any>;

// ---------------------------------------------------------------- paths/io

export function paths() {
  const home = process.env.CAL_HOME || process.env.MAIL_HOME || '/workspace/agent';
  const dir = path.join(home, 'calendar');
  return {
    config: path.join(home, 'email', 'config.json'),
    dir,
    ledger: path.join(dir, 'ledger.jsonl'),
    seen: path.join(dir, 'seen.json'),
  };
}

export function loadConfig(): Config {
  const p = paths().config;
  let cfg: Config;
  try {
    cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    throw new CalError(`cannot read ${p}: ${(e as Error).message}. Ask the operator to run /add-agentmail-tool, then /add-agentmail-calendar-tool.`);
  }
  if (!cfg.inbox || !cfg.api || !cfg.owner) throw new CalError(`${p} needs "inbox", "api" and "owner"`);
  return cfg;
}

async function realApi(
  cfg: Config,
  method: string,
  p: string,
  opts: { body?: unknown; query?: Record<string, unknown>; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ status: number; json: any }> {
  let url = `${cfg.api.replace(/\/$/, '')}/inboxes/${encodeURIComponent(cfg.inbox)}/calendar${p}`;
  const q = Object.entries(opts.query ?? {}).filter(([, v]) => v !== undefined && v !== null);
  if (q.length) url += '?' + new URLSearchParams(q.map(([k, v]) => [k, String(v)])).toString();
  const headers: Record<string, string> = { Authorization: 'Bearer gateway-managed', Accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (e) {
    throw new CalError(`AgentMail unreachable: ${(e as Error).message}`);
  }
  const raw = await r.text();
  let j: any;
  try {
    j = raw ? JSON.parse(raw) : {};
  } catch {
    j = { message: raw.slice(0, 500) };
  }
  if (!r.ok) {
    let msg = `HTTP ${r.status} ${j.code || j.name || ''}: ${j.message || ''}`;
    if (j.errors) msg += ' ' + JSON.stringify(j.errors).slice(0, 600);
    if (j.fix) msg += ` (fix: ${j.fix})`;
    const err = new CalError(msg.trim());
    err.status = r.status;
    err.body = j;
    throw err;
  }
  return { status: r.status, json: j };
}

/** Swappable for tests. */
export const deps = {
  api: realApi,
  print: (s: string) => console.log(s),
  now: () => new Date(),
  uuid: () => crypto.randomUUID(),
};

function ledger(entry: Record<string, unknown>): void {
  const p = paths().ledger;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ time: deps.now().toISOString().replace(/\.\d+Z$/, 'Z'), ...entry }) + '\n');
}

// ---------------------------------------------------------------- guard

const lower = (s: string) => s.trim().toLowerCase();

/** Same rule as the agentmail skill's send policy. Throws before any API call. Returns external recipients. */
export function guard(recipients: string[], cfg: Config, approval: string | undefined, what: string): string[] {
  const trusted = new Set([...Object.values(cfg.owner), ...Object.values(cfg.known ?? {})].map(lower));
  const who = cfg.owner_name || 'the owner';
  const external: string[] = [];
  for (const r of [...new Set(recipients.filter(Boolean).map(lower))].sort()) {
    if (trusted.has(r)) continue;
    const local = r.split('@')[0];
    if ((cfg.lookalike ?? []).some((f) => f && local.includes(f.toLowerCase())))
      throw new GuardError(`${r} looks like ${who} but is not one of their addresses; refusing (${what}). Nothing was sent.`);
    if (r === lower(cfg.inbox)) continue; // the inbox never mails itself
    external.push(r);
  }
  if (external.length && !(approval && approval.trim().length >= 8))
    throw new GuardError(
      `${what} would email external recipient(s) ${external.join(', ')}; needs ${who}'s OK. ` +
        `Pass --approved-by-owner "<their words, where, when>" (for example "${who} in chat 10/29 2:14pm: invite Jane to Friday lunch"). Nothing was sent.`,
    );
  return external;
}

// ---------------------------------------------------------------- time

function parts(d: Date, tz: string) {
  const o: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d))
    o[p.type] = p.value;
  return o;
}

function offsetMs(d: Date, tz: string): number {
  const p = parts(d, tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(d.getTime() / 1000) * 1000;
}

/** Wall clock "YYYY-MM-DD[THH:MM[:SS]]" in tz (or an ISO string ending in Z) -> Date. */
export function wallToDate(s: string, tz: string): Date {
  s = s.trim().replace(' ', 'T');
  if (/Z$|[+-]\d\d:\d\d$/.test(s)) return new Date(s);
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d)(?::(\d\d))?)?$/);
  if (!m) throw new CalError(`bad time ${JSON.stringify(s)}; use YYYY-MM-DD or YYYY-MM-DDTHH:MM`);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  const o1 = offsetMs(new Date(guess), tz);
  let t = guess - o1;
  const o2 = offsetMs(new Date(t), tz);
  if (o2 !== o1) t = guess - o2;
  return new Date(t);
}

export function normLocal(s: string, allDay: boolean): string {
  s = s.trim().replace(' ', 'T');
  if (allDay) {
    if (!/^\d{4}-\d\d-\d\d/.test(s)) throw new CalError(`bad date ${JSON.stringify(s)}; use YYYY-MM-DD with --all-day`);
    return s.slice(0, 10);
  }
  const m = s.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d)(:\d\d)?$/);
  if (!m) throw new CalError(`bad time ${JSON.stringify(s)}; use YYYY-MM-DDTHH:MM (wall clock in --tz), or YYYY-MM-DD with --all-day`);
  return m[1] + (m[2] ?? ':00');
}

const z = (d: Date) => d.toISOString().replace(/\.\d+Z$/, 'Z');
const ymd = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const dayLabel = (iso: string, long = false) =>
  new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: long ? 'long' : 'short', month: 'short', day: 'numeric' }).replace(',', '');

function clock(d: Date, tz: string, withDay: boolean): string {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    ...(withDay ? { weekday: 'short', month: 'short', day: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit',
  });
  return f.format(d).replace(/,/g, '').replace(/\s?([AP])M$/, (_, x) => x.toLowerCase() + 'm');
}

export function fmtWhen(ev: Ev, tz: string): string {
  if (ev.all_day) {
    const s = ev.start as string;
    const e = ev.end as string;
    return s === e || !e ? `${dayLabel(s)} (all day)` : `${dayLabel(s)} to ${dayLabel(e)} (all day)`;
  }
  const st = new Date(ev.start_at);
  const en = new Date(ev.end_at);
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(st).find((p) => p.type === 'timeZoneName')?.value ?? tz;
  return `${clock(st, tz, true)}-${clock(en, tz, ymd(st, tz) !== ymd(en, tz))} ${zone}`;
}

export function line(ev: Ev, tz: string): string {
  const bits = [fmtWhen(ev, tz), ev.title ?? ''];
  if (ev.location) bits.push(`@ ${ev.location}`);
  const tags: string[] = [];
  if (ev.status && ev.status !== 'confirmed') tags.push(ev.status);
  if (ev.response_status) tags.push(`my reply: ${ev.response_status}`);
  if (ev.source === 'email') tags.push(`invite from ${ev.organizer_email ?? '?'}`);
  if (ev.attendee_count) tags.push(`${ev.attendee_count} attendee(s)`);
  if (ev.recurrence || ev.kind === 'instance') tags.push('recurring');
  return bits.join('  ') + (tags.length ? `  [${tags.join(', ')}]` : '') + `\n    id ${ev.event_id}`;
}

// ---------------------------------------------------------------- api helpers

/** The calendar's own timezone (GET /calendar); UTC if unavailable. */
async function calendarTz(cfg: Config, timeoutMs = 10_000): Promise<string> {
  try {
    const { json } = await deps.api(cfg, 'GET', '', { timeoutMs });
    if (json.timezone) {
      new Intl.DateTimeFormat('en-US', { timeZone: json.timezone });
      return json.timezone;
    }
  } catch {}
  return 'UTC';
}

async function agenda(cfg: Config, after: string, before: string, overlapping = true, timeoutMs = 20_000): Promise<Ev[]> {
  const out: Ev[] = [];
  let tok: string | undefined;
  for (;;) {
    const { json } = await deps.api(cfg, 'GET', '/agenda', {
      query: { after, before, limit: 100, page_token: tok, include_overlapping: String(overlapping), consistency: 'primary' },
      timeoutMs,
    });
    out.push(...(json.events ?? []));
    tok = json.next_page_token;
    if (!tok) return out;
  }
}

async function getEvent(cfg: Config, id: string): Promise<Ev> {
  return (await deps.api(cfg, 'GET', `/events/${encodeURIComponent(id)}`, { query: { consistency: 'primary' } })).json;
}

const ifMatch = (ev: Ev) => (ev.etag ? { 'If-Match': ev.etag } : undefined);

async function write(cfg: Config, entry: Record<string, unknown>, method: string, p: string, opts: Parameters<typeof realApi>[3]) {
  try {
    return await deps.api(cfg, method, p, opts);
  } catch (e) {
    ledger({ ...entry, result: 'error', error: (e as Error).message });
    if ((e as CalError).status === 412)
      throw new CalError(`${(e as Error).message}. The event changed since it was read; nothing was changed. Re-run to retry.`);
    throw e;
  }
}

// ---------------------------------------------------------------- commands

async function cmdAgenda(cfg: Config, a: Args) {
  const tz = a.tz || (await calendarTz(cfg));
  const days = Number(a.days ?? 7);
  const now = deps.now();
  const evs = await agenda(cfg, z(now), z(new Date(now.getTime() + days * 86_400_000)));
  if (a.json) return deps.print(JSON.stringify(evs, null, 1));
  if (!evs.length) return deps.print(`Nothing on the calendar in the next ${days} day(s).`);
  let day = '';
  for (const ev of evs) {
    const d = ev.all_day ? String(ev.start).slice(0, 10) : ymd(new Date(ev.start_at), tz);
    if (d !== day) {
      day = d;
      deps.print(`\n${dayLabel(d, true)}`);
    }
    deps.print('  ' + line(ev, tz).replace('\n', '\n  '));
  }
}

async function cmdList(cfg: Config, a: Args) {
  const tz = a.tz || (await calendarTz(cfg));
  let evs: Ev[];
  if (a.stored) {
    const max = Number(a.max ?? 200);
    evs = [];
    let tok: string | undefined;
    for (;;) {
      const { json } = await deps.api(cfg, 'GET', '/events', { query: { limit: 100, page_token: tok } });
      evs.push(...(json.events ?? []));
      tok = json.next_page_token;
      if (!tok || evs.length >= max) break;
    }
    evs = evs.slice(0, max);
  } else {
    const after = a.from ? wallToDate(a.from, tz) : deps.now();
    const before = a.to ? wallToDate(a.to, tz) : new Date(after.getTime() + 30 * 86_400_000);
    evs = await agenda(cfg, z(after), z(before));
  }
  if (a.json) return deps.print(JSON.stringify(evs, null, 1));
  deps.print(evs.length ? evs.map((e) => line(e, tz)).join('\n') : 'No events.');
}

async function cmdGet(cfg: Config, a: Args) {
  const ev = await getEvent(cfg, need(a.target, 'event_id'));
  if (a.json) return deps.print(JSON.stringify(ev, null, 1));
  const tz = a.tz || (await calendarTz(cfg));
  deps.print(line(ev, tz));
  for (const k of ['kind', 'status', 'timezone', 'source', 'organizer_email', 'response_status']) if (ev[k]) deps.print(`  ${k}: ${ev[k]}`);
  if (ev.recurrence) deps.print(`  recurrence: ${ev.recurrence.rule}`);
  for (const at of ev.attendees ?? []) deps.print(`  attendee: ${at.email} (${at.status ?? 'needs_action'})`);
  if (ev.description) deps.print(`  description: ${ev.description}`);
}

function need(v: string | undefined, name: string): string {
  if (!v) throw new CalError(`missing <${name}>`);
  return v;
}

function buildFields(a: Args, creating: boolean, calTz: string | null): Ev {
  const body: Ev = {};
  if (a.title !== undefined) body.title = a.title;
  if (a.start !== undefined || a.end !== undefined) {
    if (a.start === undefined || a.end === undefined) throw new CalError('send --start and --end together');
    body.start = normLocal(a.start, !!a['all-day']);
    body.end = normLocal(a.end, !!a['all-day']);
  }
  if (a['all-day']) body.all_day = true;
  if (a.tz) body.timezone = a.tz;
  else if ((creating || a['all-day']) && calTz) body.timezone = calTz;
  if (a.location !== undefined) body.location = a.location || null;
  if (a.description !== undefined) body.description = a.description || null;
  if (a.rrule) body.recurrence = { rule: a.rrule };
  if (a.status) body.status = a.status;
  if (a.attendee?.length) body.attendees = (a.attendee as string[]).map((x) => ({ email: lower(x) }));
  return body;
}

async function cmdCreate(cfg: Config, a: Args) {
  for (const k of ['title', 'start', 'end']) if (a[k] === undefined) throw new CalError(`--${k} is required`);
  const body = buildFields(a, true, a.tz ? null : await calendarTz(cfg));
  const recips: string[] = (body.attendees ?? []).map((x: Ev) => x.email);
  const ext = a['send-invites'] ? guard(recips, cfg, a['approved-by-owner'], 'create --send-invites') : [];
  if (a['send-invites']) body.send_invites = true;
  body.client_id = a['client-id'] || `cal-${deps.uuid()}`;
  const entry = {
    cmd: 'create',
    title: body.title,
    start: body.start,
    send_invites: !!a['send-invites'],
    recipients: a['send-invites'] ? recips : [],
    external: ext,
    approval: a['approved-by-owner'] ?? '',
    client_id: body.client_id,
  };
  const { status, json } = await write(cfg, entry, 'POST', '/events', { body });
  const ev = json.event ?? json;
  ledger({ ...entry, result: status, event_id: ev.event_id, operation_id: json.operation_id });
  deps.print(a.json ? JSON.stringify(ev, null, 1) : 'created ' + line(ev, a.tz || (await calendarTz(cfg))));
}

async function cmdUpdate(cfg: Config, a: Args) {
  const id = need(a.target, 'event_id');
  const body = buildFields(a, false, a['all-day'] && !a.tz ? await calendarTz(cfg) : null);
  if (a['clear-attendees']) body.attendees = [];
  if (!Object.keys(body).length) throw new CalError('nothing to update');
  // Fail fast on explicit attendees, before any API call.
  if (a['send-invites'] && body.attendees?.length)
    guard(body.attendees.map((x: Ev) => x.email), cfg, a['approved-by-owner'], 'update --send-invites');
  const cur = await getEvent(cfg, id); // etag for If-Match, current attendees for the guard
  let recips: string[] = [];
  let ext: string[] = [];
  if (a['send-invites']) {
    const before = (cur.attendees ?? []).map((x: Ev) => x.email);
    const after = body.attendees ? body.attendees.map((x: Ev) => x.email) : before;
    recips = [...new Set([...before, ...after])].sort(); // removed attendees get a cancellation
    ext = guard(recips, cfg, a['approved-by-owner'], 'update --send-invites');
    body.send_invites = true;
  }
  const entry = {
    cmd: 'update',
    event_id: id,
    fields: Object.keys(body).filter((k) => k !== 'send_invites').sort(),
    send_invites: !!a['send-invites'],
    recipients: recips,
    external: ext,
    approval: a['approved-by-owner'] ?? '',
    if_match: cur.etag,
  };
  const { status, json } = await write(cfg, entry, 'PATCH', `/events/${encodeURIComponent(id)}`, {
    body,
    query: a.mode ? { mode: a.mode } : undefined,
    headers: ifMatch(cur),
  });
  const ev = json.event ?? json;
  ledger({ ...entry, result: status, etag: ev.etag });
  deps.print(a.json ? JSON.stringify(ev, null, 1) : 'updated ' + line(ev, a.tz || (await calendarTz(cfg))));
}

async function cmdDelete(cfg: Config, a: Args) {
  const id = need(a.target, 'event_id');
  const cur = await getEvent(cfg, id);
  let recips: string[] = [];
  let ext: string[] = [];
  if (a['send-invites']) {
    recips = (cur.attendees ?? []).map((x: Ev) => x.email);
    ext = guard(recips, cfg, a['approved-by-owner'], 'delete --send-invites');
  }
  const entry = {
    cmd: 'delete',
    event_id: id,
    title: cur.title,
    send_invites: !!a['send-invites'],
    recipients: recips,
    external: ext,
    approval: a['approved-by-owner'] ?? '',
  };
  const { status, json } = await write(cfg, entry, 'DELETE', `/events/${encodeURIComponent(id)}`, {
    query: { send_invites: a['send-invites'] ? 'true' : undefined, mode: a.mode },
    headers: ifMatch(cur),
  });
  ledger({ ...entry, result: status, deletion_id: json.deletion_id });
  deps.print(`deleted ${id} (${cur.title})` + (json.deletion_id ? ` deletion_id ${json.deletion_id}` : ''));
}

const RESPONSES = ['accepted', 'declined', 'tentative'];

async function cmdRespond(cfg: Config, a: Args, positionals: string[]) {
  const id = need(positionals[0], 'event_id');
  const answer = positionals[1];
  if (!RESPONSES.includes(answer)) throw new CalError(`respond needs one of: ${RESPONSES.join(', ')}`);
  const cur = await getEvent(cfg, id);
  const org = lower(cur.organizer_email ?? '');
  const send = !a['no-reply'];
  const ext = send ? guard([org], cfg, a['approved-by-owner'], `respond (reply to organizer ${org})`) : [];
  const body: Ev = { status: answer, send_reply: send };
  if (a.comment) body.comment = a.comment;
  const entry = {
    cmd: 'respond',
    event_id: id,
    title: cur.title,
    status: answer,
    send_reply: send,
    recipients: send ? [org] : [],
    external: ext,
    approval: a['approved-by-owner'] ?? '',
  };
  const { status } = await write(cfg, entry, 'POST', `/events/${encodeURIComponent(id)}/respond`, { body, headers: ifMatch(cur) });
  ledger({ ...entry, result: status });
  deps.print(`responded ${answer} to ${cur.title}` + (send ? ` (reply emailed to ${org})` : ' (no email)'));
}

/** Task gate. Last stdout line is always {"wakeAgent": bool, "data": {...}}; never throws. */
export async function due(cfg: Config, a: Args): Promise<{ wakeAgent: boolean; data: Record<string, unknown> }> {
  const t0 = Date.now();
  const p = paths();
  let state: any = {};
  try {
    state = JSON.parse(fs.readFileSync(p.seen, 'utf-8'));
  } catch {}
  const seenStart: Record<string, string> = state.starting ?? {};
  const seenInv: Record<string, string> = state.invites ?? {};
  const now = deps.now();
  const firstRun = !state.last_check;
  const lastCheck = firstRun ? now : new Date(state.last_check);
  const windowMin = Number(a['window-min'] ?? 10);
  const lookbackMin = Number(a['lookback-min'] ?? 2);
  const tz = await calendarTz(cfg, 5_000);

  // 1) events starting soon (small lookback in case a run was late)
  const evs = await agenda(cfg, z(new Date(now.getTime() - lookbackMin * 60_000)), z(new Date(now.getTime() + windowMin * 60_000)), false, 10_000);
  const starting: Ev[] = [];
  for (const ev of evs) {
    if (ev.status === 'cancelled' || ev.all_day) continue;
    const key = `${ev.event_id}@${ev.start_at}`;
    if (key in seenStart) continue;
    seenStart[key] = ev.start_at;
    starting.push({
      id: ev.event_id,
      title: ev.title,
      when: fmtWhen(ev, tz),
      in_min: Math.round((new Date(ev.start_at).getTime() - now.getTime()) / 60_000),
      location: ev.location ?? null,
      reply: ev.response_status ?? null,
    });
  }

  // 2) events created from emailed invitations since the last check
  const invites: Ev[] = [];
  if (Date.now() - t0 < 20_000) {
    const { json } = await deps.api(cfg, 'GET', '/events', { query: { limit: 50 }, timeoutMs: 8_000 });
    for (const ev of json.events ?? []) {
      if (ev.source !== 'email' || ev.event_id in seenInv) continue;
      seenInv[ev.event_id] = ev.created_at;
      // First run is a baseline: don't alert on invitations that were already there.
      if (firstRun || new Date(ev.created_at).getTime() < lastCheck.getTime() - 5 * 60_000) continue;
      invites.push({
        id: ev.event_id,
        title: ev.title,
        when: fmtWhen(ev, tz),
        organizer: ev.organizer_email,
        reply: ev.response_status ?? null,
        status: ev.status,
      });
    }
  }

  const cutoff = now.getTime() - 2 * 86_400_000;
  const pruned = Object.fromEntries(Object.entries(seenStart).filter(([, v]) => new Date(v).getTime() > cutoff));
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.seen + '.tmp', JSON.stringify({ last_check: z(now), starting: pruned, invites: seenInv }));
  fs.renameSync(p.seen + '.tmp', p.seen);

  for (const s of starting) deps.print(`STARTING in ${s.in_min} min: ${s.title} (${s.when}) id ${s.id}`);
  for (const i of invites) deps.print(`NEW INVITE from ${i.organizer}: ${i.title} (${i.when}) reply=${i.reply} id ${i.id}`);
  return { wakeAgent: !!(starting.length || invites.length), data: { starting: starting.slice(0, 10), new_invites: invites.slice(0, 10) } };
}

async function cmdCheck(cfg: Config) {
  const { json } = await deps.api(cfg, 'GET', '');
  deps.print(`ok: calendar of ${cfg.inbox} reachable through the gateway (timezone ${json.timezone ?? 'unset'}, ${json.event_count ?? '?'} event(s))`);
}

// ---------------------------------------------------------------- cli

const USAGE = `cal: the calendar of this agent's AgentMail inbox

  cal agenda [--days 7] [--json]
  cal list [--from 2026-11-01 --to 2026-11-08] [--json]     agenda window (default next 30 days)
  cal list --stored [--max 200] [--json]                    every stored event, incl. cancelled
  cal get <event_id> [--json]
  cal create --title T --start 2026-11-03T09:00 --end 2026-11-03T10:00
             [--tz Area/City] [--location L] [--description D] [--rrule "FREQ=WEEKLY;BYDAY=MO"]
             [--attendee a@b.com ...] [--send-invites [--approved-by-owner "..."]] [--client-id ID]
  cal create --title T --all-day --start 2026-11-02 --end 2026-11-04        (end inclusive)
  cal update <event_id> [same fields] [--status confirmed|tentative|cancelled] [--clear-attendees]
             [--mode single|future] [--send-invites [--approved-by-owner "..."]]
  cal delete <event_id> [--mode single|future] [--send-invites [--approved-by-owner "..."]]
  cal respond <event_id> accepted|declined|tentative [--comment C] [--no-reply] [--approved-by-owner "..."]
  cal due [--window-min 10] [--lookback-min 2]              scheduled-task gate; last line is JSON
  cal check                                                 verify the calendar is reachable

Times are wall clock in --tz, default the calendar's own timezone.
--send-invites and respond (without --no-reply) EMAIL people; anyone outside the owner's
addresses and "known" in email/config.json needs --approved-by-owner.`;

const S = { type: 'string' } as const;
const SM = { type: 'string', multiple: true } as const;
const B = { type: 'boolean' } as const;
const FIELDS = {
  title: S,
  start: S,
  end: S,
  tz: S,
  'all-day': B,
  location: S,
  description: S,
  rrule: S,
  attendee: SM,
  'send-invites': B,
  'approved-by-owner': S,
  json: B,
};
const OPTIONS: Record<string, Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>> = {
  agenda: { days: S, tz: S, json: B },
  list: { from: S, to: S, stored: B, max: S, tz: S, json: B },
  get: { tz: S, json: B },
  create: { ...FIELDS, 'client-id': S },
  update: { ...FIELDS, status: S, 'clear-attendees': B, mode: S },
  delete: { 'send-invites': B, 'approved-by-owner': S, mode: S },
  respond: { comment: S, 'no-reply': B, 'approved-by-owner': S },
  due: { 'window-min': S, 'lookback-min': S },
  check: {},
};

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    deps.print(USAGE);
    return cmd ? 0 : 2;
  }
  if (!(cmd in OPTIONS)) {
    console.error(`cal: unknown command ${JSON.stringify(cmd)}\n\n${USAGE}`);
    return 2;
  }
  if (cmd === 'due') {
    // A gate must always print valid JSON as its last line and exit 0.
    let result;
    try {
      const { values } = parseArgs({ args: rest, options: OPTIONS.due, strict: true });
      result = await due(loadConfig(), values);
    } catch (e) {
      result = { wakeAgent: false, data: { error: (e as Error).message.slice(0, 300) } };
    }
    deps.print(JSON.stringify(result));
    return 0;
  }
  try {
    const { values, positionals } = parseArgs({ args: rest, options: OPTIONS[cmd], allowPositionals: true, strict: true });
    const a: Args = { ...values, target: positionals[0] };
    if (a.status && !['confirmed', 'tentative', 'cancelled'].includes(a.status)) throw new CalError('--status must be confirmed, tentative or cancelled');
    if (a.mode && !['single', 'future'].includes(a.mode)) throw new CalError('--mode must be single or future');
    const cfg = loadConfig();
    switch (cmd) {
      case 'agenda':
        await cmdAgenda(cfg, a);
        break;
      case 'list':
        await cmdList(cfg, a);
        break;
      case 'get':
        await cmdGet(cfg, a);
        break;
      case 'create':
        await cmdCreate(cfg, a);
        break;
      case 'update':
        await cmdUpdate(cfg, a);
        break;
      case 'delete':
        await cmdDelete(cfg, a);
        break;
      case 'respond':
        await cmdRespond(cfg, a, positionals);
        break;
      case 'check':
        await cmdCheck(cfg);
        break;
    }
    return 0;
  } catch (e) {
    if (e instanceof CalError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      console.error(`cal ${cmd}: ${(e as Error).message}`);
      return 2;
    }
    throw e;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
