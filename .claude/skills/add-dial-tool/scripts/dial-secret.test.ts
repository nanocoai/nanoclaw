import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DIAL_SECRET, cliConnection, dialAuthFile, storeDialKey } from './dial-secret.js';

let root: string;
let auth: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dial-secret-'));
  // NanoClaw's own gateway and key: never used here.
  fs.writeFileSync(path.join(root, '.env'), 'ONECLI_URL=http://nanoclaw-env.test:1\nONECLI_API_KEY=oc_nanoclaw_env\n');
  auth = path.join(root, 'auth.v1.json');
  fs.writeFileSync(auth, JSON.stringify({ apiKey: 'sk_dial_fixture' }));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const existing = (over: Record<string, unknown> = {}) => ({
  id: 'sec-dial',
  name: 'Dial API',
  type: 'generic',
  hostPattern: 'api.getdial.ai',
  scope: 'project',
  valueSource: 'inline',
  injectionConfig: DIAL_SECRET.injectionConfig,
  ...over,
});
function gateway(rows: unknown[]) {
  return vi.fn(
    async (_url: string, init: RequestInit) =>
      new Response(JSON.stringify(init.method === 'GET' ? rows : init.method === 'POST' ? { id: 'sec-new' } : {})),
  );
}
const writes = (f: ReturnType<typeof gateway>) => f.mock.calls.filter(([, init]) => init.method !== 'GET');
const CLI = { url: 'http://gw.test:10254', apiKey: '' };
const store = (f: ReturnType<typeof gateway>, connection = CLI) =>
  storeDialKey(auth, connection, f as unknown as typeof fetch, root);

describe('add-dial-tool: storing the Dial key', () => {
  it('updates an existing Dial secret in place, so its id and every grant stay', async () => {
    const f = gateway([existing()]);
    await expect(store(f)).resolves.toBe('sec-dial');
    expect(writes(f)).toEqual([
      ['http://gw.test:10254/v1/secrets/sec-dial', expect.objectContaining({ method: 'PATCH' })],
    ]);
    expect(JSON.parse(writes(f)[0][1].body as string)).toMatchObject({ value: 'sk_dial_fixture' });
  });

  it('creates the secret with bearer injection on api.getdial.ai when there is none', async () => {
    const f = gateway([]);
    await expect(store(f)).resolves.toBe('sec-new');
    expect(JSON.parse(writes(f)[0][1].body as string)).toEqual({
      name: 'Dial API',
      type: 'generic',
      valueSource: 'inline',
      hostPattern: 'api.getdial.ai',
      value: 'sk_dial_fixture',
      injectionConfig: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    });
  });

  it.each([
    ['no auth file', () => fs.rmSync(auth)],
    ['an empty key', () => fs.writeFileSync(auth, JSON.stringify({ apiKey: ' ' }))],
    ['an unreadable file', () => fs.writeFileSync(auth, 'not json sk_dial_fixture')],
  ])('stops with %s, before any request and without echoing the file', async (_name, prepare) => {
    prepare();
    const f = gateway([]);
    const err = await store(f).catch((e: Error) => e);
    expect(String(err)).toContain('no Dial API key in the host auth file');
    expect(String(err)).not.toContain('sk_dial_fixture');
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses duplicate or differently scoped Dial secrets instead of guessing', async () => {
    await expect(store(gateway([existing(), existing({ id: 'sec-2' })]))).rejects.toThrow(
      'Multiple Dial API credentials',
    );
    await expect(store(gateway([existing({ hostPattern: 'evil.example' })]))).rejects.toThrow(
      'unexpected metadata in: hostPattern',
    );
  });

  it('writes to the gateway the onecli CLI uses, with the CLI key, never NanoClaw’s .env gateway or key', async () => {
    const f = gateway([existing()]);
    await store(f);
    expect(f.mock.calls.every(([url]) => url.startsWith('http://gw.test:10254/'))).toBe(true);
    expect(f.mock.calls.every(([, init]) => !(init.headers as Record<string, string>).Authorization)).toBe(true);
    const keyed = gateway([existing()]);
    await store(keyed, { url: 'http://gw.test:10254', apiKey: 'oc_cli' });
    expect(
      keyed.mock.calls.every(([, init]) => (init.headers as Record<string, string>).Authorization === 'Bearer oc_cli'),
    ).toBe(true);
  });

  it('reads the CLI connection, and stops without an api-host', () => {
    const run = (out: Record<string, string>) => (args: string[]) => {
      const v = out[args.join(' ')];
      if (v === undefined) throw new Error('not logged in');
      return v;
    };
    expect(
      cliConnection(
        run({ 'config get api-host': '{"key":"api-host","value":"http://h:1"}', 'auth api-key': '{"apiKey":"oc_k"}' }),
      ),
    ).toEqual({ url: 'http://h:1', apiKey: 'oc_k' });
    expect(cliConnection(run({ 'config get api-host': '{"value":"http://h:1"}' }))).toEqual({
      url: 'http://h:1',
      apiKey: '',
    });
    expect(() => cliConnection(run({}))).toThrow("could not read the onecli CLI's api-host");
  });

  it('reads the auth file where the dial CLI writes it', () => {
    expect(dialAuthFile({ XDG_DATA_HOME: '/x' })).toBe('/x/dial/auth.v1.json');
    expect(dialAuthFile({})).toBe(path.join(os.homedir(), '.local', 'share', 'dial', 'auth.v1.json'));
  });
});
