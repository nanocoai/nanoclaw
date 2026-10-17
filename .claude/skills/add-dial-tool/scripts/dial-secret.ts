/**
 * Stores the host's Dial API key in the OneCLI vault of the gateway the onecli
 * CLI writes to (the one the gate checked and the grants go to) and prints the
 * secret id. An existing Dial entry is updated in place, so its id and every
 * grant stay, including another install's on a shared gateway. The key is read
 * from the host auth file and never reaches argv or stdout.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createOneCliCredentialConnection } from '../../add-onecli/scripts/provider-credentials.js';

export const DIAL_SECRET = {
  name: 'Dial API',
  type: 'generic',
  hostPattern: 'api.getdial.ai',
  injectionConfig: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
} as const;

export function dialAuthFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'dial', 'auth.v1.json');
}

type Run = (args: string[]) => string;
const onecli: Run = (args) => execFileSync('onecli', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const field = (output: string, key: string): string => {
  try {
    const value = (JSON.parse(output) as Record<string, unknown>)[key];
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
};

/** The gateway the onecli CLI writes to, and its key ('' for a gateway with ambient local auth). */
export function cliConnection(run: Run = onecli): { url: string; apiKey: string } {
  let url = '';
  try {
    url = field(run(['config', 'get', 'api-host']), 'value');
  } catch {
    url = '';
  }
  if (!url) throw new Error("could not read the onecli CLI's api-host, so the OneCLI gateway is unknown");
  let apiKey = '';
  try {
    apiKey = field(run(['auth', 'api-key']), 'apiKey');
  } catch {
    apiKey = '';
  }
  return { url, apiKey };
}

export async function storeDialKey(
  authFile = dialAuthFile(),
  connection: { url: string; apiKey: string } = cliConnection(),
  fetchImpl: typeof fetch = globalThis.fetch,
  root = process.cwd(),
): Promise<string> {
  let key = '';
  try {
    const value = (JSON.parse(fs.readFileSync(authFile, 'utf8')) as { apiKey?: unknown }).apiKey;
    key = typeof value === 'string' ? value.trim() : '';
  } catch {
    // Reported below without echoing the file.
  }
  if (!key) {
    throw new Error('no Dial API key in the host auth file — sign in with dial auth login / verify-otp, then re-run');
  }
  // An empty key sends none: NanoClaw's own key never goes to the CLI's gateway.
  const vault = createOneCliCredentialConnection(DIAL_SECRET, connection.url, connection.apiKey, fetchImpl, root);
  return vault.save(key, await vault.find());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  storeDialKey().then(
    (id) => console.log(id),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
