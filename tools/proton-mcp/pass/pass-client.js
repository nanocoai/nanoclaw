/**
 * Proton Pass client — wraps pass-cli for vault/item/TOTP operations.
 * Uses execFile (not exec) to prevent shell injection.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PASS_BIN = process.env.PROTON_PASS_BIN || 'pass-cli';
const DEFAULT_VAULT = process.env.PROTON_PASS_VAULT || 'NanoClaw';

const PASS_ENV = { ...process.env, PROTON_PASS_KEY_PROVIDER: 'fs' };

async function runPass(args, { timeout = 15000 } = {}) {
  const { stdout } = await execFileAsync(PASS_BIN, [...args, '--output', 'json'], {
    timeout,
    env: PASS_ENV,
  });
  return JSON.parse(stdout);
}

async function runPassRaw(args, { timeout = 15000 } = {}) {
  const { stdout } = await execFileAsync(PASS_BIN, args, {
    timeout,
    env: PASS_ENV,
  });
  return stdout.trim();
}

export async function listVaults() {
  return runPass(['vault', 'list']);
}

export async function listItems(vault = DEFAULT_VAULT) {
  // item list takes vault name as a positional argument
  return runPass(['item', 'list', vault]);
}

export async function viewItem(title, vault = DEFAULT_VAULT) {
  return runPass(['item', 'view', '--item-title', title, '--vault-name', vault]);
}

export async function searchItems(query, vault = DEFAULT_VAULT) {
  // pass-cli has no search command — filter item list client-side
  const result = await listItems(vault);
  const q = query.toLowerCase();
  const matched = (result.items || []).filter((item) => {
    const t = item.content?.title?.toLowerCase() || '';
    const u = item.content?.content?.Login?.username?.toLowerCase() || '';
    const urls = (item.content?.content?.Login?.urls || []).join(' ').toLowerCase();
    return t.includes(q) || u.includes(q) || urls.includes(q);
  });
  return { items: matched };
}

export async function createItem({ title, username, password, url, notes, vault = DEFAULT_VAULT }) {
  const args = ['item', 'create', 'login',
    '--vault-name', vault,
    '--title', title,
  ];
  if (username) args.push('--username', username);
  if (password) args.push('--password', password);
  if (url) args.push('--url', url);
  // pass-cli create doesn't support --note; notes not available on create
  return runPassRaw(args);
}

export async function updateItem(title, updates, vault = DEFAULT_VAULT) {
  const args = ['item', 'update', '--item-title', title, '--vault-name', vault];
  for (const [key, value] of Object.entries(updates)) {
    if (value) args.push('--field', `${key}=${value}`);
  }
  return runPassRaw(args);
}

export async function trashItem(title, vault = DEFAULT_VAULT) {
  return runPassRaw(['item', 'trash', '--item-title', title, '--vault-name', vault]);
}

export async function getTOTP(title, vault = DEFAULT_VAULT) {
  return runPass(['item', 'totp', '--item-title', title, '--vault-name', vault]);
}
