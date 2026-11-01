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
import { readEnvFile } from '../../../../src/env.js';

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

/**
 * The gateway the onecli CLI writes to, its key ('' for a gateway with ambient
 * local auth), and its effective project (env or saved config; unset if unread).
 */
export function cliConnection(run: Run = onecli): { url: string; apiKey: string; project?: string } {
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
  // A CLI without a project setting falls back to ONECLI_PROJECT; one that
  // answers without a readable value stops, since '' would mean the default.
  let out: string | undefined;
  try {
    out = run(['config', 'get', 'project']);
  } catch {
    out = undefined;
  }
  let project: string | undefined;
  if (out !== undefined) {
    let value: unknown;
    try {
      value = (JSON.parse(out) as Record<string, unknown>).value;
    } catch {
      value = undefined;
    }
    if (typeof value !== 'string') {
      throw new Error(
        "could not read the onecli CLI's project from `onecli config get project`, so the Dial key's project is unknown",
      );
    }
    project = value.trim();
  }
  return { url, apiKey, project };
}

export async function storeDialKey(
  authFile = dialAuthFile(),
  connection: { url: string; apiKey: string; project?: string } = cliConnection(),
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
  // The key is written in NanoClaw's project and granted by the CLI in its own,
  // so a mismatch would overwrite another project's key and then fail the grant.
  const project = process.env.ONECLI_PROJECT_ID || readEnvFile(['ONECLI_PROJECT_ID'], root).ONECLI_PROJECT_ID || '';
  const cliProject = connection.project ?? (process.env.ONECLI_PROJECT || '');
  if (project !== cliProject) {
    throw new Error(
      `NanoClaw's OneCLI project (ONECLI_PROJECT_ID: ${project || 'default'}) and the onecli CLI's ` +
        `(${cliProject || 'default'}) differ: set the CLI's project to the same id (ONECLI_PROJECT, or ` +
        '`onecli config set project`), or clear both, and run again. Nothing was written to OneCLI.',
    );
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
