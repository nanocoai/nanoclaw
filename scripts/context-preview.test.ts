import { describe, it, expect } from 'vitest';
import path from 'path';
import { spawnSync } from 'child_process';

/**
 * Smoke test for scripts/context-preview.ts: the tool imports production
 * seams from both halves (host: spawn path + writers; container: poll loop,
 * provider options, tool registry), so any rename or signature drift breaks
 * it. Running the default scenario end to end — the container half under
 * Bun, as in CI — and checking every surface is non-empty catches that
 * before it rots silently.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'context-preview.ts');

describe('scripts/context-preview.ts', () => {
  it('renders all five surfaces for first-message --json', { timeout: 180_000 }, () => {
    const r = spawnSync('pnpm', ['exec', 'tsx', SCRIPT, 'first-message', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, LOG_LEVEL: 'warn' },
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(r.status, `context-preview failed:\n${r.stderr}`).toBe(0);
    const out = JSON.parse(r.stdout);

    // 1. Composed project document — sections + the runtime contract.
    expect(out.claudeMd.sections.length).toBeGreaterThan(0);
    expect(out.claudeMd.content).toContain('# NanoClaw Runtime Contract');
    // 2. Runtime system-prompt addendum — identity + destinations.
    expect(out.systemPrompt.append).toContain('## Sending messages');
    // 3. SDK options — the exact Claude query options.
    expect(Array.isArray(out.sdkOptions?.allowedTools)).toBe(true);
    expect(out.sdkOptions.allowedTools.length).toBeGreaterThan(0);
    expect(out.sdkOptions.cwd).toBe('/workspace/agent');
    // 4. MCP tool surface — registered nanoclaw tools.
    const toolNames = out.mcpTools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('send_message');
    // 5. The exact prompt the real poll loop handed the provider.
    expect(out.prompt).toContain('<message ');
    expect(out.prompt).toContain('birthday dinner');
  });
});
