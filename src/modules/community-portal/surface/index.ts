/**
 * A chat surface for each coding session, over the service — module wiring.
 *
 * For every chat platform that registered its half (platforms.ts) and for
 * which this host holds a managed install and a sign-in (install.ts), the
 * module registers a SessionSurfaceProvider (provider.ts) with code mode's
 * session-surface registry under the platform's channel type. From there
 * core does the rest: `sandboxes new` opens a surface through the provider,
 * binds the sandbox to it, mirrors status and the diff view, honours a
 * Stop. Activation is the service's answer: a host whose service says
 * "unavailable" (or has no channel to give) keeps a plain sandbox — no
 * flag, no setting.
 *
 * Two things ride the door here: a sandbox's terminal address is announced
 * on its surface when the surface is bound and again for every open
 * surface when remote access is enabled or renamed (terminal-address.ts),
 * so a `/terminal` on the surface answers with the address without a host
 * round trip. `ncl sandboxes surface status | archive | enable | disable`
 * are the operator verbs (verbs.ts); enable/disable is the host's one
 * setting, whether a new sandbox gets a surface opened at all (setting.ts).
 */
import { readInstallIdentity } from '../../../community-portal/install-identity.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
import {
  onRemoteAccessChanged,
  onSandboxBound,
  SANDBOX_HOOKS_SEAM,
  type BoundSurface,
  type SandboxGroup,
} from '../../../code-mode/hooks.js';
import { listOpenSessionSurfaces, type SessionSurfaceRow } from '../../../code-mode/surface/db.js';
import { registerSessionSurface, SESSION_SURFACE_SEAM } from '../../../code-mode/surface/registry.js';
import type { SessionSurfaceProvider } from '../../../code-mode/surface/types.js';
import { onHostShutdown, onHostStart } from '../../../host-lifecycle.js';
import { log } from '../../../log.js';
import { doorStatus, type DoorSummary } from '../door/index.js';
import { sandboxTerminalAddress } from '../remote/sandboxes.js';
import { SurfaceServiceClient } from './client.js';
import { managedInstallCredentials, type ManagedInstallCredentials, type ManagedInstallOptions } from './install.js';
import {
  listSurfacePlatforms,
  onSurfacePlatformRegistered,
  type BotIdentity,
  type SurfacePlatform,
} from './platforms.js';
import { createServiceSurfaceProvider } from './provider.js';
import { surfaceAutoOpen } from './setting.js';
import {
  announceTerminalAddress,
  announceTerminalAddresses,
  type AnnounceSweepOutcome,
  type TerminalAddressFields,
} from './terminal-address.js';

export { registerSurfacePlatform, type BotIdentity, type SurfacePlatform } from './platforms.js';
export { managedInstall, type ManagedInstall } from './install.js';
export { readSurfaceSetting, setSurfaceAutoOpen, surfaceAutoOpen, type SurfaceSetting } from './setting.js';

/** The hook names this module registers, for contract tests. */
export const SURFACE_ADDRESS_HOOK = 'surface-address';

/** What the address helper needs to know about the door. */
export type DoorAddressState = Pick<DoorSummary, 'enabled' | 'name' | 'host'>;

interface Active {
  kind: string;
  channelType: string;
  platform: SurfacePlatform;
  provider: SessionSurfaceProvider;
  unregister: () => void;
}

/** Seams the module goes through; tests swap them. */
export interface SurfaceModuleDeps extends ManagedInstallOptions {
  credentials(kind: string, platform: SurfacePlatform): Promise<ManagedInstallCredentials | null>;
  doorState(): Promise<DoorAddressState>;
}

const defaultDeps: SurfaceModuleDeps = {
  async credentials(kind, platform) {
    const where = { ...(deps.root ? { root: deps.root } : {}), ...(deps.homeDir ? { homeDir: deps.homeDir } : {}) };
    if (!platform.install) return managedInstallCredentials(kind, where);
    // The platform keeps its own install record; the bearer is still the sign-in's.
    const install = await platform.install();
    if (!install) return null;
    const identity = await readInstallIdentity(where.homeDir ? { homeDir: where.homeDir } : {});
    return identity ? { ...install, token: identity.token } : null;
  },
  doorState: () => doorStatus(),
};

let deps: SurfaceModuleDeps = defaultDeps;
const active = new Map<string, Active>();
const clients = new Map<string, SurfaceServiceClient>();
let started = false;
let unsubscribe: (() => void) | undefined;

export function setSurfaceModuleDeps(overrides: Partial<SurfaceModuleDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

/** One bearer client per service origin. */
function clientFor(credentials: ManagedInstallCredentials): SurfaceServiceClient {
  let client = clients.get(credentials.serviceBase);
  if (!client) {
    client = new SurfaceServiceClient({ serviceBase: credentials.serviceBase, token: credentials.token });
    clients.set(credentials.serviceBase, client);
  }
  return client;
}

/** The member fields for a sandbox on this host, or undefined when it has no address. */
function terminalAddressFields(sandbox: string, door: DoorAddressState): TerminalAddressFields | undefined {
  const found = sandboxTerminalAddress(sandbox, door);
  return found ? { sandboxName: found.sandbox, terminalAddress: found.address } : undefined;
}

/**
 * Offer a session surface for `kind` when this host can: a managed install
 * and a sign-in. Registered once; a platform without an install stays out
 * and its sandboxes are plain.
 */
export async function activateSurface(kind: string, platform: SurfacePlatform): Promise<boolean> {
  if (active.has(kind)) return true;
  const channelType = platform.channelType ?? kind;
  let credentials: ManagedInstallCredentials | null;
  try {
    credentials = await deps.credentials(kind, platform);
  } catch (err) {
    log.warn('Session surface: managed install unreadable — no surface for this platform', { kind, err });
    return false;
  }
  if (!credentials) {
    log.info('Session surface: no managed install or sign-in for this platform — sandboxes stay plain', { kind });
    return false;
  }
  const provider = createServiceSurfaceProvider({
    kind,
    platform,
    credentials: () => deps.credentials(kind, platform),
    clientFor,
    terminalAddress: async (sandbox) => terminalAddressFields(sandbox, await deps.doorState()),
    autoOpen: surfaceAutoOpen,
  });
  const unregister = registerSessionSurface(channelType, provider, { seam: SESSION_SURFACE_SEAM });
  active.set(kind, { kind, channelType, platform, provider, unregister });
  return true;
}

/** Activate every registered platform, and any registered from now on. */
export async function activateSurfaces(): Promise<string[]> {
  started = true;
  unsubscribe ??= onSurfacePlatformRegistered((kind, platform) => {
    if (started) void activateSurface(kind, platform);
  });
  const activated: string[] = [];
  for (const { kind, platform } of listSurfacePlatforms()) {
    if (await activateSurface(kind, platform)) activated.push(kind);
  }
  return activated;
}

export function deactivateSurfaces(): void {
  started = false;
  unsubscribe?.();
  unsubscribe = undefined;
  for (const entry of active.values()) entry.unregister();
  active.clear();
  clients.clear();
}

/** The platforms this module serves a surface for right now. */
export function activeSurfacePlatforms(): string[] {
  return [...active.keys()];
}

function activeFor(row: Pick<SessionSurfaceRow, 'provider'>): Active | undefined {
  for (const entry of active.values()) if (entry.channelType === row.provider) return entry;
  return undefined;
}

/** A client for a row's platform, when this module serves it and the host holds a bearer. */
export async function clientForRow(
  row: Pick<SessionSurfaceRow, 'provider'>,
): Promise<{ client: SurfaceServiceClient; entry: Active; credentials: ManagedInstallCredentials } | null> {
  const entry = activeFor(row);
  if (!entry) return null;
  const credentials = await deps.credentials(entry.kind, entry.platform).catch(() => null);
  return credentials ? { client: clientFor(credentials), entry, credentials } : null;
}

async function botUserIdFor(entry: Active, credentials: ManagedInstallCredentials): Promise<string | undefined> {
  if (!entry.platform.botIdentity) return undefined;
  const identity: BotIdentity | null = await entry.platform.botIdentity(credentials).catch(() => null);
  return identity?.botUserId;
}

/**
 * Every open binding this module serves reports its sandbox's terminal
 * address — run after `remote enable`, so surfaces opened before remote
 * access was on learn where a terminal reaches them. Best effort
 * throughout; never throws.
 */
export async function announceAddresses(): Promise<AnnounceSweepOutcome> {
  const none: AnnounceSweepOutcome = { announced: 0, skipped: 0, failed: 0 };
  try {
    const door = await deps.doorState();
    if (!door.enabled || !door.host) return none;
    const resolved = new Map<string, Awaited<ReturnType<typeof clientForRow>>>();
    const lookup = async (row: SessionSurfaceRow) => {
      if (!resolved.has(row.provider)) resolved.set(row.provider, await clientForRow(row));
      return resolved.get(row.provider) ?? null;
    };
    const rows = await listOpenSessionSurfaces();
    for (const row of rows) await lookup(row);
    const outcome = await announceTerminalAddresses({
      listBindings: async () => rows,
      sandboxNameOf: async (agentGroupId) => (await getAgentGroup(agentGroupId))?.folder,
      fieldsOf: (sandbox) => terminalAddressFields(sandbox, door),
      clientFor: (row) => resolved.get(row.provider)?.client ?? null,
      botUserIdFor: async (row) => {
        const found = resolved.get(row.provider);
        return found ? botUserIdFor(found.entry, found.credentials) : undefined;
      },
    });
    if (outcome.announced || outcome.failed) log.info('Session surfaces told their terminal addresses', { ...outcome });
    return outcome;
  } catch (err) {
    log.warn('Session surfaces: terminal addresses not announced', { err });
    return none;
  }
}

/** A freshly bound surface learns its sandbox's address, when the host has one. */
async function announceOnBound(group: SandboxGroup, surface: BoundSurface): Promise<void> {
  const found = await clientForRow({ provider: surface.channelType });
  if (!found) return;
  const fields = terminalAddressFields(group.folder, await deps.doorState());
  if (!fields) return;
  await announceTerminalAddress({
    client: found.client,
    row: { agent_group_id: group.id, surface_id: surface.surfaceId },
    fields,
    botUserId: await botUserIdFor(found.entry, found.credentials),
  });
}

onSandboxBound(SURFACE_ADDRESS_HOOK, announceOnBound, { seam: SANDBOX_HOOKS_SEAM });

// The sweep runs in the background: `remote enable` must not wait on it.
onRemoteAccessChanged(
  SURFACE_ADDRESS_HOOK,
  async (state) => {
    if (state.enabled && state.host) void announceAddresses();
  },
  { seam: SANDBOX_HOOKS_SEAM },
);

onHostStart(async () => {
  await activateSurfaces();
});

onHostShutdown(() => {
  deactivateSurfaces();
});

// The operator verbs extend `ncl sandboxes`.
import './verbs.js';
