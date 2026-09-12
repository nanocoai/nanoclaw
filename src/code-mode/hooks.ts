/**
 * Sandbox lifecycle hooks — where a module attaches to code mode without
 * code mode knowing it exists.
 *
 * Four events, each a list of named callbacks:
 *   - `onSandboxCreated(group)`: `sandboxes new` minted a group and its
 *     sandbox session; the first spawn has not happened yet;
 *   - `onSandboxBound(group, surface)`: a chat surface was opened for the
 *     group's coding session (code-mode/surface);
 *   - `onSandboxRemoved(group)`: `groups delete` removed a code-mode group,
 *     rows and workspace gone;
 *   - `onRemoteAccessChanged(state)`: a remote-terminal module turned
 *     remote access on or off for this host.
 *
 * Callbacks are awaited in registration order; a callback that throws is
 * logged and skipped, never propagated — a hook is a listener, not a gate,
 * and no module may fail a verb it did not implement. Registration carries
 * `{ seam }` (SANDBOX_HOOKS_SEAM); a mismatch is refused, logged and shown
 * by `ncl sandboxes list` (src/seams.ts).
 */
import { log } from '../log.js';
import type { AgentGroup } from '../types.js';
import { seamAccepted } from '../seams.js';

/** Bump only on a breaking change to a hook's arguments. */
export const SANDBOX_HOOKS_SEAM = 1;

export type SandboxHookKind = 'created' | 'bound' | 'removed' | 'remote-access-changed';

export type SandboxGroup = Pick<AgentGroup, 'id' | 'name' | 'folder'>;

/** What the binding knows about a surface, platform-agnostic. */
export interface BoundSurface {
  /** The chat platform the surface lives on (an adapter's channel type). */
  channelType: string;
  /** The provider's id for the surface (a channel id, a thread id, …). */
  surfaceId: string;
  /** The provider's id for the session behind it. */
  sessionId: string;
  /** The messaging_groups row the surface is wired through. */
  messagingGroupId: string;
}

export interface RemoteAccessState {
  enabled: boolean;
  /** This host's name at the remote end, when it has one. */
  name?: string;
  /** The address a terminal connects to, when known. */
  host?: string;
}

export type SandboxCreatedCallback = (group: SandboxGroup) => void | Promise<void>;
export type SandboxBoundCallback = (group: SandboxGroup, surface: BoundSurface) => void | Promise<void>;
export type SandboxRemovedCallback = (group: SandboxGroup) => void | Promise<void>;
export type RemoteAccessChangedCallback = (state: RemoteAccessState) => void | Promise<void>;

interface Registered<T> {
  name: string;
  callback: T;
}

const created: Registered<SandboxCreatedCallback>[] = [];
const bound: Registered<SandboxBoundCallback>[] = [];
const removed: Registered<SandboxRemovedCallback>[] = [];
const remoteAccess: Registered<RemoteAccessChangedCallback>[] = [];

export interface HookRegistration {
  seam: number;
}

/** Undo the registration. */
export type Unregister = () => void;

function add<T>(list: Registered<T>[], kind: SandboxHookKind, name: string, callback: T, seam: number): Unregister {
  if (!seamAccepted('sandbox-hooks', `${kind}:${name}`, SANDBOX_HOOKS_SEAM, seam)) return () => {};
  const entry = { name, callback };
  list.push(entry);
  return () => {
    const at = list.indexOf(entry);
    if (at >= 0) list.splice(at, 1);
  };
}

export function onSandboxCreated(name: string, callback: SandboxCreatedCallback, reg: HookRegistration): Unregister {
  return add(created, 'created', name, callback, reg.seam);
}

export function onSandboxBound(name: string, callback: SandboxBoundCallback, reg: HookRegistration): Unregister {
  return add(bound, 'bound', name, callback, reg.seam);
}

export function onSandboxRemoved(name: string, callback: SandboxRemovedCallback, reg: HookRegistration): Unregister {
  return add(removed, 'removed', name, callback, reg.seam);
}

export function onRemoteAccessChanged(
  name: string,
  callback: RemoteAccessChangedCallback,
  reg: HookRegistration,
): Unregister {
  return add(remoteAccess, 'remote-access-changed', name, callback, reg.seam);
}

async function fire<T extends (...args: never[]) => void | Promise<void>>(
  list: Registered<T>[],
  kind: SandboxHookKind,
  args: Parameters<T>,
): Promise<void> {
  for (const { name, callback } of [...list]) {
    try {
      await callback(...args);
    } catch (err) {
      log.error('Sandbox hook failed — continuing', { hook: kind, name, err });
    }
  }
}

/** Fired by code mode itself; a module never fires these two. */
export const fireSandboxCreated = (group: SandboxGroup): Promise<void> => fire(created, 'created', [group]);
export const fireSandboxRemoved = (group: SandboxGroup): Promise<void> => fire(removed, 'removed', [group]);
/** Fired by the surface core once a binding row and its wiring exist. */
export const fireSandboxBound = (group: SandboxGroup, surface: BoundSurface): Promise<void> =>
  fire(bound, 'bound', [group, surface]);
/** Fired by whichever module owns remote access when it flips the state. */
export const fireRemoteAccessChanged = (state: RemoteAccessState): Promise<void> =>
  fire(remoteAccess, 'remote-access-changed', [state]);

/** The names registered for a hook, in order — for contract tests (contract.ts). */
export function sandboxHookNames(kind: SandboxHookKind): string[] {
  const list = { created, bound, removed, 'remote-access-changed': remoteAccess }[kind];
  return list.map((entry) => entry.name);
}

/** Test seam. */
export function resetSandboxHooksForTesting(): void {
  for (const list of [created, bound, removed, remoteAccess]) list.length = 0;
}
