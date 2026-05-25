import { describe, expect, it } from 'bun:test';

import { buildCodexArgs, buildCodexPrompt, CodexProvider, extractCodexSessionId } from './codex.js';

describe('CodexProvider', () => {
  it('does not advertise active push support', () => {
    expect(new CodexProvider().supportsActivePush).toBe(false);
  });

  it('detects invalid resumed sessions', () => {
    const provider = new CodexProvider();

    expect(provider.isSessionInvalid(new Error('thread/resume failed: no rollout found for thread id abc'))).toBe(true);
    expect(provider.isSessionInvalid(new Error('Failed to authenticate. API Error: 401'))).toBe(false);
  });

  it('builds fresh exec args', () => {
    expect(buildCodexArgs(undefined, '/tmp/out.txt', 'gpt-5.4-mini')).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-o',
      '/tmp/out.txt',
      '-m',
      'gpt-5.4-mini',
      '-C',
      '/workspace/agent',
      '-',
    ]);
  });

  it('builds resume exec args', () => {
    expect(buildCodexArgs('thread-123', '/tmp/out.txt')).toEqual([
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-o',
      '/tmp/out.txt',
      'thread-123',
      '-',
    ]);
  });

  it('extracts a session id from nested JSONL events', () => {
    const jsonl = [
      JSON.stringify({ event: 'start' }),
      JSON.stringify({ msg: { thread_id: 'thread-abc' } }),
    ].join('\n');

    expect(extractCodexSessionId(jsonl)).toBe('thread-abc');
  });

  it('composes a prompt with NanoClaw and Codex context', () => {
    const prompt = buildCodexPrompt({
      prompt: 'hello',
      systemContext: { instructions: 'system instructions' },
    });

    expect(prompt).toContain('system instructions');
    expect(prompt).toContain('You are running inside NanoClaw using Codex as the active provider.');
    expect(prompt).toContain('/workspace/agent/CLAUDE.local.md');
    expect(prompt).toContain('/workspace/global/CLAUDE.md');
    expect(prompt).toContain('hello');
  });
});
