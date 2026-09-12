import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const helper = resolve('.claude/skills/add-mattermost/scripts/preflight-local.mjs');

describe('Mattermost evaluation platform preflight', () => {
  it.each([
    ['linux', 'x86_64', 0],
    ['linux', 'amd64', 0],
    ['linux', 'aarch64', 1],
    ['linux', 'arm64', 1],
    ['windows', 'amd64', 1],
  ])('checks the Docker daemon platform %s/%s before any mutations', (os, arch, status) => {
    const root = mkdtempSync(join(tmpdir(), 'nc-mm-platform-'));
    try {
      writeFileSync(
        join(root, 'docker'),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MM_CALLS"\nif [ "$1" = info ]; then printf "%s\\n" "$MM_INFO"; fi\n',
      );
      chmodSync(join(root, 'docker'), 0o755);
      const result = spawnSync(process.execPath, [helper], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: root,
          MM_CALLS: join(root, 'calls'),
          MM_INFO: JSON.stringify({ Architecture: arch, OSType: os }),
        },
      });
      expect(result.status).toBe(status);
      const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n');
      expect(calls).toEqual(
        status === 0 ? ['info --format {{json .}}', 'compose version'] : ['info --format {{json .}}'],
      );
      expect(readdirSync(root).sort()).toEqual(['calls', 'docker']);
      if (status) expect(result.stderr).toContain('select an existing Mattermost server');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
