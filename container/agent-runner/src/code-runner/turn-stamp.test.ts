/**
 * The host-visible turn stamp: monotonic seq, tmp+rename, torn/absent reads
 * as null, and the mailbox hook writes it beside the agent state on exactly
 * the turn-boundary events.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach } from 'bun:test';

import { readAgentState } from './agent-state.js';
import { readTurnState, writeTurnState } from './turn-stamp.js';

// NEVER import mailbox-hook.ts here (it runs main() on import — see
// mailbox-hook.test.ts); the hook is exercised as the subprocess claude runs.
const HOOK = path.join(import.meta.dir, 'mailbox-hook.ts');

let dir: string;
let stampPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-turn-'));
  stampPath = path.join(dir, 'code-turns', 'state.json');
});

describe('turn stamp file', () => {
  it('absent reads as null', () => {
    expect(readTurnState(stampPath)).toBeNull();
  });

  it('writes create the directory and count seq up from 1', () => {
    const first = writeTurnState('busy', stampPath);
    expect(first.seq).toBe(1);
    expect(first.state).toBe('busy');
    const second = writeTurnState('idle', stampPath);
    expect(second.seq).toBe(2);
    expect(readTurnState(stampPath)).toEqual(second);
    expect(fs.readdirSync(path.dirname(stampPath))).toEqual(['state.json']); // no tmp leftovers
  });

  it('a torn or unrecognized file reads as null', () => {
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, '{"state":"bu');
    expect(readTurnState(stampPath)).toBeNull();
    fs.writeFileSync(stampPath, JSON.stringify({ state: 'weird', at: 'x', seq: 1 }));
    expect(readTurnState(stampPath)).toBeNull();
    fs.writeFileSync(stampPath, JSON.stringify({ state: 'idle', at: 'x' }));
    expect(readTurnState(stampPath)).toBeNull();
  });
});

describe('mailbox hook stamps the turn', () => {
  function runHook(payload: unknown): number {
    const proc = Bun.spawnSync(['bun', HOOK, path.join(dir, 'agent-state.json')], {
      stdin: Buffer.from(JSON.stringify(payload)),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        NANOCLAW_MAIL_NOTICE: path.join(dir, 'mail-notice.json'),
        NANOCLAW_CONTAINER_JSON: path.join(dir, 'container.json'),
        NANOCLAW_TURN_STATE: stampPath,
      },
    });
    return proc.exitCode;
  }

  beforeEach(() => {
    fs.writeFileSync(path.join(dir, 'container.json'), JSON.stringify({ codeMode: true }));
  });

  it('UserPromptSubmit → busy, Stop → idle, SessionStart → idle; seq advances per event', () => {
    expect(runHook({ hook_event_name: 'SessionStart' })).toBe(0);
    expect(readTurnState(stampPath)).toMatchObject({ state: 'idle', seq: 1 });
    expect(runHook({ hook_event_name: 'UserPromptSubmit' })).toBe(0);
    expect(readTurnState(stampPath)).toMatchObject({ state: 'busy', seq: 2 });
    expect(runHook({ hook_event_name: 'Stop' })).toBe(0);
    expect(readTurnState(stampPath)).toMatchObject({ state: 'idle', seq: 3 });
    // The agent state moved in lockstep.
    expect(readAgentState(path.join(dir, 'agent-state.json'))?.state).toBe('idle');
  });

  it('tool-call events leave the turn stamp alone', () => {
    expect(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })).toBe(0);
    expect(runHook({ hook_event_name: 'PostToolUse' })).toBe(0);
    expect(readTurnState(stampPath)).toBeNull();
  });

  it('an unwritable stamp path never costs the agent state or the exit code', () => {
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.chmodSync(path.dirname(stampPath), 0o500);
    try {
      expect(runHook({ hook_event_name: 'UserPromptSubmit' })).toBe(0);
      expect(readAgentState(path.join(dir, 'agent-state.json'))?.state).toBe('busy');
    } finally {
      fs.chmodSync(path.dirname(stampPath), 0o700);
    }
  });
});
