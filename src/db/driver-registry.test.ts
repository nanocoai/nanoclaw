import { beforeEach, describe, expect, it } from 'vitest';

import type { DbConfig, DbDriver } from './driver.js';
import { createDbDriver, registerDbDriver, resetDbDriverRegistryForTesting } from './driver-registry.js';

const config: DbConfig = {
  path: ':memory:',
};

const driver = { dialect: 'sqlite' } as DbDriver;

beforeEach(() => resetDbDriverRegistryForTesting());

describe('central DB driver registry', () => {
  it('fails closed when composition did not register a driver', async () => {
    await expect(createDbDriver(config, { role: 'runtime' })).rejects.toThrow('No central DB driver registered');
  });

  it('creates the registered driver and forwards role/config', async () => {
    let received: unknown;
    registerDbDriver((nextConfig, options) => {
      received = { nextConfig, options };
      return driver;
    });

    await expect(createDbDriver(config, { role: 'host' })).resolves.toBe(driver);
    expect(received).toEqual({ nextConfig: config, options: { role: 'host' } });
  });

  it('rejects duplicate registration', () => {
    registerDbDriver(() => driver);
    expect(() => registerDbDriver(() => driver)).toThrow('Central DB driver already registered');
  });

  it('rejects late registration after the first resolution attempt', async () => {
    await expect(createDbDriver(config, { role: 'runtime' })).rejects.toThrow('No central DB driver registered');
    expect(() => registerDbDriver(() => driver)).toThrow('Central DB driver registration is closed');
  });
});
