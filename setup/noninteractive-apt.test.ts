/**
 * Pin the non-interactive apt posture of the Linux setup helpers (#2514).
 *
 * Setup pipes these scripts' output to a log file, so any interactive prompt
 * is invisible and blocks the whole run on stdin. The observed hang is
 * needrestart's post-install whiptail dialog, which DEBIAN_FRONTEND alone
 * does not suppress — NEEDRESTART_SUSPEND is required. Both installers must
 * export both, before the command that drives apt, in a way that survives
 * the sudo they use (nodesource pipes into `sudo -E bash -`, get.docker.com
 * escalates via `sudo -E sh -c`, and the direct apt-get call carries `-E`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const setupDir = path.dirname(fileURLToPath(import.meta.url));

function linuxBranch(script: string): string {
  const source = fs.readFileSync(path.join(setupDir, script), 'utf8');
  const start = source.indexOf('Linux)');
  expect(start, `Linux branch not found in ${script}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(';;', start);
  expect(end, `unterminated Linux branch in ${script}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe.each(['install-node.sh', 'install-docker.sh'])('%s Linux branch', (script) => {
  it('exports DEBIAN_FRONTEND=noninteractive and NEEDRESTART_SUSPEND before driving apt', () => {
    const branch = linuxBranch(script);
    const frontier = branch.indexOf('curl ');
    expect(frontier, 'no curl call found').toBeGreaterThanOrEqual(0);
    const preamble = branch.slice(0, frontier);
    expect(preamble).toContain('export DEBIAN_FRONTEND=noninteractive');
    expect(preamble).toContain('export NEEDRESTART_SUSPEND=1');
  });

  it('preserves the exported environment across sudo (sudo -E)', () => {
    const branch = linuxBranch(script);
    // Every sudo that (directly or via a piped installer script) reaches
    // apt must carry -E, or the exports die at the privilege boundary.
    // usermod does not touch apt and is exempt.
    const sudoCalls = branch.match(/sudo(?: -\S+)* [a-z-]+/g) ?? [];
    for (const call of sudoCalls) {
      if (call.includes('usermod')) continue;
      expect(call, `"${call}" drops the exported env — use sudo -E`).toContain('-E');
    }
  });
});
