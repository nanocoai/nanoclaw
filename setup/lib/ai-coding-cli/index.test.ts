import { describe, it, expect } from 'vitest';

import { claudeCli, codexCli, getAiCodingCli, listAiCodingClis } from './index.js';

describe('ai-coding-cli registry', () => {
  it('lists at least claude and codex', () => {
    const names = listAiCodingClis().map((a) => a.name);
    expect(names).toContain('claude');
    expect(names).toContain('codex');
  });

  it('getAiCodingCli returns the matching adapter', () => {
    expect(getAiCodingCli('claude')).toBe(claudeCli);
    expect(getAiCodingCli('codex')).toBe(codexCli);
  });

  it('getAiCodingCli is case-insensitive', () => {
    expect(getAiCodingCli('CLAUDE')).toBe(claudeCli);
    expect(getAiCodingCli('Codex')).toBe(codexCli);
  });

  it('getAiCodingCli returns undefined for unknown / null', () => {
    expect(getAiCodingCli('mystery-cli')).toBeUndefined();
    expect(getAiCodingCli(null)).toBeUndefined();
    expect(getAiCodingCli(undefined)).toBeUndefined();
  });
});

describe('claude adapter shape', () => {
  it('headless returns print-mode argv (tools off by default)', () => {
    const spawn = claudeCli.headless('what is 2+2');
    expect(spawn.args).toEqual(['-p', '--output-format', 'text', 'what is 2+2']);
    expect(spawn.stdin).toBe('ignore');
    expect(spawn.output).toBe('pipe');
  });

  it('headless with tools=true adds bypassPermissions for the assist flow', () => {
    const spawn = claudeCli.headless('diagnose this', { tools: true });
    expect(spawn.args).toEqual([
      '-p',
      '--output-format',
      'text',
      '--permission-mode',
      'bypassPermissions',
      'diagnose this',
    ]);
  });

  it('handoff returns interactive argv', () => {
    const spawn = claudeCli.handoff('debug this failure');
    expect(spawn.args).toEqual(['debug this failure']);
    expect(spawn.stdin).toBe('inherit');
    expect(spawn.output).toBe('inherit');
  });

  it('declares its install script', () => {
    expect(claudeCli.installScript).toBe('setup/install-claude.sh');
  });
});

describe('codex adapter shape', () => {
  it('headless uses `exec` subcommand', () => {
    const spawn = codexCli.headless('what is 2+2');
    expect(spawn.args).toEqual(['exec', 'what is 2+2']);
    expect(spawn.stdin).toBe('ignore');
    expect(spawn.output).toBe('pipe');
  });

  it('headless tools opt is a no-op (exec already allows tool use)', () => {
    const spawn = codexCli.headless('diagnose this', { tools: true });
    expect(spawn.args).toEqual(['exec', 'diagnose this']);
  });

  it('handoff is bare invocation with prompt as argv', () => {
    const spawn = codexCli.handoff('debug this failure');
    expect(spawn.args).toEqual(['debug this failure']);
    expect(spawn.stdin).toBe('inherit');
    expect(spawn.output).toBe('inherit');
  });

  it('declares no scriptable install (fork installs via /add-codex skill)', () => {
    expect(codexCli.installScript).toBeNull();
  });

  it('isAuthenticated returns undefined when installed (no fast offline probe)', () => {
    if (codexCli.isInstalled()) {
      expect(codexCli.isAuthenticated()).toBeUndefined();
    } else {
      expect(codexCli.isAuthenticated()).toBe(false);
    }
  });
});
