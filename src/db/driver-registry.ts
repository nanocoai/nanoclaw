import type { DbConfig, DbDriver, DbInitOptions } from './driver.js';

export type DbDriverFactory = (config: DbConfig, options: DbInitOptions) => DbDriver | Promise<DbDriver>;

let factory: DbDriverFactory | undefined;
let sealed = false;

export function registerDbDriver(next: DbDriverFactory): void {
  if (sealed) throw new Error('Central DB driver registration is closed');
  if (factory) throw new Error('Central DB driver already registered');
  factory = next;
}

export async function createDbDriver(config: DbConfig, options: DbInitOptions): Promise<DbDriver> {
  sealed = true;
  if (!factory) throw new Error('No central DB driver registered');
  return factory(config, options);
}

export function resetDbDriverRegistryForTesting(): void {
  factory = undefined;
  sealed = false;
}
