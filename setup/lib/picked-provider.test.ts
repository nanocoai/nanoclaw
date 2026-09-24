import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getPickedProvider, isClaudeInstall, resolveSelectedProvider, setPickedProvider } from './picked-provider.js';

const roots: string[] = [];
/** A project root with the given `.env` contents (a fresh checkout when empty). */
function projectRoot(env = ''): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'picked-provider-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, '.env'), env);
  return root;
}

afterEach(() => {
  setPickedProvider(undefined);
  delete process.env.NANOCLAW_AGENT_PROVIDER;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveSelectedProvider', () => {
  it('is undefined on a fresh run before anything has chosen a runtime', () => {
    const root = projectRoot();
    expect(resolveSelectedProvider(root)).toBeUndefined();
    expect(isClaudeInstall(root)).toBe(false);
  });

  it('a claude pick this run is carried like any other value', () => {
    setPickedProvider('Claude');
    const root = projectRoot();
    expect(resolveSelectedProvider(root)).toBe('claude');
    expect(isClaudeInstall(root)).toBe(true);
    expect(getPickedProvider()).toBe('claude');
    expect(process.env.NANOCLAW_PICKED_PROVIDER).toBe('claude');
  });

  it('a non-claude pick is carried in the env var for the creation scripts', () => {
    setPickedProvider(' OpenCode ');
    expect(getPickedProvider()).toBe('opencode');
    expect(resolveSelectedProvider(projectRoot())).toBe('opencode');
    expect(isClaudeInstall(projectRoot())).toBe(false);
  });

  it('falls back to the preset, then to the default an earlier run stamped', () => {
    process.env.NANOCLAW_AGENT_PROVIDER = 'codex';
    expect(resolveSelectedProvider(projectRoot('DEFAULT_AGENT_PROVIDER=opencode\n'))).toBe('codex');
    delete process.env.NANOCLAW_AGENT_PROVIDER;
    expect(resolveSelectedProvider(projectRoot('DEFAULT_AGENT_PROVIDER=opencode\n'))).toBe('opencode');
    expect(resolveSelectedProvider(projectRoot('DEFAULT_AGENT_PROVIDER=claude\n'))).toBe('claude');
  });

  it('the pick made this run wins over the preset and the stamped default', () => {
    process.env.NANOCLAW_AGENT_PROVIDER = 'codex';
    setPickedProvider('claude');
    expect(resolveSelectedProvider(projectRoot('DEFAULT_AGENT_PROVIDER=opencode\n'))).toBe('claude');
  });

  it('clearing the pick clears the env var', () => {
    setPickedProvider('opencode');
    setPickedProvider(undefined);
    expect(getPickedProvider()).toBeUndefined();
    expect(resolveSelectedProvider(projectRoot())).toBeUndefined();
  });
});
