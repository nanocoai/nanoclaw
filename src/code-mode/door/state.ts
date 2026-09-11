/**
 * The door's state journal (`data/door/state.json`, mode 0600): what
 * `remote enable` decided, plus the two things the forced commands need and
 * cannot derive on their own — the host's ncl socket and the host's PATH
 * (the OpenSSH server hands its children a minimal one, and the attach argv
 * the host composes names its container runtime by bare command).
 */
import { readJson, writePrivate } from '../../community-portal/private-file.js';

export const DEFAULT_APPROVAL_URL = 'https://portal.nanoclaw.dev/terminals';

export interface DoorState {
  version: 1;
  enabled: boolean;
  /** The account name the service confirmed or assigned — the DNS label and the default sandbox name. */
  name?: string;
  /** The machine's address and host name once allocated. */
  address?: string;
  host?: string;
  /** The name before a rename, so the operator learns the address changed. */
  previousName?: string;
  /** Loopback port the door listens on; chosen once, kept across restarts. */
  doorPort?: number;
  hostKey?: string;
  hostKeyFingerprint?: string;
  approvalUrl: string;
  /** The host's ncl socket, for the landing program's sandbox verbs. */
  socketPath: string;
  /** The door's unix socket, where the host answers `GET /target?port=` for the forced commands. */
  hostSocketPath: string;
  /** The host's PATH at the last start — restored inside the forced commands. */
  path: string;
  enabledAt?: string;
  updatedAt: string;
}

export async function readDoorState(file: string): Promise<DoorState | undefined> {
  const state = await readJson<DoorState>(file);
  return state && state.version === 1 ? state : undefined;
}

export function writeDoorState(file: string, state: DoorState): Promise<void> {
  return writePrivate(file, state);
}
