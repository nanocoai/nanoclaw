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
  deviceTokenCandidates,
  findProjectByName,
  findUserByPhone,
  isE164,
  main,
  normalizePhone,
  parseArgs,
  unwrapList,
  upsertEnv,
  userAssignedLine,
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
  it('finds a user by normalized phone and reads the assigned line', () => {
    const users = [{ phoneNumber: '+1 555 123 4567', assignedPhoneNumber: '+15559990000' }];
    const u = findUserByPhone(users, '+15551234567');
    expect(u).toBeTruthy();
    expect(userAssignedLine(u)).toBe('+15559990000');
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
}

/** Build a fetch that emulates the Photon dashboard + spectrum endpoints. */
function makeMockFetch(opts: { existingProject?: boolean; existingUser?: boolean } = {}): {
  fetchFn: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method || 'GET').toUpperCase();
    const pathname = url.pathname;
    calls.push({ method, pathname });

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
      return json({ projects: opts.existingProject ? [{ id: 'proj-existing', name: 'NanoClaw' }] : [] });
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
      return json({
        users: opts.existingUser
          ? [{ id: 'u-existing', phoneNumber: '+15551234567', assignedPhoneNumber: '+15558887777' }]
          : [],
      });
    }
    if (/^\/projects\/[^/]+\/users\/$/.test(pathname) && method === 'POST') {
      return json({ user: { id: 'u-created', phoneNumber: '+15551234567', assignedPhoneNumber: '+15558887777' } });
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

  it('provisions a brand-new project + user and writes creds to .env', async () => {
    const { fetchFn, calls } = makeMockFetch();
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
    // A new user was created.
    expect(calls.some((c) => c.method === 'POST' && /\/users\/$/.test(c.pathname))).toBe(true);
  });

  it('reuses an existing project + user and skips creation', async () => {
    const { fetchFn, calls } = makeMockFetch({ existingProject: true, existingUser: true });
    const code = await main(['setup', '--phone', '+15551234567', '--no-browser', '--non-interactive'], fetchFn, noSleep);
    expect(code).toBe(0);

    const env = fs.readFileSync(path.join(tempDir, '.env'), 'utf-8');
    expect(env).toContain('PHOTON_PROJECT_ID=proj-existing');
    // No create-project or create-user calls.
    expect(calls.some((c) => c.method === 'POST' && c.pathname === '/api/projects')).toBe(false);
    expect(calls.some((c) => c.method === 'POST' && /\/users\/$/.test(c.pathname))).toBe(false);
  });

  it('reuses a stored device token on a second run (no re-login)', async () => {
    // First run stores the token.
    await main(['setup', '--phone', '+15551234567', '--no-browser', '--non-interactive'], makeMockFetch().fetchFn, noSleep);

    // Second run: token is validated + reused, device-code is never requested.
    const { fetchFn, calls } = makeMockFetch();
    const code = await main(['setup', '--phone', '+15551234567', '--no-browser', '--non-interactive'], fetchFn, noSleep);
    expect(code).toBe(0);
    expect(calls.some((c) => c.pathname === '/api/auth/device/code')).toBe(false);
    expect(calls.some((c) => c.pathname === '/api/auth/get-session')).toBe(true);
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
