/**
 * The interactive CLI's argv (sandbox-spec D17).
 *
 * Code mode runs WITHOUT the CLI's local permission prompts. Enforcement is
 * the gateway's — every request is classified, policy-decided and
 * credential-injected there — so a second, local y/n adds nothing except a
 * stall in the one place with no approver: a detached sandbox.
 */
import { describe, it, expect } from 'bun:test';

import { claudeArgs, resolvePermissionMode, resumeArgs, DEFAULT_PERMISSION_MODE } from './claude-args.js';

describe('claudeArgs', () => {
  it("'bypass' skips the CLI prompt — the gateway is the approver", () => {
    expect(claudeArgs(undefined, 'bypass')).toEqual(['--dangerously-skip-permissions']);
    expect(claudeArgs('claude-opus-4-6', 'bypass')).toEqual([
      '--dangerously-skip-permissions',
      '--model',
      'claude-opus-4-6',
    ]);
  });

  it("'auto' leaves the CLI's own prompting alone", () => {
    expect(claudeArgs(undefined, 'auto')).toEqual([]);
    expect(claudeArgs('claude-opus-4-6', 'auto')).toEqual(['--model', 'claude-opus-4-6']);
  });

  it('defaults to the safe end when the caller says nothing', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('auto');
    expect(claudeArgs()).toEqual([]);
  });

  it('passes the group model only when set', () => {
    expect(claudeArgs(null, 'bypass')).toEqual(['--dangerously-skip-permissions']);
    expect(claudeArgs('', 'bypass')).toEqual(['--dangerously-skip-permissions']);
  });
});

describe('resumeArgs', () => {
  it('a resumable workspace gets --continue; a fresh one gets exactly nothing (C13)', () => {
    expect(resumeArgs(true)).toEqual(['--continue']);
    expect(resumeArgs(false)).toEqual([]);
  });
});

describe('resolvePermissionMode', () => {
  it("'bypass' is the only value that turns prompts off", () => {
    expect(resolvePermissionMode('bypass')).toBe('bypass');
  });

  it('anything else reads as auto — a typo must not silently disarm the prompts', () => {
    for (const raw of ['auto', 'AUTO', 'Bypass', 'dangerous', '', undefined, null, 1, {}]) {
      expect(resolvePermissionMode(raw)).toBe('auto');
    }
  });
});
