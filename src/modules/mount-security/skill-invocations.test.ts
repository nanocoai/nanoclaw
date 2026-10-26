/**
 * Every `ncl groups config add-mount` invocation documented in an in-tree
 * SKILL.md, driven through the real mount-security validator.
 *
 * WHY THIS EXISTS. `add-mount` does not validate. It writes the entry to the
 * container config, answers `ok`, and tells the operator to restart. Whether
 * the mount is one mount-security will ever accept is decided later, at spawn,
 * where a rejection is a `log.warn` on the host that nobody reads. So a skill
 * can document a mount that provably can never mount, an operator can follow it
 * exactly, see success twice (from the verb and from the restart), and end up
 * with nothing mounted and no error anywhere they look.
 *
 * WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT. Two of the validator's
 * rejection reasons are static properties of the documented command itself and
 * can never come true on any host:
 *
 *   - an absolute `--container` path (`isValidContainerPath`), and
 *   - a `--host` path under one of `DEFAULT_BLOCKED_PATTERNS`, which are merged
 *     into every allowlist and are not configurable away.
 *
 * The other two rejection reasons — the host path not existing, and no
 * allowlist root covering it — are deployment facts, not documentation
 * defects. This test neutralises those on purpose: it materialises each
 * documented host path under a temp HOME and writes an allowlist whose single
 * root covers that HOME with `allowReadWrite: true`. So a failure here means
 * the documented command is wrong as written, not that the test host is
 * missing something.
 *
 * Discovery-based, not a hardcoded list: a new skill that documents `add-mount`
 * is covered the day it lands.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// MOUNT_ALLOWLIST_PATH is a module-level const in production; expose it as a
// getter over hoisted state so each test points at its own temp file.
const mockState = vi.hoisted(() => ({ allowlistPath: '' }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../config.js');
  return {
    ...actual,
    get MOUNT_ALLOWLIST_PATH() {
      return mockState.allowlistPath;
    },
  };
});

import { validateMount } from './index.js';

const SKILLS_DIR = path.join(process.cwd(), '.claude', 'skills');

interface DocumentedMount {
  skill: string;
  line: number;
  host: string;
  container: string;
  ro: boolean;
}

/**
 * Scrape every `ncl groups config add-mount` invocation out of the in-tree
 * skills. Shell line-continuations are folded first so a multi-line command
 * reads as one.
 */
function documentedMounts(): DocumentedMount[] {
  const found: DocumentedMount[] = [];
  if (!fs.existsSync(SKILLS_DIR)) return found;

  for (const skill of fs.readdirSync(SKILLS_DIR).sort()) {
    const file = path.join(SKILLS_DIR, skill, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');

    // Line number of each invocation, captured before folding continuations.
    const lines = text.split('\n');
    const starts = lines
      .map((l, i) => (l.includes('ncl groups config add-mount') ? i + 1 : -1))
      .filter((i) => i !== -1);

    const folded = text.replace(/\\\n\s*/g, ' ');
    const commands = folded.match(/ncl groups config add-mount[^\n]*/g) ?? [];

    commands.forEach((cmd, i) => {
      const host = /--host\s+(\S+)/.exec(cmd)?.[1];
      const container = /--container\s+(\S+)/.exec(cmd)?.[1];
      if (!host || !container) return;
      found.push({
        skill,
        line: starts[i] ?? 0,
        host: unquote(host),
        container: unquote(container),
        ro: /--ro\b/.test(cmd),
      });
    });
  }
  return found;
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

let tmpDir: string;
let fakeHome: string;

/** Rewrite `~`, `$HOME` and `${HOME}` to the temp home this test controls. */
function underFakeHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, fakeHome).replace(/\$\{?HOME\}?/g, fakeHome);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-mounts-'));
  fakeHome = path.join(tmpDir, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  mockState.allowlistPath = path.join(tmpDir, 'mount-allowlist.json');
  // One root covering the whole fake HOME, read-write. Coverage and the
  // read-write grant are therefore never the reason a case below fails.
  fs.writeFileSync(
    mockState.allowlistPath,
    JSON.stringify({ allowedRoots: [{ path: fakeHome, allowReadWrite: true }], blockedPatterns: [] }),
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('add-mount invocations documented in in-tree skills', () => {
  const mounts = documentedMounts();

  it('finds the documented invocations at all (guards the scraper)', () => {
    // If the scraper silently matched nothing, every case below would vacuously
    // pass. Skills are free to change; "no skill documents add-mount" is not.
    expect(mounts.length).toBeGreaterThan(0);
  });

  for (const m of mounts) {
    it(`${m.skill} (SKILL.md:${m.line}) documents a mount mount-security accepts`, () => {
      const hostPath = underFakeHome(m.host);
      expect(hostPath.startsWith(fakeHome)).toBe(true);

      // Materialise the documented host path so "does not exist" — a
      // deployment fact — cannot be the reason this fails.
      fs.mkdirSync(hostPath, { recursive: true });

      const result = validateMount({
        hostPath,
        containerPath: m.container,
        readonly: m.ro,
      });

      expect(result.allowed, `rejected: ${result.reason}`).toBe(true);
    });
  }
});

describe('add-mount re-run semantics as skills describe them', () => {
  /**
   * `add-mount` used to skip an entry whose host+container pair already
   * existed; it now replaces it, so re-running is how an operator corrects a
   * mode (src/cli/resources/groups.ts). The verb's own `description` was
   * updated with that change. The skills that document the verb were not, and
   * still tell the operator a re-run is a no-op — which is the opposite of
   * what it now does, and matters precisely because correcting a wrong mode is
   * the reason anyone re-runs it.
   */
  for (const skill of fs.existsSync(SKILLS_DIR) ? fs.readdirSync(SKILLS_DIR).sort() : []) {
    const file = path.join(SKILLS_DIR, skill, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('ncl groups config add-mount')) continue;

    it(`${skill} does not describe a re-run as a skip`, () => {
      const claims = text
        .split('\n')
        .map((l, i) => ({ line: i + 1, text: l }))
        .filter(({ text: l }) => /\bskips?\b[^.]*\balready present\b|\bre-running skips\b/i.test(l));

      expect(claims.map((c) => `SKILL.md:${c.line}: ${c.text.trim()}`)).toEqual([]);
    });
  }
});
