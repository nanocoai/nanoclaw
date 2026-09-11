/**
 * The client half of `ncl groups attach` — response detection, TTY/plain
 * argv selection, and the --json bypass (json must print the frame, never
 * hand the terminal over).
 */
import { describe, expect, it } from 'vitest';

import { attachWarnings, isAttachResponse, resolveAttachExec } from './attach-exec.js';
import type { ResponseFrame } from './frame.js';

const attachData = {
  attachExec: {
    bin: 'docker',
    argsTty: ['exec', '-it', 'c1', 'tmux', '-S', '/tmp/code-runner/tmux.sock', 'attach-session', '-t', 'agent'],
    argsPlain: ['exec', '-i', 'c1', 'tmux', '-S', '/tmp/code-runner/tmux.sock', 'attach-session', '-t', 'agent'],
  },
};

const okFrame = (data: unknown): ResponseFrame => ({ id: 'r', ok: true, data });
const errFrame: ResponseFrame = { id: 'r', ok: false, error: { code: 'handler-error', message: 'nope' } };

describe('isAttachResponse', () => {
  it('accepts the exec shape and rejects near-misses', () => {
    expect(isAttachResponse(attachData)).toBe(true);
    expect(isAttachResponse(null)).toBe(false);
    expect(isAttachResponse({})).toBe(false);
    expect(isAttachResponse({ attachExec: { bin: 'docker', argsTty: 'not-array', argsPlain: [] } })).toBe(false);
  });
});

describe('resolveAttachExec', () => {
  it('selects TTY argv on a terminal, plain argv otherwise', () => {
    expect(resolveAttachExec(okFrame(attachData), false, true)).toEqual({
      bin: 'docker',
      args: attachData.attachExec.argsTty,
    });
    expect(resolveAttachExec(okFrame(attachData), false, false)).toEqual({
      bin: 'docker',
      args: attachData.attachExec.argsPlain,
    });
  });

  it('never execs for --json, errors, or non-attach data', () => {
    expect(resolveAttachExec(okFrame(attachData), true, true)).toBeUndefined();
    expect(resolveAttachExec(errFrame, false, true)).toBeUndefined();
    expect(resolveAttachExec(okFrame({ groups: [] }), false, true)).toBeUndefined();
  });

  it('an attach response may carry warnings the client prints before handing the terminal over', () => {
    const withWarnings = {
      ...attachData,
      warnings: ['name reserved for addresses; sandbox created without its own address'],
    };
    expect(resolveAttachExec(okFrame(withWarnings), false, true)?.bin).toBe('docker');
    expect(attachWarnings(okFrame(withWarnings))).toEqual([
      'name reserved for addresses; sandbox created without its own address',
    ]);
  });

  it('warnings are only non-empty strings in an array; anything else is none', () => {
    expect(attachWarnings(okFrame(attachData))).toEqual([]);
    expect(attachWarnings(okFrame({ ...attachData, warnings: 'one' }))).toEqual([]);
    expect(attachWarnings(okFrame({ ...attachData, warnings: ['ok', '', 3, null] }))).toEqual(['ok']);
    expect(attachWarnings(errFrame)).toEqual([]);
    expect(attachWarnings(okFrame(null))).toEqual([]);
  });
});
