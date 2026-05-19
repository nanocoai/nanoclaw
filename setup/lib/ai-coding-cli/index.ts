/**
 * Setup-helper agent registry barrel.
 *
 * The setup flow can hand off failed steps to a coding-agent CLI for
 * interactive debugging or call one headlessly for utility tasks
 * (e.g. timezone parsing). Each supported CLI is one adapter file
 * exporting a `AiCodingCli`. This barrel collects them and
 * exposes selection helpers.
 *
 * Selection precedence:
 *   1. `NANOCLAW_AI_CODING_CLI` env var (if set + adapter exists)
 *   2. Caller's explicit choice (passed to `getAiCodingCli(name)`)
 *   3. Auto-pick: first registered adapter that's installed
 *
 * Adding a new CLI:
 *   1. Create `setup/lib/ai-coding-cli/<name>.ts` exporting a
 *      `AiCodingCli`-conformant const.
 *   2. Append it to `BUILTIN_CLIS` below.
 *   3. The setup-time picker shows it automatically.
 */
import { readEnvFile } from '../../../src/env.js';
import { claudeCli } from './claude.js';
import { codexCli } from './codex.js';
import type { AiCodingCli } from './types.js';

const BUILTIN_CLIS: AiCodingCli[] = [claudeCli, codexCli];

const registry = new Map<string, AiCodingCli>();
for (const cli of BUILTIN_CLIS) {
  registry.set(cli.name, cli);
}

export function listAiCodingClis(): AiCodingCli[] {
  return [...registry.values()];
}

export function getAiCodingCli(name: string | null | undefined): AiCodingCli | undefined {
  if (!name) return undefined;
  return registry.get(name.toLowerCase());
}

/**
 * Resolve the agent to use, in this priority order:
 *   1. `NANOCLAW_AI_CODING_CLI` from `.env` or `process.env`
 *   2. The first installed adapter, in registration order (`claude` first)
 *   3. `null` if nothing works — caller decides whether to error or skip
 */
export function resolveAiCodingCli(): AiCodingCli | null {
  const env = readEnvFile(['NANOCLAW_AI_CODING_CLI']);
  const configured = process.env.NANOCLAW_AI_CODING_CLI || env.NANOCLAW_AI_CODING_CLI;
  if (configured) {
    const a = registry.get(configured.toLowerCase());
    if (a && a.isInstalled()) return a;
    // Configured but missing — fall through to auto-detect rather than
    // hard-failing; the caller can warn separately.
  }
  for (const cli of BUILTIN_CLIS) {
    if (cli.isInstalled()) return cli;
  }
  return null;
}

/** Test helper. */
export function _resetRegistryForTest(): void {
  registry.clear();
  for (const cli of BUILTIN_CLIS) {
    registry.set(cli.name, cli);
  }
}

export type { SpawnArgs, AiCodingCli } from './types.js';
export { claudeCli, codexCli };
