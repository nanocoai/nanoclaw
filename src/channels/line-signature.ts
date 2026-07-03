/**
 * LINE webhook signature verification.
 *
 * LINE signs every webhook delivery: HMAC-SHA256 over the *raw* request body,
 * keyed by the channel secret, base64-encoded, sent in the `x-line-signature`
 * header. We recompute the MAC and compare in constant time.
 *
 * This is the security boundary for inbound LINE traffic — the bot's official-
 * account id and QR are public and non-rotatable, so "a message arrived" proves
 * nothing. Only a valid signature proves the request actually came from LINE.
 *
 * Kept as a standalone, dependency-free module (node `crypto` only) so it is
 * unit-testable without the running adapter, the webhook server, or any network.
 */
import crypto from 'crypto';

/** Why a signature check failed — lets callers log a diagnosable reason. */
export type LineSignatureResult =
  | 'ok'
  | 'no_secret' // LINE_CHANNEL_SECRET not configured (deployment gap)
  | 'no_signature' // request carried no x-line-signature header (probably not LINE)
  | 'mismatch'; // secret + signature present but the MAC does not match

/**
 * Verify an `x-line-signature` header against the raw body and channel secret.
 * Returns a reason code rather than a bare boolean so the adapter can tell a
 * missing-secret misconfiguration apart from a genuine forgery.
 */
export function verifyLineSignatureResult(
  body: Buffer | string,
  channelSecret: string | undefined | null,
  signature: string | undefined | null,
): LineSignatureResult {
  if (!channelSecret) return 'no_secret';
  if (!signature) return 'no_signature';

  const bodyBuf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const expected = crypto.createHmac('sha256', channelSecret).update(bodyBuf).digest(); // 32 raw bytes

  // Decode the provided base64 to raw bytes and compare those. Comparing decoded
  // bytes (not the base64 strings) sidesteps any padding/whitespace variation and
  // keeps the comparison constant-time via timingSafeEqual.
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'base64');
  } catch {
    return 'mismatch';
  }
  if (provided.length !== expected.length) return 'mismatch';
  return crypto.timingSafeEqual(provided, expected) ? 'ok' : 'mismatch';
}

/** Boolean wrapper around {@link verifyLineSignatureResult}. */
export function verifyLineSignature(
  body: Buffer | string,
  channelSecret: string | undefined | null,
  signature: string | undefined | null,
): boolean {
  return verifyLineSignatureResult(body, channelSecret, signature) === 'ok';
}

/**
 * Compute the base64 `x-line-signature` value for a body + secret. Not used by
 * the adapter (LINE signs; we only verify) — exported for tests and for any
 * local tooling that needs to forge a valid signature against a test server.
 */
export function computeLineSignature(body: Buffer | string, channelSecret: string): string {
  const bodyBuf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return crypto.createHmac('sha256', channelSecret).update(bodyBuf).digest('base64');
}
