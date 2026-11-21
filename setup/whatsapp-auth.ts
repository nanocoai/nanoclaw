/**
 * Step: whatsapp-auth — standalone WhatsApp (Baileys) authentication.
 *
 * Forked from the channels-branch version so setup:auto's driver can render
 * the terminal UX itself (inside clack) instead of the step dumping a raw QR
 * to stdout. The browser method has been dropped — one less moving part and
 * it kept biting headless/SSH users.
 *
 * Methods:
 *   --method qr (default)          Emit each rotating QR as a status block
 *                                  with the raw QR string. Driver renders.
 *   --method pairing-code --phone  Request a pairing code. Emitted in a
 *                                  status block once the Baileys call returns.
 *
 * Block schema (parent parses these):
 *   WHATSAPP_AUTH_QR             { QR: "<raw>" }              — repeats
 *   WHATSAPP_AUTH_PAIRING_CODE   { CODE: "XXXX-XXXX" }        — one-shot
 *   WHATSAPP_AUTH                { STATUS: success }          — terminal
 *                                { STATUS: skipped, AUTH_DIR, REASON }
 *                                  only when creds.json holds a finished pairing
 *                                { STATUS: failed, ERROR: <reason> }
 *                                  also sent at once, with the status code,
 *                                  for any close that nothing reconnects (405)
 *
 * STATUS values are kept in the runner's vocabulary (success/skipped/failed)
 * so `spawnStep` recognises them and sets `ok` correctly; WhatsApp-specific
 * UI text (e.g. "WhatsApp linked") lives in the driver's block handler.
 *
 * On success, credentials land in store/auth/ and the process exits 0.
 */
import fs from 'fs';
import path from 'path';
// Named import (not default) — pino's d.ts under NodeNext resolves the
// default export to `typeof pino` (namespace), which isn't callable. The
// named `pino` export resolves to the callable function.
import { pino } from 'pino';

import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { emitStatus } from './status.js';
import { resolveWaWebVersion, type WaWebVersion } from './whatsapp-auth-version.js';

const AUTH_DIR = path.join(process.cwd(), 'store', 'auth');
const PAIRING_CODE_FILE = path.join(process.cwd(), 'store', 'pairing-code.txt');
const baileysLogger = pino({ level: 'silent' });

type AuthMethod = 'qr' | 'pairing-code';

/** Extract the bare phone digits from a WhatsApp JID like `14155551234:12@s.whatsapp.net`. */
function phoneFromId(id?: string | null): string {
  if (!id) return '';
  return id.split(':')[0].split('@')[0];
}

/** Saved credentials. Only a finished pairing writes `account`. */
type SavedCreds = { account?: unknown; me?: { id?: string } };

/**
 * One read of creds.json: the saved creds, 'missing', 'not-json' (for example
 * while a write is rewriting it), or the error that kept it from being opened.
 * Decide from one read only.
 */
function readSavedCreds(): SavedCreds | 'missing' | 'not-json' | NodeJS.ErrnoException {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf-8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : (err as NodeJS.ErrnoException);
  }
  try {
    const creds: unknown = JSON.parse(raw);
    return typeof creds === 'object' && creds !== null ? (creds as SavedCreds) : {};
  } catch {
    return 'not-json';
  }
}

/** Read the linked number from saved credentials (the success path's fallback). */
function readAuthedPhoneFromFile(): string {
  try {
    const raw = fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf-8');
    const creds = JSON.parse(raw) as { me?: { id?: string } };
    return phoneFromId(creds.me?.id);
  } catch {
    return '';
  }
}

/**
 * Render a raw QR payload to terminal block-art lines (small mode keeps it short
 * on 24-row terminals) plus a one-line caption. Returned as plain lines the
 * caller console.logs, so a streaming parent (hostExecStream) tees the live QR
 * straight to the operator's terminal — no parent-side renderQr / in-place redraw.
 */
async function renderQrLines(qr: string): Promise<string[]> {
  try {
    const QRCode = await import('qrcode');
    const art = await QRCode.toString(qr, { type: 'terminal', small: true });
    return [
      ...art.trimEnd().split('\n'),
      '',
      '   Open WhatsApp -> Settings -> Linked Devices -> Link a Device, then scan.',
    ];
  } catch {
    return ['QR code (raw): ' + qr];
  }
}

/** Print the pairing code as a spaced terminal card on plain stdout (teed live). */
function printPairingCard(code: string): void {
  const spaced = code.split('').join('  ');
  console.log(
    [
      '',
      `   ${spaced}`,
      '',
      '   Open WhatsApp -> Settings -> Linked Devices -> Link a Device',
      '   -> "Link with phone number instead" -> enter this code.',
      '   It expires in ~60 seconds.',
      '',
    ].join('\n'),
  );
}

/** True once `work` settles; false if it is still running after `ms`. */
function settled(work: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    void work.then(done, done);
  });
}

function parseArgs(args: string[]): { method: AuthMethod; phone?: string } {
  let method: AuthMethod = 'qr';
  let phone: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--method': {
        const raw = args[++i];
        if (raw === 'qr' || raw === 'pairing-code') {
          method = raw;
        } else {
          console.error(`Unknown --method: ${raw} (expected 'qr' or 'pairing-code')`);
          process.exit(1);
        }
        break;
      }
      case '--phone':
        phone = args[++i];
        break;
    }
  }

  if (method === 'pairing-code' && !phone) {
    console.error('--phone is required for pairing-code method');
    process.exit(1);
  }

  return { method, phone };
}

export async function run(args: string[]): Promise<void> {
  const { method, phone } = parseArgs(args);

  // Baileys rewrites creds.json in place, so a running service can leave it half
  // written for a moment: read it again, for up to 1 s, before judging it.
  let saved = readSavedCreds();
  for (let tries = 0; tries < 5 && saved === 'not-json'; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    saved = readSavedCreds();
  }
  // A file this step can't read may yet hold a link, so never say to clear it.
  if (saved instanceof Error) {
    emitStatus('WHATSAPP_AUTH', {
      STATUS: 'failed',
      ERROR: `store/auth/creds.json could not be opened (${saved.code ?? saved.message}). Make it readable by the user running setup, then run the step again.`,
    });
    process.exit(1);
  }
  if (saved === 'not-json') {
    emitStatus('WHATSAPP_AUTH', {
      STATUS: 'failed',
      ERROR:
        'store/auth/creds.json is not valid JSON (it may be mid-write). Stop the NanoClaw service if it is running, then run the step again.',
    });
    process.exit(1);
  }
  if (saved !== 'missing' && saved.account) {
    emitStatus('WHATSAPP_AUTH', {
      STATUS: 'skipped',
      REASON: 'already-authenticated',
      AUTH_DIR,
      PHONE: typeof saved.me?.id === 'string' ? phoneFromId(saved.me.id) : '',
    });
    return;
  }
  // Creds without `account` are not a link, and can't be reused: a requested pairing
  // code saves `me`, and Baileys then logs in as that `me` instead of linking.
  if (saved !== 'missing') {
    emitStatus('WHATSAPP_AUTH', {
      STATUS: 'failed',
      ERROR:
        'store/auth/ has WhatsApp credentials but no linked device (for example, from a pairing code that was never entered). Clear store/auth/ and run the step again.',
    });
    process.exit(1);
  }

  // Once, before connecting: a failure is reported as this step's own block,
  // and the 515 reconnect reuses the version instead of looking it up mid-link.
  let version: WaWebVersion;
  try {
    version = await resolveWaWebVersion(fetchLatestWaWebVersion);
  } catch (err) {
    emitStatus('WHATSAPP_AUTH', { STATUS: 'failed', ERROR: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      emitStatus('WHATSAPP_AUTH', { STATUS: 'failed', ERROR: 'timeout' });
      process.exit(1);
    }, 120_000);

    let succeeded = false;
    function succeed(phone?: string): void {
      if (succeeded) return;
      succeeded = true;
      clearTimeout(timeout);
      try {
        if (fs.existsSync(PAIRING_CODE_FILE)) fs.unlinkSync(PAIRING_CODE_FILE);
      } catch {
        // ignore — the pairing code file is best-effort cleanup
      }
      // Surface the linked number in the terminal block so the SKILL.md's
      // `nc:run effect:step capture:bot_phone=PHONE` binds it straight from the
      // block, instead of the caller reading it back out of store/auth/creds.json.
      emitStatus('WHATSAPP_AUTH', {
        STATUS: 'success',
        PHONE: phone || readAuthedPhoneFromFile(),
      });
      resolve();
      // Give a moment for creds to flush before exiting.
      setTimeout(() => process.exit(0), 1000);
    }

    async function connectSocket(isReconnect = false): Promise<void> {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      // Only a finished pairing saves `account` (a requested pairing code already
      // saves `me`), so a 515 reconnect finds it on disk; this socket's own
      // pairing shows up as isNewLogin below.
      let paired = Boolean(state.creds.account);
      let saving: Promise<unknown> = Promise.resolve();

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        printQRInTerminal: false,
        logger: baileysLogger,
        browser: Browsers.macOS('Chrome'),
      });

      // Request pairing code only on first connect (not reconnect after 515).
      if (!isReconnect && method === 'pairing-code' && phone && !state.creds.registered) {
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(phone);
            fs.writeFileSync(PAIRING_CODE_FILE, code, 'utf-8');
            // Render the code as a plain-stdout card so a streaming parent tees
            // it live to the operator; keep the block for block-parsing callers.
            emitStatus('WHATSAPP_AUTH_PAIRING_CODE', { CODE: code });
            printPairingCard(code);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            emitStatus('WHATSAPP_AUTH', { STATUS: 'failed', ERROR: message });
            process.exit(1);
          }
        }, 3000);
      }

      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr, isNewLogin } = update;
        if (isNewLogin) paired = true;

        // QR method: render each rotation as plain stdout lines so a streaming
        // parent (hostExecStream) tees the live QR straight to the operator's
        // terminal. The raw-QR status block is kept for any block-parsing caller.
        if (qr && method === 'qr') {
          emitStatus('WHATSAPP_AUTH_QR', { QR: qr });
          void renderQrLines(qr).then((lines) => {
            console.log('\n' + lines.join('\n'));
          });
        }

        if (connection === 'open') {
          succeed(phoneFromId(sock.user?.id ?? state.creds.me?.id));
          sock.end(undefined);
        }

        // Our own sock.end() after a successful link closes too; that is not a failure.
        if (connection === 'close' && !succeeded) {
          const err = lastDisconnect?.error as { message?: string; output?: { statusCode?: number } } | undefined;
          const reason = err?.output?.statusCode;
          if (reason === DisconnectReason.loggedOut) {
            clearTimeout(timeout);
            emitStatus('WHATSAPP_AUTH', {
              STATUS: 'failed',
              ERROR: 'logged_out',
            });
            process.exit(1);
          } else if (reason === DisconnectReason.timedOut) {
            clearTimeout(timeout);
            emitStatus('WHATSAPP_AUTH', {
              STATUS: 'failed',
              ERROR: 'qr_timeout',
            });
            process.exit(1);
          } else if (reason === 515) {
            // 515 = stream error after pairing succeeds but before registration
            // completes. Reconnect to finish the handshake.
            connectSocket(true);
          } else {
            // Nothing reconnects after any other close (405 = WhatsApp refused this
            // WhatsApp Web version), so waiting would only end in a misleading timeout.
            clearTimeout(timeout);
            const detail = `${reason ?? 'no status'} ${err?.message ?? ''}`.replace(/\s+/g, ' ').trim();
            const fail = (error: string): void => {
              emitStatus('WHATSAPP_AUTH', { STATUS: 'failed', ERROR: error });
              process.exit(1);
            };
            if (!paired) {
              fail(
                `WhatsApp closed the connection before linking (${detail}). Clear store/auth/ and run the step again.`,
              );
            } else {
              // A paired device stays in store/auth/ for the next run, so once the creds
              // writes settle (at most 5 s), report what creds.json holds. With a write
              // still running the file could yet change, so the link is only probably saved.
              void settled(saving, 5000).then((done) => {
                const after = `WhatsApp closed the connection after pairing (${detail})`;
                const saved = readSavedCreds();
                if (saved === 'not-json' || saved instanceof Error) {
                  fail(
                    `${after}, but store/auth/creds.json could not be read. Run the step again to check the saved link.`,
                  );
                } else if (saved === 'missing' || !saved.account) {
                  fail(`${after}, but the link was not saved. Clear store/auth/ and run the step again.`);
                } else if (done) {
                  fail(`${after}. The link is saved in store/auth/, so run the step again to use it.`);
                } else {
                  fail(
                    `${after}. The link is probably saved in store/auth/ (a creds write had not finished), so run the step again to use it.`,
                  );
                }
              });
            }
          }
        }
      });

      // A close after pairing waits for every write to settle before it reads creds.json.
      sock.ev.on('creds.update', () => {
        saving = Promise.allSettled([saving, saveCreds()]);
      });
    }

    connectSocket();
  });
}
