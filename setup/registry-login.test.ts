/**
 * The sign-in driver's idempotence decision: given a credential already on
 * disk, does this run reuse it, re-authenticate, or refuse to answer?
 *
 * That decision is the whole contract callers have with this driver — they
 * read an exit code and nothing else — and it is reachable without any of the
 * browser or enrollment machinery, so it is tested on its own here. Every test
 * runs against a temporary HOME with a stubbed `fetch`: no request leaves the
 * process, and the real credential in the developer's config directory is
 * never opened.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const emitted = vi.hoisted(() => [] as Array<Record<string, string | number | boolean>>);

vi.mock('./status.js', () => ({
  emitStatus: vi.fn((_step: string, fields: Record<string, string | number | boolean>) => {
    emitted.push(fields);
  }),
}));
// Writes `.env` in the checkout, which a test must never do.
vi.mock('./lib/registry-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/registry-state.js')>()),
  writeImageSource: vi.fn(),
}));
// Installs a binary and edits ~/.docker/config.json.
vi.mock('./install-cred-helper.js', () => ({
  installCredentialHelper: vi.fn(() => ({ helperPath: '/dev/null/helper', onPath: true })),
}));

/** Nothing listens here, and nothing is meant to: every fetch is stubbed. */
const TARGET = 'https://registry.example.invalid';
const OTHER = 'https://registry.sandbox.example.invalid';

const homes: string[] = [];
let originalHome: string | undefined;

interface StoredCredential {
  api?: string;
  account_id?: string;
  token?: string;
}

/** A temporary HOME holding `account.json` exactly as written. */
function homeWith(credential: StoredCredential | undefined): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-login-'));
  homes.push(home);
  if (credential) {
    const dir = path.join(home, '.config', 'nanoclaw');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify(credential));
  }
  process.env.HOME = home;
  return home;
}

function storedToken(home: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(home, '.config', 'nanoclaw', 'account.json'), 'utf-8');
    return (JSON.parse(raw) as { token?: string }).token;
  } catch {
    return undefined;
  }
}

/** Run the driver with CONFIG_DIR resolved against the current HOME. */
async function runLogin(argv: string[]): Promise<number> {
  vi.resetModules();
  const { run } = await import('./registry-login.js');
  process.exitCode = undefined;
  await run(argv);
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return Number(code);
}

beforeEach(() => {
  originalHome ??= process.env.HOME;
  emitted.length = 0;
  vi.clearAllMocks();
  // Anything the environment already carries would steer the driver past the
  // branch under test.
  for (const key of ['NANOCLAW_REGISTRY_TOKEN', 'NANOCLAW_REGISTRY_ENROLL_CODE', 'NANOCLAW_REGISTRY_API']) {
    vi.stubEnv(key, '');
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (originalHome !== undefined) process.env.HOME = originalHome;
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

/** The account service is there and answers; the credential is good. */
function stubProbeOk(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ account_id: 'acct_live', email: 'someone@example.invalid' }),
    })),
  );
}

/** Nothing answers — the state `probeSession` also reports for a 404 or a proxy error. */
function stubProbeUnreachable(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('fetch failed');
    }),
  );
}

const stale: StoredCredential = { api: TARGET, account_id: 'acct_stale', token: 'nct_stale' };

describe('a stored credential the service cannot be asked about', () => {
  it('--require-verified: refuses to call it a sign-in, and keeps the file', async () => {
    const home = homeWith(stale);
    stubProbeUnreachable();

    await expect(runLogin(['--non-interactive', '--require-verified', '--api', TARGET])).resolves.toBe(2);

    expect(emitted.at(-1)).toMatchObject({ STATUS: 'skipped', REASON: 'unverified' });
    // Refusing to vouch for the credential is not a reason to destroy it: the
    // operator may be offline, and the next run can still verify it.
    expect(storedToken(home)).toBe('nct_stale');
  });

  it('without the flag: keeps it and exits 0, because the image pull can live with that', async () => {
    const home = homeWith(stale);
    stubProbeUnreachable();

    await expect(runLogin(['--non-interactive', '--api', TARGET])).resolves.toBe(0);

    expect(emitted.at(-1)).toMatchObject({ REASON: 'already-signed-in-unverified' });
    expect(storedToken(home)).toBe('nct_stale');
  });

  it('--require-verified covers the record with no api field, which the issuer check cannot', async () => {
    // `readAccountCredential` fills a missing `api` by resolving the base the
    // same way this run does, so such a record compares equal to the target
    // whenever no `--api` overrides it — which is every wizard run. The
    // mismatch branch below can therefore never fire on a credential written
    // before that field existed; verification is what catches it.
    homeWith({ account_id: 'acct_old', token: 'nct_from_an_older_login' });
    vi.stubEnv('NANOCLAW_REGISTRY_API', TARGET);
    stubProbeUnreachable();

    await expect(runLogin(['--non-interactive', '--require-verified'])).resolves.toBe(2);
    expect(emitted.at(-1)).toMatchObject({ REASON: 'unverified' });
  });

  it('verified against the service: still a sign-in, flag or no flag', async () => {
    homeWith(stale);
    stubProbeOk();

    await expect(runLogin(['--non-interactive', '--require-verified', '--api', TARGET])).resolves.toBe(0);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'skipped', REASON: 'already-signed-in' });
  });
});

describe('a stored credential issued by a different service', () => {
  it('is never probed, and does not stand in for a sign-in to the target', async () => {
    const home = homeWith({ ...stale, api: OTHER });
    const fetchMock = vi.fn(async () => ({ status: 200, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock);

    // Non-interactive with nothing in the environment: the re-authentication
    // the mismatch calls for cannot happen here, so the run is a skip.
    await expect(runLogin(['--non-interactive', '--api', TARGET])).resolves.toBe(2);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'skipped', REASON: 'non-interactive' });
    expect(storedToken(home)).toBe('nct_stale');
  });
});
