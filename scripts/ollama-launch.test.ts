import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../src/db/agent-groups.js';
import { getContainerConfig } from '../src/db/container-configs.js';
import { closeDb, initTestDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  deleteMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  getMessagingGroupsByAgentGroup,
} from '../src/db/messaging-groups.js';
import { getInstallSlug } from '../src/install-slug.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { hasMembershipRow } from '../src/modules/permissions/db/agent-group-members.js';
import { getDestinationByTarget } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { getUserRoles, grantRole } from '../src/modules/permissions/db/user-roles.js';
import { getUser, upsertUser } from '../src/modules/permissions/db/users.js';
import {
  applyLaunchContainerConfig,
  ensureLocalWebOperator,
  ensureWebWiring,
  hasReusableOnecli,
  launchFallbackDisplayName,
  parseArgs,
  resolveAgentGroup,
  providerPayloadNeedsContainerBuild,
  rewriteBaseUrlForContainer,
  runSkillGitCommand,
  sendWiringWelcome,
  verifyOllamaContext,
  webChatIsReady,
  writeOllamaModelState,
} from '../.claude/skills/setup-ollama-launch/scripts/launch.js';

afterEach(async () => closeDb());

describe('Ollama launch contract', () => {
  it('wires the launched group before service startup can backfill it', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), '.claude/skills/setup-ollama-launch/scripts/launch.ts'),
      'utf8',
    );
    const main = source.slice(source.indexOf('async function main'));
    const wiringIndex = main.indexOf('const webWiring = await ensureWebWiring');
    const serviceIndex = main.indexOf("runSetupStep('service')");
    expect(wiringIndex).toBeGreaterThan(-1);
    expect(serviceIndex).toBeGreaterThan(wiringIndex);
  });

  it('keeps pnpm from recursively self-installing in a fresh home', () => {
    const setup = fs.readFileSync(path.join(process.cwd(), 'setup.sh'), 'utf8');
    const launcher = fs.readFileSync(
      path.join(process.cwd(), '.claude/skills/setup-ollama-launch/scripts/launch.sh'),
      'utf8',
    );
    expect(setup).toContain('export npm_config_manage_package_manager_versions=false');
    expect(launcher).toContain('export npm_config_manage_package_manager_versions=false');
  });

  it('recovers pnpm installed by bootstrap outside the inherited PATH', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-launch-path-'));
    const home = path.join(root, 'home');
    const launcher = path.join(root, '.claude/skills/setup-ollama-launch/scripts/launch.sh');
    try {
      fs.mkdirSync(path.dirname(launcher), { recursive: true });
      fs.mkdirSync(home);
      fs.copyFileSync(path.join(process.cwd(), '.claude/skills/setup-ollama-launch/scripts/launch.sh'), launcher);
      fs.writeFileSync(
        path.join(root, 'setup.sh'),
        '#!/bin/bash\nset -e\nmkdir -p "$HOME/.local/bin"\nprintf \'#!/bin/sh\\nexit 0\\n\' > "$HOME/.local/bin/node"\nprintf \'#!/bin/sh\\nprintf "reached\\\\n" > "$HOME/pnpm-reached"\\n\' > "$HOME/.local/bin/pnpm"\nchmod +x "$HOME/.local/bin/node" "$HOME/.local/bin/pnpm"\n',
      );
      execFileSync('/bin/bash', [launcher], { env: { HOME: home, PATH: '/usr/bin:/bin' } });
      expect(fs.readFileSync(path.join(home, 'pnpm-reached'), 'utf8')).toBe('reached\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('bootstraps when an ancestor checkout makes better-sqlite3 resolvable', () => {
    const ambientRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-launch-ambient-'));
    const root = path.join(ambientRoot, 'nested', 'nanoclaw');
    const home = path.join(ambientRoot, 'home');
    const bin = path.join(ambientRoot, 'bin');
    const launcher = path.join(root, '.claude/skills/setup-ollama-launch/scripts/launch.sh');
    try {
      fs.mkdirSync(path.dirname(launcher), { recursive: true });
      fs.mkdirSync(home);
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(ambientRoot, 'node_modules', 'better-sqlite3'), { recursive: true });
      fs.writeFileSync(path.join(ambientRoot, 'node_modules', 'better-sqlite3', 'index.js'), 'module.exports = {}\n');
      fs.copyFileSync(path.join(process.cwd(), '.claude/skills/setup-ollama-launch/scripts/launch.sh'), launcher);
      fs.writeFileSync(
        path.join(root, 'setup.sh'),
        '#!/bin/bash\nset -e\ntouch "$HOME/setup-ran"\nmkdir -p node_modules/.bin node_modules/better-sqlite3\ntouch node_modules/.bin/tsx node_modules/better-sqlite3/package.json\nchmod +x node_modules/.bin/tsx\n',
      );
      fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\ntouch "$HOME/pnpm-reached"\n');
      fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
      fs.chmodSync(path.join(bin, 'pnpm'), 0o755);
      fs.chmodSync(path.join(bin, 'node'), 0o755);

      execFileSync(process.execPath, ['-e', "require('better-sqlite3')"], { cwd: root });
      expect(fs.existsSync(path.join(root, 'node_modules', '.bin', 'tsx'))).toBe(false);

      execFileSync('/bin/bash', [launcher], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } });

      expect(fs.existsSync(path.join(home, 'setup-ran'))).toBe(true);
      expect(fs.existsSync(path.join(home, 'pnpm-reached'))).toBe(true);
    } finally {
      fs.rmSync(ambientRoot, { recursive: true, force: true });
    }
  });

  it('bootstraps when local dependency markers exist but better-sqlite3 cannot load', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-launch-partial-'));
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    const launcher = path.join(root, '.claude/skills/setup-ollama-launch/scripts/launch.sh');
    try {
      fs.mkdirSync(path.dirname(launcher), { recursive: true });
      fs.mkdirSync(home);
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
      fs.mkdirSync(path.join(root, 'node_modules', 'better-sqlite3'), { recursive: true });
      fs.copyFileSync(path.join(process.cwd(), '.claude/skills/setup-ollama-launch/scripts/launch.sh'), launcher);
      fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'tsx'), '#!/bin/sh\nexit 0\n');
      fs.writeFileSync(
        path.join(root, 'node_modules', 'better-sqlite3', 'package.json'),
        '{"name":"better-sqlite3","main":"index.js"}\n',
      );
      fs.writeFileSync(path.join(root, 'node_modules', 'better-sqlite3', 'index.js'), 'throw new Error("broken")\n');
      fs.chmodSync(path.join(root, 'node_modules', '.bin', 'tsx'), 0o755);
      fs.writeFileSync(path.join(root, 'setup.sh'), '#!/bin/bash\ntouch "$HOME/setup-ran"\n');
      fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\ntouch "$HOME/pnpm-reached"\n');
      fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
      fs.chmodSync(path.join(bin, 'pnpm'), 0o755);
      fs.chmodSync(path.join(bin, 'node'), 0o755);

      execFileSync('/bin/bash', [launcher], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } });

      expect(fs.existsSync(path.join(home, 'setup-ran'))).toBe(true);
      expect(fs.existsSync(path.join(home, 'pnpm-reached'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fetches registry payloads without evaluating shell commands', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skill-git-'));
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    try {
      fs.mkdirSync(path.join(source, 'src', 'providers'), { recursive: true });
      fs.writeFileSync(path.join(source, 'src', 'providers', 'ollama.ts'), 'provider payload\n');
      git(source, 'init');
      git(source, 'config', 'user.email', 'test@example.com');
      git(source, 'config', 'user.name', 'Test');
      git(source, 'config', 'commit.gpgsign', 'false');
      git(source, 'add', '.');
      git(source, 'commit', '-m', 'fixture');
      git(source, 'branch', 'providers');

      fs.mkdirSync(path.join(target, 'copied'), { recursive: true });
      git(target, 'init');
      git(target, 'remote', 'add', 'origin', source);
      expect(runSkillGitCommand('git fetch origin +refs/heads/providers:refs/remotes/origin/providers', target)).toBe(
        false,
      );
      expect(runSkillGitCommand('git show origin/providers:src/providers/ollama.ts > copied/ollama.ts', target)).toBe(
        true,
      );
      expect(runSkillGitCommand('git show origin/providers:src/providers/ollama.ts > copied/ollama.ts', target)).toBe(
        false,
      );

      expect(fs.readFileSync(path.join(target, 'copied', 'ollama.ts'), 'utf8')).toBe('provider payload\n');
      expect(() => runSkillGitCommand('bash untrusted.sh', target)).toThrow('unexpected skill command');
      expect(() => runSkillGitCommand('git show origin/providers:file > ../escaped', target)).toThrow(
        'unexpected skill command',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates one idempotent web wiring for the selected agent', async () => {
    const db = await initTestDb();
    await runMigrations(db);
    await createAgentGroup({
      id: 'ag-web',
      name: 'Web Agent',
      folder: 'web-agent',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const cliGroup = {
      id: 'mg-cli',
      channel_type: 'cli',
      platform_id: 'local',
      name: 'Local CLI',
      is_group: 0,
      unknown_sender_policy: 'public' as const,
      created_at: new Date().toISOString(),
    };
    await createMessagingGroup(cliGroup);
    await createMessagingGroupAgent({
      id: 'mga-cli',
      messaging_group_id: cliGroup.id,
      agent_group_id: 'ag-web',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });

    const firstWiring = await ensureWebWiring('ag-web');
    expect(firstWiring.newlyWired).toBe(true);
    expect(await ensureWebWiring('ag-web')).toEqual({
      conversationId: firstWiring.conversationId,
      newlyWired: false,
    });
    const group = await getMessagingGroupByPlatform('local-web', 'local-web:local');
    expect(firstWiring.conversationId).toBe(group?.id);
    expect(group?.name).toBe('User');
    expect(group && (await getMessagingGroupAgentByPair(group.id, 'ag-web'))?.engage_pattern).toBe('.');
    expect(group && (await getDestinationByTarget('ag-web', 'channel', group.id))?.local_name).toBe('user');
    expect(await getMessagingGroupAgentByPair(cliGroup.id, 'ag-web')).toBeUndefined();

    await createAgentGroup({
      id: 'ag-web-2',
      name: 'Web Agent 2',
      folder: 'web-agent-2',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const secondWiring = await ensureWebWiring('ag-web-2');
    const secondGroup = await getMessagingGroup(secondWiring.conversationId);
    expect(secondWiring).toMatchObject({ newlyWired: true });
    expect(secondGroup?.platform_id).toBe('local-web:agent:ag-web-2');
    expect(secondGroup?.name).toBe('User');
    expect(group && (await getMessagingGroupAgents(group.id)).map((entry) => entry.agent_group_id)).toEqual(['ag-web']);
    expect(await getMessagingGroupsByAgentGroup('ag-web')).toHaveLength(1);
    expect(await getMessagingGroupsByAgentGroup('ag-web-2')).toHaveLength(1);
    expect((await getDestinationByTarget('ag-web-2', 'channel', secondWiring.conversationId))?.local_name).toBe('user');
  });

  it('relaunch finds any surviving browser agent and reports none after the last deletion', async () => {
    const db = await initTestDb();
    await runMigrations(db);
    for (const [id, name] of [
      ['ag-web', 'Web Agent'],
      ['ag-child', 'Child'],
    ] as const) {
      await createAgentGroup({ id, name, folder: id, agent_provider: null, created_at: new Date().toISOString() });
    }
    const launched = await ensureWebWiring('ag-web');
    const child = await ensureWebWiring('ag-child');
    expect((await resolveAgentGroup({}))?.id).toBe('ag-web');

    // `groups delete` removes wirings and leaves the conversation rows behind.
    const launchedWiring = await getMessagingGroupAgentByPair(launched.conversationId, 'ag-web');
    await deleteMessagingGroupAgent(launchedWiring!.id);
    expect((await resolveAgentGroup({}))?.id).toBe('ag-child');

    const childWiring = await getMessagingGroupAgentByPair(child.conversationId, 'ag-child');
    await deleteMessagingGroupAgent(childWiring!.id);
    expect(await resolveAgentGroup({})).toBeUndefined();
    expect(launchFallbackDisplayName().length).toBeGreaterThan(0);
  });

  it('queues the standard welcome through the wired local web channel', async () => {
    let request: { method?: string; origin?: string; body?: unknown } = {};
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        request = {
          method: req.method,
          origin: req.headers.origin,
          token: req.headers['x-nanoclaw-local-web-token'],
          body: JSON.parse(body) as unknown,
        };
        res.writeHead(202).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to start welcome test server');
    const url = `http://127.0.0.1:${address.port}`;
    try {
      await sendWiringWelcome(url, 'test-token', 'mg-web');
      expect(request).toEqual({
        method: 'POST',
        origin: url,
        token: 'test-token',
        body: {
          conversationId: 'mg-web',
          text: 'System instruction: run /welcome to introduce yourself to the user on this new channel.',
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function seedLaunchedGroup(): Promise<void> {
    const db = await initTestDb();
    await runMigrations(db);
    await createAgentGroup({
      id: 'ag-owner',
      name: 'Ollama',
      folder: 'ollama-owner',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  }

  it('takes first ownership of a launch-only install, idempotently', async () => {
    await seedLaunchedGroup();

    expect(await ensureLocalWebOperator('ag-owner', 'Shafnir')).toBe(true);
    expect(await ensureLocalWebOperator('ag-owner')).toBe(true);

    expect(await getUser('local-web:local')).toMatchObject({ kind: 'local-web', display_name: 'Shafnir' });
    expect(await getUserRoles('local-web:local')).toMatchObject([{ role: 'owner', agent_group_id: null }]);
    expect(await hasMembershipRow('local-web:local', 'ag-owner')).toBe(true);
  });

  // The browser is reachable from any agent container, so launching Ollama beside
  // an existing install must not hand it authority over that install's agents.
  it('scopes the browser to the launched group when the install already has an owner', async () => {
    await seedLaunchedGroup();
    const now = new Date().toISOString();
    await upsertUser({ id: 'telegram:amit', kind: 'telegram', display_name: 'Amit', created_at: now });
    await grantRole({
      user_id: 'telegram:amit',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now,
    });

    expect(await ensureLocalWebOperator('ag-owner')).toBe(false);
    expect(await ensureLocalWebOperator('ag-owner')).toBe(false);

    expect(await getUserRoles('local-web:local')).toMatchObject([{ role: 'admin', agent_group_id: 'ag-owner' }]);
  });

  // Unrestricted ncl on a group the browser does not own is the escalation the
  // scoped grant exists to prevent, so the config write is pinned both ways.
  it('grants unrestricted ncl scope only to an install the browser owns', async () => {
    await seedLaunchedGroup();

    await applyLaunchContainerConfig('ag-owner', 'gemma4:12b-mlx', false);
    expect(await getContainerConfig('ag-owner')).toMatchObject({ provider: 'ollama', model: 'gemma4:12b-mlx' });
    expect((await getContainerConfig('ag-owner'))?.cli_scope).toBe('group');

    await applyLaunchContainerConfig('ag-owner', 'gemma4:12b-mlx', true);
    expect(await getContainerConfig('ag-owner')).toMatchObject({ provider: 'ollama', cli_scope: 'global' });
  });

  it('reuses OneCLI only when its authenticated agent API works', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-onecli-'));
    const binDir = path.join(home, '.local', 'bin');
    const binary = path.join(binDir, 'onecli');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\n[ "$1 $2" = "agents list" ]\n');
    fs.chmodSync(binary, 0o755);
    try {
      expect(hasReusableOnecli({ HOME: home, PATH: '' })).toBe(true);
      fs.writeFileSync(binary, '#!/bin/sh\nexit 1\n');
      expect(hasReusableOnecli({ HOME: home, PATH: '' })).toBe(false);
      expect(hasReusableOnecli({ HOME: path.join(home, 'missing'), PATH: '' })).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rebuilds an onboarded agent image only when provider payload changed', () => {
    expect(providerPayloadNeedsContainerBuild(true, true)).toBe(true);
    expect(providerPayloadNeedsContainerBuild(true, false)).toBe(false);
    expect(providerPayloadNeedsContainerBuild(false, true)).toBe(false);
  });

  it('parses the supported flags and rejects incomplete input', () => {
    expect(
      parseArgs([
        '--model',
        'qwen3',
        '--runtime-model',
        'nanoclaw/abc123:latest',
        '--base-url',
        'http://127.0.0.1:11434',
        '--web-browsing',
        'enabled',
        '--display-name',
        'Amit',
        '--context-length',
        '40960',
      ]),
    ).toEqual({
      ok: true,
      value: {
        model: 'qwen3',
        runtimeModel: 'nanoclaw/abc123:latest',
        baseUrl: 'http://127.0.0.1:11434',
        webBrowsing: 'enabled',
        displayName: 'Amit',
        contextLength: 40960,
      },
    });
    expect(
      parseArgs([
        '--model',
        'qwen3',
        '--base-url',
        'http://127.0.0.1:11434',
        '--web-browsing',
        'disabled',
        '--context-length',
        'all',
      ]),
    ).toEqual({
      ok: false,
      message: '--context-length must be a positive integer',
    });
    expect(parseArgs(['--model', '--base-url', 'http://127.0.0.1:11434'])).toEqual({
      ok: false,
      message: 'missing value for --model',
    });
    expect(
      parseArgs(['--model', 'qwen3', '--base-url', 'http://127.0.0.1:11434', '--web-browsing', 'disabled']),
    ).toMatchObject({
      ok: true,
      value: { model: 'qwen3', runtimeModel: 'qwen3', webBrowsing: 'disabled' },
    });
    expect(parseArgs(['--model', 'qwen3', '--base-url', 'http://127.0.0.1:11434'])).toEqual({
      ok: false,
      message: 'missing required argument: --web-browsing',
    });
    expect(parseArgs(['--model', 'qwen3', '--base-url', 'http://127.0.0.1:11434', '--web-browsing', 'maybe'])).toEqual({
      ok: false,
      message: '--web-browsing must be enabled or disabled',
    });
  });

  it('stores the source-to-runtime model mapping outside the agent workspace', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ollama-model-'));
    try {
      expect(writeOllamaModelState('qwen3:30b', 'nanoclaw/abc123:latest', 262_144, dataDir)).toBe(true);
      expect(writeOllamaModelState('qwen3:30b', 'nanoclaw/abc123:latest', 262_144, dataDir)).toBe(false);
      const key = createHash('sha256').update('qwen3:30b').digest('hex');
      expect(fs.readFileSync(path.join(dataDir, 'provider-state', 'ollama', `${key}.json`), 'utf8')).toBe(
        '{"source":"qwen3:30b","runtime":"nanoclaw/abc123:latest","contextLength":262144}\n',
      );
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("accepts only this checkout's local web health endpoint", async () => {
    let health: unknown = { ok: true };
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(health));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to start health test server');
    const url = `http://127.0.0.1:${address.port}`;
    try {
      expect(await webChatIsReady(url)).toBe(false);
      health = { ok: true, channel: 'local-web', install: getInstallSlug(process.cwd()) };
      expect(await webChatIsReady(url)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects an Ollama allocation below the model maximum', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'qwen3:latest', context_length: 8192 }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to start context test server');
    try {
      await expect(verifyOllamaContext(`http://127.0.0.1:${address.port}`, 'qwen3', 40960)).rejects.toThrow(
        'below the 40,960 requested by its launch alias',
      );
      await expect(verifyOllamaContext(`http://127.0.0.1:${address.port}`, 'qwen3', 8192)).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rewrites only loopback Ollama URLs for the container', () => {
    expect(rewriteBaseUrlForContainer('http://127.0.0.1:11434')).toBe('http://host.docker.internal:11434');
    expect(rewriteBaseUrlForContainer('http://ollama.example:11434')).toBe('http://ollama.example:11434');
    expect(() => rewriteBaseUrlForContainer('file:///tmp/ollama')).toThrow('http(s) URL');
  });
});
