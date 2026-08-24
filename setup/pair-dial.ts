/**
 * Step: pair-dial — issue a one-time 6-digit pairing code and wait for the
 * operator to text it to the Dial number from the phone they want registered,
 * proving ownership before the line is wired.
 *
 * Renders the human-facing code card itself (a scannable SMSTO: QR when the
 * line number is known, else the plain code) and emits machine-readable status
 * blocks alongside for programmatic callers (/manage-channels, /init-first-agent,
 * and the runChannelSkill driver) that parse them.
 *
 * Blocks emitted:
 *   PAIR_DIAL_CODE       { CODE }
 *   PAIR_DIAL (final)    { STATUS=success, PLATFORM_ID, PAIRED_NUMBER }
 *                     or { STATUS=failed, ERROR }
 *
 * Depends on src/channels/dial-pairing.js, which the /add-dial skill copies in
 * from the `channels` branch before this step runs. setup/ is excluded from the
 * host tsconfig, so this import resolves only at runtime — tsc won't complain on
 * branches that haven't run add-dial yet (mirrors setup/pair-telegram.ts).
 *
 * That import is deliberately LAZY (inside run(), not at module scope): channels
 * aren't in trunk, so a static import would make merely loading this file throw
 * on a checkout where add-dial hasn't run — taking the whole module, and anything
 * importing it, down with it. Loading it at the point of use keeps the rest of the
 * file usable (and testable) without the adapter present.
 */
import path from 'path';

import * as p from '@clack/prompts';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { grantRole, hasAnyOwner } from '../src/modules/permissions/db/user-roles.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';

import { emitStatus } from './status.js';

/**
 * Grant the owner role to the paired number. This is the trusted grant: it runs
 * inside the operator-run wizard, not from an inbound SMS. Grants at most one
 * owner for the install — if an owner already exists it grants nothing and
 * reports that, so a second paired phone can never silently take ownership.
 * `granted_by` carries the wizard's provenance rather than a self-grant's null.
 */
/** Provenance principal for the wizard's grant (user_roles.granted_by has an FK). */
const WIZARD_PRINCIPAL = 'setup:pair-dial';

export async function grantOwnerFromPairing(
  pairedNumber: string,
  at: string = new Date().toISOString(),
): Promise<{ granted: boolean; userId: string }> {
  const userId = `dial:${pairedNumber}`;
  // Must be awaited: the permissions store is async, and an unawaited call
  // returns a Promise, which is always truthy — that read as "an owner already
  // exists" on every install and silently skipped the grant.
  if (await hasAnyOwner()) return { granted: false, userId };
  // granted_by carries a real principal (the wizard) so provenance is non-null,
  // which the user_roles FK requires — seed that principal before the grant.
  await upsertUser({ id: WIZARD_PRINCIPAL, kind: 'system', display_name: 'setup: pair-dial', created_at: at });
  await upsertUser({ id: userId, kind: 'dial', display_name: null, created_at: at });
  await grantRole({
    user_id: userId,
    role: 'owner',
    agent_group_id: null,
    granted_by: WIZARD_PRINCIPAL,
    granted_at: at,
  });
  return { granted: true, userId };
}

const PAIR_TIMEOUT_MS = 5 * 60_000;

function parseLine(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--line') return args[++i] || null;
  }
  return null;
}

/**
 * Render an SMSTO: URI as terminal-art QR lines. `qrcode` is installed by the
 * add-dial skill; dynamic import so this step loads even if it's absent.
 * Returns [] on any failure so the caller falls back to the plain code.
 */
async function renderSmsQr(uri: string): Promise<string[]> {
  try {
    const QRCode = await import('qrcode');
    const art = await QRCode.toString(uri, { type: 'terminal', small: true });
    return art.trimEnd().split('\n');
  } catch {
    return [];
  }
}

/**
 * Render the pairing card with clack's STATIC primitives (note/log) so it
 * survives the runChannelSkill driver's streaming-exec tee (interactive/animated
 * widgets would not — see setup/pair-telegram.ts for the same constraint).
 */
async function printCodeCard(code: string, lineNumber: string | null): Promise<void> {
  const target = lineNumber ?? 'your Dial number';
  const qrLines = lineNumber ? await renderSmsQr(`SMSTO:${lineNumber}:${code}`) : [];
  if (qrLines.length > 0) {
    p.note(
      [
        ...qrLines,
        '',
        `Scan with your phone camera — it opens Messages pre-filled to ${target}.`,
        `Just press Send. (The message is the code ${code}.)`,
        `Can't scan? Text ${code} to ${target} yourself.`,
      ].join('\n'),
      'Scan to pair',
    );
  } else {
    p.note(
      [
        `   ${code.split('').join('  ')}`,
        '',
        `From the phone you want to use, text only these 6 digits to ${target}.`,
        'This proves the number is yours; you become the owner.',
      ].join('\n'),
      'Pairing code',
    );
  }
  p.log.message('Waiting for your text…');
}

/**
 * While we wait, watch for the line's guess lockout and report it once. A lockout
 * doesn't touch the pairing record `waitForPairing` watches, so without this the
 * wizard would sit on "Waiting for your text…" through a 15-minute cooldown it
 * couldn't explain — and the operator's own correct code would be refused with no
 * hint why. The terminal is the ONLY place a lockout is reported: telling the
 * sender their code was wrong, or that the line is locked, would confirm to
 * whoever is guessing that the line is live.
 *
 * `readLock` is passed in rather than imported so this stays independent of the
 * adapter — run() hands it the real `getLineLock`, tests hand it a stub.
 *
 * Returns a stop function. The timer is unref'd, so an early `process.exit` on the
 * failure path can't leave it holding the process open.
 */
export function watchLineLock(
  lineNumber: string | null,
  readLock: (line: string) => string | null,
  pollMs = 2000,
): () => void {
  // Lockouts are keyed by the inbound line; without --line there's nothing to watch.
  if (!lineNumber) return () => {};
  let reported = false;
  const timer = setInterval(() => {
    if (reported) return;
    const until = readLock(lineNumber);
    if (!until) return;
    reported = true;
    const mins = Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 60_000));
    p.log.warn(
      `Too many wrong codes were texted to ${lineNumber} — pairing is paused for about ${mins} min. ` +
        'Until it lifts even the correct code is refused; re-run this step afterwards for a fresh code.',
    );
  }, pollMs);
  timer.unref();
  return () => clearInterval(timer);
}

export async function run(args: string[]): Promise<void> {
  const lineNumber = parseLine(args);

  // The inbound interceptor that consumes the code runs inside the live service;
  // touch the DB so a fresh install has migrations applied before the first match.
  const db = await initDb(path.join(DATA_DIR, 'v2.db'));
  await runMigrations(db);

  // Lazy: the pairing store ships on the `channels` branch, so it only exists once
  // /add-dial has copied it in. Importing it here keeps module load adapter-free.
  const { createPairing, getLineLock, waitForPairing } = await import('../src/channels/dial-pairing.js');

  const record = await createPairing();
  await printCodeCard(record.code, lineNumber);
  emitStatus('PAIR_DIAL_CODE', { CODE: record.code });

  const stopLockWatch = watchLineLock(lineNumber, getLineLock);
  try {
    const consumed = await Promise.race([
      waitForPairing(record.code),
      new Promise<never>((_, reject) => {
        // .unref() so this timer never keeps the process alive after a successful pair.
        setTimeout(() => reject(new Error('timeout')), PAIR_TIMEOUT_MS).unref();
      }),
    ]);
    stopLockWatch();
    const from = consumed.consumed?.fromNumber;
    if (!from) throw new Error('paired but no number recorded');

    p.log.success(`Paired with ${from}.`);

    // The wizard is the trusted authority for the owner grant — the adapter's
    // inbound handler only records the candidate. Grant here, at most one owner.
    const grant = await grantOwnerFromPairing(from);
    if (grant.granted) {
      p.log.success(`Granted owner to ${from}.`);
    } else {
      p.log.warn(`An owner already exists — leaving ownership unchanged (not granting ${from}).`);
    }

    emitStatus('PAIR_DIAL', {
      STATUS: 'success',
      // Bare E.164 line number — the public line's platform_id. The driver
      // passes it straight through to init-first-agent (Dial platform ids are
      // the bare number, unlike Telegram's prefixed chat id).
      PLATFORM_ID: lineNumber ?? from,
      // Bare sender E.164 — captured as owner_handle; the driver composes
      // `dial:<owner_handle>`.
      PAIRED_NUMBER: from,
    });
  } catch (err) {
    stopLockWatch();
    const reason = err instanceof Error && err.message === 'timeout' ? 'no code received in time' : String(err);
    emitStatus('PAIR_DIAL', { STATUS: 'failed', ERROR: reason.slice(0, 120) });
    process.exit(2);
  }
}
