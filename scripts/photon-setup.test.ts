/**
 * Photon setup-wizard tests.
 *
 * Pure helpers are tested directly; the full device-login → project → secret →
 * user → line flow runs end-to-end against a mocked `fetch` that emulates the
 * Photon dashboard + spectrum APIs, in a throwaway cwd so real .env is never
 * touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  basicAuth,
  createUser,
  deviceTokenCandidates,
  ensureUser,
  findProjectByName,
  findRoutableUser,
  findUserByPhone,
  getImessageLine,
  isE164,
  main,
  normalizePhone,
  optInInstructions,
  parseArgs,
  projectSecretOf,
  unwrapList,
  upsertEnv,
  userAssignedLine,
  userOptedIn,
  waitForOptedInUser,
} from './photon-setup.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('upsertEnv', () => {
  it('appends new keys to an empty file', () => {
    expect(upsertEnv('', { PHOTON_PROJECT_ID: 'abc', PHOTON_PROJECT_SECRET: 'xyz' })).toBe(
      'PHOTON_PROJECT_ID=abc\nPHOTON_PROJECT_SECRET=xyz\n',
    );
  });
  it('replaces an existing key in place and preserves others + comments', () => {
    const existing = '# creds\nASSISTANT_NAME=Andy\nPHOTON_PROJECT_ID=old\n';
    const result = upsertEnv(existing, { PHOTON_PROJECT_ID: 'new' });
    expect(result).toContain('# creds');
    expect(result).toContain('ASSISTANT_NAME=Andy');
    expect(result).toContain('PHOTON_PROJECT_ID=new');
    expect(result).not.toContain('PHOTON_PROJECT_ID=old');
  });
  it('appends a new key while replacing another', () => {
    const result = upsertEnv('PHOTON_PROJECT_ID=x\n', { PHOTON_PROJECT_ID: 'y', PHOTON_PROJECT_SECRET: 's' });
    expect(result).toBe('PHOTON_PROJECT_ID=y\nPHOTON_PROJECT_SECRET=s\n');
  });
});

describe('deviceTokenCandidates', () => {
  it('finds the top-level access_token', () => {
    expect(deviceTokenCandidates({ access_token: 'tok' })).toEqual(['tok']);
  });
  it('strips a Bearer prefix and dedups across shapes', () => {
    expect(deviceTokenCandidates({ access_token: 'Bearer tok', data: { access_token: 'tok' } })).toEqual(['tok']);
  });
  it('reads the set-auth-token header', () => {
    const headers = new Headers({ 'set-auth-token': 'hdrtok' });
    expect(deviceTokenCandidates({}, headers)).toEqual(['hdrtok']);
  });
});

describe('phone helpers', () => {
  it('normalizes to + and digits', () => {
    expect(normalizePhone('+1 (555) 123-4567')).toBe('+15551234567');
  });
  it('validates E.164', () => {
    expect(isE164('+15551234567')).toBe(true);
    expect(isE164('5551234567')).toBe(false);
    expect(isE164('+0123')).toBe(false);
  });
});

describe('basicAuth', () => {
  it('base64-encodes id:secret', () => {
    expect(basicAuth('id', 'secret')).toBe('Basic ' + Buffer.from('id:secret').toString('base64'));
  });
});

describe('unwrapList / find helpers', () => {
  it('unwraps arrays under common envelope keys', () => {
    expect(unwrapList({ projects: [{ id: '1' }] })).toEqual([{ id: '1' }]);
    expect(unwrapList([{ id: '2' }])).toEqual([{ id: '2' }]);
    expect(unwrapList({ data: { users: [{ id: '3' }] } })).toEqual([{ id: '3' }]);
  });
  it('finds a project by case-insensitive name', () => {
    expect(findProjectByName([{ name: 'NanoClaw', id: 'p1' }], 'nanoclaw')).toEqual({ name: 'NanoClaw', id: 'p1' });
  });
  it('reads the current secret off a project payload', () => {
    expect(projectSecretOf({ id: 'p1', projectSecret: 'spk-abc' })).toBe('spk-abc');
    expect(projectSecretOf({ id: 'p1' })).toBeUndefined();
    expect(projectSecretOf({ id: 'p1', projectSecret: '  ' })).toBeUndefined();
    expect(projectSecretOf(undefined)).toBeUndefined();
  });
  it('finds a user by normalized phone and reads the assigned line', () => {
    const users = [{ phoneNumber: '+1 555 123 4567', assignedPhoneNumber: '+15559990000' }];
    const u = findUserByPhone(users, '+15551234567');
    expect(u).toBeTruthy();
    expect(userAssignedLine(u)).toBe('+15559990000');
  });
});

describe('userOptedIn / waitForOptedInUser', () => {
  it('only a meta.opt_in === true row counts as opted in', () => {
    expect(userOptedIn(undefined)).toBe(false);
    expect(userOptedIn({})).toBe(false);
    expect(userOptedIn({ meta: {} })).toBe(false);
    expect(userOptedIn({ meta: { opt_in: false } })).toBe(false);
    expect(userOptedIn({ meta: { project_owner: true } })).toBe(false);
    expect(userOptedIn({ meta: { opt_in: true } })).toBe(true);
  });

  it('rides out transient list failures during the wait instead of aborting', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls <= 2) throw new Error('ECONNRESET');
      return new Response(
        JSON.stringify({ users: [{ id: 'u1', phoneNumber: '+15551234567', assignedPhoneNumber: '+15558887777', meta: { opt_in: true } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    const user = await waitForOptedInUser(fetchFn, 'https://s.example.com', 'proj', 'secret', '+15551234567', {
      sleepFn: async () => {},
      intervalS: 1,
      timeoutS: 10,
    });
    expect(user.id).toBe('u1');
    expect(calls).toBe(3);
  });

  it('reports the last API error when the wait times out on failures', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch;
    await expect(
      waitForOptedInUser(fetchFn, 'https://s.example.com', 'proj', 'secret', '+15551234567', {
        sleepFn: async () => {},
        intervalS: 1,
        timeoutS: 3,
      }),
    ).rejects.toThrow(/not opted in after 3s.*ECONNRESET/);
  });

  it('prefers an opted-in row when the same phone has duplicates', () => {
    const stale = { id: 'u-stale', phoneNumber: '+15551234567', meta: {} };
    const invited = { id: 'u-invited', phoneNumber: '+1 555 123 4567', meta: { opt_in: true } };
    expect(findRoutableUser([stale, invited], '+15551234567')?.id).toBe('u-invited');
    expect(findRoutableUser([invited, stale], '+15551234567')?.id).toBe('u-invited');
    expect(findRoutableUser([stale], '+15551234567')?.id).toBe('u-stale');
    expect(findRoutableUser([], '+15551234567')).toBeUndefined();
  });

  it('times out with a re-run hint when the opt-in never lands', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ users: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    await expect(
      waitForOptedInUser(fetchFn, 'https://s.example.com', 'proj', 'secret', '+15551234567', {
        sleepFn: async () => {},
        intervalS: 1,
        timeoutS: 3,
      }),
    ).rejects.toThrow(/not opted in after 3s.*re-run setup/);
  });

  it('names the assigned line in the timeout message when it is known', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ users: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    await expect(
      waitForOptedInUser(fetchFn, 'https://s.example.com', 'proj', 'secret', '+15551234567', {
        sleepFn: async () => {},
        intervalS: 1,
        timeoutS: 3,
        assignedLine: '+15558887777',
      }),
    ).rejects.toThrow(/from \+15551234567 to \+15558887777/);
  });
});

describe('optInInstructions', () => {
  it('tells the operator to text the exact assigned line from their own number', () => {
    const text = optInInstructions('+15551234567', '+15558887777').join('\n');
    expect(text).toContain('Text +15558887777');
    expect(text).toContain('+15551234567');
  });
  it('degrades gracefully when no line has been assigned yet', () => {
    const text = optInInstructions('+15551234567', null).join('\n');
    expect(text).toContain('has not assigned');
    expect(text).toContain('+15551234567');
  });
});

describe('createUser / ensureUser', () => {
  it('posts a shared user without client-supplied meta', async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ user: { id: 'u-new', phoneNumber: '+15551234567', assignedPhoneNumber: '+15558887777', meta: {} } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    const user = await createUser(fetchFn, 'https://s.example.com', 'proj', 'secret', '+15551234567');
    expect(body).toEqual({ type: 'shared', phoneNumber: '+15551234567' });
    expect('meta' in body).toBe(false);
    expect(userAssignedLine(user)).toBe('+15558887777');
    expect(userOptedIn(user)).toBe(false);
  });

  it('treats an HTTP 200 error body as a create failure', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: 'User limit reached for this project' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    await expect(createUser(fetchFn, 'https://s.example.com', 'proj', 'secret', '+15551234567')).rejects.toThrow(
      /User limit reached/,
    );
  });

  it('rejects a non-E.164 number before calling the API', async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await expect(createUser(fetchFn, 'https://s.example.com', 'proj', 'secret', '5551234567')).rejects.toThrow(/E\.164/);
    expect(called).toBe(false);
  });

  it('reuses an existing row instead of creating a second one', async () => {
    let posts = 0;
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method || 'GET').toUpperCase() === 'POST') posts += 1;
      return new Response(
        JSON.stringify({ users: [{ id: 'u-existing', phoneNumber: '+15551234567', assignedPhoneNumber: '+15558887777', meta: {} }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    const { user, created } = await ensureUser(fetchFn, 'https://s.example.com', 'proj', 'secret', '+15551234567');
    expect(created).toBe(false);
    expect(user.id).toBe('u-existing');
    expect(posts).toBe(0);
  });
});

describe('getImessageLine', () => {
  it('treats an HTTP 200 error body as no line', async () => {
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body =
        init?.method === 'POST' ? { error: 'Line add/remove is only available on the business plan' } : { lines: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await expect(getImessageLine(fetchFn, 'https://app.example.com', 'token', 'proj')).resolves.toBeNull();
  });
});

describe('parseArgs', () => {
  it('defaults to setup with the NanoClaw project name', () => {
    const a = parseArgs([]);
    expect(a.command).toBe('setup');
    expect(a.projectName).toBe('NanoClaw');
  });
  it('parses status + flags', () => {
    const a = parseArgs(['status']);
    expect(a.command).toBe('status');
  });
  it('parses phone, project name, hosts, and toggles', () => {
    const a = parseArgs([
      'setup',
      '--phone',
      '+1 555 123 4567',
      '--project-name',
      'Bot',
      '--no-browser',
      '--non-interactive',
      '--embedded',
      '--dashboard-host',
      'https://d.example.com/',
      '--spectrum-host',
      'https://s.example.com/',
    ]);
    expect(a.phone).toBe('+15551234567');
    expect(a.projectName).toBe('Bot');
    expect(a.noBrowser).toBe(true);
    expect(a.interactive).toBe(false);
    expect(a.embedded).toBe(true);
    expect(a.dashboardHost).toBe('https://d.example.com');
    expect(a.spectrumHost).toBe('https://s.example.com');
  });
});

// ---------------------------------------------------------------------------
// End-to-end flow with a mocked Photon API
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  pathname: string;
  body?: string;
}

const POOL_LINE = '+15558887777';

/**
 * Build a fetch that emulates the Photon dashboard + spectrum endpoints.
 *
 * User-list behavior mirrors the live service: a POST creates the row with an
 * assigned line and an empty `meta`, and the row only routes once `meta.opt_in`
 * flips — which happens out of band, when the human texts the assigned line.
 * - `existingUser`: the row exists and is opted in from the first poll.
 * - `optInAfterListPolls: n`: the first n GET /users/ polls see no opted-in
 *   row; from poll n+1 whatever rows exist carry `meta.opt_in`. With
 *   `pendingUser` a row is present from the start, standing in for one an
 *   earlier run created.
 */
function makeMockFetch(
  opts: { existingProject?: boolean; existingUser?: boolean; optInAfterListPolls?: number; pendingUser?: boolean } = {},
): {
  fetchFn: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let userListPolls = 0;
  const createdUsers: Array<Record<string, unknown>> = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method || 'GET').toUpperCase();
    const pathname = url.pathname;
    calls.push({ method, pathname, body: init?.body ? String(init.body) : undefined });

    // Device login
    if (pathname === '/api/auth/device/code' && method === 'POST') {
      // interval:0 keeps the poll loop instant in tests.
      return json({
        device_code: 'dev-code',
        user_code: 'WXYZ-1234',
        verification_uri: 'https://app.photon.codes/device',
        verification_uri_complete: 'https://app.photon.codes/device?code=WXYZ-1234',
        expires_in: 300,
        interval: 0,
      });
    }
    if (pathname === '/api/auth/device/token' && method === 'POST') {
      return json({ access_token: 'device-bearer-token' });
    }
    if (pathname === '/api/auth/get-session' && method === 'GET') {
      return json({ user: { id: 'user-1', email: 'me@example.com' } });
    }
    if (pathname === '/api/projects/' && method === 'GET') {
      return json({ projects: [] });
    }
    if (pathname === '/api/projects' && method === 'GET') {
      // The dashboard returns the project's current secret on list responses.
      return json({
        projects: opts.existingProject
          ? [{ id: 'proj-existing', name: 'NanoClaw', projectSecret: 'existing-secret-value' }]
          : [],
      });
    }
    if (pathname === '/api/projects' && method === 'POST') {
      return json({ id: 'proj-created', name: 'NanoClaw' });
    }
    if (/^\/api\/projects\/[^/]+\/regenerate-secret$/.test(pathname) && method === 'POST') {
      return json({ projectSecret: 'super-secret-value' });
    }
    if (/^\/api\/projects\/[^/]+\/lines$/.test(pathname)) {
      // No dedicated line inventory on shared-line plans.
      return json({ lines: [] });
    }
    // Spectrum users
    if (/^\/projects\/[^/]+\/users\/$/.test(pathname) && method === 'GET') {
      userListPolls += 1;
      const optedInRow = {
        id: 'u-existing',
        phoneNumber: '+15551234567',
        assignedPhoneNumber: POOL_LINE,
        meta: { opt_in: true },
      };
      if (opts.existingUser) return json({ users: [optedInRow] });
      const pending = opts.pendingUser
        ? [{ id: 'u-pending', phoneNumber: '+15551234567', assignedPhoneNumber: POOL_LINE, meta: {} }]
        : [];
      const rows = [...pending, ...createdUsers];
      const flipped = opts.optInAfterListPolls !== undefined && userListPolls > opts.optInAfterListPolls;
      if (!flipped) return json({ users: rows });
      // The opt-in flips server-side, standing in for the human's first message.
      return json({ users: rows.length ? rows.map((r) => ({ ...r, meta: { opt_in: true } })) : [optedInRow] });
    }
    if (/^\/projects\/[^/]+\/users\/$/.test(pathname) && method === 'POST') {
      // Creates always come back un-opted-in: client-supplied meta is ignored,
      // and only the human's message to the assigned line sets the flag.
      const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const row = {
        id: `u-created-${createdUsers.length + 1}`,
        phoneNumber: String(payload.phoneNumber ?? ''),
        assignedPhoneNumber: POOL_LINE,
        meta: {},
      };
      createdUsers.push(row);
      return json({ user: row });
    }
    return json({ error: `unmocked ${method} ${pathname}` }, 404);
  }) as typeof fetch;

  return { fetchFn, calls };
}

describe('photon setup flow (mocked API)', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photon-setup-'));
    process.chdir(tempDir);
    delete process.env.PHOTON_PROJECT_ID;
    delete process.env.PHOTON_PROJECT_SECRET;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const noSleep = { sleepFn: async () => {} };

  it('provisions a brand-new project, creates the user, waits for the opt-in, and writes creds to .env', async () => {
    // The row flips to opted in on the third list poll, as if the operator
    // texted the assigned line while the wizard waited.
    const { fetchFn, calls } = makeMockFetch({ optInAfterListPolls: 2 });
    const code = await main(['setup', '--phone', '+15551234567', '--no-browser', '--non-interactive'], fetchFn, noSleep);
    expect(code).toBe(0);

    const env = fs.readFileSync(path.join(tempDir, '.env'), 'utf-8');
    expect(env).toContain('PHOTON_PROJECT_ID=proj-created');
    expect(env).toContain('PHOTON_PROJECT_SECRET=super-secret-value');

    const auth = JSON.parse(fs.readFileSync(path.join(tempDir, 'data', 'photon-auth.json'), 'utf-8'));
    expect(auth.access_token).toBe('device-bearer-token');
    expect(auth.project_id).toBe('proj-created');
    expect(auth.phone_number).toBe('+15551234567');
    expect(auth.assigned_phone_number).toBe('+15558887777');

    // The device-code endpoint was hit (fresh login).
    expect(calls.some((c) => c.pathname === '/api/auth/device/code')).toBe(true);
    // The project was created (not found).
    expect(calls.some((c) => c.method === 'POST' && c.pathname === '/api/projects')).toBe(true);
    // Lookup poll, then the wait polls until the opt-in landed (poll 3).
    expect(calls.filter((c) => c.method === 'GET' && /\/users\/$/.test(c.pathname)).length).toBe(3);
    // The absent row was created exactly once, with no client-supplied meta.
    const creates = calls.filter((c) => c.method === 'POST' && /\/users\/$/.test(c.pathname));
    expect(creates.length).toBe(1);
    expect(JSON.parse(creates[0].body ?? '{}')).toEqual({ type: 'shared', phoneNumber: '+15551234567' });
    // The create response carried no projectSecret → minted via regenerate.
    expect(calls.some((c) => /regenerate-secret$/.test(c.pathname))).toBe(true);
    // Status only turns green after setup records the successful opt-in —
    // and it re-verifies the opt-in live through the same (mocked) API.
    expect(await main(['status'], fetchFn)).toBe(0);
  });

  it('a registered-but-not-opted-in row is not success — it keeps polling until opt_in lands', async () => {
    const { fetchFn, calls } = makeMockFetch({ optInAfterListPolls: 2, pendingUser: true });
    const code = await main(['setup', '--phone', '+15551234567', '--no-browser', '--non-interactive'], fetchFn, noSleep);
    expect(code).toBe(0);
    expect(calls.filter((c) => c.method === 'GET' && /\/users\/$/.test(c.pathname)).length).toBe(3);
    // An existing row is reused, never duplicated by a second create.
    expect(calls.some((c) => c.method === 'POST' && /\/users\/$/.test(c.pathname))).toBe(false);
  });

  it('prints the assigned line and tells the operator to text it', async () => {
    const { fetchFn } = makeMockFetch({ optInAfterListPolls: 2 });
    const written: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await main(['setup', '--phone', '+15551234567', '--no-browser', '--non-interactive'], fetchFn, noSleep)).toBe(0);
    } finally {
      process.stdout.write = realWrite;
    }
    // The instruction names the exact line the row was assigned.
    expect(written.join('')).toContain('Text +15558887777');
  });

  it('does not create a second row when a completed setup is re-run', async () => {
    const { fetchFn, calls } = makeMockFetch({ optInAfterListPolls: 1 });
    expect(await main(['setup', '--phone', '+15551234567', '--no-browser', '--non-interactive'], fetchFn, noSleep)).toBe(0);
    expect(await main(['setup', '--phone', '+15551234567', '--no-browser', '--non-interactive'], fetchFn, noSleep)).toBe(0);
    expect(calls.filter((c) => c.method === 'POST' && /\/users\/$/.test(c.pathname)).length).toBe(1);
  });

  it('short-circuits an already-opted-in row without waiting', async () => {
    const { fetchFn, calls } = makeMockFetch({ existingUser: true });
    expect(await main(['setup', '--phone', '+15551234567', '--no-browser', '--non-interactive'], fetchFn, noSleep)).toBe(0);
    // One lookup, no poll loop.
    expect(calls.filter((c) => c.method === 'GET' && /\/users\/$/.test(c.pathname)).length).toBe(1);
  });

  it('fails (exit 1) when the opt-in never lands, and never claims success', async () => {
    const { fetchFn, calls } = makeMockFetch();
    const code = await main(['setup', '--phone', '+15551234567', '--no-browser', '--non-interactive'], fetchFn, noSleep);
    expect(code).toBe(1);
    // The row is created once; a never-opted-in row is still not success.
    expect(calls.filter((c) => c.method === 'POST' && /\/users\/$/.test(c.pathname)).length).toBe(1);
    // Creds persist so a re-run resumes where it left off.
    const env = fs.readFileSync(path.join(tempDir, '.env'), 'utf-8');
    expect(env).toContain('PHOTON_PROJECT_ID=proj-created');
    // Saved credentials are resumable state, not proof that routing is ready.
    expect(await main(['status'], fetchFn)).toBe(1);
  });

  it('reuses an existing project + user and skips creation', async () => {
    const { fetchFn, calls } = makeMockFetch({ existingProject: true, existingUser: true });
    const code = await main(['setup', '--phone', '+15551234567', '--no-browser', '--non-interactive'], fetchFn, noSleep);
    expect(code).toBe(0);

    const env = fs.readFileSync(path.join(tempDir, '.env'), 'utf-8');
    expect(env).toContain('PHOTON_PROJECT_ID=proj-existing');
    // The listing's current secret is reused — never rotated. Rotating here
    // would invalidate the secret for every other consumer of the project.
    expect(env).toContain('PHOTON_PROJECT_SECRET=existing-secret-value');
    expect(calls.some((c) => /regenerate-secret$/.test(c.pathname))).toBe(false);
    // No create-project or create-user calls.
    expect(calls.some((c) => c.method === 'POST' && c.pathname === '/api/projects')).toBe(false);
    expect(calls.some((c) => c.method === 'POST' && /\/users\/$/.test(c.pathname))).toBe(false);
  });

  it('reuses a stored device token on a second run (no re-login)', async () => {
    // First run stores the token.
    await main(['setup', '--phone', '+15551234567', '--no-browser', '--non-interactive'], makeMockFetch({ existingUser: true }).fetchFn, noSleep);

    // Second run: token is validated + reused, device-code is never requested.
    const { fetchFn, calls } = makeMockFetch({ existingUser: true });
    const code = await main(['setup', '--phone', '+15551234567', '--no-browser', '--non-interactive'], fetchFn, noSleep);
    expect(code).toBe(0);
    expect(calls.some((c) => c.pathname === '/api/auth/device/code')).toBe(false);
    expect(calls.some((c) => c.pathname === '/api/auth/get-session')).toBe(true);
  });

  it('a no-phone re-run preserves the stored phone_number and routing stays green', async () => {
    // First run: full success, phone_number + assigned number stored.
    await main(['setup', '--phone', '+15551234567', '--no-browser', '--non-interactive'], makeMockFetch({ existingUser: true }).fetchFn, noSleep);

    // Re-run without --phone: step 4 is skipped, and the merge must not erase
    // what the first run learned.
    const { fetchFn } = makeMockFetch({ existingUser: true });
    expect(await main(['setup', '--no-browser', '--non-interactive'], fetchFn, noSleep)).toBe(0);

    const auth = JSON.parse(fs.readFileSync(path.join(tempDir, 'data', 'photon-auth.json'), 'utf-8'));
    expect(auth.phone_number).toBe('+15551234567');
    expect(auth.assigned_phone_number).toBe('+15558887777');
    expect(await main(['status'], fetchFn)).toBe(0);
  });

  it('status probes the API: a stale phone_number with an un-opted-in row is not ready', async () => {
    // Simulate an install configured by the old wizard: local state says
    // "registered", but the live row never got the dashboard opt-in.
    await main(['setup', '--phone', '+15551234567', '--no-browser', '--non-interactive'], makeMockFetch({ existingUser: true }).fetchFn, noSleep);
    const { fetchFn } = makeMockFetch({ optInAfterListPolls: Number.MAX_SAFE_INTEGER, pendingUser: true });
    expect(await main(['status'], fetchFn)).toBe(1);
  });

  it('status returns 1 when the routing probe cannot reach the API', async () => {
    await main(['setup', '--phone', '+15551234567', '--no-browser', '--non-interactive'], makeMockFetch({ existingUser: true }).fetchFn, noSleep);
    const failFetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    expect(await main(['status'], failFetch)).toBe(1);
  });

  it('completes without a phone (skips user registration) but still writes creds', async () => {
    const { fetchFn, calls } = makeMockFetch();
    const code = await main(['setup', '--no-browser', '--non-interactive'], fetchFn, noSleep);
    expect(code).toBe(0);
    const env = fs.readFileSync(path.join(tempDir, '.env'), 'utf-8');
    expect(env).toContain('PHOTON_PROJECT_ID=proj-created');
    // No user calls when no phone is supplied.
    expect(calls.some((c) => /\/users\/$/.test(c.pathname))).toBe(false);
  });
});
