/**
 * WhatsApp (community/Baileys) channel flow for setup:auto.
 *
 * `runWhatsAppChannel(displayName)` owns the full branch from auth-method
 * picker through the welcome DM:
 *
 *   1. Ask how to authenticate (QR code in terminal, default, or pairing code)
 *   2. If pairing-code: collect the phone number
 *   3. Install the adapter + Baileys + QR + pino via setup/add-whatsapp.sh
 *   4. Run the whatsapp-auth step, rendering status blocks as clack UI:
 *      - WHATSAPP_AUTH_QR (repeating): render the QR as terminal block art
 *        inside a clack note. On rotation we clear the previous QR in-place
 *        via ANSI escapes so the terminal doesn't fill up with stale codes.
 *      - WHATSAPP_AUTH_PAIRING_CODE (one-shot): centred code card.
 *   5. Read store/auth/creds.json → extract the authenticated (bot) phone
 *   6. Kick the service so the adapter picks up the new credentials
 *   7. Ask the operator for the phone they'll chat from (defaults to the
 *      authed number). Different number ⇒ dedicated mode ⇒ also writes
 *      ASSISTANT_HAS_OWN_NUMBER=true so outbound replies aren't prefixed
 *   8. Ask for the messaging-agent name (defaulting to "Nano")
 *   9. Wire the agent via scripts/init-first-agent.ts; the existing welcome
 *      DM path delivers the greeting through the adapter
 *
 * All output obeys the three-level contract: clack UI for the user, structured
 * entries in logs/setup.log, full raw output in per-step files under
 * logs/setup-steps/. See docs/setup-flow.md.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import * as setupLog from '../logs.js';
import { BACK_TO_CHANNEL_SELECTION, type ChannelFlowResult } from '../lib/back-nav.js';
import { brightSelect } from '../lib/bright-select.js';
import { getLaunchdLabel, getSystemdUnit } from '../../src/install-slug.js';
import {
  type Block,
  type StepResult,
  dumpTranscriptOnFailure,
  ensureAnswer,
  fail,
  runQuietChild,
  spawnStep,
  writeStepEntry,
} from '../lib/runner.js';
import { askOperatorRole } from '../lib/role-prompt.js';
import { accentGreen, brandBody, brandBold, fmtDuration, note } from '../lib/theme.js';

const DEFAULT_AGENT_NAME = 'Nano';
const AUTH_CREDS_PATH = path.join(process.cwd(), 'store', 'auth', 'creds.json');

type AuthMethod = 'qr' | 'pairing-code';

export async function runWhatsAppChannel(displayName: string): Promise<ChannelFlowResult> {
  const method = await askAuthMethod();
  if (method === 'back') return BACK_TO_CHANNEL_SELECTION;
  const phone = method === 'pairing-code' ? await askPhoneNumber() : undefined;

  const install = await runQuietChild(
    'whatsapp-install',
    'bash',
    ['setup/add-whatsapp.sh'],
    {
      running: 'Installing the WhatsApp adapter…',
      done: 'WhatsApp adapter installed.',
      skipped: 'WhatsApp adapter already installed.',
    },
  );
  if (!install.ok) {
    fail(
      'whatsapp-install',
      "Couldn't install the WhatsApp adapter.",
      'See logs/setup-steps/ for details, then retry setup.',
    );
  }

  const auth = await runWhatsAppAuth(method, phone);
  if (!auth.ok) {
    const reason = auth.terminal?.fields.ERROR ?? 'unknown';
    fail(
      'whatsapp-auth',
      `WhatsApp authentication failed (${reason}).`,
      reason === 'qr_timeout' || reason === 'timeout'
        ? 'The code expired. Re-run setup to get a fresh one.'
        : 'Re-run setup to try again.',
    );
  }

  const botPhone = readAuthedPhone();
  if (!botPhone) {
    fail(
      'whatsapp-auth',
      "Authenticated but couldn't read your WhatsApp number from the saved credentials.",
      'Re-run setup to try again.',
    );
  }

  await restartService();

  const chatPhone = await askChatPhone(botPhone);
  const isDedicated = chatPhone !== botPhone;
  if (isDedicated) {
    writeAssistantHasOwnNumber();
  }

  const role = await askOperatorRole('WhatsApp');
  setupLog.userInput('whatsapp_role', role);

  const agentName = await resolveAgentName();

  const platformId = `${chatPhone}@s.whatsapp.net`;

  const init = await runQuietChild(
    'init-first-agent',
    'pnpm',
    [
      'exec', 'tsx', 'scripts/init-first-agent.ts',
      '--channel', 'whatsapp',
      '--user-id', platformId,
      '--platform-id', platformId,
      '--display-name', displayName,
      '--agent-name', agentName,
      '--role', role,
    ],
    {
      running: `Connecting ${agentName} to WhatsApp…`,
      done: isDedicated
        ? `${agentName} is ready. Check WhatsApp for a welcome message.`
        : `${agentName} is ready. Look in your "You" chat on WhatsApp for the welcome.`,
    },
    {
      extraFields: {
        CHANNEL: 'whatsapp',
        AGENT_NAME: agentName,
        PLATFORM_ID: platformId,
        MODE: isDedicated ? 'dedicated' : 'shared',
        ROLE: role,
      },
    },
  );
  if (!init.ok) {
    fail(
      'init-first-agent',
      `Couldn't finish connecting ${agentName}.`,
      'You can retry later with `/manage-channels`.',
    );
  }
}

async function askAuthMethod(): Promise<AuthMethod | 'back'> {
  const choice = ensureAnswer(
    await brightSelect({
      message: 'How would you like to authenticate with WhatsApp?',
      options: [
        {
          value: 'qr',
          label: 'Scan a QR code in this terminal',
          hint: 'recommended',
        },
        {
          value: 'pairing-code',
          label: 'Enter a pairing code on your phone',
          hint: 'no camera needed',
        },
        {
          value: 'back',
          label: '← Back to channel selection',
        },
      ],
    }),
  ) as AuthMethod | 'back';
  if (choice !== 'back') setupLog.userInput('whatsapp_auth_method', choice);
  return choice;
}

async function askPhoneNumber(): Promise<string> {
  note(
    [
      "Enter your phone number the way WhatsApp expects it:",
      '',
      '  • Digits only — no +, spaces, or dashes',
      '  • Country code first, then the rest of the number',
      '',
      k.dim('Example: 14155551234 (country code 1, then 4155551234)'),
    ].join('\n'),
    'Your phone number',
  );
  const answer = ensureAnswer(
    await p.text({
      message: 'Phone number',
      validate: (v) => {
        const t = (v ?? '').trim();
        if (!t) return 'Phone number is required';
        if (!/^\d{8,15}$/.test(t)) {
          return "That doesn't look right. Digits only, country code included.";
        }
        return undefined;
      },
    }),
  );
  const phone = (answer as string).trim();
  setupLog.userInput('whatsapp_phone', phone);
  return phone;
}

async function runWhatsAppAuth(
  method: AuthMethod,
  phone: string | undefined,
): Promise<StepResult & { rawLog: string; durationMs: number }> {
  const rawLog = setupLog.stepRawLog('whatsapp-auth');
  const start = Date.now();
  const s = p.spinner();
  s.start('Starting WhatsApp authentication…');
  let spinnerActive = true;

  const stopSpinner = (msg: string, code?: number) => {
    if (spinnerActive) {
      s.stop(msg, code);
      spinnerActive = false;
    }
  };

  // Tracks the QR render so we can overwrite it in-place on rotation. null
  // before the first QR is printed.
  let qrLinesPrinted = 0;

  const extra =
    method === 'pairing-code' && phone
      ? ['--method', 'pairing-code', '--phone', phone]
      : ['--method', 'qr'];

  const result = await spawnStep(
    'whatsapp-auth',
    extra,
    (block: Block) => {
      if (block.type === 'WHATSAPP_AUTH_QR') {
        const qr = block.fields.QR ?? '';
        if (!qr) return;
        // Fire-and-forget — await inside spawnStep's sync onBlock is fine
        // since spawnStep's own logic keeps running in parallel.
        void renderQr(qr).then((lines) => {
          if (qrLinesPrinted === 0) {
            stopSpinner('QR code ready — scan with WhatsApp.');
          } else {
            // Cursor up N lines + clear from there to end of screen. Wipes
            // the previous QR + caption so the new one renders in place.
            process.stdout.write(`\x1b[${qrLinesPrinted}A\x1b[0J`);
          }
          process.stdout.write(lines.join('\n') + '\n');
          qrLinesPrinted = lines.length;
        });
      } else if (block.type === 'WHATSAPP_AUTH_PAIRING_CODE') {
        const code = block.fields.CODE ?? '????';
        stopSpinner('Your pairing code is ready.');
        note(formatPairingCard(code), 'Pairing code');
        s.start('Waiting for you to enter the code…');
        spinnerActive = true;
      } else if (block.type === 'WHATSAPP_AUTH') {
        const status = block.fields.STATUS;
        if (status === 'skipped') {
          stopSpinner('WhatsApp is already authenticated.');
        } else if (status === 'success') {
          // Erase the QR block if one was on screen — it's served its purpose.
          if (qrLinesPrinted > 0) {
            process.stdout.write(`\x1b[${qrLinesPrinted}A\x1b[0J`);
            qrLinesPrinted = 0;
          }
          // In QR flow the spinner was stopped when the first QR landed.
          // Fall back to a plain success line so the user sees confirmation.
          if (spinnerActive) {
            stopSpinner('WhatsApp linked.');
          } else {
            p.log.success(brandBody('WhatsApp linked.'));
          }
        } else if (status === 'failed') {
          if (qrLinesPrinted > 0) {
            process.stdout.write(`\x1b[${qrLinesPrinted}A\x1b[0J`);
            qrLinesPrinted = 0;
          }
          const err = block.fields.ERROR ?? 'unknown';
          if (spinnerActive) {
            stopSpinner(`Authentication failed: ${err}`, 1);
          } else {
            p.log.error(`Authentication failed: ${err}`);
          }
        }
      }
    },
    rawLog,
  );
  const durationMs = Date.now() - start;

  // Safety net — if the step died without emitting a terminal block, don't
  // leave the spinner running.
  if (spinnerActive) {
    stopSpinner(
      result.ok ? 'Done.' : 'Authentication ended unexpectedly.',
      result.ok ? 0 : 1,
    );
    if (!result.ok) dumpTranscriptOnFailure(result.transcript);
  }

  writeStepEntry('whatsapp-auth', result, durationMs, rawLog);
  return { ...result, rawLog, durationMs };
}

/**
 * Render the raw QR string to an array of terminal lines (block-art QR +
 * a caption). Returned as an array so the caller can count lines for the
 * in-place rewrite on rotation. Uses the small-mode QR to keep the height
 * manageable on 24-row terminals.
 */
async function renderQr(qr: string): Promise<string[]> {
  try {
    const QRCode = await import('qrcode');
    const qrText = await QRCode.toString(qr, { type: 'terminal', small: true });
    const caption = k.dim(
      '   Open WhatsApp → You / Settings → Linked Devices → Link a Device → scan.',
    );
    return [...qrText.trimEnd().split('\n'), '', caption];
  } catch {
    return ['QR code (raw): ' + qr];
  }
}

function formatPairingCard(code: string): string {
  // WhatsApp pairing codes are 8 characters; render with two-wide gap so the
  // digits read clearly in the terminal.
  const spaced = code.split('').join('  ');
  return [
    '',
    `   ${brandBold(spaced)}`,
    '',
    k.dim('   Open WhatsApp → You / Settings → Linked Devices → Link a Device'),
    k.dim('   → "Link with phone number instead" → enter this code.'),
    k.dim('   It expires in ~60 seconds.'),
  ].join('\n');
}

/**
 * Pull the authenticated WhatsApp phone out of store/auth/creds.json.
 * `creds.me.id` looks like `14155551234:<device>@s.whatsapp.net` — we want
 * just the leading digit run.
 */
function readAuthedPhone(): string {
  try {
    const raw = fs.readFileSync(AUTH_CREDS_PATH, 'utf-8');
    const creds = JSON.parse(raw) as { me?: { id?: string } };
    const id = creds.me?.id;
    if (!id) return '';
    return id.split(':')[0].split('@')[0];
  } catch {
    return '';
  }
}

async function restartService(): Promise<void> {
  const s = p.spinner();
  s.start('Restarting NanoClaw so it sees your WhatsApp credentials…');
  const start = Date.now();
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      spawnSync(
        'launchctl',
        ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${getLaunchdLabel()}`],
        { stdio: 'ignore' },
      );
    } else if (platform === 'linux') {
      const unit = getSystemdUnit();
      const user = spawnSync(
        'systemctl',
        ['--user', 'restart', unit],
        { stdio: 'ignore' },
      );
      if (user.status !== 0) {
        spawnSync('sudo', ['systemctl', 'restart', unit], {
          stdio: 'ignore',
        });
      }
    }
    // Give the adapter a moment to reconnect before init-first-agent's
    // welcome DM hits the delivery path.
    await new Promise((r) => setTimeout(r, 5000));
    s.stop(`NanoClaw restarted. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`);
    setupLog.step('whatsapp-restart', 'success', Date.now() - start, {
      PLATFORM: platform,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    s.stop(`Restart may have failed: ${message}`, 1);
    setupLog.step('whatsapp-restart', 'failed', Date.now() - start, {
      ERROR: message,
    });
    // Non-fatal — the user can restart manually if init-first-agent fails.
  }
}

async function askChatPhone(authedPhone: string): Promise<string> {
  note(
    [
      `Authenticated with ${k.cyan('+' + authedPhone)}.`,
      '',
      "What's the phone number you'll chat with your agent from?",
      '',
      k.dim(
        'Same number = messages will land in your "You" / self-chat on WhatsApp\n' +
          "(you won't be able to reply to yourself — use a different number for a\n" +
          'two-way chat).',
      ),
    ].join('\n'),
    'Your chat number',
  );
  const answer = ensureAnswer(
    await p.text({
      message: 'Your personal phone number',
      placeholder: authedPhone,
      defaultValue: authedPhone,
      validate: (v) => {
        const t = (v ?? authedPhone).trim();
        if (!/^\d{8,15}$/.test(t)) {
          return 'Digits only, country code included.';
        }
        return undefined;
      },
    }),
  );
  const phone = ((answer as string) || authedPhone).trim();
  setupLog.userInput('whatsapp_chat_phone', phone);
  return phone;
}

/** Persist ASSISTANT_HAS_OWN_NUMBER=true to .env. */
function writeAssistantHasOwnNumber(): void {
  const envPath = path.join(process.cwd(), '.env');
  let contents = '';
  try {
    contents = fs.readFileSync(envPath, 'utf-8');
  } catch {
    contents = '';
  }
  if (/^ASSISTANT_HAS_OWN_NUMBER=/m.test(contents)) {
    contents = contents.replace(
      /^ASSISTANT_HAS_OWN_NUMBER=.*$/m,
      'ASSISTANT_HAS_OWN_NUMBER=true',
    );
  } else {
    if (contents.length > 0 && !contents.endsWith('\n')) contents += '\n';
    contents += 'ASSISTANT_HAS_OWN_NUMBER=true\n';
  }
  fs.writeFileSync(envPath, contents);
}

async function resolveAgentName(): Promise<string> {
  const preset = process.env.NANOCLAW_AGENT_NAME?.trim();
  if (preset) {
    setupLog.userInput('agent_name', preset);
    return preset;
  }
  const answer = ensureAnswer(
    await p.text({
      message: `What should your ${accentGreen('assistant')} be called?`,
      placeholder: DEFAULT_AGENT_NAME,
      defaultValue: DEFAULT_AGENT_NAME,
    }),
  );
  const value = (answer as string).trim() || DEFAULT_AGENT_NAME;
  setupLog.userInput('agent_name', value);
  return value;
}
