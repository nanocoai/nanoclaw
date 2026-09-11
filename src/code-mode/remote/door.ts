/**
 * The seam between the link's stream pipe and the loopback door.
 *
 * The running host needs four things from the door: whether it is enabled
 * and on which loopback port; a place to register what each relayed stream
 * is for, keyed by the loopback source port the pipe connects from (the
 * program a connection lands in reads that port from `SSH_CONNECTION` and
 * asks the door); the reverse of that when the stream ends; and a sink for
 * the `terminal` section of every perks snapshot, which carries the keys the
 * account owner approved or revoked in the browser. This module is that
 * interface plus a stand-in that reads the journal, keeps targets in memory
 * and remembers the last snapshot. The door module supplies the real one:
 * its supervisor answers `status`, its target map takes the registrations,
 * and its key store consumes the snapshot.
 */
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readJson, type Journal, type LinkLog, type TerminalSnapshot } from '../../community-portal/index.js';

export interface StreamTarget {
  /** The account name; the default sandbox is named after it. */
  account: string;
  /** A named sandbox to attach instead of the account default. */
  sandbox?: string;
}

/** What the host keeps per loopback source port while a stream is open. */
export interface StreamRecord {
  stream: string;
  target: StreamTarget;
  /** The terminal's public address as the relay saw it. */
  source: { ip: string; port: number };
  openedAt: string;
}

export interface DoorStatus {
  enabled: boolean;
  /** The loopback port the door accepts on, while enabled. */
  port?: number;
  hostKey?: string;
  /** The fingerprints the door currently honours. */
  authorizedFingerprints: string[];
}

export interface Door {
  status(): Promise<DoorStatus>;
  registerTarget(port: number, record: StreamRecord): void;
  unregisterTarget(port: number): void;
  lookupTarget(port: number): StreamRecord | undefined;
  /** The mirror's `terminal` section on every perks snapshot (undefined when the mirror carries none). */
  applyTerminalSnapshot(terminal: TerminalSnapshot | undefined): void;
}

export interface LocalDoorOptions {
  root?: string;
  log?: LinkLog;
}

/**
 * The stand-in: enabled and the port come from the journal's `terminal`
 * section, targets live in a map for the life of the process, and the last
 * snapshot is kept so the periodic report can name the honoured keys.
 */
export function localDoor({ root = process.cwd(), log = () => {} }: LocalDoorOptions = {}): Door {
  const file = path.join(root, 'data/community-portal.json');
  const targets = new Map<number, StreamRecord>();
  let terminal: TerminalSnapshot | undefined;
  return {
    async status() {
      const journal = await readJson<Partial<Journal>>(file);
      const saved = journal?.terminal;
      const port = saved?.enabled === true && Number.isInteger(saved.doorPort) ? saved.doorPort : undefined;
      return {
        enabled: port !== undefined,
        ...(port === undefined ? {} : { port }),
        authorizedFingerprints: terminal?.keys.map((key) => key.fingerprint) ?? [],
      };
    },
    registerTarget(port, record) {
      targets.set(port, { ...record, target: { ...record.target }, source: { ...record.source } });
    },
    unregisterTarget(port) {
      targets.delete(port);
    },
    lookupTarget(port) {
      return targets.get(port);
    },
    applyTerminalSnapshot(next) {
      if (isDeepStrictEqual(next, terminal)) return;
      terminal = next;
      log({
        event: 'terminal_snapshot',
        enabled: next?.enabled ?? false,
        keys: next?.keys.length ?? 0,
        pending: next?.pending.length ?? 0,
      });
    },
  };
}
