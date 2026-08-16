import { afterEach, describe, expect, it } from 'vitest';

import { runAdvancedScreen } from './setup-config-screen.js';
import type { SetupDriver } from './setup-driver.js';

describe('machine advanced configuration', () => {
  const envKey = 'NANOCLAW_ONECLI_API_TOKEN';
  let previousToken: string | undefined;

  afterEach(() => {
    if (previousToken === undefined) delete process.env[envKey];
    else process.env[envKey] = previousToken;
    previousToken = undefined;
  });

  it('rejects secret entries before an answer can reach process.env', async () => {
    previousToken = process.env[envKey];
    delete process.env[envKey];
    const driver = {
      mode: 'ndjson' as const,
      prompt: async () => 'onecliApiToken',
      error(code: string): never {
        throw new Error(code);
      },
    } as unknown as SetupDriver;

    await expect(runAdvancedScreen({}, driver)).rejects.toThrow('secret_transport_forbidden');
    expect(process.env[envKey]).toBeUndefined();
  });
});
