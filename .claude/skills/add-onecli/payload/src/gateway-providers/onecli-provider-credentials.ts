/**
 * This install's record of the OneCLI secrets its provider logins saved, by
 * agent provider name. A group is granted the ones for the provider it runs;
 * every other secret is attached only by the skill that adds it. Imported by
 * the skill's setup scripts as well, so it uses node builtins only.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ProviderCredentialRecord {
  providers: Record<string, string[]>;
  /** Providers whose secrets were matched by saved name once; never matched again. */
  matched: string[];
}

export function providerCredentialFile(dataDir: string): string {
  return path.join(dataDir, 'onecli', 'provider-credentials.json');
}

const isIds = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((id) => typeof id === 'string');

/** A missing file is an empty record; an unreadable one throws rather than guess. */
export function readProviderCredentials(dataDir: string): ProviderCredentialRecord {
  const file = providerCredentialFile(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { providers: {}, matched: [] };
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<ProviderCredentialRecord> | null;
  const providers = parsed?.providers;
  if (
    !providers ||
    typeof providers !== 'object' ||
    Array.isArray(providers) ||
    !Object.values(providers).every(isIds) ||
    !isIds(parsed.matched)
  ) {
    throw new Error(`${file} must hold provider names mapped to OneCLI secret ids`);
  }
  return { providers, matched: parsed.matched };
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Read, change and write the record under a lock file, so the host process and
 * a setup script never drop each other's ids. A stuck lock is never taken over
 * automatically (that races a live writer); the error names it.
 */
export function updateProviderCredentials(
  dataDir: string,
  change: (record: ProviderCredentialRecord) => void,
  opts: { lockTimeoutMs?: number } = {},
): ProviderCredentialRecord {
  const file = providerCredentialFile(dataDir);
  // Mode 0700 matches the staged-file directory this shares.
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + (opts.lockTimeoutMs ?? 5_000);
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx', 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() > deadline) {
        throw new Error(`${lock} is held; retry, or delete it if no NanoClaw setup or host is running`);
      }
      sleep(25);
    }
  }
  try {
    const record = readProviderCredentials(dataDir);
    change(record);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return record;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Adds ids to a provider's entry, or replaces the entry. */
export function recordProviderCredentials(
  dataDir: string,
  provider: string,
  ids: string[],
  opts: { replace?: boolean } = {},
): void {
  updateProviderCredentials(dataDir, (record) => {
    record.providers[provider] = [...new Set([...(opts.replace ? [] : (record.providers[provider] ?? [])), ...ids])];
  });
}

// The names NanoClaw's provider setup gives the secrets it saves. Names only:
// a typed key under another name may be one user's in a per-user setup.
const SAVED: Record<string, (name: string) => boolean> = {
  claude: (name) => name === 'Anthropic',
  codex: (name) => /^(codex|openai)$/i.test(name),
  opencode: (name) => name.startsWith('OpenCode '),
};

export function isSavedProviderCredential(provider: string, secret: { name?: unknown }): boolean {
  return typeof secret.name === 'string' && (SAVED[provider]?.(secret.name) ?? false);
}

/** Pulls the secret id out of `onecli secrets create` output (JSON, possibly with a `hint` key). */
export function createdSecretId(output: string): string | null {
  try {
    const parsed = JSON.parse(output) as { id?: unknown; data?: { id?: unknown } };
    const id = parsed.id ?? parsed.data?.id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}
