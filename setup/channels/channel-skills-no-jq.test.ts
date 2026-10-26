// The channel skills' API steps, run the way setup runs them (the engine,
// through the host shell) on a fresh-host PATH that has Node but no jq. Stock
// Ubuntu and WSL do not ship jq, and nothing installs it. Fake curl, dial and
// ncl answer fixture responses, so no test reaches a real API.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { applySkill, fullyApplied } from '../../scripts/skill-apply.js';
import { parseDirectives } from '../../scripts/skill-directives.js';
import { hostExec } from '../lib/skill-driver.js';

const SKILLS_DIR = join(process.cwd(), '.claude/skills');

let base: string;
let bin: string;
let fixtures: string;
let root: string;

// Build the PATH once per file: the first run of a freshly written executable
// is slow on macOS, so a new set per test would add seconds.
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'nc-no-jq-'));
  bin = join(base, 'path');
  fixtures = join(base, 'fixtures');
  mkdirSync(bin);
  for (const tool of ['bash', 'mv', 'chmod']) {
    const real = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
    symlinkSync(real, join(bin, tool));
  }
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const tool of ['curl', 'dial', 'ncl']) fakeTool(tool);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  root = mkdtempSync(join(base, 'root-'));
  mkdirSync(fixtures);
  vi.stubEnv('PATH', bin);
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(fixtures, { recursive: true, force: true });
});

// A stand-in CLI that prints its fixture body. Like real curl, `-f` turns an
// HTTP error status into exit 22 with no output; dial and ncl exit with the
// fixture status instead.
function fakeTool(tool: string): void {
  const status = `"$(<"${fixtures}/${tool}.status")"`;
  const fail =
    tool === 'curl'
      ? `for a in "$@"; do case "$a" in --*) ;; -*f*) [ ${status} -ge 400 ] && exit 22 ;; esac; done`
      : `[ ${status} = 0 ] || exit ${status}`;
  const script = [
    '#!/bin/bash',
    `printf '%s\\n' "$*" >> "${fixtures}/${tool}.calls"`,
    fail,
    `printf '%s' "$(<"${fixtures}/${tool}.body")"`,
    '',
  ].join('\n');
  writeFileSync(join(bin, tool), script);
  chmodSync(join(bin, tool), 0o755);
}

function respond(tool: 'curl' | 'dial' | 'ncl', body: unknown, status = tool === 'curl' ? 200 : 0): void {
  writeFileSync(join(fixtures, `${tool}.body`), typeof body === 'string' ? body : JSON.stringify(body));
  writeFileSync(join(fixtures, `${tool}.status`), String(status));
}

const calls = (tool: string): string => readFileSync(join(fixtures, `${tool}.calls`), 'utf8');

// The one nc: fence in a skill's SKILL.md whose text contains `needle`.
function fence(skill: string, needle: string): string {
  const text = readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
  const found = [...text.matchAll(/```nc:[^\n]*\n[\s\S]*?\n```/g)].map((m) => m[0]).filter((b) => b.includes(needle));
  if (found.length !== 1)
    throw new Error(`Expected one ${skill} directive containing ${needle}, found ${found.length}`);
  return found[0];
}

// Apply one real step from a skill, with its inputs bound by plain prompts.
async function apply(skill: string, needle: string, inputs: Record<string, string>) {
  const dir = join(root, 'skill');
  mkdirSync(dir, { recursive: true });
  const prompts = Object.keys(inputs).map((name) => `\`\`\`nc:prompt ${name}\n${name}\n\`\`\``);
  writeFileSync(join(dir, 'SKILL.md'), [...prompts, fence(skill, needle)].join('\n\n'));
  return applySkill(dir, root, { inputs, exec: hostExec(root) });
}

function expectFailed(res: Awaited<ReturnType<typeof apply>>, captured: string): void {
  expect(fullyApplied(res)).toBe(false);
  expect(res.agentTasks).toHaveLength(1);
  expect(res.vars[captured]).toBeUndefined();
}

it('the test PATH has no jq', () => {
  expect(() => execFileSync(join(bin, 'bash'), ['-c', 'command -v jq'], { env: { PATH: bin } })).toThrow();
});

describe('add-slack', () => {
  const inputs = { bot_token: 'xoxb-fixture-token', owner_handle: 'U0FIXTURE1' };

  it('captures the bot identity from auth.test', async () => {
    respond('curl', { ok: true, url: 'https://acme.slack.com/', team: 'Acme', user: 'nano', user_id: 'U0BOT' });
    const res = await apply('add-slack', 'auth.test', inputs);
    expect(fullyApplied(res)).toBe(true);
    expect(res.vars.connected_as).toBe('@nano in Acme');
    expect(calls('curl')).toContain('Authorization: Bearer xoxb-fixture-token');
  });

  it.each([{ ok: false, error: 'invalid_auth' }, 'not json', ''])(
    'fails auth.test without an identity',
    async (body) => {
      respond('curl', body);
      expectFailed(await apply('add-slack', 'auth.test', inputs), 'connected_as');
    },
  );

  it('fails auth.test on an HTTP error', async () => {
    respond('curl', { ok: false }, 500);
    expectFailed(await apply('add-slack', 'auth.test', inputs), 'connected_as');
  });

  it('opens the owner DM and captures its address', async () => {
    respond('curl', { ok: true, channel: { id: 'D0FIXTURE' } });
    const res = await apply('add-slack', 'conversations.open', inputs);
    expect(fullyApplied(res)).toBe(true);
    expect(res.vars.platform_id).toBe('slack:D0FIXTURE');
    expect(calls('curl')).toContain('{"users":"U0FIXTURE1"}');
  });

  it.each([{ ok: false, error: 'missing_scope', needed: 'im:write' }, { ok: true, channel: {} }, 'not json'])(
    'fails the DM step without a channel id',
    async (body) => {
      respond('curl', body);
      expectFailed(await apply('add-slack', 'conversations.open', inputs), 'platform_id');
    },
  );
});

describe('add-discord', () => {
  const inputs = { bot_token: 'fixture.bot.token', owner_handle: '111222333444555666' };

  it('opens the owner DM and captures its address', async () => {
    respond('curl', { id: '1234567890123456789', type: 1, recipients: [{ id: '111222333444555666' }] });
    const res = await apply('add-discord', 'users/@me/channels', inputs);
    expect(fullyApplied(res)).toBe(true);
    expect(res.vars.platform_id).toBe('discord:@me:1234567890123456789');
    expect(calls('curl')).toContain('{"recipient_id":"111222333444555666"}');
  });

  it.each([
    { status: 403, body: { message: 'Cannot send messages to this user', code: 50007 } },
    { status: 401, body: { message: '401: Unauthorized', code: 0 } },
    { status: 200, body: 'not json' },
  ])('fails the DM step when Discord refuses ($status)', async ({ status, body }) => {
    respond('curl', body, status);
    expectFailed(await apply('add-discord', 'users/@me/channels', inputs), 'platform_id');
  });
});

describe('add-telegram', () => {
  const getMe = { ok: true, result: { id: 123456789, is_bot: true, first_name: 'Nano', username: 'nanoclaw_bot' } };

  it.each<{ needle: string; captured: string; inputs: Record<string, string> }>([
    { needle: 'bot{{bot_token}}/getMe', captured: 'bot_username', inputs: { bot_token: '123:fixture' } },
    {
      needle: 'bot{{bot_token_2}}/getMe',
      captured: 'bot_username_2',
      inputs: { add_another: 'yes', bot_token_2: '456:fixture' },
    },
  ])('captures $captured from getMe', async ({ needle, captured, inputs }) => {
    respond('curl', getMe);
    const res = await apply('add-telegram', needle, inputs);
    expect(fullyApplied(res)).toBe(true);
    expect(res.vars[captured]).toBe('nanoclaw_bot');
  });

  it.each([
    { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } },
    { status: 200, body: { ok: true, result: { id: 1, is_bot: true } } },
    { status: 200, body: 'not json' },
  ])('fails getMe without a username ($status)', async ({ status, body }) => {
    respond('curl', body, status);
    expectFailed(await apply('add-telegram', 'bot{{bot_token}}/getMe', { bot_token: '123:fixture' }), 'bot_username');
  });
});

describe('add-teams', () => {
  const token = { wire_owner: 'yes', app_tenant_id: 'tenant-1', app_id: 'app-1', app_password: 'fixture-secret' };
  const create = {
    wire_owner: 'yes',
    bot_token: 'eyJfixture',
    app_id: 'app-1',
    owner_aad_id: 'aad-1',
    app_tenant_id: 'tenant-1',
  };
  const members = { wire_owner: 'yes', bot_token: 'eyJfixture', conversation_id: 'a:1fixture' };

  it('captures the Bot Framework token', async () => {
    respond('curl', {
      token_type: 'Bearer',
      expires_in: 3599,
      ext_expires_in: 3599,
      access_token: 'eyJfixture.token.sig',
    });
    const res = await apply('add-teams', 'oauth2/v2.0/token', token);
    expect(fullyApplied(res)).toBe(true);
    expect(res.vars.bot_token).toBe('eyJfixture.token.sig');
  });

  it.each([
    { status: 401, body: { error: 'invalid_client' } },
    { status: 200, body: { token_type: 'Bearer' } },
  ])('fails the token step without an access token ($status)', async ({ status, body }) => {
    respond('curl', body, status);
    expectFailed(await apply('add-teams', 'oauth2/v2.0/token', token), 'bot_token');
  });

  it('captures the created conversation id', async () => {
    respond('curl', { id: 'a:1fixture', activityId: 'x' });
    const res = await apply('add-teams', '/v3/conversations"', create);
    expect(fullyApplied(res)).toBe(true);
    expect(res.vars.conversation_id).toBe('a:1fixture');
  });

  it('fails the create step without a conversation id', async () => {
    respond('curl', { activityId: 'x' });
    expectFailed(await apply('add-teams', '/v3/conversations"', create), 'conversation_id');
  });

  it.each([
    {
      list: [
        { id: '28:app-1', name: 'Bot' },
        { id: '29:owner', name: 'Dan', givenName: 'D' },
      ],
      name: 'Dan',
    },
    { list: [{ id: '29:owner', givenName: 'Dana' }], name: 'Dana' },
    { list: [{ id: '29:owner' }], name: 'Teams user' },
  ])('picks the first non-bot member as the owner ($name)', async ({ list, name }) => {
    respond('curl', list);
    const res = await apply('add-teams', '/members"', members);
    expect(fullyApplied(res)).toBe(true);
    expect(res.vars.owner_handle).toBe('29:owner');
    expect(res.vars.owner_name).toBe(name);
  });

  it.each([[], [{ id: '28:app-1', name: 'Bot' }], [{ id: 123, name: 'Owner' }], 'not json'])(
    'fails without a non-bot member',
    async (body) => {
      respond('curl', body);
      expectFailed(await apply('add-teams', '/members"', members), 'owner_handle');
    },
  );
});

describe('add-dial', () => {
  const numbers = {
    numbers: [
      { id: 'pn_new', number: '+14155550123' },
      { id: 'pn_old', number: '+14155550100' },
    ],
  };

  it('captures the newest number as the line', async () => {
    respond('dial', numbers);
    const res = await apply('add-dial', 'capture:platform_id', { dial_ua: 'nanoclaw/2.2.0' });
    expect(fullyApplied(res)).toBe(true);
    expect(res.vars.platform_id).toBe('+14155550123');
    expect(calls('dial')).toBe('number list --json\n');
  });

  it.each([
    { status: 0, body: { numbers: [] } },
    { status: 0, body: {} },
    { status: 1, body: '' },
  ])('fails the line step without a number', async ({ status, body }) => {
    respond('dial', body, status);
    expectFailed(await apply('add-dial', 'capture:platform_id', { dial_ua: 'nanoclaw/2.2.0' }), 'platform_id');
  });

  describe('default sender pin', () => {
    const auth = {
      apiKey: 'fixture-key',
      email: 'op@example.com',
      phoneNumber: '+14155550100',
      phoneNumberId: 'pn_old',
    };
    let file: string;

    beforeEach(() => {
      file = join(root, 'data', 'dial', 'auth.v1.json');
      mkdirSync(join(root, 'data', 'dial'), { recursive: true });
      writeFileSync(file, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 });
    });

    it('points the auth file at the wired line and keeps it private', async () => {
      respond('dial', numbers);
      const res = await apply('add-dial', 'auth.v1.json', { dial_ua: 'nanoclaw/2.2.0', platform_id: '+14155550123' });
      expect(fullyApplied(res)).toBe(true);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        ...auth,
        phoneNumber: '+14155550123',
        phoneNumberId: 'pn_new',
      });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(existsSync(`${file}.new`)).toBe(false);
    });

    it.each([
      { why: 'the line is not on the account', list: numbers, line: '+14155550999' },
      { why: 'the line has no id', list: { numbers: [{ id: false, number: '+14155550123' }] }, line: '+14155550123' },
    ])('leaves the auth file alone when $why', async ({ list, line }) => {
      respond('dial', list);
      const res = await apply('add-dial', 'auth.v1.json', { dial_ua: 'nanoclaw/2.2.0', platform_id: line });
      expect(fullyApplied(res)).toBe(false);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(auth);
      expect(existsSync(`${file}.new`)).toBe(false);
    });

    it('refuses an auth file that is not an object', async () => {
      writeFileSync(file, '[]\n', { mode: 0o600 });
      respond('dial', numbers);
      const res = await apply('add-dial', 'auth.v1.json', { dial_ua: 'nanoclaw/2.2.0', platform_id: '+14155550123' });
      expect(fullyApplied(res)).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe('[]\n');
    });
  });

  it.each([
    { data: [], answer: 'no' },
    { data: [{ id: 'ag-1', name: 'Nano' }], answer: 'yes' },
  ])('answers whether agents exist ($answer)', async ({ data, answer }) => {
    respond('ncl', { data });
    const res = await apply('add-dial', 'capture:has_agents', { install_tool: 'yes' });
    expect(fullyApplied(res)).toBe(true);
    expect(res.vars.has_agents).toBe(answer);
  });

  it('fails the agents check when ncl fails', async () => {
    respond('ncl', '', 1);
    expectFailed(await apply('add-dial', 'capture:has_agents', { install_tool: 'yes' }), 'has_agents');
  });

  it('lists the agents for the Dial scope question', async () => {
    respond('ncl', {
      data: [
        { id: 'ag-1', name: 'Nano' },
        { id: 'ag-2', name: 'Ops' },
      ],
    });
    const res = await apply('add-dial', 'capture:agent_groups', { has_agents: 'yes' });
    expect(fullyApplied(res)).toBe(true);
    expect(res.vars.agent_groups).toBe('ag-1 (Nano), ag-2 (Ops)');
  });
});

// Skills that still pipe through jq. Setup reaches add-dial-tool only when the
// operator accepts Dial's optional tool install (the channel works without it),
// and add-dial-number adds a line to an installed Dial channel after setup.
const STILL_USE_JQ = ['add-dial-number', 'add-dial-tool'];

// Checks nc:run bodies only, not the scripts they call.
it('no other skill has an nc:run step that pipes through jq', () => {
  const runsJq = (body: string): boolean => /(?:^|[\s|;&(])jq(?:\s|$)/m.test(body);
  const offenders = readdirSync(SKILLS_DIR)
    .filter((name) => existsSync(join(SKILLS_DIR, name, 'SKILL.md')))
    .filter((name) =>
      parseDirectives(readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8')).some(
        (d) => d.kind === 'run' && runsJq(d.body.join('\n')),
      ),
    );
  expect(offenders.sort()).toEqual(STILL_USE_JQ);
});
