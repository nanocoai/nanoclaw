/**
 * Outbound-message transform extension point (ADR 0006 contract 7).
 *
 * `writeMessageOut` is the single writer every reply path funnels
 * through. Core ships an IDENTITY transform so pristine upstream builds
 * and behaves unchanged with zero fork modules present. An install
 * overlay (TaskFlow's web-chat reply gate) may replace it by calling
 * `registerOutboundTransform` at module load.
 *
 * Mirrors `providers/provider-registry.ts`: a single registered slot,
 * imported for its side effect by the relevant barrel.
 *
 * FAIL-CLOSED contract: `applyOutboundTransform` does NOT catch — a
 * throw from the registered transform propagates out of
 * `writeMessageOut` so a web-origin reply can never silently fall back
 * to writing the plain channel row.
 */
import type { WriteMessageOut } from './messages-out.js';

export type OutboundTransform = (msg: WriteMessageOut) => WriteMessageOut;

const identity: OutboundTransform = (msg) => msg;

let current: OutboundTransform = identity;

export function registerOutboundTransform(fn: OutboundTransform): void {
  current = fn;
}

/** Apply the registered transform. Throws propagate (fail-closed). */
export function applyOutboundTransform(msg: WriteMessageOut): WriteMessageOut {
  return current(msg);
}
