/**
 * The seam between the account link and the loopback door.
 *
 * The running host needs four things from the door: whether it is enabled
 * and on which loopback port; a place to register what each relayed stream
 * is for, keyed by the loopback source port the pipe connects from (the
 * program a connection lands in reads that port from `SSH_CONNECTION` and
 * asks the door); the reverse of that when the stream ends; and a sink for
 * the `terminal` section of every perks snapshot, which carries the keys the
 * account owner approved or revoked in the browser. The door needs three
 * things from the link, which it calls through its terminal seam: the
 * account service's answer at enable (the name it confirms or assigns and
 * the address), the state report on every start and disable, and the
 * approval code for a key waiting in the waiting room. `wireDoor` connects
 * both directions. The seam's requests read the checkout's identity from
 * disk on every call, so they work whether or not the link is up, and fall
 * back to the door's standalone behaviour on a checkout that is not set up
 * with the account service.
 */
import * as doorModule from '../door/index.js';
import type { DoorStream } from '../door/index.js';
import {
  checkoutClient,
  reportTerminalState,
  type LinkLog,
  type TerminalSnapshot,
} from '../../../community-portal/index.js';

export interface DoorStatus {
  enabled: boolean;
  /** The loopback port the door accepts on, while enabled. */
  port?: number;
  hostKey?: string;
  /** The fingerprints the door currently honours. */
  authorizedFingerprints: string[];
}

/** What the link registers per loopback source port while a stream is open. */
export type StreamEntry = Omit<DoorStream, 'openedAt'> & { openedAt?: string };

export interface Door {
  status(): Promise<DoorStatus>;
  registerTarget(port: number, entry: StreamEntry): void;
  unregisterTarget(port: number): void;
  lookupTarget(port: number): DoorStream | undefined;
  /** The mirror's `terminal` section on every perks snapshot (undefined when the mirror carries none). */
  applyTerminalSnapshot(terminal: TerminalSnapshot | undefined): Promise<void>;
}

/** The door module's surface the seam builds on; injectable for tests. */
export type DoorModule = Pick<
  typeof doorModule,
  | 'doorStatus'
  | 'listDoorKeys'
  | 'registerTarget'
  | 'unregisterTarget'
  | 'lookupTarget'
  | 'applyTerminalMirror'
  | 'setTerminalSeam'
>;

export interface WireDoorOptions {
  root?: string;
  homeDir?: string;
  log?: LinkLog;
  /** Runs after every state report, so the link can re-announce its caps without waiting for a poll. */
  onReported?: () => void;
  module?: DoorModule;
  now?: () => number;
}

/** A snapshot stamped this much before the host's own enable call may still be the service's answer to it. */
export const MIRROR_SKEW_MS = 30_000;
/** How long a waiting room may wait for an approval when the service minted no code. */
export const PENDING_APPROVAL_TTL_MS = 10 * 60_000;

/**
 * Wire the door to the account link: install the seam and return the door
 * as the link sees it. Nothing is written until a seam call happens.
 */
export function wireDoor({
  root = process.cwd(),
  homeDir,
  log = () => {},
  onReported = () => {},
  module = doorModule,
  now = Date.now,
}: WireDoorOptions = {}): Door {
  let lastEnableAt: number | undefined;
  /** A bearer client for the checkout, or undefined while it is not set up with the account service. */
  const client = () => checkoutClient({ root, homeDir, log });

  module.setTerminalSeam({
    async enable(request) {
      const portal = await client();
      if (!portal?.deviceKey) {
        if (!request.name) {
          throw new Error(
            'this checkout is not set up with the account service; pass --name <account-name> to ncl sandboxes remote enable',
          );
        }
        return { name: request.name };
      }
      lastEnableAt = now();
      const result = await portal.terminalEnable({
        ...(request.name ? { name: request.name } : {}),
        hostKey: request.hostKey,
      });
      // A rename reaches the door through the mirror (`previousName`), not through this answer.
      return {
        name: result.name,
        ...(result.address ? { address: result.address } : {}),
        ...(result.host ? { host: result.host } : {}),
      };
    },
    async report(state) {
      await reportTerminalState(state, { root, homeDir, log, now });
      onReported();
    },
    async pending(request) {
      const fallback = {
        url: request.approvalUrl,
        expiresAt: new Date(Date.parse(request.at) + PENDING_APPROVAL_TTL_MS).toISOString(),
      };
      const portal = await client();
      // The service records where the key came from; a connection the host did not relay has no source.
      if (!portal || !request.source) return fallback;
      const { fingerprint, keyType, publicKey, source, at } = request;
      const result = await portal.terminalPending({ fingerprint, keyType, publicKey, source, at });
      return {
        ...(result.code ? { code: result.code } : {}),
        url: result.url || fallback.url,
        expiresAt: result.expiresAt || fallback.expiresAt,
      };
    },
  });

  return {
    async status() {
      const summary = await module.doorStatus();
      const store = await module.listDoorKeys();
      const port = summary.enabled && summary.doorPort ? summary.doorPort : undefined;
      return {
        enabled: port !== undefined,
        ...(port === undefined ? {} : { port }),
        ...(summary.hostKey ? { hostKey: summary.hostKey } : {}),
        authorizedFingerprints: [
          ...new Set([...store.approved.map((key) => key.fingerprint), ...(store.mirror?.fingerprints ?? [])]),
        ],
      };
    },
    registerTarget: (port, entry) => module.registerTarget(port, entry),
    unregisterTarget: (port) => module.unregisterTarget(port),
    lookupTarget: (port) => module.lookupTarget(port),
    async applyTerminalSnapshot(terminal) {
      // A mirror older than this host's own enable call would report the door disabled.
      const stampedAt = terminal?.updatedAt ? Date.parse(terminal.updatedAt) : NaN;
      if (lastEnableAt !== undefined && !(stampedAt >= lastEnableAt - MIRROR_SKEW_MS)) {
        log({ event: 'terminal_snapshot_stale', ...(terminal?.updatedAt ? { updatedAt: terminal.updatedAt } : {}) });
        return;
      }
      await module.applyTerminalMirror(
        terminal && {
          enabled: terminal.enabled,
          ...(terminal.name ? { name: terminal.name } : {}),
          ...(terminal.previousName ? { previousName: terminal.previousName } : {}),
          keys: terminal.keys.map((key) => ({ fingerprint: key.fingerprint })),
        },
      );
    },
  };
}
