/**
 * The session-surface contract: how a chat platform becomes a surface for a
 * coding session.
 *
 * A SessionSurfaceProvider is an optional capability, one object per chat
 * platform, attached with `registerSessionSurface(channelType, provider, {
 * seam })` (registry.ts) or offered from a channel adapter. Every method is
 * async so a REMOTE implementer (a service the host talks to over HTTP) is
 * a legal implementation, and no method exposes a platform SDK object: core
 * hands the provider its own ids and gets ids back.
 *
 * What stays in core (this directory): the mapper (turn stamp → status),
 * diff collection, the interrupt, the binding table and wiring, the runtime
 * (tick, coalescing, stopped gate, event cursor, backoff) and the CLI
 * verbs. The provider owns everything that touches the platform.
 *
 * Failure vocabulary: a provider signals "cannot at all" / "gone for good" /
 * "the user stopped it" by throwing a SurfaceError with that kind; anything
 * else is transient and retried by the runtime.
 */
import type { SandboxGroup } from '../hooks.js';

export type SurfaceStatus = 'active' | 'processing' | 'suspended' | 'closed';

/** The provider's handle for one open surface. */
export interface SurfaceHandle {
  surfaceId: string;
  /** The provider's id for the session behind it (core passes the agent group id at open). */
  sessionId: string;
}

/** How the platform's adapter spells the surface as a messaging_groups row. */
export interface SurfaceSpelling {
  platformId: string;
  instance: string;
}

export interface SurfaceView {
  key: string;
  type: 'diff' | 'html' | 'blocks' | 'canvas';
  name?: string;
  content: string;
  /** For a diff view: the working branch, when known. */
  headBranch?: string;
}

export interface SurfaceBarItem {
  key: string;
  label: string;
  icon?: string;
  url?: string;
}

export interface SurfaceBoardItem {
  id: string;
  text: string;
  claimedBy?: string | null;
  done?: boolean;
}

export interface BoardState {
  items: SurfaceBoardItem[];
}

export type SurfaceBoardOp =
  | { op: 'init'; items?: string[] }
  | { op: 'add'; text: string }
  | { op: 'claim'; id: string; by: string }
  | { op: 'done'; id: string }
  | { op: 'unclaim'; id: string }
  | { op: 'show' };

export interface SurfaceCommandSpec {
  name: string;
  description: string;
}

export interface SurfaceMember {
  /** The platform's id for the member (a user id, a bot id). */
  id: string;
  name?: string;
  role?: string;
}

export type SurfaceEvent =
  | {
      type: 'stop';
      ts?: string;
      /** Who pressed it, in the platform's id. */
      user?: string;
      /** Set when the stop was scoped to a thread (relayed only; the turn runs on). */
      threadId?: string;
    }
  | { type: 'command'; command: string; text?: string; user?: string; ts?: string }
  | { type: 'member_joined'; member: SurfaceMember }
  | { type: 'member_left'; member: SurfaceMember }
  | { type: 'board_changed'; board?: BoardState };

export interface SurfaceEventsPage {
  events: SurfaceEvent[];
  /** The cursor to continue from; null when the provider has none. */
  cursor: string | null;
}

export interface SessionSurfaceProvider {
  /**
   * The messaging_groups spelling the adapter's inbound path will resolve
   * for this surface, so the binding writes the row the adapter matches
   * (today's `ChannelAdapter.conversationPlatformId`).
   */
  spell(surfaceId: string): Promise<SurfaceSpelling>;
  /**
   * Open (or find) the surface for a sandbox. Null means "not available" —
   * no install, no sign-in, a platform that cannot do it yet — and the
   * sandbox goes on without one. Never throws for that; a thrown error is
   * logged and treated the same.
   */
  open(sandbox: SandboxGroup, options: { title?: string; terminalAddress?: string }): Promise<SurfaceHandle | null>;
  /** The mapper's output, coalesced by the runtime. `resume` flags the first send after a stop. */
  status(handle: SurfaceHandle, status: SurfaceStatus, options?: { resume?: boolean }): Promise<void>;
  /** The diff after a turn, or another view the platform can show. */
  view(handle: SurfaceHandle, view: SurfaceView): Promise<void>;
  /** Items on the surface's context bar (a terminal address, a link). */
  bar?(handle: SurfaceHandle, items: SurfaceBarItem[]): Promise<void>;
  /** A shared task board on the surface. */
  board?(handle: SurfaceHandle, op: SurfaceBoardOp): Promise<BoardState>;
  /** Commands the surface offers its members. */
  commands?(handle: SurfaceHandle, specs: SurfaceCommandSpec[]): Promise<void>;
  members?(handle: SurfaceHandle): Promise<SurfaceMember[]>;
  join?(handle: SurfaceHandle, member: SurfaceMember): Promise<void>;
  leave?(handle: SurfaceHandle, member: SurfaceMember): Promise<void>;
  /**
   * The runtime's long-poll: events since `cursor`, waiting up to `waitSec`
   * for one. A provider that pushes nothing returns an empty page after the
   * wait. `signal` aborts the wait when the runtime stops.
   */
  events(
    handle: SurfaceHandle,
    cursor: string | null,
    waitSec: number,
    signal?: AbortSignal,
  ): Promise<SurfaceEventsPage>;
  /** The explicit wrap-up: the surface closes, with a summary first when given. */
  close(handle: SurfaceHandle, options?: { summary?: string }): Promise<void>;
}

export type SurfaceErrorKind =
  /** The platform cannot give this host a surface at all — degrade, do not retry. */
  | 'unavailable'
  /** The surface is gone for good (closed elsewhere, unknown) — stop mirroring it. */
  | 'gone'
  /** The user stopped the session from the surface; status is refused until the next human turn resumes. */
  | 'stopped';

export class SurfaceError extends Error {
  readonly kind: SurfaceErrorKind;
  constructor(kind: SurfaceErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SurfaceError';
    this.kind = kind;
  }
}

export function surfaceErrorKind(error: unknown): SurfaceErrorKind | undefined {
  return error instanceof SurfaceError ? error.kind : undefined;
}
