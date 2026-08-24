import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { processQuery } from '../poll-loop.js';

import recordings from './__fixtures__/sdk-midturn-recordings.json';

// Replays of REAL SDK message streams, captured live against
// @anthropic-ai/claude-agent-sdk 0.3.197 (scripts/sdk-capture/run-battery.ts,
// 2026-08-16, default model claude-opus-4-8). Message text is verbatim;
// non-text noise was trimmed by scripts/sdk-capture/extract-fixtures.ts.
//
// Two layers:
//  1. Provider invariant on real data — in every captured turn the SDK's
//     result text was EXACTLY the last streamed assistant text (the
//     containment premise the structural strip rests on).
//  2. End-to-end poll-loop outcomes for the captured shapes, including the
//     live-observed verbatim echo after a tool call (s03) that must deliver
//     exactly once.

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const m of sdkMessages) yield m;
    })(),
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

type Fixture = { gist: string; messages: unknown[] };
const FIXTURES = recordings as Record<string, Fixture>;

const CHAT_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  taskRun: false,
};

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-recorded-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  initTestSessionDb();
  for (const [name, channelType, platformId] of [
    ['discord-main', 'discord', 'chan-1'],
    ['ops-log', 'slack', 'chan-ops'],
  ]) {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }
});

afterEach(() => {
  closeSessionDb();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function load(id: string): void {
  sdkMessages.length = 0;
  sdkMessages.push(...FIXTURES[id].messages);
}

async function providerEvents(id: string): Promise<Array<{ type: string; text?: string | null }>> {
  load(id);
  const provider = new ClaudeProvider({});
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  const events: Array<{ type: string; text?: string | null }> = [];
  for await (const e of q.events) events.push(e as { type: string; text?: string | null });
  return events;
}

async function runThroughPollLoop(id: string): Promise<{ delivered: string[]; pushes: string[] }> {
  load(id);
  const provider = new ClaudeProvider({});
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const query = provider.query({ prompt: 'hi', cwd: tmp });
  const pushes: string[] = [];
  const origPush = query.push;
  query.push = (m: string) => {
    pushes.push(m);
    origPush(m);
  };
  await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);
  const delivered = getUndeliveredMessages()
    .filter((m) => m.kind === 'chat')
    .map((m) => (JSON.parse(m.content) as { text: string }).text);
  return { delivered, pushes };
}

describe('captured containment invariant', () => {
  it('in every captured turn with a result, the result text is EXACTLY the last streamed text event', async () => {
    for (const id of Object.keys(FIXTURES)) {
      const events = await providerEvents(id);
      let lastText: string | null = null;
      let checkedResults = 0;
      for (const e of events) {
        if (e.type === 'text') lastText = e.text ?? null;
        if (e.type === 'result') {
          expect({ id, result: e.text }).toEqual({ id, result: lastText });
          checkedResults++;
          lastText = null; // next turn starts fresh
        }
      }
      if (id !== 's12-abort-midstream') expect({ id, checkedResults }).not.toEqual({ id, checkedResults: 0 });
    }
  });
});

describe('captured end-to-end poll-loop outcomes', () => {
  it('s02: simple block turn — one delivery, result repeat stripped', async () => {
    const { delivered, pushes } = await runThroughPollLoop('s02-single-block');
    expect(delivered).toEqual(['Hey there! 👋 TestBot here, ready to help.']);
    expect(pushes).toHaveLength(0);
  });

  it('s03: verbatim echo of the block after a tool call — exactly ONE delivery (echo guard)', async () => {
    const { delivered, pushes } = await runThroughPollLoop('s03-block-then-tool');
    expect(delivered).toEqual(['✅ Deploy is done.']);
    expect(pushes).toHaveLength(0);
  });

  it('s04b: genuine half-message split across assistant messages — assembled and delivered once, no nudge', async () => {
    // Captured segments: "<message to=\"discord-main\">part one" then
    // "part two</message>" (a Bash call between them). Assembly joins the
    // fragments verbatim — the model put no separator at the boundary, so
    // the delivered body is exactly the concatenation.
    const { delivered, pushes } = await runThroughPollLoop('s04b-tool-inside-block');
    expect(delivered).toEqual(['part onepart two']);
    expect(pushes.filter((p) => p.includes('was not delivered'))).toHaveLength(0);
  });

  it('s06: tool first, block only in the final text — delivered once', async () => {
    const { delivered, pushes } = await runThroughPollLoop('s06-only-final');
    expect(delivered).toEqual(['hi']);
    expect(pushes).toHaveLength(0);
  });

  it('s08: long block with leading prose — block delivered once, prose stays scratchpad, no nudge', async () => {
    const { delivered, pushes } = await runThroughPollLoop('s08-long-block');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toStartWith('**Orion Deploy Update');
    expect(pushes).toHaveLength(0);
  });

  it('s09: two identical blocks in ONE segment (instructed repeat) — both deliver', async () => {
    const { delivered } = await runThroughPollLoop('s09-repeat-in-summary');
    expect(delivered).toEqual(['backup finished', 'backup finished']);
  });

  it('s10: block then unwrapped self-summary — one delivery, summary is scratchpad, no nudge', async () => {
    const { delivered, pushes } = await runThroughPollLoop('s10-summarize-no-repeat');
    expect(delivered).toEqual(['backup finished']);
    expect(pushes).toHaveLength(0);
  });

  it('s12: turn aborted mid tool call, no result event — the mid-turn delivery stands', async () => {
    const { delivered } = await runThroughPollLoop('s12-abort-midstream');
    expect(delivered).toEqual(['starting the slow job']);
  });

  it('s13: internal-wrapped blunt draft never delivers; the real block does', async () => {
    const { delivered } = await runThroughPollLoop('s13-internal-draft');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toStartWith('Hi! Just a friendly nudge');
    expect(delivered[0]).not.toContain('Blunt draft');
  });

  it('s14: two streamed turns — one delivery each, result repeats inert per turn', async () => {
    const { delivered, pushes } = await runThroughPollLoop('s14-two-turns-stream');
    expect(delivered).toEqual(['turn one', 'turn two']);
    expect(pushes).toHaveLength(0);
  });

  it('s16: block spread across THREE assistant messages (two tool calls between) — assembled, one delivery, no nudge', async () => {
    // Captured segments: "<message to=\"discord-main\">alpha " / Bash /
    // "beta " / Bash / "gamma</message>"; the SDK result carried only the
    // tail fragment "gamma</message>".
    const { delivered, pushes } = await runThroughPollLoop('s16-three-way-split');
    expect(delivered).toEqual(['alpha beta gamma']);
    expect(pushes).toHaveLength(0);
  });
});
