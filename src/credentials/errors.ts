/**
 * Stable wire envelope for credential failures.
 *
 * Generalizes the gccourse `connect_required` / `forbidden` pattern. Used
 * by future credential proxies (and by container-runner spawn refusal) so
 * upstream-API 401/403 responses can't degrade into opaque errors — when
 * the resolver explicitly says "you need to connect" or "you're forbidden",
 * the caller sees a typed envelope.
 */
import type { CredentialDecision } from './types.js';

export const HTTP_STATUS_CONNECT_REQUIRED = 402;
export const HTTP_STATUS_FORBIDDEN = 403;

export type CredentialErrorBody = {
  type: 'connect_required' | 'forbidden';
  provider: string;
  message?: string;
  connect_url?: string;
  reason?: string;
};

export interface SerializedCredentialError {
  status: number;
  body: CredentialErrorBody;
}

export function serializeCredentialError(
  decision: Extract<CredentialDecision, { kind: 'connect_required' | 'forbidden' }>,
): SerializedCredentialError {
  if (decision.kind === 'connect_required') {
    const body: CredentialErrorBody = {
      type: 'connect_required',
      provider: decision.provider,
      message: decision.message,
    };
    if (decision.connectUrl !== undefined) body.connect_url = decision.connectUrl;
    return { status: HTTP_STATUS_CONNECT_REQUIRED, body };
  }
  const body: CredentialErrorBody = {
    type: 'forbidden',
    provider: decision.provider,
  };
  if (decision.reason !== undefined) body.reason = decision.reason;
  return { status: HTTP_STATUS_FORBIDDEN, body };
}
