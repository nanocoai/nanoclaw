import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { isErrno } from './errors.js';

/**
 * The install identity the portal client presents: the install token and the
 * account and install ids from ~/.config/nanoclaw/account.json, which the
 * registry sign-in (setup/registry-login.ts, the WorkOS device flow) writes.
 * Nothing here writes; sign-in owns the file. The install id is the record's
 * `install_id` when present, otherwise the per-machine id in
 * ~/.config/nanoclaw/host-id that the sign-in enrolled with.
 */
export interface InstallIdentity {
  token: string;
  accountId: string;
  installId: string;
}

export function accountFile(homeDir = os.homedir()): string {
  return path.join(homeDir, '.config', 'nanoclaw', 'account.json');
}

export function hostIdFile(homeDir = os.homedir()): string {
  return path.join(homeDir, '.config', 'nanoclaw', 'host-id');
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** The signed-in identity, or null when the machine is not signed in or the record is incomplete. */
export async function readInstallIdentity({ homeDir = os.homedir() } = {}): Promise<InstallIdentity | null> {
  const raw = await readText(accountFile(homeDir));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const token = text(record.token);
  const accountId = text(record.account_id);
  const installId = text(record.install_id) ?? text(await readText(hostIdFile(homeDir)));
  if (!token || !accountId || !installId) return null;
  return { token, accountId, installId };
}
