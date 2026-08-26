import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { run } from './timezone.js';

const originalCwd = process.cwd();
const originalTz = process.env.TZ;

afterEach(() => {
  process.chdir(originalCwd);
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('timezone preseed', () => {
  it('persists --tz ahead of the host timezone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tz-'));
    try {
      process.chdir(root);
      process.env.TZ = 'UTC';

      await run(['--tz', 'Asia/Jerusalem']);

      expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('TZ=Asia/Jerusalem\n');
      const autoSource = fs.readFileSync(path.join(originalCwd, 'setup', 'auto.ts'), 'utf8');
      expect(autoSource).toContain("preseedTz ? ['--tz', preseedTz] : []");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an invalid environment preseed before setup starts', () => {
    const result = spawnSync(
      path.join(originalCwd, 'node_modules', '.bin', 'tsx'),
      [path.join(originalCwd, 'setup', 'auto.ts')],
      {
        cwd: originalCwd,
        encoding: 'utf8',
        env: { ...process.env, NANOCLAW_TZ: 'local' },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NANOCLAW_TZ must be an IANA timezone such as Europe/Lisbon');
  });
});
