/**
 * Step: signal-auth — link this host to an existing Signal account via
 * signal-cli's QR-code flow.
 *
 * signal-cli `link` opens a bi-directional handshake with the Signal
 * servers: it prints one line containing a linking URL (`sgnl://linkdevice?…`
 * or older `tsdevice://linkdevice?…`), then blocks until either the user
 * scans it from an existing Signal install, or the code expires. On
 * success, a secondary account is created under the user's signal-cli
 * data directory, associated with the phone number of the scanner.
 *
 * Methods:
 *   (no args)                    Spawn signal-cli link, emit SIGNAL_AUTH_QR
 *                                with the URL, wait for completion.
 *
 * Block schema (parent parses these):
 *   SIGNAL_AUTH_QR       { QR: "<sgnl:// or tsdevice:// url>" }   — one-shot
 *   SIGNAL_AUTH          { STATUS: success, ACCOUNT: +<digits> }  — terminal
 *                        { STATUS: skipped, ACCOUNT, REASON: already-authenticated }
 *                        { STATUS: failed, ERROR: <reason> }
 *
 * STATUS values match the runner's vocabulary (success/skipped/failed) so
 * spawnStep recognises them and sets `ok` correctly; Signal-specific UI
 * lives in setup/channels/signal.ts.
 *
 * If one or more accounts are already linked (discovered via
 * `signal-cli -o json listAccounts`), the step emits SIGNAL_AUTH
 * STATUS=skipped with the first account so the driver can reuse it.
 * Selecting a different existing account is a driver concern.
 */
import { spawn, spawnSync } from 'child_process';

import { emitStatus } from './status.js';

const LINK_TIMEOUT_MS = 180_000;
const DEFAULT_DEVICE_NAME = 'NanoClaw';

interface SignalAccount {
  number?: string;
  account?: string;
  registered?: boolean;
}

function cliPath(): string {
  return process.env.SIGNAL_CLI_PATH || 'signal-cli';
}

/**
 * Query signal-cli for currently linked accounts. Empty array if none
 * configured, no binary, or the call fails for any other reason.
 */
function listAccounts(): string[] {
  const cli = cliPath();
  try {
    const res = spawnSync(cli, ['-o', 'json', 'listAccounts'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.status !== 0) return [];
    const parsed = JSON.parse(res.stdout || '[]') as SignalAccount[];
    return parsed
      .filter((a) => a.registered !== false)
      .map((a) => a.number ?? a.account ?? '')
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function run(_args: string[]): Promise<void> {
  const cli = cliPath();

  // Verify signal-cli exists before we commit to the long-running link.
  // The driver checks too, but this keeps the step honest when run alone.
  const probe = spawnSync(cli, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (probe.error || probe.status !== 0) {
    emitStatus('SIGNAL_AUTH', {
      STATUS: 'failed',
      ERROR: 'signal-cli not found. Install signal-cli first.',
    });
    return;
  }

  const existing = listAccounts();
  if (existing.length > 0) {
    emitStatus('SIGNAL_AUTH', {
      STATUS: 'skipped',
      ACCOUNT: existing[0],
      REASON: 'already-authenticated',
    });
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let qrEmitted = false;

    const finish = (block: Record<string, string | number | boolean>, code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      emitStatus('SIGNAL_AUTH', block);
      resolve();
      setTimeout(() => process.exit(code), 500);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      finish({ STATUS: 'failed', ERROR: 'qr_timeout' }, 1);
    }, LINK_TIMEOUT_MS);

    const child = spawn(cli, ['link', '--name', DEFAULT_DEVICE_NAME], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // stdout carries the URL on the first line; subsequent lines may print
    // status like "Associated with: +1555…". We don't strictly need to parse
    // the number — listAccounts after exit is the source of truth — but the
    // URL match drives the QR emit, which is the whole point.
    let stdoutBuf = '';
    const handleStdout = (chunk: Buffer): void => {
      stdoutBuf += chunk.toString('utf-8');
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        // Match both modern (sgnl://) and legacy (tsdevice://) schemes.
        if (/^(sgnl|tsdevice):\/\/linkdevice\?/.test(line) && !qrEmitted) {
          qrEmitted = true;
          emitStatus('SIGNAL_AUTH_QR', { QR: line });
        }
      }
    };
    child.stdout.on('data', handleStdout);

    // Capture stderr for the transcript / log — signal-cli writes warnings
    // and errors there. We don't emit on partial stderr lines since a
    // successful link can still produce noise.
    let stderrBuf = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8');
    });

    child.on('error', (err) => {
      finish({ STATUS: 'failed', ERROR: `spawn error: ${err.message}` }, 1);
    });

    child.on('close', (code) => {
      // After a successful link, signal-cli exits 0 and the newly linked
      // account shows up in listAccounts. Use that as the source of truth
      // rather than scraping stdout — more robust across signal-cli versions.
      if (code === 0) {
        const post = listAccounts();
        if (post.length === 0) {
          finish(
            { STATUS: 'failed', ERROR: 'link exited 0 but no account registered' },
            1,
          );
          return;
        }
        finish({ STATUS: 'success', ACCOUNT: post[0] }, 0);
        return;
      }

      // Non-zero exit. Surface the last non-empty stderr line for context;
      // signal-cli's own error messages are usually informative.
      const lastErr =
        stderrBuf
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-1)[0] ?? `signal-cli link exited with code ${code}`;
      finish({ STATUS: 'failed', ERROR: lastErr }, 1);
    });
  });
}
