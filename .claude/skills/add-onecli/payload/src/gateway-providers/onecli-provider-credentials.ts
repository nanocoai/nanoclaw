/**
 * This install's record of the OneCLI secrets its provider logins saved, by
 * agent provider name. A group is granted the ones for the provider it runs;
 * every other secret is attached only by the skill that adds it. Imported by
 * the skill's setup scripts as well, so it uses node builtins only.
 */
import fs from 'node:fs';
import os from 'node:os';
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The record lock stayed held past the timeout; the message names the lock file. */
export class RecordLockedError extends Error {}

/**
 * Read, change and write the record under a lock file, so the host process and
 * a setup script never drop each other's ids. Waiting never blocks the event
 * loop. A lock is never taken over (every takeover can race a live writer); one
 * left by a crash is named in the error, and holds the writer's host and pid.
 */
export async function updateProviderCredentials(
  dataDir: string,
  change: (record: ProviderCredentialRecord) => void,
  opts: { lockTimeoutMs?: number } = {},
): Promise<ProviderCredentialRecord> {
  const file = providerCredentialFile(dataDir);
  // Mode 0700 matches the staged-file directory this shares.
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + (opts.lockTimeoutMs ?? 5_000);
  let fd: number;
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() > deadline) {
        throw new RecordLockedError(`${lock} is held; retry, or delete it if no NanoClaw setup or host is running`);
      }
      await sleep(25);
    }
  }
  try {
    fs.writeSync(fd, `${os.hostname()} ${process.pid}`);
  } catch (err) {
    fs.rmSync(lock, { force: true });
    throw err;
  } finally {
    fs.closeSync(fd);
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
export async function recordProviderCredentials(
  dataDir: string,
  provider: string,
  ids: string[],
  opts: { replace?: boolean } = {},
): Promise<void> {
  await updateProviderCredentials(dataDir, (record) => {
    record.providers[provider] = [...new Set([...(opts.replace ? [] : (record.providers[provider] ?? [])), ...ids])];
  });
}

// The names NanoClaw's provider setup gives the secrets it saves. Names only:
// a typed key under another name may be one user's in a per-user setup.
const SAVED: Record<string, (name: string) => boolean> = {
  claude: (name) => name === 'Anthropic',
  codex: (name) => /^(codex|openai)$/i.test(name),
  opencode: (name) => name.startsWith('OpenCode '),
  cursor: (name) => name === 'Cursor' || name === 'Cursor models',
};

/** Whether NanoClaw's setup saves this provider's credentials under known names. */
export function hasSavedProviderNames(provider: string): boolean {
  return Object.hasOwn(SAVED, provider);
}

export function isSavedProviderCredential(provider: string, secret: { name?: unknown }): boolean {
  return typeof secret.name === 'string' && hasSavedProviderNames(provider) && SAVED[provider](secret.name);
}

// The shape of each provider's model key, as older setup matched it. Never
// adopted (on a shared gateway it may be another user's); only reported, so
// the operator can run the login that records this install's own key.
const lower = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : '');
const MODEL_KEY: Record<string, (secret: { type?: unknown; hostPattern?: unknown }) => boolean> = {
  claude: (s) => s.type === 'anthropic',
  codex: (s) => s.type === 'openai' || ['api.openai.com', 'chatgpt.com'].includes(lower(s.hostPattern)),
};

/**
 * Secrets shaped like `provider`'s model key that no provider recorded and no
 * other provider saves by name: an older install's key under another name.
 */
export function unrecordedModelKeys(
  record: ProviderCredentialRecord,
  provider: string,
  secrets: Array<{ id?: unknown; name?: unknown; type?: unknown; hostPattern?: unknown }>,
): Array<{ id: string; name: string }> {
  if (!Object.hasOwn(MODEL_KEY, provider)) return [];
  const recorded = new Set(Object.values(record.providers).flat());
  return secrets.flatMap((s) =>
    typeof s.id === 'string' &&
    !recorded.has(s.id) &&
    MODEL_KEY[provider](s) &&
    !Object.keys(SAVED).some((other) => other !== provider && isSavedProviderCredential(other, s))
      ? [{ id: s.id, name: typeof s.name === 'string' ? s.name : '' }]
      : [],
  );
}

/**
 * The secrets a provider's login saved, by name, for an install that recorded
 * none. Several secrets under one name cannot be told apart (another install's,
 * or a stray entry), so they come back as `duplicates` and nothing is chosen.
 */
export function savedProviderCredentials(
  provider: string,
  secrets: Array<{ id?: unknown; name?: unknown }>,
): { ids: string[]; duplicates: string[] } {
  // Grouped ignoring case, as the Codex matcher is.
  const byName = new Map<string, Array<{ name: string; id: string }>>();
  for (const secret of secrets) {
    if (typeof secret.id !== 'string' || !isSavedProviderCredential(provider, secret)) continue;
    const name = secret.name as string;
    byName.set(name.toLowerCase(), [...(byName.get(name.toLowerCase()) ?? []), { name, id: secret.id }]);
  }
  const groups = [...byName.values()];
  const duplicates = groups
    .filter((group) => group.length > 1)
    .flatMap((group) => group.map((s) => `${s.name} ${s.id}`));
  return duplicates.length ? { ids: [], duplicates } : { ids: groups.flat().map((s) => s.id), duplicates };
}

/** Several secrets under a provider's saved name and none recorded; the message lists them. */
export class DuplicateSavedCredentialsError extends Error {}

/**
 * Once per provider, for an install that saved credentials before ids were
 * recorded: record the ones saved under NanoClaw's names. Run it under the
 * record lock. Anything recorded wins, even an id `secrets` does not list (a
 * login newer than that list, or a deleted secret its login must replace).
 */
export function adoptSavedProviderCredentials(
  record: ProviderCredentialRecord,
  provider: string,
  secrets: Array<{ id?: unknown; name?: unknown }>,
): void {
  // Never marked without names, so names a later release adds still adopt once.
  if (record.matched.includes(provider) || !hasSavedProviderNames(provider)) return;
  if (!record.providers[provider]?.length) {
    const saved = savedProviderCredentials(provider, secrets);
    if (saved.duplicates.length) {
      throw new DuplicateSavedCredentialsError(
        `several OneCLI secrets share a name the ${provider} login saves (${saved.duplicates.join(', ')}) and none is recorded: ` +
          `run that login again to record the one to use, or delete the extra secrets`,
      );
    }
    record.providers[provider] = saved.ids;
  }
  record.matched.push(provider);
}

/**
 * For setup: whether groups running `provider` will be granted a credential in
 * `secrets`. Adopts saved names as above; duplicates count as not connected,
 * so the login runs and records its own.
 */
export async function hasProviderCredential(
  dataDir: string,
  provider: string,
  secrets: Array<{ id?: unknown; name?: unknown }>,
): Promise<boolean> {
  const live = new Set(secrets.map((s) => s.id));
  const record = readProviderCredentials(dataDir);
  if (record.providers[provider]?.some((id) => live.has(id))) return true;
  if (!savedProviderCredentials(provider, secrets).ids.length) return false;
  const after = await updateProviderCredentials(dataDir, (r) => adoptSavedProviderCredentials(r, provider, secrets));
  return after.providers[provider]?.some((id) => live.has(id)) ?? false;
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
