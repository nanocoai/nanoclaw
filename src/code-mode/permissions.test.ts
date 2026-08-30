/**
 * Code mode, piece D: the host-owned permission posture (D17/T7) — mode
 * precedence, both composed policies pinned byte-for-byte in the direction
 * that matters (bypass must carry NO boundary rules; auto must carry ALL of
 * them plus the bypass-flag lock), and the stamp's failure mode.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  BOUNDARY_ASK_RULES,
  BOUNDARY_DECISIONS_SUBDIR,
  MANAGED_SETTINGS_CONTAINER_PATH,
  MANAGED_SETTINGS_FILE,
  boundaryDecisionMounts,
  composeManagedSettings,
  managedSettingsMounts,
  resolveCodePermissionMode,
} from './permissions.js';

describe('resolveCodePermissionMode', () => {
  it('group override wins in both directions', () => {
    expect(resolveCodePermissionMode('auto', 'bypass')).toBe('auto');
    expect(resolveCodePermissionMode('bypass', undefined)).toBe('bypass');
  });

  it('an unset or hand-mangled group value follows the deployment', () => {
    expect(resolveCodePermissionMode(null, 'bypass')).toBe('bypass');
    expect(resolveCodePermissionMode(undefined, 'bypass')).toBe('bypass');
    expect(resolveCodePermissionMode('BYPASS', 'bypass')).toBe('bypass'); // not a silent group override
    expect(resolveCodePermissionMode('yes', undefined)).toBe('auto');
  });

  it('everything unset reads as the safe end', () => {
    expect(resolveCodePermissionMode(null, undefined)).toBe('auto');
    expect(resolveCodePermissionMode(null, 'never-heard-of-it')).toBe('auto');
  });
});

describe('composeManagedSettings', () => {
  it('bypass is the full escape hatch: no ask rules, no bypass lock', () => {
    // D17 decided: a bypass group's gateway is the approver — resurrecting
    // any local ask would put the one prompt back where no one answers it.
    expect(composeManagedSettings('bypass')).toEqual({
      permissions: { defaultMode: 'bypassPermissions' },
    });
  });

  it('auto pins the boundary: every ask rule present, bypass flag disabled', () => {
    const settings = composeManagedSettings('auto') as {
      permissions: { defaultMode: string; disableBypassPermissionsMode: string; allow: string[]; ask: string[] };
    };
    expect(settings.permissions.defaultMode).toBe('default');
    // The agent must not be able to lift its own posture with a nested
    // `claude --dangerously-skip-permissions`.
    expect(settings.permissions.disableBypassPermissionsMode).toBe('disable');
    expect(settings.permissions.ask).toEqual([...BOUNDARY_ASK_RULES]);
    // The permissive inside — and every boundary path is absolute (`//`),
    // never resolved relative to the settings file's directory.
    expect(settings.permissions.allow).toContain('Bash');
    for (const rule of settings.permissions.ask) {
      if (!rule.startsWith('Bash(')) expect(rule).toMatch(/^(Edit|Write)\(\/\//);
    }
  });

  it('the boundaries cover release and all three custody paths', () => {
    const ask = BOUNDARY_ASK_RULES.join('\n');
    expect(ask).toContain('ncl envs release');
    expect(ask).toContain(`//workspace/${MANAGED_SETTINGS_FILE}`); // the policy's own stamp
    expect(ask).toContain('//home/node/.claude/settings.json'); // the hooks' home
    expect(ask).toContain('//workspace/group/CLAUDE.md'); // the operating manual
  });
});

describe('managedSettingsMounts', () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stamps the composed policy and mounts it RO at the admin tier AND over its own workspace spelling', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-perms-'));
    const mounts = managedSettingsMounts(dir, 'ag-1', 'auto');
    // Two mounts, one inode: the /etc tier the CLI reads, and the RO cover
    // over the /workspace path an in-place Bash redirect used to write the
    // policy through (E-t7 review).
    expect(mounts).toHaveLength(2);
    const [admin, cover] = mounts;
    expect(admin.hostPath).toBe(path.join(dir, MANAGED_SETTINGS_FILE));
    expect(admin.containerPath).toBe(MANAGED_SETTINGS_CONTAINER_PATH);
    expect(cover.hostPath).toBe(admin.hostPath);
    expect(cover.containerPath).toBe(`/workspace/${MANAGED_SETTINGS_FILE}`);
    for (const mount of mounts) {
      expect(mount.readonly).toBe(true);
      expect(mount.mountClass).toBe('group-state');
      expect(mount.scope).toBe('ag-1');
    }
    expect(JSON.parse(fs.readFileSync(admin.hostPath, 'utf8'))).toEqual(composeManagedSettings('auto'));
  });

  it('restamps on every call — a flipped mode never serves the old policy', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-perms-'));
    managedSettingsMounts(dir, 'ag-1', 'auto');
    const [mount] = managedSettingsMounts(dir, 'ag-1', 'bypass');
    expect(JSON.parse(fs.readFileSync(mount.hostPath, 'utf8'))).toEqual(composeManagedSettings('bypass'));
  });

  it('an unwritable session dir costs the file, never the session', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-perms-'));
    fs.chmodSync(dir, 0o500);
    try {
      expect(managedSettingsMounts(dir, 'ag-1', 'auto')).toEqual([]);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});

describe('boundaryDecisionMounts', () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prepares the host-side decisions dir and mounts it RO in the workspace', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-perms-'));
    const mounts = boundaryDecisionMounts(dir, 'ag-1');
    expect(mounts).toHaveLength(1);
    const mount = mounts[0];
    expect(mount.hostPath).toBe(path.join(dir, BOUNDARY_DECISIONS_SUBDIR));
    expect(mount.containerPath).toBe(`/workspace/${BOUNDARY_DECISIONS_SUBDIR}`);
    // RO is the whole point: a decision the agent can write is a boundary
    // the agent can approve (E-t7 review).
    expect(mount.readonly).toBe(true);
    expect(mount.mountClass).toBe('group-state');
    expect(fs.statSync(mount.hostPath).isDirectory()).toBe(true);
  });

  it('a dir it cannot prepare costs the mount — the hook then denies, never polls open', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-perms-'));
    fs.chmodSync(dir, 0o500);
    try {
      expect(boundaryDecisionMounts(dir, 'ag-1')).toEqual([]);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});
