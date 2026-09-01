/**
 * Dev-env driver registry.
 *
 * Its own module, not part of the barrel, for the same reason the session
 * driver registry is: the file an overlay appends an import to must not be the
 * file that owns the map, or the overlay's module-scope registration runs while
 * the map is still in its temporal dead zone.
 */
import type { StampSource } from './stamp-registry.js';
import type { DevEnvDriver } from './types.js';

/** Not a union — this tree must not enumerate kinds it cannot execute. */
export type DevEnvDriverKind = string;

export interface DevEnvDriverConfig {
  /** Scopes runtime labels and discovery to this install. */
  installScope: string;
  /**
   * The stamps registry's sync window (C12), when the host runs one. A driver
   * that consumes stamps merges it with its static table; a driver with no
   * stamp concept ignores it — which is why it rides the factory config
   * rather than the seam.
   */
  stampSource?: StampSource;
}

export type DevEnvDriverFactory = (config: DevEnvDriverConfig) => DevEnvDriver;

const registry = new Map<DevEnvDriverKind, DevEnvDriverFactory>();

/** A duplicate registration is a wiring bug and throws rather than letting the last import silently win. */
export function registerDevEnvDriver(kind: DevEnvDriverKind, factory: DevEnvDriverFactory): void {
  if (registry.has(kind)) {
    throw new Error(`Dev-env driver already registered: ${kind}`);
  }
  registry.set(kind, factory);
}

export function getDevEnvDriverFactory(kind: DevEnvDriverKind): DevEnvDriverFactory | undefined {
  return registry.get(kind);
}

/** The kinds this build can actually run — what the failure message reports. */
export function listDevEnvDriverKinds(): DevEnvDriverKind[] {
  return [...registry.keys()];
}
