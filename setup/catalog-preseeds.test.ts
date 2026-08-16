import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, it } from 'vitest';

describe('--catalog-preseeds', () => {
  it('prints the UI preseed contract before setup can mutate the checkout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-preseeds-'));
    try {
      fs.mkdirSync(path.join(root, 'setup', 'lib'), { recursive: true });
      for (const file of [
        'nanoclaw.sh',
        'setup/catalog-preseeds.ts',
        'setup/lib/setup-config.ts',
        'setup/providers/index.ts',
        'setup/providers/registry.ts',
      ]) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.copyFileSync(path.join(process.cwd(), file), path.join(root, file));
      }
      fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(root, 'node_modules'));

      const result = spawnSync('bash', ['nanoclaw.sh', '--catalog-preseeds'], {
        cwd: root,
        encoding: 'utf8',
      });

      expect(result.status, result.stderr).toBe(0);
      const catalog = JSON.parse(result.stdout) as {
        preseeds: Array<{
          key: string;
          kind: string;
          default: unknown;
          options: Array<unknown>;
          validation: unknown;
        }>;
      };
      expect(catalog.preseeds.map((entry) => entry.key).sort()).toEqual(
        [
          'agentName',
          'agentProvider',
          'anthropicAuthToken',
          'anthropicBaseUrl',
          'displayName',
          'hardenedImage',
          'onecliApiHost',
          'onecliApiToken',
          'skip',
          'templatePath',
        ].sort(),
      );
      expect(catalog.preseeds.every((entry) => entry.kind && Array.isArray(entry.options))).toBe(true);
      expect(
        catalog.preseeds
          .find((entry) => entry.key === 'agentProvider')
          ?.options.map((option) => (option as { value: string }).value),
      ).toEqual(['claude', 'codex']);
      expect(catalog.preseeds.find((entry) => entry.key === 'hardenedImage')?.options).toEqual([true, false]);
      expect(catalog.preseeds.find((entry) => entry.key === 'onecliApiHost')?.default).toBeNull();
      expect(catalog.preseeds.find((entry) => entry.key === 'onecliApiHost')?.validation).toEqual({
        kind: 'httpUrl',
        message: 'Must be http(s)://…',
      });
      expect(fs.existsSync(path.join(root, 'logs'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
