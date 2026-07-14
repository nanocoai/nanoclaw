/**
 * Pilot activation persistence — one row per registration code.
 *
 * Lifecycle: pending → used. Expiry is checked at consume time against
 * `expires_at` (24h from creation); expired codes are never deleted, so
 * the START handler can tell "expired" apart from "never existed" and
 * reply with a friendly "request a new link" instead of silence.
 */
import crypto from 'crypto';

import { getDb } from '../../db/connection.js';

export type PilotLang = 'he' | 'en';

export interface PilotActivation {
  code: string;
  lang: PilotLang;
  /** JSON blob: { name?, email?, phone? } — contact metadata only, never routing. */
  metadata: string | null;
  created_at: string;
  expires_at: string;
  status: 'pending' | 'used';
  used_by_user_id: string | null;
  used_at: string | null;
  agent_group_id: string | null;
  pilot_started_at: string | null;
  pilot_ends_at: string | null;
}

export const CODE_TTL_HOURS = 24;
export const PILOT_WINDOW_DAYS = 10;

/**
 * Codes ride in a t.me deep link (`?start=<code>`), which allows
 * [A-Za-z0-9_-]{1,64}. 20 chars from an unambiguous uppercase alphabet
 * (no 0/O/1/I) ≈ 100 bits — unguessable, and visually distinct from the
 * 4-digit setup pairing codes so the two interceptors never collide.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 20;

export function generatePilotCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

/** Matches text that could be a pilot code (used to cheaply gate the interceptor). */
export function looksLikePilotCode(candidate: string): boolean {
  return new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(candidate);
}

export function createActivation(input: {
  lang: PilotLang;
  metadata?: Record<string, unknown> | null;
}): PilotActivation {
  const now = new Date();
  const expires = new Date(now.getTime() + CODE_TTL_HOURS * 3600 * 1000);
  const row: PilotActivation = {
    code: generatePilotCode(),
    lang: input.lang,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    status: 'pending',
    used_by_user_id: null,
    used_at: null,
    agent_group_id: null,
    pilot_started_at: null,
    pilot_ends_at: null,
  };
  getDb()
    .prepare(
      `INSERT INTO pilot_activations (code, lang, metadata, created_at, expires_at, status)
       VALUES (@code, @lang, @metadata, @created_at, @expires_at, @status)`,
    )
    .run(row as unknown as Record<string, unknown>);
  return row;
}

export function getActivation(code: string): PilotActivation | undefined {
  return getDb().prepare('SELECT * FROM pilot_activations WHERE code = ?').get(code) as PilotActivation | undefined;
}

export function isExpired(activation: PilotActivation, now = new Date()): boolean {
  return now.toISOString() > activation.expires_at;
}

/**
 * Atomically consume a pending, unexpired code. Returns the row when this
 * call did the consuming; null when the code was already used, expired, or
 * unknown (callers then inspect getActivation for the friendly-error path).
 * The single UPDATE with status guard makes concurrent START presses safe.
 */
export function consumeActivation(
  code: string,
  usedBy: { userId: string; agentGroupId: string },
): PilotActivation | null {
  const now = new Date();
  const pilotEnds = new Date(now.getTime() + PILOT_WINDOW_DAYS * 24 * 3600 * 1000);
  const result = getDb()
    .prepare(
      `UPDATE pilot_activations
       SET status = 'used', used_by_user_id = @userId, used_at = @usedAt,
           agent_group_id = @agentGroupId, pilot_started_at = @usedAt, pilot_ends_at = @pilotEnds
       WHERE code = @code AND status = 'pending' AND expires_at > @usedAt`,
    )
    .run({
      code,
      userId: usedBy.userId,
      agentGroupId: usedBy.agentGroupId,
      usedAt: now.toISOString(),
      pilotEnds: pilotEnds.toISOString(),
    });
  if (result.changes === 0) return null;
  return getActivation(code)!;
}

/**
 * The user's current active pilot, if any — enforces "one active agent per
 * Telegram user". Active = consumed and still inside the 10-day window.
 */
export function findActivePilotByUser(userId: string): PilotActivation | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM pilot_activations
       WHERE used_by_user_id = ? AND status = 'used' AND pilot_ends_at > ?
       ORDER BY used_at DESC LIMIT 1`,
    )
    .get(userId, new Date().toISOString()) as PilotActivation | undefined;
}
