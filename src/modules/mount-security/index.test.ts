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

import type { MountPolicy } from '../../drivers/types.js';
import { loadMountAllowlist, protectedMountReason, validateMount } from './index.js';

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

describe('paths NanoClaw mounts itself', () => {
  // A fake install whose runner source sits under an allowlisted root, the way
  // an operator who allowlists their whole home directory has it.
  let installRoot: string;
  let runnerSrc: string;
  let policy: MountPolicy;

  beforeEach(() => {
    installRoot = path.join(tmpDir, 'install');
    runnerSrc = path.join(installRoot, 'container', 'agent-runner', 'src');
    fs.mkdirSync(runnerSrc, { recursive: true });
    policy = {
      groupsRoot: path.join(installRoot, 'groups'),
      dataRoot: path.join(installRoot, 'data'),
      surfaceRoots: [runnerSrc, path.join(installRoot, 'container', 'skills')],
      materialsRoot: path.join(installRoot, 'data', 'session-materials'),
      gatewayTrustRoot: path.join(installRoot, 'data', 'gateway-trust'),
    };
    writeAllowlist({ allowedRoots: [{ path: tmpDir, allowReadWrite: true }], blockedPatterns: [] });
  });

  it('rejects the runner source even when an allowed root covers it', () => {
    // Accepted here, it reaches the driver classed allowlisted-extra, and the
    // driver refuses every start of the group with no word to the user.
    const result = validateMount({ hostPath: runnerSrc, containerPath: 'runner' }, policy);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/install-surface/);
  });

  it('rejects it when the install root is reached through a symlink', () => {
    // The policy names the install as the service sees it; the mount check
    // judges the resolved path. Both spellings must match.
    const link = path.join(tmpDir, 'install-link');
    fs.symlinkSync(installRoot, link);
    const linked = { ...policy, surfaceRoots: [path.join(link, 'container', 'agent-runner', 'src')] };
    expect(validateMount({ hostPath: runnerSrc, containerPath: 'runner' }, linked).allowed).toBe(false);
  });

  it("rejects a group's stamped plugins tree", () => {
    // The driver pins `groups/<folder>/plugins` to install-surface through the
    // session's folder label, so the same silent refusal follows.
    const plugins = path.join(installRoot, 'groups', 'g1', 'plugins');
    fs.mkdirSync(plugins, { recursive: true });
    expect(validateMount({ hostPath: plugins, containerPath: 'plugins' }, policy).reason).toMatch(/install-surface/);
    expect(
      validateMount({ hostPath: path.join(installRoot, 'groups', 'g1'), containerPath: 'g1' }, policy).allowed,
    ).toBe(true);
  });

  it('rejects a stamped plugins tree named through a symlinked group folder', () => {
    const real = path.join(tmpDir, 'srv', 'g2');
    fs.mkdirSync(path.join(real, 'plugins'), { recursive: true });
    fs.mkdirSync(policy.groupsRoot, { recursive: true });
    fs.symlinkSync(real, path.join(policy.groupsRoot, 'g2'));
    const plugins = path.join(policy.groupsRoot, 'g2', 'plugins');
    expect(validateMount({ hostPath: plugins, containerPath: 'plugins' }, policy).allowed).toBe(false);
  });

  it('still allows a sibling of a protected path', () => {
    const sibling = path.join(installRoot, 'container', 'notes');
    fs.mkdirSync(sibling, { recursive: true });
    expect(validateMount({ hostPath: sibling, containerPath: 'notes' }, policy).allowed).toBe(true);
  });

  it('names the reason for a path that does not exist yet', () => {
    expect(protectedMountReason(path.join(installRoot, 'container', 'skills', 'new-skill'), policy)).toMatch(
      /install-surface/,
    );
    expect(protectedMountReason(path.join(tmpDir, 'elsewhere'), policy)).toBeNull();
    // ...also when it is reached through a symlinked install root.
    const alias = path.join(tmpDir, 'alias');
    fs.symlinkSync(installRoot, alias);
    expect(protectedMountReason(path.join(alias, 'container', 'skills', 'new-skill'), policy)).toMatch(
      /install-surface/,
    );
  });
});
