/**
 * Mailbox delivery loop (D15): idle-inject with the chat runner's ack
 * discipline, busy turns untouched, accumulate contract preserved, and the
 * crash-recovery + fail-open paths. Real session DBs via the test fixture;
 * the PTY is a fake capturing writes.
 *
 * The fixture PINS the transport to SQLite. This suite is about the state
 * machine — which transport a recipe composed is mailbox-verbs.test.ts's
 * subject, not this one's — and it seeds and asserts through raw session-DB
 * tables, so it can only mean SQLite. Left unpinned it read whatever the
 * composition registered: green under a recipe that composes the SQLite
 * mailbox, and 34 tests red under one that composes S3, whose constructor
 * wants env this suite has no business supplying.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { loadConfig } from '../config.js';
import { registerAgentMailbox, resetAgentMailboxForTesting } from '../mailbox/index.js';
import { SqliteAgentMailbox } from '../mailbox/sqlite/index.js';
import { initTestSessionDb, closeSessionDb } from '../mailbox/sqlite/connection.js';
import type { AgentMailboxFactory } from '../mailbox/types.js';
import type { MessageInRow } from '../db/index.js';
import { formatLocalTime, TIMEZONE } from '../timezone.js';
import { READY_FALLBACK_MS, readMailNotice } from './agent-state.js';
import {
  ACK_WINDOW_MS,
  BUSY_STALE_MS,
  COMPOSE_HOLD_MS,
  HOLD_RELEASE_MS,
  MailboxDeliveryLoop,
  MAX_INJECT_ATTEMPTS,
  NUDGE_WINDOW_MS,
  renderMailbox,
  type MailboxSession,
} from './mailbox.js';

loadConfig(); // defaults — getPendingMessages reads maxMessagesPerPrompt

class FakeSession implements MailboxSession {
  written: string[] = [];
  running = true;
  lastSpawnAt = 0;
  write(data: string) {
    this.written.push(data);
  }
  get text() {
    return this.written.join('');
  }
}

let inbound: ReturnType<typeof initTestSessionDb>['inbound'];
let outbound: ReturnType<typeof initTestSessionDb>['outbound'];
let session: FakeSession;
let statePath: string;
let noticePath: string;
let now: number;
let composed: AgentMailboxFactory | undefined;

/** State stamps must ride the FAKE clock — production compares hook wall-clock stamps to Date.now(). */
function stampState(state: 'idle' | 'busy', atMs: number = now): void {
  fs.writeFileSync(statePath, JSON.stringify({ state, at: new Date(atMs).toISOString() }));
}

function loop(overrides: Partial<ConstructorParameters<typeof MailboxDeliveryLoop>[0]> = {}) {
  return new MailboxDeliveryLoop({
    session,
    stateFilePath: statePath,
    mailNoticePath: noticePath,
    now: () => now,
    onFatal: () => {},
    ...overrides,
  });
}

function seedInbound(
  id: string,
  opts: {
    text?: string;
    sender?: string;
    kind?: string;
    trigger?: number;
    onWake?: number;
    seq?: number;
    content?: string;
  } = {},
): void {
  inbound
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, on_wake, content)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(
      id,
      opts.seq ?? null,
      opts.kind ?? 'chat',
      new Date().toISOString(),
      opts.trigger ?? 1,
      opts.onWake ?? 0,
      opts.content ?? JSON.stringify({ text: opts.text ?? `text of ${id}`, sender: opts.sender ?? 'gavriel' }),
    );
}

function ackRows(): Array<{ message_id: string; status: string }> {
  return outbound.prepare('SELECT message_id, status FROM processing_ack').all() as Array<{
    message_id: string;
    status: string;
  }>;
}

beforeEach(() => {
  const dbs = initTestSessionDb();
  inbound = dbs.inbound;
  outbound = dbs.outbound;
  session = new FakeSession();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-mailbox-'));
  statePath = path.join(stateDir, 'state.json');
  noticePath = path.join(stateDir, 'mail-notice.json');
  now = 1_000_000_000;
  // Capture per test, not once at import: another suite may hold the slot
  // when this file loads, and a swap must always put back what it took.
  composed = resetAgentMailboxForTesting();
  registerAgentMailbox(() => new SqliteAgentMailbox());
});

afterEach(() => {
  closeSessionDb();
  resetAgentMailboxForTesting();
  if (composed) registerAgentMailbox(composed);
});

describe('idle injection', () => {
  it('types pending mail into the PTY as a bracketed paste and acks completed on the busy transition', async () => {
    stampState('idle');
    seedInbound('m1', { text: 'ship the driver', sender: 'gavriel' });
    const l = loop();
    await l.tick();
    expect(session.text).toContain('\x1b[200~');
    expect(session.text).toContain('ship the driver');
    expect(session.text).toContain('gavriel');
    expect(session.text).toEndWith('\x1b[201~\r');
    // The write alone earns only the claim — completion needs the TUI's
    // hook evidence that the CR actually submitted (ISSUES #1).
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'processing' }]);

    stampState('busy', now + 50); // UserPromptSubmit fired post-injection
    await l.tick();
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'completed' }]);

    // Next tick: nothing left, nothing typed again.
    session.written = [];
    stampState('idle', now + 100);
    await l.tick();
    expect(session.text).toBe('');
  });

  it('never injects while the hook state says busy, delivers after Stop flips it', async () => {
    stampState('busy');
    seedInbound('m1');
    const l = loop();
    await l.tick();
    expect(session.text).toBe('');
    expect(ackRows()).toEqual([]);

    stampState('idle');
    await l.tick();
    expect(session.text).toContain('text of m1');
    stampState('busy', now + 50);
    await l.tick();
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'completed' }]);
  });

  it('skips injection while the PTY is down (respawning) and recovers after', async () => {
    stampState('idle');
    seedInbound('m1');
    session.running = false;
    const l = loop();
    await l.tick();
    expect(ackRows()).toEqual([]);
    session.running = true;
    await l.tick();
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'processing' }]);
    stampState('busy', now + 50);
    await l.tick();
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'completed' }]);
  });
});

describe('contracts honored', () => {
  it('leaves a trigger=0-only batch pending (accumulate) and delivers it alongside a trigger=1 row', async () => {
    stampState('idle');
    seedInbound('ctx', { trigger: 0, text: 'context only' });
    const l = loop();
    await l.tick();
    expect(session.text).toBe('');
    expect(ackRows()).toEqual([]);

    seedInbound('wake', { trigger: 1, text: 'now engage' });
    await l.tick();
    expect(session.text).toContain('context only');
    expect(session.text).toContain('now engage');
    stampState('busy', now + 50);
    await l.tick();
    expect(
      ackRows()
        .map((r) => r.message_id)
        .sort(),
    ).toEqual(['ctx', 'wake']);
    expect(ackRows().every((r) => r.status === 'completed')).toBe(true);
  });

  it('never types kind=system rows (transport envelopes)', async () => {
    stampState('idle');
    seedInbound('sys', { kind: 'system', text: 'cli_response payload' });
    const l = loop();
    await l.tick();
    expect(session.text).toBe('');
    expect(ackRows()).toEqual([]);
  });

  it('delivers on_wake rows on the first poll only', async () => {
    stampState('idle');
    seedInbound('wake-note', { onWake: 1, text: 'you were restarted' });
    const l = loop();
    await l.tick();
    expect(session.text).toContain('you were restarted');
    stampState('busy', now + 50); // submit evidence — completes the delivery
    await l.tick();
    expect(ackRows()).toEqual([{ message_id: 'wake-note', status: 'completed' }]);

    // A second loop instance (fresh "container") with a new on_wake row NOT
    // on its first poll: seed after the first tick. Fresh idle stamp so the
    // busy gate is not what hides the row — on_wake retirement must be.
    stampState('idle', now + 100);
    const l2 = loop();
    await l2.tick(); // first poll, nothing pending
    seedInbound('wake-late', { onWake: 1, text: 'stale restart note' });
    await l2.tick();
    expect(session.text).not.toContain('stale restart note');
  });

  it("start() clears a crashed predecessor's processing claims", async () => {
    outbound
      .prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('ghost', 'processing', ?)")
      .run(new Date().toISOString());
    const l = loop();
    l.start();
    l.stop();
    expect(ackRows()).toEqual([]);
  });
});

describe('readiness', () => {
  it('waits for the first hook signal, then fails open after the fallback window', async () => {
    seedInbound('m1');
    const l = loop();
    await l.tick(); // no state file, within window — hold
    expect(session.text).toBe('');

    now += READY_FALLBACK_MS + 1;
    await l.tick(); // hooks presumed broken — fail open
    expect(session.text).toContain('text of m1');
  });

  it("a dead life's stale idle stamp never gates a respawned claude — the hold re-arms per life", async () => {
    // Life 1 ended idle; its stamp survives (the review's confirmed
    // mail-loss repro). Life 2 spawns later than the stamp.
    stampState('idle');
    seedInbound('m1', { text: 'urgent: prod is down' });
    now += 5_000;
    session.lastSpawnAt = now; // respawn NOW — stamp predates it
    const l = loop();
    await l.tick();
    expect(session.text).toBe(''); // held: booting TUI, not typed at
    expect(ackRows()).toEqual([]); // and crucially NOT acked

    // This life's SessionStart fires → stamp is fresh → delivery.
    now += 1_000;
    stampState('idle');
    await l.tick();
    expect(session.text).toContain('urgent: prod is down');
    stampState('busy', now + 50); // the submit's own hook evidence
    await l.tick();
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'completed' }]);
  });

  it('the fail-open window measures from the current life, not container boot', async () => {
    seedInbound('m1');
    now += READY_FALLBACK_MS * 2; // container is old...
    session.lastSpawnAt = now - 1_000; // ...but this claude is 1s old
    const l = loop();
    await l.tick();
    expect(session.text).toBe(''); // young life: still held
    now += READY_FALLBACK_MS;
    await l.tick(); // hooks presumed broken for THIS life — fail open
    expect(session.text).toContain('text of m1');
  });
});

describe('stale-busy ceiling', () => {
  it('busy blocks delivery until the 30-minute staleness ceiling, then treats as idle', async () => {
    stampState('busy');
    seedInbound('m1');
    const l = loop();
    now += BUSY_STALE_MS - 60_000;
    await l.tick();
    expect(session.text).toBe(''); // fresh-enough busy: honored

    now += 61_000; // past the ceiling — wedged turn (Esc fires no Stop hook)
    await l.tick();
    expect(session.text).toContain('text of m1');
  });
});

describe('operator compose hold', () => {
  it('holds injection while an attached human typed recently', async () => {
    stampState('idle');
    seedInbound('m1');
    let typedAt = now - 1_000;
    const l = loop({ lastOperatorInputAt: () => typedAt });
    await l.tick();
    expect(session.text).toBe(''); // human mid-composition — never submit over them

    now += COMPOSE_HOLD_MS;
    await l.tick();
    expect(session.text).toContain('text of m1');
  });
});

describe('first-poll retention', () => {
  it('a skipped trigger=0-only batch does not burn the on_wake window', async () => {
    stampState('idle');
    const l = loop();
    seedInbound('ctx', { trigger: 0 });
    await l.tick(); // trigger=0-only: skipped, firstPoll must survive the skip
    expect(session.text).toBe('');

    seedInbound('wake-note', { onWake: 1, trigger: 1, text: 'late restart note' });
    await l.tick(); // still first-poll semantics: the on_wake row is visible and delivered
    expect(session.text).toContain('late restart note');
    expect(session.text).toContain('text of ctx'); // rider delivered too
  });
});

describe('trigger starvation rescue', () => {
  it('an older trigger=1 row crowded out by 10 newer trigger=0 rows still delivers', async () => {
    stampState('idle');
    seedInbound('mention', { trigger: 1, seq: 2, text: 'old mention' });
    for (let i = 0; i < 10; i++) seedInbound(`ctx-${i}`, { trigger: 0, seq: 4 + i * 2 });
    await loop().tick();
    expect(session.text).toContain('old mention'); // rescued into the batch
  });
});

describe('escape-sequence hardening', () => {
  it('a message carrying the bracketed-paste-end sequence cannot break out of the paste', async () => {
    stampState('idle');
    seedInbound('evil', { text: 'innocent\x1b[201~\rmalicious-keystrokes\x1b[200~more' });
    await loop().tick();
    const injected = session.text;
    // Exactly one paste wrapper — ours — survives; embedded ESC is gone.
    expect(injected.split('\x1b[201~')).toHaveLength(2);
    expect(injected.split('\x1b[200~')).toHaveLength(2);
    expect(injected).toContain('malicious-keystrokes'); // as inert text
    expect(injected.indexOf('\x1b[201~')).toBeGreaterThan(injected.indexOf('malicious-keystrokes'));
    // The only CR is our final submit keystroke, outside the paste.
    expect(injected.match(/\r/g)).toHaveLength(1);
    expect(injected.endsWith('\x1b[201~\r')).toBe(true);
  });
});

describe('renderMailbox', () => {
  function row(overrides: Partial<MessageInRow> & { content: string }): MessageInRow {
    return {
      id: 'big',
      seq: 2,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      status: 'pending',
      process_after: null,
      recurrence: null,
      tries: 0,
      trigger: 1,
      platform_id: null,
      channel_type: null,
      thread_id: null,
      ...overrides,
    };
  }

  it('truncates long texts into previews pointing at ncl inbox read --id', async () => {
    const long = 'x'.repeat(900);
    const rendered = renderMailbox([row({ content: JSON.stringify({ text: long, sender: 'g' }) })], 700);
    expect(rendered).toContain('truncated — full text: ncl inbox read --id big');
    expect(rendered).not.toContain('x'.repeat(701));
  });

  it('renders a prompt-only task row task-shaped, timed by process_after', async () => {
    const processAfter = '2026-08-16T09:30:00.000Z';
    const rendered = renderMailbox(
      [
        row({
          id: 't1',
          kind: 'task',
          process_after: processAfter,
          content: JSON.stringify({ prompt: 'check the deploy', script: 'echo hi', originSessionId: 'sess-1' }),
        }),
      ],
      700,
    );
    expect(rendered).toContain(`[nanoclaw task · ${formatLocalTime(processAfter, TIMEZONE)}]`);
    expect(rendered).toContain('Instructions: check the deploy');
    // Task-shaped, never the raw JSON blob under an 'unknown' mail header.
    expect(rendered).not.toContain('unknown');
    expect(rendered).not.toContain('originSessionId');
    expect(rendered).not.toContain('Script output:');
  });

  it("surfaces a task's stored scriptOutput before the instructions", async () => {
    const rendered = renderMailbox(
      [
        row({
          id: 't2',
          kind: 'task',
          content: JSON.stringify({ prompt: 'report on it', scriptOutput: { ok: true, count: 3 } }),
        }),
      ],
      700,
    );
    expect(rendered).toContain(`Script output: ${JSON.stringify({ ok: true, count: 3 })}`);
    expect(rendered.indexOf('Script output:')).toBeLessThan(rendered.indexOf('Instructions: report on it'));
  });

  it('strips the legacy persisted task contract from prompts', async () => {
    const rendered = renderMailbox(
      [
        row({
          id: 't3',
          kind: 'task',
          content: JSON.stringify({ prompt: 'water the plants\n\n[Task delivery contract: legacy generated suffix]' }),
        }),
      ],
      700,
    );
    expect(rendered).toContain('Instructions: water the plants');
    expect(rendered).not.toContain('Task delivery contract');
  });

  it('truncates long task bodies into previews like mail', async () => {
    const rendered = renderMailbox(
      [row({ id: 't4', kind: 'task', content: JSON.stringify({ prompt: 'y'.repeat(900) }) })],
      700,
    );
    expect(rendered).toContain('truncated — full text: ncl inbox read --id t4');
    expect(rendered).not.toContain('y'.repeat(701));
  });
});

describe('task delivery', () => {
  it('injects a kind=task row task-shaped, not as raw JSON', async () => {
    stampState('idle');
    seedInbound('t1', {
      kind: 'task',
      content: JSON.stringify({ prompt: 'run the nightly checks', script: '', originSessionId: 'sess-9' }),
    });
    const l = loop();
    await l.tick();
    expect(session.text).toContain('[nanoclaw task · ');
    expect(session.text).toContain('Instructions: run the nightly checks');
    expect(session.text).not.toContain('originSessionId');
    stampState('busy', now + 50);
    await l.tick();
    expect(ackRows()).toEqual([{ message_id: 't1', status: 'completed' }]);
  });
});

describe('lastInjectionAt', () => {
  it('is 0 before any delivery and stamps the injection time after (D14 liveness input)', async () => {
    stampState('idle');
    const l = loop();
    expect(l.lastInjectionAt).toBe(0);
    await l.tick(); // empty tick — no injection, no stamp
    expect(l.lastInjectionAt).toBe(0);

    seedInbound('m1');
    now += 5_000;
    await l.tick();
    expect(l.lastInjectionAt).toBe(now);
  });
});

// ---------------------------------------------------------------------------
// The inject-ack state machine (ISSUES #1, T6 2026-08-18): completed is
// earned by the TUI's own hook evidence, never assumed on the write.

describe('inject-ack state machine', () => {
  /** The bracketed-paste injections among the raw PTY writes. */
  function pastes(): string[] {
    return session.written.filter((w) => w.startsWith('\x1b[200~'));
  }
  /** The bare-CR re-nudges among the raw PTY writes. */
  function nudges(): string[] {
    return session.written.filter((w) => w === '\r');
  }

  it("acks on a busy stamp strictly newer than the injection — the gating stamp's tie never acks", async () => {
    stampState('idle'); // at == the injection's own millisecond (fake clock)
    seedInbound('m1');
    const l = loop();
    await l.tick(); // inject
    await l.tick(); // same stamp, same millisecond — the tie must NOT auto-ack
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'processing' }]);

    stampState('busy', now + 1); // strictly newer — the submit's evidence
    await l.tick();
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'completed' }]);
  });

  it('accepts a same-life idle stamp newer than the injection (whole turn inside the poll gap) — no duplicate', async () => {
    stampState('idle');
    seedInbound('m1');
    const l = loop();
    await l.tick(); // inject
    stampState('idle', now + 500); // Stop hook: the turn ran and finished between polls
    await l.tick();
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'completed' }]);
    expect(pastes()).toHaveLength(1); // treated as a miss it would have re-delivered
  });

  it('re-nudges with exactly one bare CR when no transition lands inside the ack window', async () => {
    stampState('idle');
    seedInbound('m1');
    const l = loop();
    await l.tick(); // inject
    now += ACK_WINDOW_MS;
    await l.tick();
    expect(nudges()).toHaveLength(1);
    expect(session.written).toHaveLength(2); // the paste, then the bare CR — nothing else
    await l.tick(); // inside the nudge window: no second nudge, no re-claim
    expect(nudges()).toHaveLength(1);
  });

  it('releases the claim after the nudge window, re-injects next tick, and the on_wake row survives', async () => {
    stampState('idle');
    seedInbound('wk', { onWake: 1, trigger: 1, text: 'restart mail' });
    const l = loop();
    await l.tick(); // inject (first poll — the only poll that can see on_wake)
    expect(ackRows()).toEqual([{ message_id: 'wk', status: 'processing' }]);

    now += ACK_WINDOW_MS;
    await l.tick(); // nudge
    now += NUDGE_WINDOW_MS;
    await l.tick(); // still nothing — claim released for retry
    expect(ackRows()).toEqual([]);

    await l.tick(); // next tick re-claims: firstPoll stayed armed, on_wake row still visible
    expect(pastes()).toHaveLength(2);
    expect(session.text.split('restart mail')).toHaveLength(3);

    stampState('busy', now + 50);
    await l.tick();
    expect(ackRows()).toEqual([{ message_id: 'wk', status: 'completed' }]);
  });

  it('fail-open delivery (broken hooks) keeps ack-on-write — no wait, no nudge, no retry loop', async () => {
    seedInbound('m1');
    const l = loop();
    now += READY_FALLBACK_MS + 1;
    await l.tick(); // no state file ever — fail open
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'completed' }]);
    now += ACK_WINDOW_MS + NUDGE_WINDOW_MS;
    await l.tick();
    await l.tick();
    expect(session.written).toHaveLength(1); // the paste — never a nudge
  });

  it('stale-busy-ceiling delivery keeps ack-on-write — its hooks stopped reporting', async () => {
    stampState('busy');
    seedInbound('m1');
    const l = loop();
    now += BUSY_STALE_MS + 1;
    await l.tick();
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'completed' }]);
    expect(session.written).toHaveLength(1);
  });

  it('a respawn mid-wait releases the claim — the injection died with the old life, never ack', async () => {
    stampState('idle');
    seedInbound('m1');
    const l = loop();
    await l.tick(); // inject into life 1
    session.lastSpawnAt = now + 5_000; // life 1 died; life 2 spawns
    now += 5_000;
    await l.tick();
    expect(ackRows()).toEqual([]); // released, not acked — life 2 never saw the paste

    // Life 2's own SessionStart→idle gates the retry as any fresh life.
    now += 1_000;
    stampState('idle');
    await l.tick();
    expect(pastes()).toHaveLength(2);
    stampState('busy', now + 50);
    await l.tick();
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'completed' }]);
  });

  it('holds the re-nudge while an operator is mid-composition, nudges once the hold clears', async () => {
    stampState('idle');
    seedInbound('m1');
    let typedAt = 0;
    const l = loop({ lastOperatorInputAt: () => typedAt });
    await l.tick(); // inject
    typedAt = now + 1_000; // operator starts typing during the ack wait
    now += ACK_WINDOW_MS + 1_500;
    await l.tick();
    expect(nudges()).toHaveLength(0); // a nudge now would submit their half-typed prompt

    now = typedAt + COMPOSE_HOLD_MS;
    await l.tick();
    expect(nudges()).toHaveLength(1); // hold cleared — the deferred nudge lands
  });

  it('a compose hold can never starve the claim past the host SLA — released un-nudged at the ceiling', async () => {
    stampState('idle');
    seedInbound('m1');
    let typedAt = 0;
    const l = loop({ lastOperatorInputAt: () => typedAt });
    await l.tick(); // inject
    const injectedAt = now;
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'processing' }]);

    // The operator types continuously with gaps under COMPOSE_HOLD_MS: the
    // nudge can never fire, and before HOLD_RELEASE_MS existed nothing else
    // could either — the 'processing' claim froze until the host's 60s
    // claim-stuck kill landed on the live attach.
    while (now - injectedAt < HOLD_RELEASE_MS) {
      typedAt = now;
      now += COMPOSE_HOLD_MS / 2;
      await l.tick();
    }
    expect(nudges()).toHaveLength(0); // never submitted over their composition
    expect(ackRows()).toEqual([]); // released at the ceiling — half the 60s SLA

    // Still typing: nothing is re-claimed over them (claim age stays 0)...
    typedAt = now;
    await l.tick();
    expect(ackRows()).toEqual([]);
    expect(pastes()).toHaveLength(1);

    // ...until they pause — the normal retry path re-claims, and the TUI's
    // own evidence completes it.
    now += COMPOSE_HOLD_MS;
    await l.tick();
    expect(pastes()).toHaveLength(2);
    stampState('busy', now + 50);
    await l.tick();
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'completed' }]);
  });

  it("the attempt cap is per MESSAGE ID — new mail riding a re-claim never resets a message's count", async () => {
    // Binding verdict #4's distinguishing scenario: a per-BATCH key would
    // reset the counter the moment m2 changes the batch's composition, and
    // m1 would be re-claimed forever.
    stampState('idle');
    seedInbound('m1');
    const l = loop();
    for (let attempt = 1; attempt < MAX_INJECT_ATTEMPTS; attempt++) {
      await l.tick(); // (re-)claim + inject m1 alone
      now += ACK_WINDOW_MS;
      await l.tick(); // nudge
      now += NUDGE_WINDOW_MS;
      await l.tick(); // attempt spent — claim released
    }
    expect(pastes()).toHaveLength(MAX_INJECT_ATTEMPTS - 1);
    expect(ackRows()).toEqual([]);

    seedInbound('m2', { text: 'rider mail' });
    await l.tick(); // m1's final attempt — with m2 riding along
    const last = pastes()[MAX_INJECT_ATTEMPTS - 1];
    expect(pastes()).toHaveLength(MAX_INJECT_ATTEMPTS);
    expect(last).toContain('text of m1');
    expect(last).toContain('rider mail');

    now += ACK_WINDOW_MS;
    await l.tick(); // nudge
    now += NUDGE_WINDOW_MS;
    await l.tick(); // m1 hit the per-id cap — the changed batch must NOT reset it
    expect(ackRows().sort((a, b) => a.message_id.localeCompare(b.message_id))).toEqual([
      { message_id: 'm1', status: 'processing' },
      { message_id: 'm2', status: 'processing' },
    ]);
    const writes = session.written.length;
    await l.tick();
    await l.tick();
    expect(session.written).toHaveLength(writes); // escalated: claiming stopped for good
  });

  it("stops re-claiming at the per-id attempt cap and leaves the claim to the host's claim-stuck SLA", async () => {
    stampState('idle');
    seedInbound('m1');
    const l = loop();
    for (let attempt = 1; attempt <= MAX_INJECT_ATTEMPTS; attempt++) {
      await l.tick(); // (re-)claim + inject
      expect(pastes()).toHaveLength(attempt);
      now += ACK_WINDOW_MS;
      await l.tick(); // nudge
      now += NUDGE_WINDOW_MS;
      await l.tick(); // attempt spent: release — or, at the cap, escalate
    }
    // Escalated: the LAST claim stays 'processing' unrefreshed so the host's
    // 60s claim-stuck kill recycles the container (tries/backoff/MAX_TRIES).
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'processing' }]);
    const writes = session.written.length;
    await l.tick();
    await l.tick();
    expect(session.written).toHaveLength(writes); // claiming stopped for good
  });
});

describe('channel transport (terminal-architecture phase 2)', () => {
  function spoolDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-mailbox-spool-'));
  }
  function spoolFiles(dir: string): string[] {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  }

  it('spools instead of typing; the ack discipline is unchanged', async () => {
    const dir = spoolDir();
    stampState('idle');
    seedInbound('m1', { text: 'ship the driver', sender: 'gavriel' });
    const l = loop({ channelSpoolDir: dir });
    await l.tick();

    // Nothing touches the terminal — the channel owns injection mechanics.
    expect(session.text).toBe('');
    const files = spoolFiles(dir);
    expect(files).toHaveLength(1);
    const entry = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    expect(entry.content).toContain('ship the driver');
    expect(entry.meta).toEqual({ ids: 'm1', batch: '1' });
    // The spool write earns only the claim; completion still needs hook evidence.
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'processing' }]);

    stampState('busy', now + 50);
    await l.tick();
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'completed' }]);
  });

  it('the nudge is a no-op write but the windows still run: no evidence releases and re-spools', async () => {
    const dir = spoolDir();
    stampState('idle');
    seedInbound('m1');
    const l = loop({ channelSpoolDir: dir });
    await l.tick();
    expect(spoolFiles(dir)).toHaveLength(1);

    // Ack window expires with no evidence → the "nudge" stamps without any
    // terminal write (there is no composer on this transport).
    now += ACK_WINDOW_MS + 1;
    await l.tick();
    expect(session.text).toBe('');
    expect(spoolFiles(dir)).toHaveLength(1); // nudge never re-spools

    // Nudge window expires too → the claim is released, exactly as on the
    // typing transport. (What the RETRY looks like is the availability
    // fallback's subject — silence on a channel means the events are going
    // nowhere, so the next attempt types instead of re-spooling.)
    now += NUDGE_WINDOW_MS + 1;
    await l.tick();
    expect(ackRows()).toEqual([]);
  });
});

describe('channel availability fallback (verified live: 2.1.238 answers "Channels are not currently available" while the server emits into the void)', () => {
  it('an unacked channel delivery downgrades the session to typing, purges the spool, and redelivers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-mailbox-spool-'));
    stampState('idle');
    seedInbound('m1', { text: 'still gets through' });
    const l = loop({ channelSpoolDir: dir });

    await l.tick(); // spooled, nothing typed
    expect(session.text).toBe('');
    expect(l.channelFellBack).toBe(false);

    // No hook evidence ever arrives — the client dropped the event silently.
    now += ACK_WINDOW_MS + 1;
    await l.tick(); // "nudge" (no-op on this transport)
    now += NUDGE_WINDOW_MS + 1;
    await l.tick(); // release + downgrade

    expect(l.channelFellBack).toBe(true);
    expect(ackRows()).toEqual([]);
    // The spool is purged: no entry left for a server that will never read it.
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.json'))).toEqual([]);

    // The redelivery is TYPED — mail reaches the agent despite channels being
    // unavailable, which is the whole point of the durable contract.
    await l.tick();
    expect(session.text).toContain('\x1b[200~');
    expect(session.text).toContain('still gets through');
    stampState('busy', now + 50);
    await l.tick();
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'completed' }]);
  });

  it('stays on channels when deliveries ack — one failure is what downgrades, not configuration', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-mailbox-spool-'));
    stampState('idle');
    seedInbound('m1');
    const l = loop({ channelSpoolDir: dir });
    await l.tick();
    stampState('busy', now + 50);
    await l.tick();
    expect(l.channelFellBack).toBe(false);

    seedInbound('m2');
    stampState('idle', now + 100);
    now += 200;
    await l.tick();
    expect(session.text).toBe(''); // still spooling, never typing
  });
});

describe('mail notice (the busy-path notify\'s input)', () => {
  it('publishes the waiting sequences on every tick — especially the busy ones the hook exists for', async () => {
    // Busy is exactly when deliver() returns before it would ever look at
    // the mailbox, and exactly when the PostToolUse hook needs an answer.
    stampState('busy');
    seedInbound('m1', { seq: 2 });
    seedInbound('m2', { seq: 4 });
    const l = loop();
    await l.tick();
    expect(session.text).toBe(''); // nothing injected — the turn is untouched
    expect(readMailNotice(noticePath)?.seqs).toEqual([2, 4]);
  });

  it('publishes only what the hook may announce: no system envelopes, no context-only rows, no claimed mail', async () => {
    stampState('busy');
    seedInbound('sys', { kind: 'system', seq: 2 });
    seedInbound('ctx', { trigger: 0, seq: 4 });
    seedInbound('mail', { seq: 6 });
    const l = loop();
    await l.tick();
    expect(readMailNotice(noticePath)?.seqs).toEqual([6]);

    // Once the loop claims it, it is no longer news — and the stamp is
    // published AFTER delivery, so the claiming tick already says so.
    stampState('idle');
    await l.tick();
    expect(session.text).toContain('text of mail');
    expect(readMailNotice(noticePath)?.seqs).toEqual([]);
  });

  it('delivers even when the notice write throws — the notify is a courtesy, delivery is the point', async () => {
    // The stamp is a /tmp write and /tmp can be full, read-only, or (here)
    // shadowed by a file where the dir must be: mkdirSync raises ENOTDIR.
    // Before, this ran first inside tick()'s try and took the whole tick
    // with it, so a broken notify silently stopped mail.
    const blocker = path.join(path.dirname(noticePath), 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const l = loop({ mailNoticePath: path.join(blocker, 'mail-notice.json') });

    stampState('idle');
    seedInbound('m1', { text: 'ship it anyway', seq: 2 });
    await l.tick();
    expect(session.text).toContain('ship it anyway');
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'processing' }]);

    // And the ack half of the contract still completes on the next tick.
    stampState('busy', now + 50);
    await l.tick();
    expect(ackRows()).toEqual([{ message_id: 'm1', status: 'completed' }]);
  });

  it('stamps the notice even when the tick itself fails', async () => {
    // The other half of the isolation: a delivery that throws must not cost
    // the hook its answer either.
    stampState('busy');
    seedInbound('m1', { seq: 2 });
    const exploding: MailboxSession = {
      write: () => {},
      lastSpawnAt: 0,
      get running(): boolean {
        throw new Error('session probe blew up');
      },
    };
    const l = loop({ session: exploding });
    await l.tick(); // swallowed by tick()'s catch
    expect(readMailNotice(noticePath)?.seqs).toEqual([2]);
  });
});
