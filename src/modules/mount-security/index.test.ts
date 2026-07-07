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

import { loadMountAllowlist, validateMount } from './index.js';

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
