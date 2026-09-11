/**
 * Seam between the door and the host's account link. `remote enable`,
 * `remote disable` and every host start report the door's state here; the
 * link, once it carries terminal streams, replaces this body with the call
 * that tells the account service the machine accepts remote terminals under
 * this name and host key. Until then it only logs.
 */
import { log } from '../../log.js';

export interface TerminalState {
  enabled: boolean;
  name?: string;
  hostKeyFingerprint?: string;
  doorPort?: number;
  /** Fingerprints the door currently honours. */
  authorizedFingerprints: string[];
}

export async function reportTerminalState(state: TerminalState): Promise<void> {
  log.info('Remote terminal state', { ...state });
}
