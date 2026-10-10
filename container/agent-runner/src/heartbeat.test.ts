import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { heartbeatPath, touchHeartbeat } from './heartbeat.js';

afterEach(() => {
  delete process.env.NANOCLAW_HEARTBEAT_PATH;
});

describe('heartbeat path', () => {
  it('defaults to the workspace heartbeat', () => {
    expect(heartbeatPath()).toBe('/workspace/.heartbeat');
  });

  it('honors NANOCLAW_HEARTBEAT_PATH and touches that file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-'));
    const override = path.join(dir, '.heartbeat');
    process.env.NANOCLAW_HEARTBEAT_PATH = override;

    expect(heartbeatPath()).toBe(override);
    touchHeartbeat();
    expect(fs.existsSync(override)).toBe(true);

    // Second touch goes down the utimes path (file exists) and lands within
    // clock tolerance — utimes stores whole ms while write stamps fractional.
    const before = fs.statSync(override).mtimeMs;
    touchHeartbeat();
    expect(fs.statSync(override).mtimeMs).toBeGreaterThanOrEqual(before - 5);
  });
});
