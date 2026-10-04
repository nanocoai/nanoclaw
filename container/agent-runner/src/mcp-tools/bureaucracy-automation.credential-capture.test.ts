/**
 * Tests for handleCredentialCaptureReply's username -> password -> saveCredential
 * state machine, with node:child_process mocked so no real `agent-browser`
 * binary is invoked. This is the security-critical path: the whole point of
 * this feature is that the captured password reaches saveCredential's
 * execFileSync call via the `input` option, never via `args` (which would be
 * visible in process listings and shell history-equivalents). Every test here
 * that touches the password step asserts that property directly against the
 * mocked call, not just via code comments.
 *
 * node:child_process is mocked with `mock.module` + a dynamic import of the
 * module under test, mirroring the pattern already used in
 * `providers/claude.fast-mode.test.ts` etc. for `@anthropic-ai/claude-agent-sdk`:
 * the mock must be registered before the first (dynamic) import of
 * bureaucracy-automation.ts pulls in the real node:child_process.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

interface CapturedCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

let lastCall: CapturedCall | undefined;
let execFileSyncImpl: (command: string, args: string[], options: Record<string, unknown>) => string = () => '';

mock.module('node:child_process', () => ({
  execFileSync: (command: string, args: string[], options: Record<string, unknown>) => {
    lastCall = { command, args, options };
    return execFileSyncImpl(command, args, options);
  },
}));

const { handleCredentialCaptureReply } = await import('./bureaucracy-automation.js');
const { clearPendingCredentialCapture, getPendingCredentialCapture, setPendingCredentialCapture } = await import(
  '../db/credential-capture.js'
);
const { closeSessionDb, initTestSessionDb } = await import('../mailbox/sqlite/connection.js');
const { getUndeliveredMessages } = await import('../db/messages-out.js');

const PASSWORD = 'sup3r-secret-pw!';

beforeEach(() => {
  initTestSessionDb();
  lastCall = undefined;
  execFileSyncImpl = () => '';
});

afterEach(() => {
  clearPendingCredentialCapture();
  closeSessionDb();
});

describe('handleCredentialCaptureReply', () => {
  it('returns false when nothing is pending, leaving the message for the normal path', async () => {
    expect(await handleCredentialCaptureReply('hello')).toBe(false);
    expect(lastCall).toBeUndefined();
  });

  it('advances username -> password without ever calling execFileSync', async () => {
    setPendingCredentialCapture({ site: 'har-hakesef', url: 'https://itur.mof.gov.il', step: 'username' });

    const handled = await handleCredentialCaptureReply('alice');

    expect(handled).toBe(true);
    expect(lastCall).toBeUndefined();
    expect(getPendingCredentialCapture()).toEqual({
      site: 'har-hakesef',
      url: 'https://itur.mof.gov.il',
      step: 'password',
      username: 'alice',
    });
  });

  it('saves the credential via execFileSync input — never args — and clears pending state', async () => {
    setPendingCredentialCapture({
      site: 'har-hakesef',
      url: 'https://itur.mof.gov.il',
      step: 'password',
      username: 'alice',
    });

    const handled = await handleCredentialCaptureReply(PASSWORD);

    expect(handled).toBe(true);
    expect(lastCall).toBeDefined();
    expect(lastCall!.command).toBe('agent-browser');
    expect(lastCall!.args).toEqual([
      'auth',
      'save',
      'har-hakesef',
      '--url',
      'https://itur.mof.gov.il',
      '--username',
      'alice',
      '--password-stdin',
    ]);
    // The load-bearing security property: the password is never in argv.
    expect(lastCall!.args).not.toContain(PASSWORD);
    expect(lastCall!.args.join(' ')).not.toContain(PASSWORD);
    expect(JSON.stringify(lastCall!.args)).not.toContain(PASSWORD);
    // ...and it DOES travel via the input option (child process stdin).
    expect(lastCall!.options.input).toBe(PASSWORD);

    expect(getPendingCredentialCapture()).toBeUndefined();

    const [row] = getUndeliveredMessages();
    const content = JSON.parse(row.content) as { text: string };
    expect(content.text).not.toContain(PASSWORD);
    expect(content.text).toContain('Saved');
  });

  it('runs the full two-step flow end to end', async () => {
    setPendingCredentialCapture({ site: 'clal', url: 'https://clal.example', step: 'username' });

    expect(await handleCredentialCaptureReply('bob')).toBe(true);
    expect(lastCall).toBeUndefined(); // still just the username step

    expect(await handleCredentialCaptureReply('bobs-pw')).toBe(true);
    expect(lastCall!.command).toBe('agent-browser');
    expect(lastCall!.args).toContain('clal');
    expect(lastCall!.args).toContain('bob');
    expect(lastCall!.args).not.toContain('bobs-pw');
    expect(lastCall!.options.input).toBe('bobs-pw');
    expect(getPendingCredentialCapture()).toBeUndefined();
  });

  it('clears pending state and never leaks the password when execFileSync throws', async () => {
    execFileSyncImpl = () => {
      throw new Error('agent-browser: boom');
    };
    setPendingCredentialCapture({
      site: 'har-hakesef',
      url: 'https://itur.mof.gov.il',
      step: 'password',
      username: 'alice',
    });

    const handled = await handleCredentialCaptureReply(PASSWORD);

    expect(handled).toBe(true);
    // Pending state must not survive a failed save — otherwise a stuck
    // capture would keep intercepting every future message in the session.
    expect(getPendingCredentialCapture()).toBeUndefined();

    const [row] = getUndeliveredMessages();
    const content = JSON.parse(row.content) as { text: string };
    expect(content.text).not.toContain(PASSWORD);
    expect(content.text).toContain('boom');
  });
});
