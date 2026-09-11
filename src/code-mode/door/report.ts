/**
 * The seam between the door and the host's account link.
 *
 * The door never talks to the account service itself; it calls these three
 * functions, and the link replaces their bodies with `setTerminalSeam()` when
 * it can carry them (naming and address allocation at enable, the state
 * report on every start/disable, and pending-key registration that mints the
 * approval code). Until then the defaults keep the door usable on its own:
 * an explicit `--name`, a log line, and the configured approval page.
 */
import { log } from '../../log.js';
import type { DoorSource } from './target-map.js';

export interface TerminalState {
  enabled: boolean;
  name?: string;
  hostKeyFingerprint?: string;
  doorPort?: number;
  /** Fingerprints the door currently honours. */
  authorizedFingerprints: string[];
}

export interface TerminalEnableRequest {
  /** Omitted when the account service is expected to assign one. */
  name?: string;
  hostKey: string;
  hostKeyFingerprint: string;
}

export interface TerminalEnableResult {
  /** The name the account now carries — assigned or confirmed by the service. */
  name: string;
  /** The machine's address and host name, once the network side allocates them. */
  address?: string;
  host?: string;
  /** Set when the account was renamed since the last enable. */
  previousName?: string;
}

export interface PendingKeyRequest {
  fingerprint: string;
  keyType: string;
  publicKey: string;
  source?: DoorSource;
  at: string;
  /** The door's configured approval page, for the default answer. */
  approvalUrl: string;
}

export interface PendingKeyResult {
  /** The short code the approval page asks for, when the service minted one. */
  code?: string;
  url: string;
  expiresAt: string;
}

export interface TerminalSeam {
  enable: (request: TerminalEnableRequest) => Promise<TerminalEnableResult>;
  report: (state: TerminalState) => Promise<void>;
  pending: (request: PendingKeyRequest) => Promise<PendingKeyResult>;
}

export const PENDING_APPROVAL_TTL_MS = 10 * 60_000;

const defaults: TerminalSeam = {
  async enable(request) {
    if (!request.name) {
      throw new Error(
        'no account link carries terminal names yet — pass --name <account-name> to ncl sandboxes remote enable',
      );
    }
    return { name: request.name };
  },
  async report(state) {
    log.info('Remote terminal state', { ...state });
  },
  async pending(request) {
    const expiresAt = new Date(Date.parse(request.at) + PENDING_APPROVAL_TTL_MS).toISOString();
    return { url: request.approvalUrl, expiresAt };
  },
};

let seam: TerminalSeam = { ...defaults };

/** Replace part of the seam (the link does this at wiring time); `undefined` restores a default. */
export function setTerminalSeam(partial: Partial<TerminalSeam>): void {
  seam = {
    enable: partial.enable ?? defaults.enable,
    report: partial.report ?? defaults.report,
    pending: partial.pending ?? defaults.pending,
  };
}

export function enableTerminal(request: TerminalEnableRequest): Promise<TerminalEnableResult> {
  return seam.enable(request);
}

export function reportTerminalState(state: TerminalState): Promise<void> {
  return seam.report(state);
}

export function reportPendingKey(request: PendingKeyRequest): Promise<PendingKeyResult> {
  return seam.pending(request);
}
