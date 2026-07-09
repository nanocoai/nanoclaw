/**
 * Signal channel flow for setup:auto.
 *
 * `runSignalChannel(displayName)` owns the full branch from signal-cli
 * presence check through the welcome DM:
 *
 *   1. Probe signal-cli on PATH (or SIGNAL_CLI_PATH). On macOS without it,
 *      offer `brew install signal-cli` inline. On Linux, surface the
 *      GitHub releases URL and bail with an actionable error.
 *   2. Install the adapter + qrcode via setup/add-signal.sh (idempotent).
 *   3. Run the signal-auth step, rendering each SIGNAL_AUTH_QR block as
 *      a terminal QR the operator scans from Signal → Linked Devices.
 *   4. Persist SIGNAL_ACCOUNT to .env.
 *   5. Kick the service so the adapter picks up the new credentials.
 *   6. Ask operator role + agent name.
 *   7. Wire the agent via scripts/init-first-agent.ts; the existing welcome
 *      DM path delivers the greeting through the adapter.
 *
 * Signal's `link` flow creates a *secondary* device. The phone number
 * comes from the primary (the phone that scanned the QR); this host then
 * sends/receives as that primary number. No registration of new numbers.
 *
 * Output obeys the three-level contract: clack UI for the user, structured
 * entries in logs/setup.log, full raw output in per-step files under
 * logs/setup-steps/. See docs/setup-flow.md.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import * as setupLog from '../logs.js';
import { getLaunchdLabel, getSystemdUnit } from '../../src/install-slug.js';
import { BACK_TO_CHANNEL_SELECTION, type ChannelFlowResult } from '../lib/back-nav.js';
import { brightSelect } from '../lib/bright-select.js';
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
import { accentGreen, fmtDuration, note } from '../lib/theme.js';

const DEFAULT_AGENT_NAME = 'Nano';

export async function runSignalChannel(displayName: string): Promise<ChannelFlowResult> {
  note(
    [
      "NanoClaw links to Signal as a *secondary* device on your existing",
      "phone — no new number needed. Your assistant will send and receive",
      "messages as the number on that phone.",
      '',
      "Here's what's about to happen — no input needed for any of it:",
      '',
      '  1. Set up signal-cli (auto-installs if missing)',
      '  2. Install the Signal adapter',
      '  3. Show a QR code — scan it from Signal → Settings → Linked Devices',
      '  4. Wire your assistant and send a welcome message',
    ].join('\n'),
    'Set up Signal',
  );

  const proceed = ensureAnswer(await brightSelect<'continue' | 'back'>({
    message: 'Ready to set up Signal?',
    options: [
      { value: 'continue', label: 'Continue' },
      { value: 'back', label: '← Back to channel selection' },
    ],
    initialValue: 'continue',
  }));
  if (proceed === 'back') return BACK_TO_CHANNEL_SELECTION;

  await ensureSignalCli();

  const install = await runQuietChild(
    'signal-install',
    'bash',
    ['setup/add-signal.sh'],
    {
      running: 'Installing the Signal adapter…',
      done: 'Signal adapter installed.',
      skipped: 'Signal adapter already installed.',
    },
  );
  if (!install.ok) {
    await fail(
      'signal-install',
      "Couldn't install the Signal adapter.",
      'See logs/setup-steps/ for details, then retry setup.',
    );
  }

  const auth = await runSignalAuth();
  if (!auth.ok) {
    const reason = auth.terminal?.fields.ERROR ?? 'unknown';
    await fail(
      'signal-auth',
      `Signal link failed (${reason}).`,
      reason === 'qr_timeout'
        ? 'The code expired. Re-run setup to get a fresh one.'
        : 'Re-run setup to try again.',
    );
  }

  const account = auth.terminal?.fields.ACCOUNT;
  if (!account) {
    await fail(
      'signal-auth',
      'Linked with Signal but couldn\'t read the phone number back.',
      'Run `signal-cli listAccounts` to confirm, then re-run setup.',
    );
  }

  writeSignalAccount(account!);
  await restartService();

  const role = await askOperatorRole('Signal');
  setupLog.userInput('signal_role', role);

  const agentName = await resolveAgentName();

  const init = await runQuietChild(
    'init-first-agent',
    'pnpm',
    [
      'exec', 'tsx', 'scripts/init-first-agent.ts',
      '--channel', 'signal',
      '--user-id', account!,
      '--platform-id', account!,
      '--display-name', displayName,
      '--agent-name', agentName,
      '--role', role,
    ],
    {
      running: `Connecting ${agentName} to Signal…`,
      done: `${agentName} is ready. Check Signal for a welcome message.`,
    },
    {
      extraFields: {
        CHANNEL: 'signal',
        AGENT_NAME: agentName,
        PLATFORM_ID: account!,
        ROLE: role,
      },
    },
  );
  if (!init.ok) {
    await fail(
      'init-first-agent',
      `Couldn't finish connecting ${agentName}.`,
      'You can retry later with `/manage-channels`.',
    );
  }
}

async function ensureSignalCli(): Promise<void> {
  const cli = process.env.SIGNAL_CLI_PATH || 'signal-cli';
  const probeFor = (): boolean => {
    const r = spawnSync(cli, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return !r.error && r.status === 0;
  };
  if (probeFor()) return;

  note(
    [
      "NanoClaw talks to Signal through signal-cli, which isn't installed yet.",
      "We'll install it for you now — about 30 seconds, one-time only.",
      '',
      process.platform === 'darwin'
        ? "On this Mac we'll use Homebrew (no admin password needed)."
        : "On Linux we'll grab the native release binary (no Java needed) and install it to ~/.local/bin.",
    ].join('\n'),
    'Setting up signal-cli',
  );

  const install = await runQuietChild(
    'install-signal-cli',
    'bash',
    ['setup/install-signal-cli.sh'],
    {
      running: 'Installing signal-cli…',
      done: 'signal-cli installed.',
    },
  );

  if (install.ok && probeFor()) return;

  const reason = install.terminal?.fields.ERROR;
  if (process.platform === 'darwin') {
    note(
      [
        "We couldn't install signal-cli automatically.",
        reason === 'homebrew_not_installed'
          ? '  Reason: Homebrew is not installed.'
          : `  Reason: ${reason ?? 'unknown'}.`,
        '',
        'You can install it manually:',
        '',
        k.cyan('  brew install signal-cli'),
        '',
        'Then re-run setup.',
      ].join('\n'),
      "Couldn't install signal-cli",
    );
  } else {
    note(
      [
        "We couldn't install signal-cli automatically.",
        `  Reason: ${reason ?? 'unknown'}.`,
        '',
        'You can install it manually from GitHub:',
        '',
        k.cyan('  https://github.com/AsamK/signal-cli/releases'),
        '',
        'Then re-run setup.',
      ].join('\n'),
      "Couldn't install signal-cli",
    );
  }
  await fail(
    'install-signal-cli',
    'signal-cli is required but the auto-install failed.',
    'Install it manually and re-run setup.',
  );
}

async function runSignalAuth(): Promise<
  StepResult & { rawLog: string; durationMs: number }
> {
  const rawLog = setupLog.stepRawLog('signal-auth');
  const start = Date.now();
  const s = p.spinner();
  s.start('Starting Signal link…');
  let spinnerActive = true;

  const stopSpinner = (msg: string, code?: number): void => {
    if (spinnerActive) {
      s.stop(msg, code);
      spinnerActive = false;
    }
  };

  // Tracks how many lines the QR block occupies so we can wipe it in-place
  // once linking succeeds (Signal's link URL doesn't rotate like WhatsApp's,
  // but we still want to erase the QR from screen once it's served).
  let qrLinesPrinted = 0;

  const result = await spawnStep(
    'signal-auth',
    [],
    (block: Block) => {
      if (block.type === 'SIGNAL_AUTH_QR') {
        const qr = block.fields.QR ?? '';
        if (!qr) return;
        void renderQr(qr).then((lines) => {
          stopSpinner('Scan this QR from Signal → Settings → Linked Devices.');
          process.stdout.write(lines.join('\n') + '\n');
          qrLinesPrinted = lines.length;
          s.start('Waiting for you to scan…');
          spinnerActive = true;
        });
      } else if (block.type === 'SIGNAL_AUTH') {
        const status = block.fields.STATUS;
        // Wipe the QR block regardless of outcome — it's either scanned
        // and useless, or expired and misleading.
        if (qrLinesPrinted > 0) {
          process.stdout.write(`\x1b[${qrLinesPrinted}A\x1b[0J`);
          qrLinesPrinted = 0;
        }
        const account = block.fields.ACCOUNT;
        if (status === 'skipped') {
          stopSpinner(
            account
              ? `Signal already linked as ${k.cyan(account)}.`
              : 'Signal already linked.',
          );
        } else if (status === 'success') {
          stopSpinner(`Signal linked as ${k.cyan(String(account ?? ''))}.`);
        } else if (status === 'failed') {
          const err = block.fields.ERROR ?? 'unknown';
          stopSpinner(`Signal link failed: ${err}`, 1);
        }
      }
    },
    rawLog,
  );
  const durationMs = Date.now() - start;

  if (spinnerActive) {
    stopSpinner(
      result.ok ? 'Done.' : 'Signal link ended unexpectedly.',
      result.ok ? 0 : 1,
    );
    if (!result.ok) dumpTranscriptOnFailure(result.transcript);
  }

  writeStepEntry('signal-auth', result, durationMs, rawLog);
  return { ...result, rawLog, durationMs };
}

/**
 * Render the raw linking URL as a block-art QR, returned line-by-line so
 * the caller can count lines for in-place cleanup. Uses small-mode so the
 * code stays scannable on 24-row terminals. If qrcode isn't installed
 * (add-signal.sh should have handled it, but we're defensive), fall back
 * to the raw URL and ask the user to paste it into an external renderer.
 */
async function renderQr(url: string): Promise<string[]> {
  try {
    const QRCode = await import('qrcode');
    const qrText = await QRCode.toString(url, { type: 'terminal', small: true });
    const caption = k.dim(
      '   Signal → Settings → Linked Devices → Link New Device → scan.',
    );
    return [...qrText.trimEnd().split('\n'), '', caption];
  } catch {
    return [
      'Linking URL (render at https://qr.io or similar):',
      '',
      url,
      '',
      k.dim('Signal → Settings → Linked Devices → Link New Device → scan.'),
    ];
  }
}

/** Persist SIGNAL_ACCOUNT to .env. */
function writeSignalAccount(account: string): void {
  const envPath = path.join(process.cwd(), '.env');
  let contents = '';
  try {
    contents = fs.readFileSync(envPath, 'utf-8');
  } catch {
    contents = '';
  }
  if (/^SIGNAL_ACCOUNT=/m.test(contents)) {
    contents = contents.replace(
      /^SIGNAL_ACCOUNT=.*$/m,
      `SIGNAL_ACCOUNT=${account}`,
    );
  } else {
    if (contents.length > 0 && !contents.endsWith('\n')) contents += '\n';
    contents += `SIGNAL_ACCOUNT=${account}\n`;
  }
  fs.writeFileSync(envPath, contents);

  setupLog.userInput('signal_account', account);
}

async function restartService(): Promise<void> {
  const s = p.spinner();
  s.start('Restarting NanoClaw so it sees your Signal account…');
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
      const user = spawnSync('systemctl', ['--user', 'restart', unit], {
        stdio: 'ignore',
      });
      if (user.status !== 0) {
        spawnSync('sudo', ['systemctl', 'restart', unit], { stdio: 'ignore' });
      }
    }
    // Give the adapter a moment to connect to signal-cli before
    // init-first-agent's welcome DM hits the delivery path.
    await new Promise((r) => setTimeout(r, 5000));
    s.stop(`NanoClaw restarted. ${k.dim(`(${fmtDuration(Date.now() - start)})`)}`);
    setupLog.step('signal-restart', 'success', Date.now() - start, {
      PLATFORM: platform,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    s.stop(`Restart may have failed: ${message}`, 1);
    setupLog.step('signal-restart', 'failed', Date.now() - start, {
      ERROR: message,
    });
    // Non-fatal — the user can restart manually if init-first-agent fails.
  }
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
