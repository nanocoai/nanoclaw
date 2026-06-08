/**
 * Tests for shortApprovalId — the OneCLI manual-approval card id used as
 * the lookup key in the Chat SDK callback. Two properties matter:
 *
 *   1. Unguessable. The id IS the auth — anyone who knows a pending id and
 *      can post a click to the webhook can approve a credentialed action.
 *      Math.random() with 8 base36 chars is ~41 bits and brute-forceable.
 *      crypto.randomBytes(16) gives 128 bits, well past brute-force range.
 *
 *   2. Fits in Telegram's callback_data budget. Chat SDK wraps the id as
 *      `chat:{"a":"<id>","v":"<value>"}` and Telegram caps callback_data at
 *      64 bytes total. A full UUID (36 chars) plus our `oa-` prefix would
 *      not fit; the base64url encoding picked here does.
 */
import { describe, expect, it } from 'vitest';

import { shortApprovalId } from './onecli-approvals.js';

describe('shortApprovalId', () => {
  it('starts with the oa- prefix and uses base64url-safe characters only', () => {
    const id = shortApprovalId();
    expect(id.startsWith('oa-')).toBe(true);
    // base64url: A–Z, a–z, 0–9, '-', '_'.
    expect(/^oa-[A-Za-z0-9_-]+$/.test(id)).toBe(true);
  });

  it('fits inside Chat SDK callback_data wrapping for the longer button value', () => {
    // chat:{"a":"<id>","v":"<value>"} — see @chat-adapter/telegram callback encoder.
    const wrap = (id: string, value: string): string => `chat:${JSON.stringify({ a: id, v: value })}`;
    const id = shortApprovalId();
    // Telegram hard limit is 64 bytes; allow the longer of the two real values.
    expect(Buffer.byteLength(wrap(id, 'approve'), 'utf8')).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(wrap(id, 'reject'), 'utf8')).toBeLessThanOrEqual(64);
  });

  it('produces no collisions over 50,000 samples (sanity for entropy)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50_000; i++) seen.add(shortApprovalId());
    expect(seen.size).toBe(50_000);
  });
});
