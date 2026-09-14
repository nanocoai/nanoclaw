import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

import { expect, it } from 'vitest';

it('retries activation after the service build failed while the old service stayed healthy', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-launch-recovery-'));
  const root = path.join(fixture, 'install');
  const registry = path.join(fixture, 'registry');
  const bin = path.join(fixture, 'bin');
  const launcher = '.claude/skills/setup-ollama-launch/scripts/launch.ts';
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  fs.mkdirSync(root);
  fs.mkdirSync(registry);
  fs.mkdirSync(bin);
  let server: http.Server | undefined;
  try {
    git(process.cwd(), 'archive', '--output', path.join(fixture, 'source.tar'), 'HEAD');
    execFileSync('tar', ['-xf', path.join(fixture, 'source.tar'), '-C', root]);
    fs.copyFileSync(path.join(process.cwd(), launcher), path.join(root, launcher));
    fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(root, 'node_modules'), 'dir');
    // The payload repository is synthetic test data, never a feature-branch commit.
    fs.writeFileSync(path.join(registry, 'provider.txt'), 'new provider payload\n');
    fs.writeFileSync(path.join(registry, 'channel.txt'), 'new channel payload\n');
    git(registry, 'init');
    git(registry, 'add', '.');
    git(
      registry,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture',
    );
    git(registry, 'branch', 'providers');
    git(registry, 'branch', 'channels');
    git(root, 'init');
    git(root, 'remote', 'add', 'origin', registry);
    for (const [skill, branch, file] of [
      ['add-ollama-provider', 'providers', 'provider.txt'],
      ['add-local-web-chat', 'channels', 'channel.txt'],
    ]) {
      fs.writeFileSync(
        path.join(root, '.claude/skills', skill, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: Test fixture\n---\n# Apply\n\`\`\`nc:copy from-branch:${branch}\n${file}\n\`\`\`\n`,
      );
    }
    fs.writeFileSync(
      path.join(bin, 'pnpm'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PWD/setup-calls"\nif [ "$*" = "exec tsx setup/index.ts --step service" ] && [ -f "$PWD/fail-service" ]; then exit 1; fi\n',
    );
    fs.chmodSync(path.join(bin, 'pnpm'), 0o755);
    fs.writeFileSync(path.join(root, 'bin/ncl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PWD/ncl-calls"\n');
    fs.chmodSync(path.join(root, 'bin/ncl'), 0o755);
    fs.writeFileSync(path.join(bin, 'open'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(bin, 'open'), 0o755);
    const env = {
      ...process.env,
      HOME: path.join(fixture, 'home'),
      PATH: `${bin}:${process.env.PATH}`,
      NANOCLAW_INSTALL_ID: 'launch-recovery-test',
    };
    const seed = `
      import { initDb, closeDb } from './src/db/connection.ts';
      import { runMigrations } from './src/db/migrations/index.ts';
      import { createAgentGroup } from './src/db/agent-groups.ts';
      import { ensureContainerConfig, updateContainerConfigScalars } from './src/db/container-configs.ts';
      import { writeUpgradeState } from './src/upgrade-state.ts';
      await runMigrations(await initDb('data/v2.db'));
      await createAgentGroup({ id:'ag-test',name:'Ollama',folder:'ollama',agent_provider:null,created_at:new Date().toISOString() });
      await ensureContainerConfig('ag-test','ollama');
      await updateContainerConfigScalars('ag-test',{provider:'ollama',model:'fixture-model'});
      writeUpgradeState({via:'test'});
      await closeDb();
    `;
    fs.mkdirSync(path.join(root, 'data/local-web'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/local-web/token'), 'fixture-token');
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', seed], {
      cwd: root,
      env,
      stdio: 'pipe',
    });
    let welcomes = 0;
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/messages') welcomes++;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          req.url === '/healthz' ? { ok: true, channel: 'local-web', install: env.NANOCLAW_INSTALL_ID } : { ok: true },
        ),
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected test TCP listener');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const args = [
      launcher,
      '--group',
      'ag-test',
      '--model',
      'fixture-model',
      '--base-url',
      baseUrl,
      '--web-browsing',
      'disabled',
    ];
    const run = (): Promise<{ code: number | null; output: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
          cwd: root,
          env: { ...env, NANOCLAW_LOCAL_WEB_PORT: String(address.port) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          output += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, output }));
      });
    fs.writeFileSync(path.join(root, 'fail-service'), '');
    const first = await run();
    expect(first.code, first.output).toBe(1);
    expect(first.output).toContain('setup step service failed');
    fs.unlinkSync(path.join(root, 'fail-service'));
    const second = await run();
    expect(second.code, second.output).toBe(0);
    const calls = fs.readFileSync(path.join(root, 'setup-calls'), 'utf8').split('\n');
    expect(calls.filter((call) => call === 'exec tsx setup/index.ts --step service')).toHaveLength(2);
    expect(fs.readFileSync(path.join(root, 'ncl-calls'), 'utf8')).toContain('groups restart --id ag-test');
    expect(welcomes).toBe(1);
    const third = await run();
    expect(third.code, third.output).toBe(0);
    expect(
      fs
        .readFileSync(path.join(root, 'setup-calls'), 'utf8')
        .split('\n')
        .filter((call) => call === 'exec tsx setup/index.ts --step service'),
    ).toHaveLength(2);
    expect(welcomes).toBe(1);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);
