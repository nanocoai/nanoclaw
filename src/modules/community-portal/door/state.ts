/**
 * The door's state journal (`data/door/state.json`, mode 0600): what
 * `remote enable` decided, kept across host restarts.
 */
import { readJson, writePrivate } from '../../../community-portal/private-file.js';

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
  /**
   * The page where a waiting key is approved in the browser, derived from
   * the portal this checkout is enrolled with; absent on a checkout that is
   * not enrolled (approval is then `ncl sandboxes remote keys approve`).
   */
  approvalUrl?: string;
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
