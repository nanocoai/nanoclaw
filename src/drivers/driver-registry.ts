/**
 * Session driver registry.
 *
 * Its own module, not part of `index.ts`, for the same reason
 * `provider-container-registry.ts` is separate from the provider barrel: the
 * file an overlay appends an import to must not be the file that owns the map.
 * An appended `import './x.js';` is evaluated BEFORE the importing module's
 * body, so a driver registering from inside `index.ts`'s own import graph would
 * touch the map while it is still in its temporal dead zone — a
 * `ReferenceError` at startup, on the one path nobody exercises until an
 * overlay is installed.
 */
import type { MountPolicy, SessionDriver } from './types.js';

/**
 * Not a union. This tree ships one driver and must not enumerate kinds it
 * cannot execute — a union here would list `vm` as a legitimate value on a
 * host where selecting it can only throw, and would make every overlay's kind a
 * change to this file.
 */
export type DriverKind = string;

/** Built from the fully-resolved mount policy; the driver owns everything else. */
export type SessionDriverFactory = (policy: MountPolicy) => SessionDriver;

const registry = new Map<DriverKind, SessionDriverFactory>();

/**
 * Install a driver under a kind. Overlays call this at module scope from a file
 * reached via `installed.ts`; a duplicate registration is a wiring bug (the
 * import got added twice, or two overlays claim one kind) and throws rather
 * than letting the last import silently win.
 */
export function registerSessionDriver(kind: DriverKind, factory: SessionDriverFactory): void {
  if (registry.has(kind)) {
    throw new Error(`Session driver already registered: ${kind}`);
  }
  registry.set(kind, factory);
}

export function getSessionDriverFactory(kind: DriverKind): SessionDriverFactory | undefined {
  return registry.get(kind);
}

/** The kinds this build can actually run — what the failure message reports. */
export function listSessionDriverKinds(): DriverKind[] {
  return [...registry.keys()];
}
