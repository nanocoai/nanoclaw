import { exec, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseDirectives } from '../../scripts/skill-directives.js';

const execAsync = promisify(exec);
const directives = parseDirectives(readFileSync('.claude/skills/add-mattermost/SKILL.md', 'utf8'));
const token = 'fixture_bot_token_0123456789';
const owner = 'o'.repeat(26);
const bot = 'b'.repeat(26);
const dm = 'd'.repeat(26);
let server: Server;
let bin: string;
let baseUrl: string;
let response: unknown;
let status: number;
let requests: { path: string; authorization: string | undefined; body: string }[];

beforeEach(async () => {
  // Exercise the actual skill commands in a fresh-host PATH: Node and curl,
  // without jq or a shell fallback that can accidentally find it elsewhere.
  bin = mkdtempSync(join(tmpdir(), 'nc-mm-no-jq-'));
  symlinkSync(process.execPath, join(bin, 'node'));
  symlinkSync(execFileSync('/bin/sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).trim(), join(bin, 'curl'));
  status = 200;
  requests = [];
  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization, body });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof response === 'string' ? response : JSON.stringify(response));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(bin, { recursive: true, force: true });
});

function run(path: string) {
  const directive = directives.find((d) => d.kind === 'run' && d.body.some((line) => line.includes(path)));
  if (!directive) throw new Error('Missing API directive');
  const vars: Record<string, string> = {
    base_url: baseUrl,
    bot_token: token,
    owner_user_id: owner,
    bot_user_id: bot,
  };
  const command = directive.body.join('\n').replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name]);
  return execAsync(command, { shell: '/bin/sh', env: { ...process.env, PATH: bin } });
}

describe('Mattermost skill API checks without jq', () => {
  it('validates server configuration through the declared skill command', async () => {
    response = { SiteURL: baseUrl, WebsocketURL: '' };
    expect((await run('/api/v4/config/client')).stdout).toBe(`${baseUrl}\n\n`);
    expect(requests).toEqual([{ path: '/api/v4/config/client?format=old', authorization: undefined, body: '' }]);
  });

  it.each([{ SiteURL: 'https://different.invalid', WebsocketURL: '' }, { WebsocketURL: 'wss://different.invalid' }])(
    'rejects mismatched server configuration',
    async (config) => {
      response = { SiteURL: baseUrl, ...config };
      await expect(run('/api/v4/config/client')).rejects.toMatchObject({ code: 1 });
    },
  );

  it('opens and captures the selected owner/bot DM through the declared command', async () => {
    response = { id: dm, type: 'D' };
    expect((await run('/api/v4/channels/direct')).stdout).toBe(`mattermost:${dm}\n`);
    expect(requests).toEqual([
      { path: '/api/v4/channels/direct', authorization: `Bearer ${token}`, body: JSON.stringify([owner, bot]) },
    ]);
  });

  it.each([{ id: 'invalid', type: 'D' }, { id: dm, type: 'P' }, 'private invalid JSON'])(
    'rejects malformed or non-DM responses without echoing their contents',
    async (body) => {
      response = body;
      await expect(run('/api/v4/channels/direct')).rejects.toMatchObject({
        code: 1,
        stdout: '',
        stderr: 'Could not verify the Mattermost server configuration or owner DM response.\n',
      });
    },
  );

  it('propagates a failed API request through the pipeline', async () => {
    status = 401;
    response = { message: 'private server error' };
    await expect(run('/api/v4/channels/direct')).rejects.toMatchObject({ code: 1, stdout: '' });
  });
});
