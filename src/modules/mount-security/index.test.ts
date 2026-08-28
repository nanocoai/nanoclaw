/**
 * Tests for the mount allowlist loader/validator.
 *
 * Covers the two cleanups:
 *  - The loader honors the per-root `readOnly` key (translating it to
 *    `allowReadWrite`) and tolerates the top-level `nonMainReadOnly` key that
 *    setup writes into every fresh install.
 *  - The allowlist is read per call (mtime-keyed cache), so a parse error is
 *    never cached permanently — a fixed file is picked up without a restart.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The config path is a module-level const in production; point it at a
// per-test temp file via a getter so each test is isolated from the cache.
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

import { checkMountAdmissibleAtWrite, loadMountAllowlist, validateMount } from './index.js';

let tmpDir: string;
let configFile: string;
let projectsDir: string;
let repoDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnt-sec-'));
  configFile = path.join(tmpDir, 'mount-allowlist.json');
  mockState.allowlistPath = configFile;

  projectsDir = path.join(tmpDir, 'projects');
  repoDir = path.join(projectsDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAllowlist(obj: unknown): void {
  fs.writeFileSync(configFile, JSON.stringify(obj, null, 2) + '\n');
}

describe('loadMountAllowlist', () => {
  it('translates per-root readOnly:false into a read-write grant', () => {
    writeAllowlist({
      allowedRoots: [{ path: projectsDir, readOnly: false }],
      blockedPatterns: [],
    });

    const allowlist = loadMountAllowlist();
    expect(allowlist).not.toBeNull();
    expect(allowlist!.allowedRoots[0].allowReadWrite).toBe(true);

    // ...and a mount that requests read-write actually gets it.
    const result = validateMount({ hostPath: repoDir, readonly: false });
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('keeps readOnly:true as a read-only grant', () => {
    writeAllowlist({
      allowedRoots: [{ path: projectsDir, readOnly: true }],
      blockedPatterns: [],
    });

    const allowlist = loadMountAllowlist();
    expect(allowlist!.allowedRoots[0].allowReadWrite).toBe(false);

    const result = validateMount({ hostPath: repoDir, readonly: false });
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('tolerates an unknown top-level nonMainReadOnly key', () => {
    writeAllowlist({
      allowedRoots: [{ path: projectsDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const allowlist = loadMountAllowlist();
    expect(allowlist).not.toBeNull();
    expect(allowlist!.allowedRoots).toHaveLength(1);
    expect(allowlist!.allowedRoots[0].allowReadWrite).toBe(true);
  });

  it('picks up a fixed file without a restart (parse errors are not cached)', () => {
    // A broken edit blocks all mounts...
    fs.writeFileSync(configFile, 'not valid json {');
    expect(loadMountAllowlist()).toBeNull();

    // ...but fixing the file recovers on the very next call — no restart.
    writeAllowlist({
      allowedRoots: [{ path: projectsDir, allowReadWrite: true }],
      blockedPatterns: [],
    });
    const allowlist = loadMountAllowlist();
    expect(allowlist).not.toBeNull();
    expect(allowlist!.allowedRoots).toHaveLength(1);
  });

  it('returns null when the allowlist file is missing', () => {
    // No file written.
    expect(loadMountAllowlist()).toBeNull();
  });
});

describe('checkMountAdmissibleAtWrite', () => {
  it('rejects an absolute container path and names the relative rule', () => {
    writeAllowlist({ allowedRoots: [{ path: projectsDir, allowReadWrite: true }], blockedPatterns: [] });

    const result = checkMountAdmissibleAtWrite({ hostPath: repoDir, containerPath: '/usr/local/bin/rtk' });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toMatch(/RELATIVE/);
    expect((result as { ok: false; reason: string }).reason).toMatch(/\/workspace\/extra\/rtk/);
  });

  it('rejects a traversing or colon-bearing container path', () => {
    writeAllowlist({ allowedRoots: [{ path: projectsDir, allowReadWrite: true }], blockedPatterns: [] });

    expect(checkMountAdmissibleAtWrite({ hostPath: repoDir, containerPath: '../escape' }).ok).toBe(false);
    expect(checkMountAdmissibleAtWrite({ hostPath: repoDir, containerPath: 'repo:rw' }).ok).toBe(false);
  });

  it('rejects a blocked host pattern even with no allowlist on disk', () => {
    // No allowlist file: the default blocked list is still the floor, because
    // loadMountAllowlist merges it into every allowlist it does parse.
    const result = checkMountAdmissibleAtWrite({ hostPath: path.join(tmpDir, '.local', 'bin'), containerPath: 'bin' });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toMatch(/blocked pattern "\.local\/bin"/);
  });

  it('accepts a relative container path, leaving allowed-root and existence checks to spawn', () => {
    // Deliberately NOT under any allowed root, and the host path does not
    // exist: both are spawn-time concerns that can legitimately change before
    // the next spawn, so the write-time check must not refuse them.
    expect(checkMountAdmissibleAtWrite({ hostPath: '/data/gmail-mcp', containerPath: 'gmail-mcp' })).toEqual({
      ok: true,
    });
  });

  it('derives the container path from the host basename when none is given', () => {
    expect(checkMountAdmissibleAtWrite({ hostPath: repoDir })).toEqual({ ok: true });
  });
});
