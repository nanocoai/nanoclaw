import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHAT_LATER,
  createStageProbe,
  fill,
  FIRST_CHAT_COPY,
  SLOW_MODEL,
  keepWaitingQuestion,
  skippedWaitCopy,
  StageDisplay,
  stageFor,
  StageTracker,
  type SessionState,
  type SpinnerLike,
  type StageSignals,
} from './first-chat-progress.js';

const none: StageSignals = { session: false, sandboxRunning: false, agentActive: false };
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('stageFor', () => {
  it('maps the generic signals to the stage being waited on', () => {
    expect(stageFor(none)).toBe('sending');
    expect(stageFor({ ...none, session: true })).toBe('starting_sandbox');
    expect(stageFor({ ...none, session: true, sandboxRunning: true })).toBe('starting_agent');
    expect(stageFor({ session: true, sandboxRunning: true, agentActive: true })).toBe('waiting_for_reply');
  });

  it('trusts agent activity even when the sandbox status was missed', () => {
    expect(stageFor({ session: true, sandboxRunning: false, agentActive: true })).toBe('waiting_for_reply');
  });
});

describe('StageTracker', () => {
  it('times each stage and finishes skipped ones at zero', () => {
    const t = new StageTracker(1000);
    expect(t.advance('starting_sandbox', 1500)).toEqual([{ stage: 'sending', ms: 500 }]);
    expect(t.advance('waiting_for_reply', 13_500)).toEqual([
      { stage: 'starting_sandbox', ms: 12_000 },
      { stage: 'starting_agent', ms: 0 },
    ]);
    expect(t.stage).toBe('waiting_for_reply');
    expect(t.stageStart).toBe(13_500);
  });

  it('never moves back when a signal drops', () => {
    const t = new StageTracker(0);
    t.advance('starting_agent', 10);
    expect(t.advance('starting_sandbox', 20)).toEqual([]);
    expect(t.stage).toBe('starting_agent');
  });
});

describe('createStageProbe', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(since: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-first-chat-'));
    dirs.push(dir);
    let session: SessionState | null = null;
    const probe = createStageProbe({
      since,
      readSession: async () => session,
      heartbeatFile: (agentGroupId, sessionId) => path.join(dir, `${agentGroupId}-${sessionId}.heartbeat`),
    });
    const heartbeat = path.join(dir, 'ag-1-s-1.heartbeat');
    const touch = (mtimeMs: number) => {
      fs.writeFileSync(heartbeat, '');
      fs.utimesSync(heartbeat, mtimeMs / 1000, mtimeMs / 1000);
    };
    return { probe, touch, setSession: (s: SessionState | null) => (session = s) };
  }

  it('reports nothing until the message has a session', async () => {
    const { probe } = setup(Date.now());
    await expect(probe.read()).resolves.toEqual(none);
  });

  it('follows the session from sandbox start to agent activity', async () => {
    const since = Date.now();
    const { probe, touch, setSession } = setup(since);
    setSession({ agentGroupId: 'ag-1', sessionId: 's-1', containerStatus: 'stopped' });
    await expect(probe.read()).resolves.toEqual({ session: true, sandboxRunning: false, agentActive: false });
    setSession({ agentGroupId: 'ag-1', sessionId: 's-1', containerStatus: 'running' });
    await expect(probe.read()).resolves.toEqual({ session: true, sandboxRunning: true, agentActive: false });
    touch(since + 2000);
    await expect(probe.read()).resolves.toEqual({ session: true, sandboxRunning: true, agentActive: true });
  });

  it('ignores a heartbeat left from an earlier run until it is touched again', async () => {
    const since = Date.now();
    const { probe, touch, setSession } = setup(since);
    touch(since - 600_000);
    setSession({ agentGroupId: 'ag-1', sessionId: 's-1', containerStatus: 'running' });
    expect((await probe.read()).agentActive).toBe(false);
    // A sandbox clock running behind the host still counts once the file changes.
    touch(since - 500_000);
    expect((await probe.read()).agentActive).toBe(true);
  });
});

describe('StageDisplay', () => {
  function fakeUi() {
    const lines: string[] = [];
    const spinners: Array<SpinnerLike & { label: string }> = [];
    const spinner = (): SpinnerLike => {
      const s = {
        label: '',
        start: vi.fn((msg?: string) => (s.label = plain(msg ?? ''))),
        message: vi.fn((msg?: string) => (s.label = plain(msg ?? ''))),
        stop: vi.fn((msg?: string) => lines.push(plain(msg ?? ''))),
        clear: vi.fn(),
      };
      spinners.push(s);
      return s;
    };
    return {
      lines,
      spinners,
      deps: { spinner, step: (msg: string) => lines.push(plain(msg)), note: (msg: string) => lines.push(plain(msg)) },
    };
  }

  it('prints each finished stage with its own time and labels the current one', async () => {
    let signals = none;
    let now = 0;
    const ui = fakeUi();
    const display = new StageDisplay({ read: async () => signals }, { ...ui.deps, now: () => now }, 0);
    display.start();
    expect(ui.spinners[0].label).toMatch(/^Waking your assistant… \(0s\)/);
    await display.tick();
    expect(ui.spinners[0].label).toMatch(/^Sending a test message… \(0s\)/);
    signals = { session: true, sandboxRunning: true, agentActive: false };
    now = 12_000;
    await display.tick();
    expect(ui.lines).toEqual(['Test message received (12s)', 'Sandbox started (0s)']);
    expect(ui.spinners.at(-1)?.label).toMatch(/^Starting the agent runtime… \(0s\)/);
    now = 15_000;
    await display.tick();
    expect(ui.spinners.at(-1)?.label).toMatch(/^Starting the agent runtime… \(3s\)/);
  });

  it('shows the slow-model hint once after a while waiting for the reply', async () => {
    let now = 0;
    const ui = fakeUi();
    const signals: StageSignals = { session: true, sandboxRunning: true, agentActive: true };
    const display = new StageDisplay({ read: async () => signals }, { ...ui.deps, now: () => now }, 0);
    display.start();
    await display.tick();
    const hint = (l: string) => l.includes('local model');
    now = 10_000;
    await display.tick();
    expect(ui.lines.some(hint)).toBe(false);
    now = 25_000;
    await display.tick();
    now = 40_000;
    await display.tick();
    expect(ui.lines.filter(hint)).toHaveLength(1);
  });

  it('ends with the reply stage and the total time on success', async () => {
    let now = 0;
    const ui = fakeUi();
    const signals: StageSignals = { session: true, sandboxRunning: true, agentActive: true };
    const display = new StageDisplay({ read: async () => signals }, { ...ui.deps, now: () => now }, 0);
    display.start();
    now = 5000;
    await display.tick();
    now = 65_000;
    display.succeed('Your assistant is ready.');
    expect(ui.lines.slice(-2)).toEqual(['Reply received (1m 0s)', 'Your assistant is ready. (1m 5s)']);
  });

  it('keeps the timer running while a probe read hangs', async () => {
    let now = 0;
    const ui = fakeUi();
    const display = new StageDisplay({ read: () => new Promise(() => {}) }, { ...ui.deps, now: () => now }, 0);
    display.start();
    void display.tick();
    now = 7000;
    void display.tick();
    expect(ui.spinners[0].label).toMatch(/^Waking your assistant… \(7s\)/);
    vi.useFakeTimers();
    const idle = display.idle();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(idle).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('reports no seen stage until a read succeeds', async () => {
    const ui = fakeUi();
    let fail = true;
    const signals: StageSignals = { session: true, sandboxRunning: false, agentActive: false };
    const display = new StageDisplay(
      { read: async () => (fail ? Promise.reject(new Error('locked')) : signals) },
      { ...ui.deps, now: () => 0 },
      0,
    );
    display.start();
    await display.tick();
    expect(display.seenStage).toBeUndefined();
    fail = false;
    await display.tick();
    expect(display.seenStage).toBe('starting_sandbox');
  });

  it('claims no stage when the probe never reads', async () => {
    let now = 0;
    const ui = fakeUi();
    const display = new StageDisplay(
      { read: () => Promise.reject(new Error('locked')) },
      { ...ui.deps, now: () => now },
      0,
    );
    display.start();
    now = 30_000;
    await display.tick();
    expect(ui.spinners[0].label).toMatch(/^Waking your assistant… \(30s\)/);
    display.fail("Your assistant didn't reply in time.");
    expect(ui.lines).toEqual(["Your assistant didn't reply in time. (30s)"]);
  });

  it('keeps tracking while paused for a question', async () => {
    let signals = none;
    let now = 0;
    const ui = fakeUi();
    const display = new StageDisplay({ read: async () => signals }, { ...ui.deps, now: () => now }, 0);
    display.start();
    display.pause();
    signals = { ...none, session: true };
    now = 3000;
    await display.tick();
    expect(ui.spinners).toHaveLength(1);
    expect(ui.lines).toEqual([]);
    expect(display.stage).toBe('starting_sandbox');
    display.resume();
    expect(ui.lines).toEqual(['Test message received (3s)']);
    expect(ui.spinners.at(-1)?.label).toMatch(/^Starting the sandbox…/);
  });
});

describe('skippedWaitCopy', () => {
  const flat = (text: string) => text.replace(/\s+/g, ' ');

  it('names the last stage seen, points to chat later and the log, without the troubleshooting guide', () => {
    const copy = skippedWaitCopy('waiting_for_reply');
    expect(flat(copy.note)).toContain("was still waiting for the model's first reply when you stopped waiting");
    expect(flat(copy.note)).toContain('`pnpm run chat hi`');
    expect(flat(copy.note)).toContain('`logs/nanoclaw.log`');
    expect(flat(copy.note)).not.toContain('troubleshooting');
  });

  it('claims no stage when none was seen', () => {
    expect(flat(skippedWaitCopy(undefined).note)).toContain('had not replied when you stopped waiting');
  });
});

describe('exact first-chat wording', () => {
  // Pinned so a copy edit is a deliberate change to what users read.
  it('renders the skip note and the keep-waiting hint as reviewed', () => {
    expect(skippedWaitCopy('waiting_for_reply').note.replace(/\s+/g, ' ')).toBe(
      "Your assistant was still waiting for the model's first reply when you stopped waiting. Setup carries on without the first chat. Chat with it later using `pnpm run chat hi`. If it never answers, check `logs/nanoclaw.log`.",
    );
    expect(skippedWaitCopy(undefined).spinner).toBe('Stopped waiting for the first reply.');
  });

  it('does not promise a startup time the wait itself outlasts', () => {
    expect(FIRST_CHAT_COPY.intro).toBe(
      "Your assistant runs in an isolated sandbox. I'm going to send it a quick test message (ping) and wait for a reply (pong) to confirm it's responding. The first reply can take a minute or more while the sandbox starts and the model loads.",
    );
  });
});

describe('keepWaitingQuestion', () => {
  it('names the stage seen', () => {
    expect(keepWaitingQuestion('starting_sandbox', 120_000)).toBe(
      'Still starting the sandbox after 2m 0s. Keep waiting?',
    );
  });

  it('claims no stage when none was seen', () => {
    expect(keepWaitingQuestion(undefined, 120_000)).toBe('Still waiting for a reply after 2m 0s. Keep waiting?');
  });
});

const PLACEHOLDERS = new Set(['time', 'minutes']);

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

describe('fill', () => {
  it('fills named placeholders wherever a translation puts them', () => {
    expect(fill('Still waiting after {time}. Keep waiting?', { time: '2m 0s' })).toBe(
      'Still waiting after 2m 0s. Keep waiting?',
    );
    expect(fill('{time}: still waiting', { time: '2m 0s' })).toBe('2m 0s: still waiting');
  });

  it('leaves an unknown placeholder visible instead of dropping text', () => {
    expect(fill('After {time}', {})).toBe('After {time}');
    expect(fill('{toString} {__proto__}', {})).toBe('{toString} {__proto__}');
  });
});

describe('FIRST_CHAT_COPY', () => {
  it('uses only the known placeholders', () => {
    for (const text of strings(FIRST_CHAT_COPY)) {
      for (const [, name] of text.matchAll(/\{(\w+)\}/g)) expect(PLACEHOLDERS.has(name)).toBe(true);
    }
  });

  it('has a whole sentence for every stage, so no sentence is built from a stage phrase', () => {
    for (const stage of Object.values(FIRST_CHAT_COPY.stages)) {
      expect(stage.running).toMatch(/…$/);
      expect(stage.stillWaiting).toMatch(/^Still .+\{time\}.+Keep waiting\?$/);
      expect(stage.skipped).toMatch(/^Your assistant .+\.$/);
    }
  });

  it('defines each repeated sentence once and reuses it', () => {
    expect(FIRST_CHAT_COPY.slowModelHint).toBe(SLOW_MODEL);
    expect(FIRST_CHAT_COPY.keepWaitingHint).toContain(SLOW_MODEL);
    expect(FIRST_CHAT_COPY.skipHint).toBe(CHAT_LATER);
    expect(FIRST_CHAT_COPY.skippedNext).toContain(CHAT_LATER);
  });
});

describe('keep-waiting option text', () => {
  it('reads as two whole sentences', () => {
    expect(fill(FIRST_CHAT_COPY.keepWaitingHint, { minutes: 2 })).toBe(
      '2 more minutes. A local model can take several minutes to load and read its first prompt.',
    );
    expect(FIRST_CHAT_COPY.skipHint).toBe('Chat with it later using `pnpm run chat hi`.');
  });
});
