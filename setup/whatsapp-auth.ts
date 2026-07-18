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
 *                                { STATUS: failed, ERROR: <reason> }
 *
 * STATUS values are kept in the runner's vocabulary (success/skipped/failed)
 * so `spawnStep` recognises them and sets `ok` correctly; WhatsApp-specific
 * UI text (e.g. "WhatsApp linked") lives in the driver's block handler.
 *
 * On success, credentials land in store/auth/ and the process exits 0.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
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

const AUTH_DIR = path.join(process.cwd(), 'store', 'auth');
const PAIRING_CODE_FILE = path.join(process.cwd(), 'store', 'pairing-code.txt');
const baileysLogger = pino({ level: 'silent' });

// Baileys v6 bug: getPlatformId sends charCode (49) instead of enum value (1).
// Fixed in Baileys 7.x but not backported. Without this patch pairing codes
// fail with "couldn't link device" because WhatsApp receives an invalid
// platform id. createRequire because proto is not a named ESM export.
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { proto } = _require('@whiskeysockets/baileys') as { proto: any };
try {
  const _generics = _require(
    '@whiskeysockets/baileys/lib/Utils/generics',
  ) as Record<string, unknown>;
  _generics.getPlatformId = (browser: string): string => {
    const platformType =
      proto.DeviceProps.PlatformType[
        browser.toUpperCase() as keyof typeof proto.DeviceProps.PlatformType
      ];
    return platformType ? platformType.toString() : '1';
  };
} catch {
  // If CJS require fails, QR auth still works; only pairing code may be affected.
}

type AuthMethod = 'qr' | 'pairing-code';

/** Extract the bare phone digits from a WhatsApp JID like `14155551234:12@s.whatsapp.net`. */
function phoneFromId(id?: string | null): string {
  if (!id) return '';
  return id.split(':')[0].split('@')[0];
}

/** Read the linked number from saved credentials (the skipped / already-authed path). */
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

  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    emitStatus('WHATSAPP_AUTH', {
      STATUS: 'skipped',
      REASON: 'already-authenticated',
      AUTH_DIR,
      PHONE: readAuthedPhoneFromFile(),
    });
    return;
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
      const { version } = await fetchLatestWaWebVersion({}).catch(() => ({
        version: undefined,
      }));

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
      if (
        !isReconnect &&
        method === 'pairing-code' &&
        phone &&
        !state.creds.registered
      ) {
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
        const { connection, lastDisconnect, qr } = update;

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

        if (connection === 'close') {
          const reason = (
            lastDisconnect?.error as { output?: { statusCode?: number } }
          )?.output?.statusCode;
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
          }
        }
      });

      sock.ev.on('creds.update', saveCreds);
    }

    connectSocket();
  });
}
