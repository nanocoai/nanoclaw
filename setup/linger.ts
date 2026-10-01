/**
 * Linger management for Linux user-systemd installs.
 *
 * This module is Linux-only and intentionally not imported from the top of
 * service.ts. setupSystemd loads it via dynamic import so its body never
 * evaluates on macOS (which dispatches to setupLaunchd) or on Linux/WSL
 * installs that fall back to nohup.
 *
 * callers must gate on Linux; safe-but-wasteful elsewhere
 *
 * See issue #2680: enabling linger on per-home-encrypted systems
 * (ecryptfs / fscrypt / gocryptfs) causes the user systemd manager to
 * come up at boot before PAM has decrypted ~/.config/systemd/user/, so it
 * starts with an empty unit table and nanoclaw never launches.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../src/log.js';
import { commandExists } from './platform.js';

export type EncryptedHomeType = 'ecryptfs' | 'fscrypt' | 'gocryptfs';

export interface EncryptedHomeDetection {
  detected: boolean;
  type?: EncryptedHomeType;
  /** Human-readable signal that triggered detection (used in warnings/logs). */
  signal?: string;
}

export interface LingerResult {
  lingerEnabled: boolean;
  encryptedHome?: EncryptedHomeDetection;
}

/**
 * Detect whether $HOME is on per-user-encrypted storage that only gets
 * decrypted at PAM login (ecryptfs, fscrypt, gocryptfs).
 *
 * Block-device encryption (LUKS / dm-crypt) is intentionally NOT a trigger:
 * those volumes are decrypted before userspace and don't break user systemd
 * at boot. See issue #2680 for the failure mode this detection guards.
 *
 * fscrypt is per-directory with no mount entry and no universal marker file,
 * so we rely on the `fscrypt` CLI when present. If it isn't installed, we
 * skip fscrypt detection; there is no safe lightweight probe without it.
 */
export function detectEncryptedHome(
  homeDir: string = os.homedir(),
): EncryptedHomeDetection {
  // findmnt: catches ecryptfs and fuse.gocryptfs cleanly via the mount table.
  // execFileSync (no shell) so a hostile homeDir cannot inject — JSON.stringify
  // does not escape `$` or backticks, and inside shell double-quotes `\"`
  // still terminates the string, so the previous execSync form was a
  // (low-likelihood) injection surface.
  try {
    const fstype = execFileSync(
      'findmnt',
      ['-n', '-T', homeDir, '-o', 'FSTYPE'],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' },
    ).trim();
    if (fstype === 'ecryptfs') {
      return {
        detected: true,
        type: 'ecryptfs',
        signal: `findmnt reports FSTYPE=ecryptfs for ${homeDir}`,
      };
    }
    if (fstype === 'fuse.gocryptfs') {
      return {
        detected: true,
        type: 'gocryptfs',
        signal: `findmnt reports FSTYPE=fuse.gocryptfs for ${homeDir}`,
      };
    }
  } catch {
    // findmnt missing or no mount row; fall through to other probes.
  }

  // ecryptfs marker directories: present on the classic Ubuntu encrypted-home
  // setup even when findmnt is unavailable.
  //
  // NOTE: `~/.Private` can persist after a user migrates *off* an
  // ecryptfs-encrypted home (the ecryptfs-migrate-home script does not always
  // remove it), so this check can produce a false positive on a system that
  // is no longer encrypted. Worst case is linger gets skipped unnecessarily
  // and the user has to run the recovery command once per boot; harmless but
  // worth a future flag to override.
  try {
    if (fs.existsSync(path.join(homeDir, '.ecryptfs'))) {
      return {
        detected: true,
        type: 'ecryptfs',
        signal: `${homeDir}/.ecryptfs exists`,
      };
    }
    if (fs.existsSync(path.join(homeDir, '.Private'))) {
      return {
        detected: true,
        type: 'ecryptfs',
        signal: `${homeDir}/.Private exists`,
      };
    }
  } catch {
    // fs probe failed; ignore.
  }

  // fscrypt: only reliable detection is the fscrypt CLI. The issue body
  // specifically warns against marker-file heuristics, and rolling a raw
  // FS_IOC_GET_ENCRYPTION_POLICY ioctl from Node isn't trivial.
  if (commandExists('fscrypt')) {
    try {
      const out = execFileSync('fscrypt', ['status', homeDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      // `fscrypt status DIR` exits 0 on encrypted dirs and prints lines like
      // "Policy: ..." / "Unlocked: Yes". Match a couple of fscrypt-specific
      // tokens rather than the generic word "encrypted" to avoid false
      // positives on help text.
      //
      // Token match (`Policy:` / `Unlocked:`) verified against fscrypt v0.3.4
      // (google/fscrypt, latest at time of writing). If upstream renames
      // these fields, this probe goes silent (false-negative — linger gets
      // enabled and the original #2680 failure mode is back). Re-check the
      // output format when bumping the supported fscrypt version.
      if (/policy\s*:/i.test(out) || /unlocked\s*:/i.test(out)) {
        return {
          detected: true,
          type: 'fscrypt',
          signal: `fscrypt status reports an encryption policy on ${homeDir}`,
        };
      }
    } catch {
      // Non-zero exit means no fscrypt policy on this dir; ignore.
    }
  }

  return { detected: false };
}

/**
 * Manage user-systemd lingering.
 *
 * Skipped silently on per-home-encrypted systems (ecryptfs / fscrypt /
 * gocryptfs). On those, linger causes the user manager to come up at boot
 * before PAM has decrypted ~/.config/systemd/user/, so it starts with an
 * empty unit table and nanoclaw never launches. See issue #2680.
 *
 * `unitName` is the real per-install systemd unit name returned by
 * getSystemdUnit(projectRoot) (e.g. `nanoclaw-v2-abc123`); it gets
 * interpolated into the recovery command in the warning so a user who
 * copy-pastes does not hit `Unit nanoclaw.service not found.`.
 *
 * TODO(#2680): item 4 of the suggested fix (a PAM / login-hook self-heal
 * that runs `systemctl --user start <unitName>` on first login) is not
 * implemented here. Tracked in the issue.
 *
 * Exported (along with `detect` / `exec` overrides) so service.test.ts can
 * exercise the skip path without shelling out.
 */
export function manageUserLinger(
  unitName: string,
  detect: () => EncryptedHomeDetection = detectEncryptedHome,
  exec: (cmd: string) => void = (cmd: string) =>
    void execSync(cmd, { stdio: 'ignore' }),
): LingerResult {
  const detection = detect();
  if (detection.detected) {
    log.warn(
      [
        `Per-home encryption detected (${detection.type}); skipping`,
        '`loginctl enable-linger`. With linger enabled on a per-home-encrypted',
        'system, the user systemd manager starts at boot before PAM has',
        'decrypted ~/.config/systemd/user/, so it comes up with an empty unit',
        `table and ${unitName} never launches. Without linger, ${unitName}`,
        'will start when you log in after each reboot. If the service is not',
        `running after login, run: systemctl --user daemon-reload &&`,
        `systemctl --user start ${unitName}. See`,
        'https://github.com/nanocoai/nanoclaw/issues/2680.',
      ].join(' '),
      { type: detection.type, signal: detection.signal, unitName },
    );
    return { lingerEnabled: false, encryptedHome: detection };
  }

  try {
    exec('loginctl enable-linger');
    log.info('Enabled loginctl linger for current user');
    return { lingerEnabled: true };
  } catch (err) {
    log.warn(
      'loginctl enable-linger failed; service may stop on SSH logout',
      { err },
    );
    return { lingerEnabled: false };
  }
}
