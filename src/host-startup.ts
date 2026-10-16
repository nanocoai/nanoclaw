/**
 * Generic seam: providers register startup work that runs after migrations.
 * Core does not name a product. Tests call `runHostStartups` directly.
 */
export const HOST_STARTUP_SEAM = 1;

export type HostStartup = () => void | Promise<void>;

const startups = new Map<string, HostStartup>();

export function registerHostStartup(name: string, fn: HostStartup): void {
  if (startups.has(name)) {
    throw new Error(`Host startup already registered: ${name}`);
  }
  startups.set(name, fn);
}

export async function runHostStartups(): Promise<void> {
  for (const fn of startups.values()) {
    await fn();
  }
}
