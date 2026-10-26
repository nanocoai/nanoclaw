/**
 * REAL-BINARY contract test for the Apple Container CLI.
 *
 * Every other driver test runs against `FakeCli`, so the whole suite stays
 * green when the actual `container` CLI changes its JSON shape, its flags, or
 * its exit codes underneath us. That is the gap this file closes: it shells out
 * to the installed binary and asserts ONLY the surfaces this install actually
 * parses, so a runtime upgrade that breaks one of them fails here instead of in
 * production.
 *
 * Why these two commands specifically:
 *   - `network inspect default` → `[0].status.ipv4Gateway` is how
 *     `resolveAppleHostGateway` rewrites OneCLI's proxy URL for every spawn.
 *     If its shape moves, containers get a dead gateway and the failure is a
 *     silent total outage with no error anywhere (see that function's header).
 *   - `list --format json` → `configuration.id` + `configuration.labels` +
 *     `status` is how `drainContainers` (scripts/update/service.ts) decides
 *     whether NanoClaw containers are still running during an update. A
 *     misparse there makes an update think the host is quiet when it is not.
 *
 * Read-only by design: it never creates, starts, or deletes a container, so it
 * is safe to run against a live install.
 *
 * Skips when the binary is absent (CI, Linux, docker-only installs) — the point
 * is to catch drift where the runtime IS installed, not to demand it.
 */
import { execFileSync } from 'child_process';
import { describe, it, expect } from 'vitest';

function hasAppleContainer(): boolean {
  try {
    execFileSync('container', ['--version'], { encoding: 'utf-8', timeout: 10_000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function run(args: string[]): string {
  return execFileSync('container', args, { encoding: 'utf-8', timeout: 30_000, stdio: 'pipe' });
}

const AVAILABLE = hasAppleContainer();

describe.skipIf(!AVAILABLE)('Apple Container CLI contract (real binary)', () => {
  it('reports a version we can read', () => {
    const out = run(['--version']);
    // Grammar has been `container CLI version X.Y.Z (...)`; assert only that a
    // dotted version is present, not the surrounding prose.
    expect(out).toMatch(/\d+\.\d+\.\d+/);
  });

  it('`network inspect default` still exposes [0].status.ipv4Gateway as an IPv4 string', () => {
    const parsed = JSON.parse(run(['network', 'inspect', 'default'])) as Array<{
      status?: { ipv4Gateway?: string };
    }>;
    expect(Array.isArray(parsed)).toBe(true);
    const gateway = parsed[0]?.status?.ipv4Gateway;
    expect(typeof gateway).toBe('string');
    // The value feeds a URL the container must dial; a non-IPv4 string here is
    // exactly the silent-dead-gateway case resolveAppleHostGateway guards.
    expect(gateway).toMatch(/^\d{1,3}(\.\d{1,3}){3}(\/\d+)?$/);
  });

  it('`list --format json` parses, and any entry carries configuration.id + a readable status', () => {
    const parsed = JSON.parse(run(['list', '--all', '--format', 'json'])) as Array<{
      status: string | { state?: string };
      configuration?: { id?: string; labels?: Record<string, string> };
    }>;
    expect(Array.isArray(parsed)).toBe(true);
    for (const entry of parsed) {
      // drainContainers reads exactly these three.
      expect(typeof entry.configuration?.id).toBe('string');
      const state = typeof entry.status === 'string' ? entry.status : entry.status?.state;
      expect(typeof state).toBe('string');
      if (entry.configuration?.labels !== undefined) {
        expect(typeof entry.configuration.labels).toBe('object');
      }
    }
  });

  it('exits non-zero on an unknown subcommand (the throw our Cli.run contract relies on)', () => {
    // `Cli.run` throws on non-zero and callers branch on that. If a CLI
    // restructure ever made failures exit 0, every one of those branches
    // silently inverts.
    expect(() => run(['definitely-not-a-subcommand'])).toThrow();
  });
});

describe.skipIf(AVAILABLE)('Apple Container CLI contract (skipped)', () => {
  it('is skipped because the `container` binary is not installed here', () => {
    expect(AVAILABLE).toBe(false);
  });
});
