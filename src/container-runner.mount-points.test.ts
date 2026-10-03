/**
 * ensureSessionMountPoints: nested bind-mount targets inside the session
 * workspace are created by the host (not by the Docker daemon as root), so
 * `ncl tasks delete` can rmSync the whole session directory.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureSessionMountPoints } from './container-runner.js';
import type { VolumeMount } from './providers/provider-container-registry.js';

let tmp: string;
let sessDir: string;
let groupDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-points-'));
  sessDir = path.join(tmp, 'sess');
  groupDir = path.join(tmp, 'group');
  fs.mkdirSync(sessDir);
  fs.mkdirSync(groupDir);
  fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), '# doc');
  fs.writeFileSync(path.join(tmp, 'config.json'), '{}');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mount(hostPath: string, containerPath: string): VolumeMount {
  return { hostPath, containerPath, readonly: false };
}

describe('ensureSessionMountPoints', () => {
  it('creates directory and file targets that sit directly under /workspace', () => {
    ensureSessionMountPoints(
      [
        mount(sessDir, '/workspace'),
        mount(groupDir, '/workspace/agent'),
        mount(path.join(tmp, 'missing-global'), '/workspace/global'),
        mount(groupDir, '/workspace/extra/wordpress-creds'),
        mount(path.join(tmp, 'config.json'), '/workspace/settings.json'),
      ],
      sessDir,
    );
    expect(fs.statSync(path.join(sessDir, 'agent')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(sessDir, 'global')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(sessDir, 'extra', 'wordpress-creds')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(sessDir, 'settings.json')).isFile()).toBe(true);
  });

  it('skips targets nested under another mount and targets outside /workspace', () => {
    ensureSessionMountPoints(
      [
        mount(sessDir, '/workspace'),
        mount(groupDir, '/workspace/agent'),
        mount(path.join(groupDir, 'CLAUDE.md'), '/workspace/agent/CLAUDE.md'),
        mount(groupDir, '/app/src'),
      ],
      sessDir,
    );
    expect(fs.readdirSync(sessDir)).toEqual(['agent']);
    expect(fs.readdirSync(path.join(sessDir, 'agent'))).toEqual([]);
    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf8')).toBe('# doc');
  });

  it('leaves an existing target untouched', () => {
    fs.mkdirSync(path.join(sessDir, 'agent'));
    fs.writeFileSync(path.join(sessDir, 'agent', 'keep'), 'x');
    ensureSessionMountPoints([mount(sessDir, '/workspace'), mount(groupDir, '/workspace/agent')], sessDir);
    expect(fs.readFileSync(path.join(sessDir, 'agent', 'keep'), 'utf8')).toBe('x');
  });

  it('never writes outside the session directory', () => {
    ensureSessionMountPoints([mount(sessDir, '/workspace'), mount(groupDir, '/workspace/../escape')], sessDir);
    expect(fs.existsSync(path.join(tmp, 'escape'))).toBe(false);
  });
});
