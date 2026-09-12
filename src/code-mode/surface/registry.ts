/**
 * The session-surface registry: which chat platforms can be a surface for a
 * coding session on this host.
 *
 * A module registers one provider per channel type with `{ seam }`
 * (SESSION_SURFACE_SEAM); a mismatch is refused and logged (src/seams.ts),
 * a duplicate is refused and logged. With nothing registered a sandbox is
 * plain: `open` is never called and `ncl sandboxes status | diff | stop` are
 * the surface. A binding whose provider is not registered (the module has
 * not activated yet, or left) waits: nothing is sent and nothing is
 * persisted for it until a provider for its platform registers, which the
 * runtime learns through `onSessionSurfaceChange`.
 */
import { log } from '../../log.js';
import { seamAccepted } from '../../seams.js';
import type { SessionSurfaceProvider } from './types.js';

/** Bump only on a breaking change to SessionSurfaceProvider. */
export const SESSION_SURFACE_SEAM = 1;

const providers = new Map<string, SessionSurfaceProvider>();

/** Undo the registration. */
export type Unregister = () => void;

/** Fires after a platform's provider registers (`provider` set) or unregisters (null). */
export type SessionSurfaceChangeListener = (channelType: string, provider: SessionSurfaceProvider | null) => void;

const listeners = new Set<SessionSurfaceChangeListener>();

/** Subscribe to registrations; the runtime rebinds the rows of a platform whose provider just changed. */
export function onSessionSurfaceChange(listener: SessionSurfaceChangeListener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function notify(channelType: string, provider: SessionSurfaceProvider | null): void {
  for (const listener of [...listeners]) {
    try {
      listener(channelType, provider);
    } catch (err) {
      log.error('Session surface change listener failed', { channelType, err });
    }
  }
}

export function registerSessionSurface(
  channelType: string,
  provider: SessionSurfaceProvider,
  registration: { seam: number },
): Unregister {
  if (!seamAccepted('session-surface', channelType, SESSION_SURFACE_SEAM, registration.seam)) return () => {};
  if (providers.has(channelType)) {
    log.error('Session surface refused: a provider for this platform is already registered', { channelType });
    return () => {};
  }
  providers.set(channelType, provider);
  log.info('Session surface registered', { channelType });
  notify(channelType, provider);
  return () => {
    if (providers.get(channelType) !== provider) return;
    providers.delete(channelType);
    notify(channelType, null);
  };
}

export function getSessionSurface(channelType: string): SessionSurfaceProvider | undefined {
  return providers.get(channelType);
}

export function listSessionSurfaces(): Array<{ channelType: string; provider: SessionSurfaceProvider }> {
  return [...providers.entries()].map(([channelType, provider]) => ({ channelType, provider }));
}

/**
 * A provider that opens nothing, accepts every send silently and reports no
 * events — a base for tests and partial implementations. The runtime treats
 * a binding resolved to this object as one with NO provider: nothing is
 * mirrored or persisted through it.
 */
export const noopSessionSurface: SessionSurfaceProvider = {
  spell: async (surfaceId) => ({ platformId: surfaceId, instance: '' }),
  open: async () => null,
  status: async () => {},
  view: async () => {},
  events: async (_handle, cursor, waitSec, signal) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitSec * 1000);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    return { events: [], cursor };
  },
  close: async () => {},
};

/** Test seam. */
export function resetSessionSurfacesForTesting(): void {
  providers.clear();
}
