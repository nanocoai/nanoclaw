import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { heartbeatPath, touchHeartbeat } from './heartbeat-lease.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-runner-heartbeat-'));
  dirs.push(dir);
  return dir;
}

describe('the heartbeat lease file', () => {
  test("the path is the chat runner's default, or NANOCLAW_HEARTBEAT_PATH when set", () => {
    expect(heartbeatPath({})).toBe('/workspace/.heartbeat');
    expect(heartbeatPath({ NANOCLAW_HEARTBEAT_PATH: '' })).toBe('/workspace/.heartbeat');
    expect(heartbeatPath({ NANOCLAW_HEARTBEAT_PATH: '  ' })).toBe('/workspace/.heartbeat');
    expect(heartbeatPath({ NANOCLAW_HEARTBEAT_PATH: '/run/nanoclaw/heartbeat/.heartbeat' })).toBe(
      '/run/nanoclaw/heartbeat/.heartbeat',
    );
  });

  test('absent: created; present: its mtime refreshed to now', () => {
    const file = path.join(scratch(), '.heartbeat');
    expect(touchHeartbeat(file, new Date(1_700_000_000_000))).toBe(true);
    expect(fs.statSync(file).isFile()).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(1_700_000_000_000);
    expect(touchHeartbeat(file, new Date(1_700_000_005_000))).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(1_700_000_005_000);
  });

  test('a directory where the file should be — what a guest makes of an unwritten subPath — is reported, never thrown', () => {
    const dir = path.join(scratch(), '.heartbeat');
    fs.mkdirSync(dir);
    expect(touchHeartbeat(dir)).toBe(false);
    const target = path.join(scratch(), 'missing-parent', '.heartbeat');
    expect(() => touchHeartbeat(target)).not.toThrow();
    expect(touchHeartbeat(target)).toBe(false);
    // And a directory that cannot be a file for the write arm:
    fs.chmodSync(dir, 0o555);
    const inside = path.join(dir, 'nested', '.heartbeat');
    expect(touchHeartbeat(inside)).toBe(false);
  });
});
