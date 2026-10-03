import { describe, expect, it } from 'vitest';

import { computeLineSignature, verifyLineSignature, verifyLineSignatureResult } from './line-signature.js';

const SECRET = 'test-channel-secret-0123456789';
const BODY = JSON.stringify({ destination: 'U123', events: [{ type: 'message' }] });

describe('LINE signature verification', () => {
  it('accepts a signature it computed for the same body + secret', () => {
    const sig = computeLineSignature(BODY, SECRET);
    expect(verifyLineSignature(BODY, SECRET, sig)).toBe(true);
    expect(verifyLineSignatureResult(BODY, SECRET, sig)).toBe('ok');
  });

  it('accepts a Buffer body identically to a string body', () => {
    const sig = computeLineSignature(BODY, SECRET);
    expect(verifyLineSignature(Buffer.from(BODY, 'utf8'), SECRET, sig)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = computeLineSignature(BODY, SECRET);
    const tampered = BODY.replace('U123', 'U999');
    expect(verifyLineSignature(tampered, SECRET, sig)).toBe(false);
    expect(verifyLineSignatureResult(tampered, SECRET, sig)).toBe('mismatch');
  });

  it('rejects a signature made with a different secret', () => {
    const sig = computeLineSignature(BODY, 'some-other-secret');
    expect(verifyLineSignature(BODY, SECRET, sig)).toBe(false);
    expect(verifyLineSignatureResult(BODY, SECRET, sig)).toBe('mismatch');
  });

  it('reports no_secret when the channel secret is missing', () => {
    const sig = computeLineSignature(BODY, SECRET);
    expect(verifyLineSignatureResult(BODY, '', sig)).toBe('no_secret');
    expect(verifyLineSignatureResult(BODY, undefined, sig)).toBe('no_secret');
    expect(verifyLineSignature(BODY, '', sig)).toBe(false);
  });

  it('reports no_signature when the header is absent', () => {
    expect(verifyLineSignatureResult(BODY, SECRET, undefined)).toBe('no_signature');
    expect(verifyLineSignatureResult(BODY, SECRET, '')).toBe('no_signature');
    expect(verifyLineSignature(BODY, SECRET, null)).toBe(false);
  });

  it('rejects garbage / wrong-length signatures without throwing', () => {
    expect(verifyLineSignature(BODY, SECRET, 'not-base64-!!!')).toBe(false);
    expect(verifyLineSignature(BODY, SECRET, 'AAAA')).toBe(false); // valid base64, wrong length
  });

  it('is sensitive to the exact secret (no truncation collisions)', () => {
    const sig = computeLineSignature(BODY, SECRET);
    expect(verifyLineSignature(BODY, SECRET + 'x', sig)).toBe(false);
  });
});
