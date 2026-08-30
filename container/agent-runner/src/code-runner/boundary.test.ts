/**
 * The pure D17 boundary half: classification (over-matching asks — the
 * fail-safe direction), the fail-closed decision file, and the poll loop's
 * timeout=deny contract, all without a subprocess.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach } from 'bun:test';

import {
  classifyBoundary,
  decisionPath,
  decisionsDirTrusted,
  readBoundaryDecision,
  readPermissionPosture,
  requestPath,
  waitForDecision,
  writeBoundaryRequest,
} from './boundary.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-boundary-'));
});

describe('classifyBoundary', () => {
  it('flags dev-env release wherever it appears in a command', () => {
    expect(classifyBoundary('Bash', { command: 'ncl envs release env-1' })).toContain('release');
    // Compound commands are still a release — substring on purpose.
    expect(classifyBoundary('Bash', { command: 'cd /x && ncl  envs  release env-1' })).toContain('release');
  });

  it('lets ordinary sandbox work flow', () => {
    expect(classifyBoundary('Bash', { command: 'ncl envs list' })).toBeNull();
    expect(classifyBoundary('Bash', { command: 'ncl envs get env-1' })).toBeNull();
    expect(classifyBoundary('Bash', { command: 'echo released' })).toBeNull();
    expect(classifyBoundary('Bash', {})).toBeNull();
    expect(classifyBoundary('Read', { file_path: '/workspace/group/CLAUDE.md' })).toBeNull(); // reads are free
    expect(classifyBoundary('Glob', {})).toBeNull();
  });

  it('flags Edit and Write on each custody path, normalized', () => {
    for (const file of [
      '/workspace/code-mode-managed-settings.json',
      '/home/node/.claude/settings.json',
      '/workspace/group/CLAUDE.md',
      '/workspace/group/../code-mode-managed-settings.json', // dot-dot does not launder the path
    ]) {
      expect(classifyBoundary('Edit', { file_path: file })).toContain('custody');
      expect(classifyBoundary('Write', { file_path: file })).toContain('custody');
    }
    expect(classifyBoundary('Edit', { file_path: '/workspace/group/notes.md' })).toBeNull();
    expect(classifyBoundary('Write', { file_path: '' })).toBeNull();
  });

  it('flags Bash commands that NAME a custody path — the redirect channel Edit/Write rules miss', () => {
    // The E-t7 review's write-through: a plain redirect rewrote the managed
    // policy because only the Edit/Write TOOLS were gated.
    for (const command of [
      `echo '{}' > /workspace/code-mode-managed-settings.json`,
      'tee /home/node/.claude/settings.json < /tmp/x',
      `sed -i 's/a/b/' ~/.claude/settings.json`, // suffix marker covers the ~ spelling
      'cp /tmp/x /workspace/group/CLAUDE.md',
      'cat /workspace/code-mode-managed-settings.json', // reads over-match too: over-matching asks
    ]) {
      expect(classifyBoundary('Bash', { command })).toContain('custody');
    }
    expect(classifyBoundary('Bash', { command: 'cat /workspace/group/notes.md' })).toBeNull();
    expect(classifyBoundary('Bash', { command: 'bun run typecheck' })).toBeNull();
  });
});

describe('readPermissionPosture', () => {
  it('reads bypass only from the composed escape-hatch shape; any other policy is auto', () => {
    const file = path.join(dir, 'managed-settings.json');
    fs.writeFileSync(file, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
    expect(readPermissionPosture(file)).toBe('bypass');
    fs.writeFileSync(file, JSON.stringify({ permissions: { defaultMode: 'default', allow: ['Bash'] } }));
    expect(readPermissionPosture(file)).toBe('auto');
    fs.writeFileSync(file, JSON.stringify({ permissions: {} }));
    expect(readPermissionPosture(file)).toBe('auto');
  });

  it('an absent or unreadable stamp is null — not a code-mode container', () => {
    expect(readPermissionPosture(path.join(dir, 'nope.json'))).toBeNull();
    const file = path.join(dir, 'torn.json');
    fs.writeFileSync(file, '{"permis');
    expect(readPermissionPosture(file)).toBeNull();
  });
});

describe('decisionsDirTrusted', () => {
  // The trusted case (EROFS) needs a real RO mount, which a test cannot make
  // without root — the hook subprocess test covers the deny it implies. Here:
  // every refusal the agent CAN manufacture must read untrusted.
  it('a dir this uid can write to is never trusted, and the probe leaves no litter', () => {
    expect(decisionsDirTrusted(dir)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('a missing dir and a chmod-555 dir are untrusted — EACCES/ENOENT are not EROFS', () => {
    expect(decisionsDirTrusted(path.join(dir, 'missing'))).toBe(false);
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked, { mode: 0o555 });
    try {
      expect(decisionsDirTrusted(locked)).toBe(false);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
});

describe('the decision file, fail-closed', () => {
  it('only the exact pair of verdicts parses; everything else keeps polling', () => {
    const file = path.join(dir, 'd.json');
    expect(readBoundaryDecision(file)).toBeNull(); // absent
    fs.writeFileSync(file, '{"decis'); // torn
    expect(readBoundaryDecision(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ decision: 'ALLOW' })); // wrong charset/case
    expect(readBoundaryDecision(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ decision: 'deny', reason: 'no' }));
    expect(readBoundaryDecision(file)).toEqual({ decision: 'deny', reason: 'no' });
    fs.writeFileSync(file, JSON.stringify({ decision: 'allow' }));
    expect(readBoundaryDecision(file)?.decision).toBe('allow');
  });

  it('request write is atomic: no tmp residue beside the request', () => {
    writeBoundaryRequest(dir, { id: 'r1', toolName: 'Bash', toolInput: {}, reason: 'x', at: new Date().toISOString() });
    expect(fs.readdirSync(dir)).toEqual(['r1.request.json']);
    expect(JSON.parse(fs.readFileSync(requestPath(dir, 'r1'), 'utf8')).id).toBe('r1');
  });
});

describe('waitForDecision', () => {
  it('returns the decision the moment the file lands', async () => {
    const file = decisionPath(dir, 'w1');
    let clock = 0;
    const result = waitForDecision(file, {
      ttlMs: 10_000,
      pollMs: 1,
      now: () => clock,
      sleep: async () => {
        clock += 1;
        if (clock === 3) fs.writeFileSync(file, JSON.stringify({ decision: 'allow' }));
      },
    });
    await expect(result).resolves.toEqual({ decision: 'allow', reason: undefined });
  });

  it('timeout means deny (D17) — never allow, never hang', async () => {
    const file = decisionPath(dir, 'w2');
    let clock = 0;
    const result = await waitForDecision(file, {
      ttlMs: 100,
      pollMs: 1,
      now: () => clock,
      sleep: async () => {
        clock += 50;
      },
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('no approval');
  });
});
