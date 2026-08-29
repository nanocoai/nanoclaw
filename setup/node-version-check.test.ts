import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Pin the Node floor logic in the setup shell scripts.
 *
 * The floor is 22.14.0, not 22.0.0: better-sqlite3 13 prebuilds segfault on
 * open (silent SIGSEGV) on Node 22 releases older than 22.14.0
 * (WiseLibs/better-sqlite3#1514). A major-only comparison waves an affected
 * Node through and the install dies later as an undiagnosable native crash,
 * so these tests run the REAL shell logic against versions on both sides of
 * the boundary.
 */

const setupDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(setupDir, '..');

/** Extract a top-level `name() { … }` function body from a shell script. */
function extractShellFunction(script: string, name: string): string {
  const source = fs.readFileSync(script, 'utf8');
  const start = source.indexOf(`${name}() {`);
  expect(start, `${name}() not found in ${script}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}', start);
  expect(end, `unterminated ${name}() in ${script}`).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

describe('setup/install-node.sh node_version_ok', () => {
  const fn = extractShellFunction(path.join(repoRoot, 'setup', 'install-node.sh'), 'node_version_ok');
  const prelude = 'NODE_MIN_MAJOR=22\nNODE_MIN_MINOR=14\n';

  function versionOk(version: string): boolean {
    try {
      execFileSync('bash', ['-c', `${prelude}${fn}\nnode_version_ok "${version}"`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  it('accepts 22.14.0 and newer', () => {
    expect(versionOk('22.14.0')).toBe(true);
    expect(versionOk('22.23.2')).toBe(true);
    expect(versionOk('24.1.0')).toBe(true);
    expect(versionOk('26.8.0')).toBe(true);
  });

  it('rejects Node 22 releases older than 22.14.0 (better-sqlite3 segfault range)', () => {
    expect(versionOk('22.0.0')).toBe(false);
    expect(versionOk('22.13.1')).toBe(false);
  });

  it('rejects majors below the floor', () => {
    expect(versionOk('20.19.0')).toBe(false);
    expect(versionOk('21.7.3')).toBe(false);
  });

  it('rejects garbage instead of passing it', () => {
    expect(versionOk('not-a-version')).toBe(false);
    expect(versionOk('')).toBe(false);
  });
});

describe('setup.sh check_node', () => {
  const fn = extractShellFunction(path.join(repoRoot, 'setup.sh'), 'check_node');

  function checkNode(version: string): boolean {
    // Run the real check_node with `node`/`command` shimmed to report the
    // given version; the function's own `log` is stubbed out.
    const script = `
      log() { :; }
      node() { echo "v${version}"; }
      command() { if [ "$1" = "-v" ] && [ "$2" = "node" ]; then echo /usr/bin/node; else builtin command "$@"; fi; }
      ${fn}
      check_node
      [ "$NODE_OK" = "true" ]
    `;
    try {
      execFileSync('bash', ['-c', script], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  it('accepts 22.14.0, newer 22.x, and newer majors', () => {
    expect(checkNode('22.14.0')).toBe(true);
    expect(checkNode('22.23.2')).toBe(true);
    expect(checkNode('24.1.0')).toBe(true);
  });

  it('rejects 22.x older than 22.14.0 and majors below 22', () => {
    expect(checkNode('22.13.1')).toBe(false);
    expect(checkNode('20.19.0')).toBe(false);
  });
});
