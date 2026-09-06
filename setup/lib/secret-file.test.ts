import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { childEnvWithoutSetupSecrets, withSecretFile } from './secret-file.js';

describe('withSecretFile', () => {
  it('provides a private file and removes it after the operation', async () => {
    const secret = 'machine-only-secret';
    let secretPath = '';

    await withSecretFile(secret, async (filePath) => {
      secretPath = filePath;
      expect(fs.readFileSync(filePath, 'utf8')).toBe(secret);
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    });

    expect(fs.existsSync(secretPath)).toBe(false);
    expect(fs.existsSync(path.dirname(secretPath))).toBe(false);
  });

  it('removes the file when the operation fails', async () => {
    let secretPath = '';

    await expect(
      withSecretFile('secret', async (filePath) => {
        secretPath = filePath;
        throw new Error('operation failed');
      }),
    ).rejects.toThrow('operation failed');

    expect(fs.existsSync(secretPath)).toBe(false);
    expect(fs.existsSync(path.dirname(secretPath))).toBe(false);
  });

  it('removes setup credentials from machine child environments', () => {
    expect(
      childEnvWithoutSetupSecrets({
        NANOCLAW_ANTHROPIC_AUTH_TOKEN: 'secret',
        NANOCLAW_REGISTRY_ENROLL_CODE: 'secret',
        NANOCLAW_REGISTRY_TOKEN: 'secret',
        ONECLI_API_KEY: 'secret',
        PATH: '/bin',
      }),
    ).toEqual({ PATH: '/bin' });
  });
});
