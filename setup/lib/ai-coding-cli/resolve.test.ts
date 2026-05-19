/**
 * Tests for the runtime AI-coding-CLI resolver — covers the
 * smoke-matrix scenarios that don't require an interactive prompt.
 *
 * `resolveAiCodingCli` is what every non-setup path uses to pick the
 * CLI for handoff / headless work (tz-from-cli, cli-handoff,
 * cli-assist). The setup-time picker (`pickAiCodingCli` in
 * setup/auto.ts) is a separate flow that prompts the user — covered
 * by manual smoke verification, not here.
 *
 * Matrix scenarios covered:
 *   ✓ Only claude installed → resolves to claude
 *   ✓ Only codex installed → resolves to codex
 *   ✓ Both installed → first in registration order wins (claude)
 *   ✓ Nothing installed → returns null
 *   ✓ NANOCLAW_AI_CODING_CLI=codex + codex installed → codex
 *   ✓ NANOCLAW_AI_CODING_CLI=mystery (unknown) → falls through to first-installed
 *   ✓ NANOCLAW_AI_CODING_CLI=codex but codex NOT installed → falls through
 *   ✓ env var is case-insensitive
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { claudeCli, codexCli, resolveAiCodingCli } from './index.js';

// We override isInstalled() per test. Stash + restore the originals.
const originals = {
  claude: claudeCli.isInstalled,
  codex: codexCli.isInstalled,
};

function setInstalled(adapter: { isInstalled: () => boolean }, value: boolean) {
  adapter.isInstalled = () => value;
}

beforeEach(() => {
  // Reset .env-read cache — readEnvFile reads the file each call so no cache to bust.
  delete process.env.NANOCLAW_AI_CODING_CLI;
  // Default: all uninstalled.
  setInstalled(claudeCli, false);
  setInstalled(codexCli, false);
});

afterEach(() => {
  claudeCli.isInstalled = originals.claude;
  codexCli.isInstalled = originals.codex;
  delete process.env.NANOCLAW_AI_CODING_CLI;
});

describe('resolveAiCodingCli — auto-pick from install state', () => {
  it('returns claude when only claude is installed', () => {
    setInstalled(claudeCli, true);
    expect(resolveAiCodingCli()?.name).toBe('claude');
  });

  it('returns codex when only codex is installed', () => {
    setInstalled(codexCli, true);
    expect(resolveAiCodingCli()?.name).toBe('codex');
  });

  it('returns null when nothing is installed', () => {
    expect(resolveAiCodingCli()).toBeNull();
  });

  it('returns claude (first registered) when claude + codex both installed', () => {
    setInstalled(claudeCli, true);
    setInstalled(codexCli, true);
    expect(resolveAiCodingCli()?.name).toBe('claude');
  });
});

describe('resolveAiCodingCli — NANOCLAW_AI_CODING_CLI env var', () => {
  it('honors a matching configured value', () => {
    setInstalled(claudeCli, true);
    setInstalled(codexCli, true);
    process.env.NANOCLAW_AI_CODING_CLI = 'codex';
    expect(resolveAiCodingCli()?.name).toBe('codex');
  });

  it('is case-insensitive', () => {
    setInstalled(claudeCli, true);
    setInstalled(codexCli, true);
    process.env.NANOCLAW_AI_CODING_CLI = 'CODEX';
    expect(resolveAiCodingCli()?.name).toBe('codex');
  });

  it('falls through to auto-pick when configured CLI is unknown', () => {
    setInstalled(claudeCli, true);
    process.env.NANOCLAW_AI_CODING_CLI = 'mystery';
    expect(resolveAiCodingCli()?.name).toBe('claude');
  });

  it('falls through to auto-pick when configured CLI is uninstalled', () => {
    setInstalled(claudeCli, true);
    setInstalled(codexCli, false); // configured but not installed
    process.env.NANOCLAW_AI_CODING_CLI = 'codex';
    expect(resolveAiCodingCli()?.name).toBe('claude');
  });

  it('returns null if configured CLI is uninstalled AND nothing else is installed', () => {
    setInstalled(claudeCli, false);
    setInstalled(codexCli, false);
    process.env.NANOCLAW_AI_CODING_CLI = 'codex';
    expect(resolveAiCodingCli()).toBeNull();
  });
});
