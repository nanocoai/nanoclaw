/**
 * The client half of `ncl groups attach` — response detection, TTY/plain
 * argv selection, and the --json bypass (json must print the frame, never
 * hand the terminal over).
 */
import { describe, expect, it } from 'vitest';

import { isAttachResponse, resolveAttachExec } from './attach-exec.js';
import type { ResponseFrame } from './frame.js';

const attachData = {
  attachExec: {
    bin: 'docker',
    argsTty: ['exec', '-it', 'c1', 'bun', '/app/src/code-runner/attach-client.ts'],
    argsPlain: ['exec', '-i', 'c1', 'bun', '/app/src/code-runner/attach-client.ts'],
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
});
