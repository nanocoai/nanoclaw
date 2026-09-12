/**
 * The platform registry — the one thing a chat platform tells this module.
 *
 * The provider here talks to the service; it knows no platform API. What
 * it cannot know on its own is how the platform's adapter spells a
 * conversation as a messaging_groups row (so the binding writes the row
 * the adapter's inbound path resolves) and, optionally, which bot user
 * this host is on the platform (so a member update names the right
 * member). A platform's module registers that half with
 * `registerSurfacePlatform(kind, half)`; the module then offers a session
 * surface for that platform on every host with a managed install for it.
 */
import { log } from '../../../log.js';
import type { SurfaceSpelling } from '../../../code-mode/surface/types.js';
import type { ManagedInstall } from './install.js';

export interface BotIdentity {
  botUserId: string;
  teamId?: string;
}

export interface SurfacePlatform {
  /** The adapter's channel type; defaults to the platform kind. */
  channelType?: string;
  /** The adapter instance the surface rows belong to; defaults to the channel type. */
  instance?: string;
  /** How the adapter spells a conversation id as a messaging_groups platform id. */
  spell(conversationId: string): SurfaceSpelling;
  /**
   * Where the managed install for this platform is recorded, when it is
   * not one the portal keeps (install.ts `managedInstall(kind)` is the
   * default). Null: no managed app, so no surface.
   */
  install?(): Promise<ManagedInstall | null>;
  /**
   * This host's own bot on the platform, when the platform half can name
   * it; null (or absent) lets the service name it from its own record.
   * Consulted at open and at a member update, never a gate.
   */
  botIdentity?(install: ManagedInstall): Promise<BotIdentity | null>;
}

const platforms = new Map<string, SurfacePlatform>();
const listeners = new Set<(kind: string, platform: SurfacePlatform) => void>();

/** Undo the registration. */
export type Unregister = () => void;

export function registerSurfacePlatform(kind: string, platform: SurfacePlatform): Unregister {
  if (platforms.has(kind)) {
    log.error('Surface platform refused: already registered', { platform: kind });
    return () => {};
  }
  platforms.set(kind, platform);
  for (const listener of [...listeners]) listener(kind, platform);
  return () => {
    if (platforms.get(kind) === platform) platforms.delete(kind);
  };
}

export function getSurfacePlatform(kind: string): SurfacePlatform | undefined {
  return platforms.get(kind);
}

export function listSurfacePlatforms(): Array<{ kind: string; platform: SurfacePlatform }> {
  return [...platforms.entries()].map(([kind, platform]) => ({ kind, platform }));
}

/** Hear of platforms registered after this module started. */
export function onSurfacePlatformRegistered(listener: (kind: string, platform: SurfacePlatform) => void): Unregister {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Test seam. */
export function resetSurfacePlatformsForTesting(): void {
  platforms.clear();
  listeners.clear();
}
