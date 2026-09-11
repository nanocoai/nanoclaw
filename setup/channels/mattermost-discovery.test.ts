import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const script = '.claude/skills/add-mattermost/scripts/discover-server.mjs';

describe('Mattermost server discovery', () => {
  const cleanups: (() => Promise<unknown>)[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function fakeCommand(directory: string, name: string, body: string) {
    const path = join(directory, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
  }

  async function discover(
    commandSetup: (directory: string, port: number) => Promise<void>,
    basePath = '',
  ) {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(request.url === `${basePath}/api/v4/system/ping` ? '{"status":"OK"}' : '{}');
    });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');

    const bin = await mkdtemp(join(tmpdir(), 'mattermost-discovery-'));
    cleanups.push(() => rm(bin, { recursive: true, force: true }));
    await commandSetup(bin, address.port);
    const baseUrl = `http://127.0.0.1:${address.port}${basePath}`;
    const { stdout } = await execFileAsync(process.execPath, [script], {
      env: { ...process.env, PATH: bin, MATTERMOST_BASE_URL: baseUrl },
    });
    return { result: JSON.parse(stdout), baseUrl };
  }

  it('detects host-local mmctl without replacing the selected URL', async () => {
    const { result, baseUrl } = await discover(
      async (bin) => {
        await fakeCommand(bin, 'mmctl', 'exit 0');
      },
      '/mattermost',
    );
    expect(result).toEqual({
      discovery: 'found',
      base_url: baseUrl,
      config_access: 'host',
      mattermost_container: 'none',
    });
  });

  it('detects mmctl in a Mattermost container published on the selected port', async () => {
    const { result } = await discover(async (bin, port) => {
      await fakeCommand(bin, 'mmctl', 'exit 1');
      await fakeCommand(
        bin,
        'docker',
        `if [ "$1" = "ps" ]; then printf 'mattermost-lab\\tmattermost/mattermost-team-edition\\t127.0.0.1:${port}->8065/tcp\\n'; exit 0; fi\nexit 0`,
      );
    });
    expect(result).toMatchObject({ config_access: 'docker', mattermost_container: 'mattermost-lab' });
  });

  it('does not associate a Mattermost container published on another port', async () => {
    const { result } = await discover(async (bin) => {
      await fakeCommand(bin, 'mmctl', 'exit 1');
      await fakeCommand(
        bin,
        'docker',
        `if [ "$1" = "ps" ]; then printf 'mattermost-lab\\tmattermost/mattermost-team-edition\\t127.0.0.1:9999->8065/tcp\\n'; exit 0; fi\nexit 0`,
      );
    });
    expect(result).toMatchObject({ config_access: 'unavailable', mattermost_container: 'none' });
  });
});
