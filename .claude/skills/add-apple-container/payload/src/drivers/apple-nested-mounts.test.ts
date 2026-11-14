/**
 * Nested file mounts on Apple Container, against a REAL filesystem (the driver test
 * file mocks fs). Covers copying a differing nested file into its parent share and the
 * refusals that keep the host from writing through symlinks or into shared surfaces.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { dropClobberingFileMounts, materializeIntoShare } from './apple-container-driver.js';
import type { MountSpec } from './types.js';
describe('nested file mounts on a real filesystem', () => {
  // 2026-09-27: OneCLI's codex sign-in stub, mounted at ~/.codex/auth.json inside the
  // .codex-shared share, was dropped; Codex read the empty placeholder and every turn 401'd.
  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-mount-'));
    const shareDir = path.join(root, 'codex-shared');
    fs.mkdirSync(shareDir);
    fs.writeFileSync(path.join(shareDir, 'auth.json'), ''); // the host's empty placeholder
    const stub = path.join(root, 'stub');
    fs.writeFileSync(stub, '{"auth_mode":"chatgpt"}', { mode: 0o600 });
    const share: MountSpec = {
      class: 'allowlisted-extra',
      hostPath: shareDir,
      containerPath: '/home/node/.codex',
      mode: 'rw',
      groupScope: 'g1',
    };
    const stubMount: MountSpec = {
      class: 'allowlisted-extra',
      hostPath: stub,
      containerPath: '/home/node/.codex/auth.json',
      mode: 'ro',
      groupScope: 'g1',
    };
    return { root, shareDir, stub, share, stubMount, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }

  it('copies a differing nested file into the share so the guest sees its content', () => {
    const t = setup();
    try {
      const kept = dropClobberingFileMounts([t.share, t.stubMount]);
      expect(kept.map((m) => m.containerPath)).toEqual(['/home/node/.codex']);
      const target = path.join(t.shareDir, 'auth.json');
      expect(fs.readFileSync(target, 'utf8')).toBe('{"auth_mode":"chatgpt"}');
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(t.shareDir)).toEqual(['auth.json']); // no temp file left behind
    } finally {
      t.cleanup();
    }
  });

  it('writes nothing when the share already holds the same file', () => {
    const t = setup();
    try {
      const own = path.join(t.shareDir, 'AGENTS.md');
      fs.writeFileSync(own, 'canon');
      const before = fs.statSync(own).mtimeMs;
      const outcome = materializeIntoShare(
        { ...t.stubMount, hostPath: own, containerPath: '/home/node/.codex/AGENTS.md' },
        t.share,
        'AGENTS.md',
      );
      expect(outcome).toEqual({ kind: 'same' });
      expect(fs.statSync(own).mtimeMs).toBe(before);
    } finally {
      t.cleanup();
    }
  });

  it('replaces a symlink planted at the target and never writes through it', () => {
    const t = setup();
    try {
      const victim = path.join(t.root, 'victim');
      fs.writeFileSync(victim, 'do not touch');
      const target = path.join(t.shareDir, 'auth.json');
      fs.rmSync(target);
      fs.symlinkSync(victim, target);
      expect(materializeIntoShare(t.stubMount, t.share, 'auth.json')).toEqual({ kind: 'materialized' });
      expect(fs.readFileSync(victim, 'utf8')).toBe('do not touch');
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(target, 'utf8')).toBe('{"auth_mode":"chatgpt"}');
    } finally {
      t.cleanup();
    }
  });

  it('refuses read-only shares, install surfaces, deeper paths and a directory in the way', () => {
    const t = setup();
    try {
      const target = path.join(t.shareDir, 'auth.json');
      expect(materializeIntoShare(t.stubMount, { ...t.share, mode: 'ro' }, 'auth.json').kind).toBe('refused');
      expect(materializeIntoShare(t.stubMount, { ...t.share, class: 'install-surface' }, 'auth.json').kind).toBe(
        'refused',
      );
      fs.mkdirSync(path.join(t.shareDir, 'sub'));
      expect(materializeIntoShare(t.stubMount, t.share, 'sub/auth.json').kind).toBe('refused');
      expect(fs.existsSync(path.join(t.shareDir, 'sub', 'auth.json'))).toBe(false);
      expect(fs.readFileSync(target, 'utf8')).toBe(''); // untouched by every refusal
      fs.rmSync(target);
      fs.mkdirSync(target);
      expect(materializeIntoShare(t.stubMount, t.share, 'auth.json').kind).toBe('refused');
    } finally {
      t.cleanup();
    }
  });

  it('refuses a FIFO source or target without blocking the host', () => {
    // An agent can swap an entry in its own share for a FIFO; a blocking open would hang
    // every spawn. Without O_NONBLOCK this test times out instead of failing fast.
    const t = setup();
    try {
      const fifo = path.join(t.root, 'fifo');
      execFileSync('mkfifo', [fifo]);
      expect(materializeIntoShare({ ...t.stubMount, hostPath: fifo }, t.share, 'auth.json').kind).toBe('refused');
      const target = path.join(t.shareDir, 'auth.json');
      fs.rmSync(target);
      execFileSync('mkfifo', [target]);
      expect(materializeIntoShare(t.stubMount, t.share, 'auth.json')).toEqual({ kind: 'materialized' });
      expect(fs.readFileSync(target, 'utf8')).toBe('{"auth_mode":"chatgpt"}');
    } finally {
      t.cleanup();
    }
  }, 3000);

  it('sets the source mode exactly and rewrites a target whose mode drifted', () => {
    const t = setup();
    const old = process.umask(0o077);
    try {
      fs.chmodSync(t.stub, 0o644);
      const target = path.join(t.shareDir, 'auth.json');
      expect(materializeIntoShare(t.stubMount, t.share, 'auth.json').kind).toBe('materialized');
      expect(fs.statSync(target).mode & 0o777).toBe(0o644);
      fs.chmodSync(target, 0o777);
      expect(materializeIntoShare(t.stubMount, t.share, 'auth.json').kind).toBe('materialized');
      expect(fs.statSync(target).mode & 0o777).toBe(0o644);
    } finally {
      process.umask(old);
      t.cleanup();
    }
  });

  it('keeps a top-level file mount that is not nested in any share', () => {
    const t = setup();
    try {
      const ca = { ...t.stubMount, containerPath: '/tmp/onecli-ca.pem' };
      expect(dropClobberingFileMounts([t.share, ca]).map((m) => m.containerPath)).toEqual([
        '/home/node/.codex',
        '/tmp/onecli-ca.pem',
      ]);
    } finally {
      t.cleanup();
    }
  });
});
