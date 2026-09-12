/**
 * A SessionSurfaceProvider over the service: the platform-agnostic half of
 * "a chat surface for a coding session" as a remote implementation.
 *
 * Core (code-mode/surface) decides WHEN — open at sandbox creation, status
 * on every mapper tick, the diff view after a turn, the long-poll, the
 * interrupt on a Stop, the archive — and hands this provider its own ids.
 * The provider turns each call into one service route (client.ts) and
 * maps the service's answers onto the contract's failure vocabulary:
 * "unavailable" (no surface for this host: `open` answers null, anything
 * else throws SurfaceError 'unavailable'), "gone" (archived or unknown) and
 * "stopped" (the user pressed Stop). Everything platform-shaped — how a
 * conversation id is spelled for the adapter, which bot this host is — is
 * the registered platform half's (platforms.ts).
 */
import type { SandboxGroup } from '../../../code-mode/hooks.js';
import {
  SurfaceError,
  type BoardState,
  type SessionSurfaceProvider,
  type SurfaceBarItem,
  type SurfaceBoardOp,
  type SurfaceCommandSpec,
  type SurfaceEvent,
  type SurfaceEventsPage,
  type SurfaceHandle,
  type SurfaceMember,
  type SurfaceSpelling,
  type SurfaceStatus,
  type SurfaceView,
} from '../../../code-mode/surface/types.js';
import { log } from '../../../log.js';
import {
  COMMAND_EVENT,
  isChannelGone,
  isNotFound,
  isSessionStopped,
  isUnavailable,
  STOPPED_EVENT,
  SurfaceServiceError,
  type ChannelEvent,
  type ChannelRecord,
  type SurfaceServiceClient,
  type ViewType,
} from './client.js';
import type { ManagedInstallCredentials } from './install.js';
import type { BotIdentity, SurfacePlatform } from './platforms.js';
import type { TerminalAddressFields } from './terminal-address.js';

/** Member events the service relays, mapped onto the contract's. */
export const MEMBER_JOINED_EVENT = 'code_channel.member_joined';
export const MEMBER_LEFT_EVENT = 'code_channel.member_left';

export interface ServiceSurfaceProviderDeps {
  /** The platform kind the provider serves (the registry key). */
  kind: string;
  platform: SurfacePlatform;
  /** The install and bearer, read on every open (an install may land later); null = no surface. */
  credentials(): Promise<ManagedInstallCredentials | null>;
  /** A client for the credentials' service (cached by the caller). */
  clientFor(credentials: ManagedInstallCredentials): SurfaceServiceClient;
  /** The address a terminal reaches a sandbox at on this host, when it has one. */
  terminalAddress(sandbox: string): Promise<TerminalAddressFields | undefined>;
  /** The host's setting: open a surface for a new sandbox at all (setting.ts). Absent = yes. */
  autoOpen?(): Promise<boolean>;
}

/** The contract's failure kinds for the service's answers; anything else is transient and rethrown as is. */
export function mapServiceError(error: unknown): unknown {
  if (isSessionStopped(error)) return new SurfaceError('stopped', (error as Error).message, { cause: error });
  if (isChannelGone(error)) return new SurfaceError('gone', (error as Error).message, { cause: error });
  if (isUnavailable(error)) return new SurfaceError('unavailable', (error as Error).message, { cause: error });
  return error;
}

const VIEW_TYPES: Record<SurfaceView['type'], ViewType> = {
  diff: 'diff',
  html: 'html',
  blocks: 'block_kit',
  canvas: 'canvas',
};

/** One service event as the contract names it; undefined for a type this host does not know. */
export function mapEvent(event: ChannelEvent): SurfaceEvent | undefined {
  switch (event.type) {
    case STOPPED_EVENT:
      return {
        type: 'stop',
        ...(event.ts ? { ts: event.ts } : {}),
        ...(event.user ? { user: event.user } : {}),
        ...(event.threadTs ? { threadId: event.threadTs } : {}),
      };
    case COMMAND_EVENT:
      return {
        type: 'command',
        command: event.command ?? '',
        ...(event.text !== undefined ? { text: event.text } : {}),
        ...(event.user ? { user: event.user } : {}),
        ...(event.ts ? { ts: event.ts } : {}),
      };
    case MEMBER_JOINED_EVENT:
      return { type: 'member_joined', member: { id: event.user ?? '' } };
    case MEMBER_LEFT_EVENT:
      return { type: 'member_left', member: { id: event.user ?? '' } };
    default:
      return undefined;
  }
}

function memberOf(member: NonNullable<ChannelRecord['members']>[number]): SurfaceMember {
  return {
    id: member.botUserId,
    ...(member.sandboxName ? { name: member.sandboxName } : {}),
    ...(member.role ? { role: member.role } : {}),
  };
}

export function createServiceSurfaceProvider(deps: ServiceSurfaceProviderDeps): SessionSurfaceProvider {
  const { kind, platform } = deps;

  async function client(): Promise<SurfaceServiceClient> {
    const credentials = await deps.credentials();
    if (!credentials) {
      throw new SurfaceError('unavailable', `no managed install for ${kind} on this host`);
    }
    return deps.clientFor(credentials);
  }

  async function identity(credentials: ManagedInstallCredentials): Promise<BotIdentity | null> {
    if (!platform.botIdentity) return null;
    try {
      return await platform.botIdentity(credentials);
    } catch (err) {
      log.warn('Session surface: bot identity lookup failed — the service names the bot instead', { kind, err });
      return null;
    }
  }

  async function address(sandbox: SandboxGroup, given?: string): Promise<TerminalAddressFields | undefined> {
    try {
      const found = await deps.terminalAddress(sandbox.folder);
      if (found) return found;
    } catch (err) {
      log.warn('Session surface: terminal address lookup failed — opening without it', { kind, err });
    }
    return given ? { terminalAddress: given, sandboxName: sandbox.folder.toLowerCase() } : undefined;
  }

  /** The service keys idempotency on the session id and refuses a new channel for an archived one. */
  function isArchived(record: ChannelRecord): boolean {
    return Boolean(record.archivedAt) || record.status === 'closed';
  }

  const provider: SessionSurfaceProvider = {
    async spell(surfaceId): Promise<SurfaceSpelling> {
      return platform.spell(surfaceId);
    },

    async open(sandbox, options): Promise<SurfaceHandle | null> {
      if (deps.autoOpen && !(await deps.autoOpen())) {
        log.info('Session surface: opening surfaces is disabled on this host — sandbox continues without one', {
          kind,
          sandbox: sandbox.folder,
        });
        return null;
      }
      const credentials = await deps.credentials();
      if (!credentials) {
        log.info('Session surface: no managed install on this host — sandbox continues without one', { kind });
        return null;
      }
      const service = deps.clientFor(credentials);
      const who = await identity(credentials);
      const fields = await address(sandbox, options.terminalAddress);
      const body = {
        appId: credentials.appId,
        title: options.title ?? sandbox.folder,
        ...(who ? { botUserId: who.botUserId, ...(who.teamId ? { teamId: who.teamId } : {}) } : {}),
        ...(fields ?? {}),
      };
      try {
        let { channel } = await service.create({ ...body, sessionId: sandbox.id });
        if (isArchived(channel)) {
          // A sandbox whose surface was archived binds again under a suffixed
          // session id; a retry after a crash converges on the same one.
          const suffix = Date.parse(channel.archivedAt ?? '') || Date.now();
          ({ channel } = await service.create({ ...body, sessionId: `${sandbox.id}.${suffix.toString(36)}` }));
        }
        return { surfaceId: channel.channelId, sessionId: channel.sessionId };
      } catch (error) {
        if (isUnavailable(error) || isNotFound(error)) {
          log.info('Session surface not available from the service — sandbox continues without one', {
            kind,
            reason: error instanceof SurfaceServiceError ? error.code : String(error),
          });
          return null;
        }
        throw error;
      }
    },

    async status(handle, status: SurfaceStatus, options = {}): Promise<void> {
      try {
        await (await client()).setStatus(handle.surfaceId, status, options);
      } catch (error) {
        throw mapServiceError(error);
      }
    },

    async view(handle, view: SurfaceView): Promise<void> {
      try {
        await (
          await client()
        ).putView(handle.surfaceId, view.key, {
          type: VIEW_TYPES[view.type],
          ...(view.name ? { name: view.name } : {}),
          content: view.content,
          ...(view.headBranch ? { headBranch: view.headBranch } : {}),
        });
      } catch (error) {
        throw mapServiceError(error);
      }
    },

    async bar(handle, items: SurfaceBarItem[]): Promise<void> {
      try {
        await (await client()).putProperties(handle.surfaceId, { contextBarItems: items });
      } catch (error) {
        throw mapServiceError(error);
      }
    },

    async commands(handle, specs: SurfaceCommandSpec[]): Promise<void> {
      try {
        await (await client()).setCommands(handle.surfaceId, specs);
      } catch (error) {
        throw mapServiceError(error);
      }
    },

    async members(handle): Promise<SurfaceMember[]> {
      try {
        return (await (await client()).members(handle.surfaceId)).map(memberOf);
      } catch (error) {
        throw mapServiceError(error);
      }
    },

    async join(handle, member: SurfaceMember): Promise<void> {
      try {
        await (
          await client()
        ).addMember(handle.surfaceId, {
          botUserId: member.id,
          ...(member.name ? { sandboxName: member.name } : {}),
        });
      } catch (error) {
        throw mapServiceError(error);
      }
    },

    async leave(handle, member: SurfaceMember): Promise<void> {
      try {
        await (await client()).removeMember(handle.surfaceId, member.id);
      } catch (error) {
        throw mapServiceError(error);
      }
    },

    async events(handle, cursor, waitSec, signal): Promise<SurfaceEventsPage> {
      let page;
      try {
        page = await (await client()).events(handle.surfaceId, { since: cursor, wait: waitSec, signal });
      } catch (error) {
        throw mapServiceError(error);
      }
      const events: SurfaceEvent[] = [];
      for (const event of page.events) {
        const mapped = mapEvent(event);
        if (mapped) events.push(mapped);
        else log.debug('Session surface: service event not known to this host', { kind, type: event.type });
      }
      return { events, cursor: page.cursor };
    },

    async close(handle, options = {}): Promise<void> {
      try {
        await (await client()).archive(handle.surfaceId, options);
      } catch (error) {
        // Already archived or unknown: the wrap-up is done either way.
        if (isChannelGone(error)) return;
        throw mapServiceError(error);
      }
    },
  };
  return provider;
}

/** The board is not carried by the service yet; the contract leaves it optional and core never calls an absent method. */
export type { BoardState, SurfaceBoardOp };
