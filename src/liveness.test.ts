import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect } from 'vitest';

import { createHeartbeatFileLivenessSource } from './liveness.js';

describe('heartbeat-file liveness source', () => {
  it('reports the heartbeat mtime, and null when the file is absent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liveness-'));
    const hb = path.join(dir, '.heartbeat');
    const source = createHeartbeatFileLivenessSource(() => hb);
    const session = { id: 's-1', agent_group_id: 'g-1' };

    expect(await source.lastActivityMs(session)).toBeNull();

    fs.writeFileSync(hb, '');
    const stamp = new Date(Date.now() - 60_000);
    fs.utimesSync(hb, stamp, stamp);
    const observed = await source.lastActivityMs(session);
    expect(observed).not.toBeNull();
    expect(Math.abs((observed as number) - stamp.getTime())).toBeLessThan(1_000);
  });
});
