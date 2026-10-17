import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isValidGroupFolder } from '../../src/group-folder.js';
import * as setupLog from '../logs.js';
import {
  classifyPingResult,
  pingOutcome,
  sanitizeDetail,
  GENERIC_FAILURE_NOTICE,
  logFirstChat,
  pingFailureCopy,
  PING_AGENT_FOLDER,
  startCliPing,
} from './agent-ping.js';

vi.mock('../logs.js', () => ({ step: vi.fn() }));

const { children, spawnEnv } = vi.hoisted(() => ({
  children: [] as FakeChild[],
  spawnEnv: [] as Array<Record<string, string | undefined> | undefined>,
}));
vi.mock('child_process', () => ({
  spawn: (_cmd: string, _args: string[], opts?: { env?: Record<string, string | undefined> }) => {
    spawnEnv.push(opts?.env);
    const child: FakeChild = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(() => setImmediate(() => child.emit('close', null))),
    });
    children.push(child);
    return child;
  },
}));
const raw = (text: string, failureNotice?: boolean) =>
  Buffer.from(JSON.stringify(failureNotice ? { text, failureNotice } : { text }) + '\n');
type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };

it('uses a runtime-safe folder for the setup ping agent', () => {
  expect(isValidGroupFolder(PING_AGENT_FOLDER)).toBe(true);
});

describe('classifyPingResult', () => {
  it('treats a normal text reply as ok', () => {
    expect(classifyPingResult(0, 'pong\n')).toBe('ok');
  });

  it('detects Anthropic auth errors printed as a chat reply', () => {
    expect(
      classifyPingResult(
        0,
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
      ),
    ).toBe('auth_error');
  });

  it('detects auth errors on stderr too', () => {
    expect(classifyPingResult(1, '', 'Authentication error')).toBe('auth_error');
  });

  it('detects Claude Code login banners printed as a chat reply', () => {
    expect(classifyPingResult(0, 'Invalid API key · Please run /login')).toBe('auth_error');
    expect(classifyPingResult(0, 'Not logged in · Please run /login')).toBe('auth_error');
  });

  it('detects the notice for a bad external auth token', () => {
    expect(classifyPingResult(4, 'Invalid auth token · Fix external auth token')).toBe('auth_error');
  });

  it('preserves socket errors', () => {
    expect(classifyPingResult(2, '')).toBe('socket_error');
  });

  it('treats empty output as no reply', () => {
    expect(classifyPingResult(0, '')).toBe('no_reply');
    expect(classifyPingResult(0, '  \n')).toBe('no_reply');
  });

  it('treats a failure notice (chat exit 4) as an agent failure, not ok', () => {
    expect(classifyPingResult(4, `${GENERIC_FAILURE_NOTICE}\n`)).toBe('agent_failure');
  });

  it('keeps auth_error for a failure notice that names an auth problem', () => {
    expect(classifyPingResult(4, 'Invalid API key · Please run /login')).toBe('auth_error');
  });
});

it('logs the first-chat ping result to setup.log', () => {
  logFirstChat({ result: 'no_reply' }, 1200);
  expect(setupLog.step).toHaveBeenCalledWith('first-chat', 'failed', 1200, {
    RESULT: 'no_reply',
    HINT: expect.stringContaining('logs/nanoclaw.log'),
  });
});

it('logs an agent failure with a what-to-do hint but not its error text', () => {
  logFirstChat({ result: 'agent_failure', detail: 'quota exceeded' }, 900);
  expect(setupLog.step).toHaveBeenCalledWith('first-chat', 'failed', 900, {
    RESULT: 'agent_failure',
    HINT: expect.stringContaining('credentials'),
  });
});

it('logs ok as success without a hint', () => {
  logFirstChat({ result: 'ok' }, 500);
  expect(setupLog.step).toHaveBeenCalledWith('first-chat', 'success', 500, { RESULT: 'ok' });
});

it('logs how often the user kept waiting', () => {
  logFirstChat({ result: 'ok' }, 250_000, { keptWaiting: 1, skipped: false, stage: 'waiting_for_reply' });
  expect(setupLog.step).toHaveBeenCalledWith('first-chat', 'success', 250_000, { RESULT: 'ok', KEPT_WAITING: 1 });
});

it('logs a skipped wait with the stage it stopped at', () => {
  logFirstChat({ result: 'no_reply' }, 480_000, { keptWaiting: 3, skipped: true, stage: 'waiting_for_reply' });
  expect(setupLog.step).toHaveBeenCalledWith('first-chat', 'failed', 480_000, {
    RESULT: 'no_reply',
    HINT: expect.stringContaining('skipped'),
    KEPT_WAITING: 3,
    SKIPPED: true,
    STAGE: 'waiting_for_reply',
  });
});

describe('startCliPing', () => {
  afterEach(() => {
    vi.useRealTimers();
    children.length = 0;
  });

  it('hands the chat client the deadline and reports no_reply when stopped', async () => {
    const ping = startCliPing(600_000);
    expect(spawnEnv.at(-1)?.NANOCLAW_CHAT_TIMEOUT_MS).toBe('600000');
    ping.stop();
    expect(children.at(-1)?.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(ping.outcome).resolves.toEqual({ result: 'no_reply' });
  });

  it('keeps a reply the client printed before it was stopped', async () => {
    const ping = startCliPing(600_000);
    children.at(-1)?.stdout.emit('data', raw('pong'));
    ping.stop();
    await expect(ping.outcome).resolves.toEqual({ result: 'ok' });
  });

  it('reads output that drains after the kill before deciding', async () => {
    const ping = startCliPing(600_000);
    const child = children.at(-1)!;
    child.kill.mockImplementation(() => undefined);
    child.stdout.emit('data', raw('Done part one.'));
    ping.stop();
    child.stdout.emit('data', raw('Spending limit reached', true));
    child.emit('close', null);
    await expect(ping.outcome).resolves.toEqual({ result: 'agent_failure', detail: 'Spending limit reached' });
  });

  it('kills a chat client that outlives its own deadline', async () => {
    vi.useFakeTimers();
    const ping = startCliPing(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(children.at(-1)?.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children.at(-1)?.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(ping.outcome).resolves.toEqual({ result: 'no_reply' });
  });
});

describe('ping outcome from raw chat-client lines', () => {
  it('uses the flagged notice, not a partial reply before it', () => {
    const stdout = raw('Finished the first step.').toString() + raw('403 billing_error: Spending limit reached.', true);
    expect(pingOutcome(4, stdout, '(node:1) Warning: something\n')).toEqual({
      result: 'agent_failure',
      detail: '403 billing_error: Spending limit reached.',
    });
  });

  it('hides the generic notice, which carries no reason', () => {
    expect(pingOutcome(4, raw(GENERIC_FAILURE_NOTICE, true).toString(), '')).toEqual({ result: 'agent_failure' });
  });

  it('uses the matching line for an auth error on either stream', () => {
    expect(pingOutcome(1, '', 'Authentication error: invalid account\n')).toEqual({
      result: 'auth_error',
      detail: 'Authentication error: invalid account',
    });
    expect(pingOutcome(4, raw('Invalid API key · Please run /login', true).toString(), '')).toEqual({
      result: 'auth_error',
      detail: 'Invalid API key · Please run /login',
    });
    expect(pingOutcome(4, raw('Invalid auth token · Fix external auth token', true).toString(), '')).toEqual({
      result: 'auth_error',
      detail: 'Invalid auth token · Fix external auth token',
    });
  });

  it('reads a normal reply as ok', () => {
    expect(pingOutcome(0, raw('pong').toString(), '')).toEqual({ result: 'ok' });
  });

  it('turns tabs into spaces and never splits a character when truncating', () => {
    expect(sanitizeDetail('a\tb')).toBe('a b');
    const emoji = sanitizeDetail('🙂'.repeat(200));
    expect(Array.from(emoji ?? '')).toHaveLength(160);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('strips terminal escapes and keeps one short line', () => {
    expect(sanitizeDetail('\x1b]52;c;VEVTVA==\x07\x1b[31mInvalid API key\x1b[0m\nsecond line')).toBe('Invalid API key');
    const long = sanitizeDetail('word '.repeat(100));
    expect(long).toHaveLength(160);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('runs the chat client in raw-lines mode and attaches the reason', async () => {
    const ping = startCliPing(1000);
    const child = children[children.length - 1];
    child.stdout.emit('data', raw('Credit balance is too low', true));
    child.emit('close', 4);
    await expect(ping.outcome).resolves.toEqual({ result: 'agent_failure', detail: 'Credit balance is too low' });
    expect(spawnEnv[spawnEnv.length - 1]?.NANOCLAW_CHAT_RAW_LINES).toBe('1');
  });
});

describe('wizard failure copy', () => {
  // The note is wrapped to the terminal width; compare it as one line.
  const flat = (text: string) => text.replace(/\s+/g, ' ');

  it("shows the agent's own error plus the logs and docs", () => {
    const copy = pingFailureCopy({ result: 'agent_failure', detail: 'Credit balance is too low' });
    expect(flat(copy.note)).toContain('It said: "Credit balance is too low".');
    expect(copy.assistHint).toContain('Credit balance is too low');
    expect(flat(copy.note)).toContain('`logs/nanoclaw.log` and `logs/nanoclaw.error.log`');
    expect(flat(copy.note)).toContain('https://docs.nanoclaw.dev/operate/troubleshooting#start-here');
  });

  it('says no reason was sent for the generic notice', () => {
    const copy = pingFailureCopy({ result: 'agent_failure' });
    expect(flat(copy.note)).toContain('It sent no reason.');
    expect(flat(copy.note)).toContain('`logs/nanoclaw.log` and `logs/nanoclaw.error.log`');
    expect(flat(copy.note)).toContain('https://docs.nanoclaw.dev/operate/troubleshooting#start-here');
  });

  it('names how long setup waited when no reply came', () => {
    const copy = pingFailureCopy({ result: 'no_reply' }, 240_000);
    expect(flat(copy.note)).toContain('No reply from your assistant after 4m 0s.');
    expect(copy.assistMsg).toBe('No reply from the assistant after 4m 0s.');
  });
});
