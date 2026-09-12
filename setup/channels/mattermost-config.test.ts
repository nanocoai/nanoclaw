import { exec } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fullyApplied } from '../../scripts/skill-apply.js';
import { readEnvFile } from '../../src/env.js';
import { runSkill } from '../lib/skill-driver.js';

const execAsync = promisify(exec);
const quote = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
const helper = resolve('.claude/skills/add-mattermost/scripts/configure.ts');
const tsx = resolve('node_modules/tsx/dist/cli.mjs');
const source = readFileSync('.claude/skills/add-mattermost/SKILL.md', 'utf8');
// Server selection is outside this slice; bind its output through a fixture
// prompt, then execute the authentication/configuration directives verbatim.
const settingsSkill =
  '# Configuration fixture\n\n```nc:prompt base_url\nServer URL\n```\n' +
  source.slice(source.indexOf('### 4.'), source.indexOf('### 6.'));
const oldToken = 'existing_bot_token_0123456789';
const newToken = 'replacement_bot_token_0123456789';
const secret = 'a'.repeat(64);
let root: string;
let skillDir: string;
let server: Server;
let baseUrl: string;
let auth: string[];
let rejectAuth: boolean;
let botAccount: boolean;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'nc-mm-config-'));
  skillDir = join(root, 'skill');
  mkdirSync(skillDir);
  writeFileSync(join(skillDir, 'SKILL.md'), settingsSkill);
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}');
  writeFileSync(
    join(root, '.env'),
    `UNRELATED=keep\nMATTERMOST_BASE_URL=http://old.invalid\nMATTERMOST_BOT_TOKEN=${oldToken}\nMATTERMOST_CALLBACK_URL=http://old.invalid/webhook/mattermost\nMATTERMOST_CALLBACK_SECRET=${secret}\n`,
  );
  auth = [];
  rejectAuth = false;
  botAccount = true;
  server = createServer((req, res) => {
    auth.push(req.headers.authorization ?? '');
    res.writeHead(rejectAuth ? 401 : 200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        rejectAuth ? { message: 'unauthorized' } : { id: 'b'.repeat(26), username: 'fixture-bot', is_bot: botAccount },
      ),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});

async function run(reuse = false, callback = 'http://new.invalid/webhook/mattermost') {
  return runSkill(skillDir, {
    projectRoot: root,
    inputs: { base_url: baseUrl },
    reuse: true,
    confirm: async () => reuse,
    resolveInput: async (name) => (name === 'bot_token' ? newToken : callback),
    onEvent: () => {},
    exec: async (command) => {
      const actual = command.replace(
        'pnpm exec tsx .claude/skills/add-mattermost/scripts/configure.ts',
        `${quote(process.execPath)} ${quote(tsx)} ${quote(helper)}`,
      );
      const { stdout } = await execAsync(actual, { cwd: root });
      return stdout;
    },
  });
}

describe('Mattermost configuration through the real skill driver', () => {
  it('saves a selected replacement token and callback while keeping existing cards valid', async () => {
    const result = await run();
    expect(fullyApplied(result), JSON.stringify(result)).toBe(true);
    expect(auth).toEqual([`Bearer ${newToken}`]);
    expect(
      readEnvFile(
        [
          'MATTERMOST_BASE_URL',
          'MATTERMOST_BOT_TOKEN',
          'MATTERMOST_CALLBACK_URL',
          'MATTERMOST_CALLBACK_SECRET',
          'UNRELATED',
        ],
        root,
      ),
    ).toEqual({
      MATTERMOST_BASE_URL: baseUrl,
      MATTERMOST_BOT_TOKEN: newToken,
      MATTERMOST_CALLBACK_URL: 'http://new.invalid/webhook/mattermost',
      MATTERMOST_CALLBACK_SECRET: secret,
      UNRELATED: 'keep',
    });
    expect(JSON.stringify(result)).not.toContain(newToken);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('uses and retains the settings accepted in the reuse prompts', async () => {
    expect(fullyApplied(await run(true))).toBe(true);
    expect(auth).toEqual([`Bearer ${oldToken}`]);
    expect(readEnvFile(['MATTERMOST_BOT_TOKEN', 'MATTERMOST_CALLBACK_URL'], root)).toEqual({
      MATTERMOST_BOT_TOKEN: oldToken,
      MATTERMOST_CALLBACK_URL: 'http://old.invalid/webhook/mattermost',
    });
  });

  it('does not persist a token rejected by Mattermost', async () => {
    rejectAuth = true;
    const before = readFileSync(join(root, '.env'), 'utf8');
    expect(fullyApplied(await run())).toBe(false);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(before);
  });

  it('does not persist credentials for a non-bot account', async () => {
    botAccount = false;
    const before = readFileSync(join(root, '.env'), 'utf8');
    expect(fullyApplied(await run())).toBe(false);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(before);
  });

  it('rejects shell syntax in a callback URL before any configuration write', async () => {
    const before = readFileSync(join(root, '.env'), 'utf8');
    expect(fullyApplied(await run(false, 'http://example.com/$(touch injected)'))).toBe(false);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(before);
  });

  it('generates a private callback secret once without exporting it in the result', async () => {
    writeFileSync(join(root, '.env'), 'UNRELATED=keep\n');
    const result = await run();
    expect(fullyApplied(result)).toBe(true);
    const first = readEnvFile(['MATTERMOST_CALLBACK_SECRET'], root).MATTERMOST_CALLBACK_SECRET;
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(first);
    expect(result.vars).not.toHaveProperty('callback_secret');
    expect(fullyApplied(await run(true))).toBe(true);
    expect(readEnvFile(['MATTERMOST_CALLBACK_SECRET'], root).MATTERMOST_CALLBACK_SECRET).toBe(first);
  });
});
