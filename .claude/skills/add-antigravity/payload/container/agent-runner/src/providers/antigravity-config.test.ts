import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ANTIGRAVITY_API_KEY_PLACEHOLDER,
  ANTIGRAVITY_FORCED_SETTINGS,
  ANTIGRAVITY_RULE_MAX_BYTES,
  ANTIGRAVITY_RULE_TRUNCATION_MARKER,
  type AntigravityMemorySessionHook,
  antigravityExecutionPolicySection,
  antigravityInferenceSection,
  antigravityMcpConfigPath,
  antigravityMcpServersSection,
  antigravityMemorySection,
  antigravityRulePath,
  antigravitySettingsPath,
  buildAntigravityProcessEnv,
  prepareAntigravityRules,
  renderAntigravityMcpConfig,
  renderAntigravityRuleFile,
  renderAntigravitySettings,
  runAntigravityMemoryHook,
  runHookCommand,
  NANOCLAW_MCP_TIMEOUT_SECONDS,
  writeAntigravityRuntimeFiles,
} from './antigravity-config.js';
import type { McpServerConfig } from './types.js';

let dir: string;
let previousHome: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-config-'));
  previousHome = process.env.HOME;
  process.env.HOME = path.join(dir, 'home');
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for `bun /app/src/memory/hook.ts`: logs its stdin, prints `body`, exits with `exitCode`. */
function fakeHook(opts: { body?: string; exitCode?: number; sources?: string[] } = {}): AntigravityMemorySessionHook {
  const script = path.join(dir, `hook-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      `cat >> "${path.join(dir, 'hook-stdin.log')}"`,
      `cat <<'EOF'`,
      opts.body ?? 'MEMORY-SENTINEL',
      'EOF',
      `exit ${opts.exitCode ?? 0}`,
    ].join('\n') + '\n',
  );
  return { command: `sh ${script}`, legacyCommands: [], sources: opts.sources ?? ['startup', 'clear', 'compact'] };
}

describe('configuration sections', () => {
  it('declares the fixed execution stance', () => {
    expect(antigravityExecutionPolicySection()).toEqual({
      permissionMode: 'always-proceed',
      args: ['--dangerously-skip-permissions'],
    });
  });

  it('maps model and effort onto agy flags and leaves the defaults to agy', () => {
    expect(antigravityInferenceSection({})).toEqual({ args: [] });
    expect(antigravityInferenceSection({ model: ' gemini-3.8-flash-medium ', effort: 'HIGH' })).toEqual({
      args: ['--model', 'gemini-3.8-flash-medium', '--effort', 'high'],
    });
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(antigravityInferenceSection({ effort }).args).toEqual(['--effort', effort]);
    }
  });

  it('drops an effort agy does not accept instead of failing the container', () => {
    // e.g. Codex's `minimal` left on a group that switched provider.
    expect(antigravityInferenceSection({ effort: 'minimal' })).toEqual({ args: [] });
    expect(antigravityInferenceSection({ model: 'gemini-3.8-flash-low', effort: 'none' })).toEqual({
      args: ['--model', 'gemini-3.8-flash-low'],
    });
  });

  it('ignores speed: agy has no speed knob', () => {
    expect(antigravityInferenceSection({ model: 'm', speed: 'fast' })).toEqual(
      antigravityInferenceSection({ model: 'm' }),
    );
  });

  it('returns the memory hook it will run, as a copy', () => {
    const hook = { command: 'bun /app/src/memory/hook.ts', legacyCommands: ['old'], sources: ['startup'] };
    const section = antigravityMemorySection(hook);
    expect(section).toEqual(hook);
    expect(section.sources).not.toBe(hook.sources);
  });

  it('maps stdio and remote MCP servers onto mcp_config.json entries', () => {
    expect(
      antigravityMcpServersSection({
        nanoclaw: { command: 'bun', args: ['run', '/app/src/mcp-tools/index.ts'], env: {} },
        plugin: {
          command: 'node',
          args: ['server.js'],
          env: { TOKEN_FILE: '/x' },
          cwd: '/workspace/agent/plugins/p',
          pluginRoot: '/workspace/agent/plugins/p',
        },
        docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Api-Version': '2024-06' } },
        bare: { type: 'http', url: 'https://bare.example.com/mcp', headers: {} },
      }),
    ).toEqual({
      mcpServers: {
        nanoclaw: {
          command: 'bun',
          args: ['run', '/app/src/mcp-tools/index.ts'],
          timeoutSeconds: NANOCLAW_MCP_TIMEOUT_SECONDS,
        },
        plugin: { command: 'node', args: ['server.js'], env: { TOKEN_FILE: '/x' }, cwd: '/workspace/agent/plugins/p' },
        docs: { serverUrl: 'https://mcp.example.com/mcp', headers: { 'X-Api-Version': '2024-06' } },
        bare: { serverUrl: 'https://bare.example.com/mcp' },
      },
    });
  });
});

describe('NanoClaw MCP tool-call timeout', () => {
  it("outlasts ask_user_question's 300 s wait, as an integer agy accepts", () => {
    expect(NANOCLAW_MCP_TIMEOUT_SECONDS).toBe(330);
    const { nanoclaw } = antigravityMcpServersSection({ nanoclaw: { command: 'bun' } }).mcpServers;
    expect(typeof nanoclaw.timeoutSeconds).toBe('number');
    expect(nanoclaw.timeoutSeconds).toBe(330);
    expect(renderAntigravityMcpConfig({ mcpServers: { nanoclaw } })).toContain('"timeoutSeconds": 330');
  });

  it("leaves other servers on agy's default unless they set an integer timeout of their own", () => {
    const { mcpServers } = antigravityMcpServersSection({
      plain: { command: 'node' },
      remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
      own: { command: 'node', timeoutSeconds: -1 } as McpServerConfig,
      ownRemote: { type: 'http', url: 'https://x.example.com/mcp', timeoutSeconds: 60 } as McpServerConfig,
      stringy: { command: 'node', timeoutSeconds: '60' } as unknown as McpServerConfig,
    });
    expect(mcpServers.plain).toEqual({ command: 'node' });
    expect(mcpServers.remote).toEqual({ serverUrl: 'https://mcp.example.com/mcp' });
    expect(mcpServers.own.timeoutSeconds).toBe(-1);
    expect(mcpServers.ownRemote.timeoutSeconds).toBe(60);
    // A string would make agy drop the whole server, so it never reaches the file.
    expect(mcpServers.stringy).toEqual({ command: 'node' });
  });
});

const FORCED = { modelProvider: 'gemini', enableTerminalSandbox: false, artifactReviewPolicy: 'always-proceed' };

describe('settings.json', () => {
  it('forces API-key mode, no terminal sandbox and no plan review, keeping every other key', () => {
    expect(ANTIGRAVITY_FORCED_SETTINGS).toEqual(FORCED);
    const merged = JSON.parse(
      renderAntigravitySettings(
        JSON.stringify({
          modelProvider: 'google',
          enableTerminalSandbox: true,
          artifactReviewPolicy: 'request-review',
          theme: 'dark',
        }),
      ),
    );
    expect(merged).toEqual({ ...FORCED, theme: 'dark' });
  });

  it('creates the document when there is none, and replaces one agy could not read either', () => {
    const fresh = JSON.stringify(FORCED, null, 2) + '\n';
    expect(renderAntigravitySettings(undefined)).toBe(fresh);
    expect(renderAntigravitySettings('{ not json')).toBe(fresh);
    expect(renderAntigravitySettings('["array"]')).toBe(fresh);
  });
});

describe('always-on rule file', () => {
  it('starts with the always_on frontmatter and puts the headless note before memory', () => {
    const content = renderAntigravityRuleFile({ memory: 'MEMORY' });
    expect(content.startsWith('---\ntrigger: always_on\n---\n')).toBe(true);
    const order = [
      'Managed by NanoClaw',
      'Running headless inside NanoClaw',
      '<nanoclaw_system_context>',
      'ask_question',
      'MEMORY',
    ];
    const positions = order.map((marker) => content.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(content.endsWith('MEMORY\n')).toBe(true);
  });

  it('omits absent sections', () => {
    const content = renderAntigravityRuleFile({});
    expect(content).toContain('Running headless inside NanoClaw');
    expect(content).not.toContain('undefined');
  });

  it('caps the file at 24 KB, cutting memory, never the headless note', () => {
    const content = renderAntigravityRuleFile({ memory: 'm'.repeat(40_000) });
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(ANTIGRAVITY_RULE_MAX_BYTES);
    expect(content).toContain('Running headless inside NanoClaw');
    expect(content.endsWith(ANTIGRAVITY_RULE_TRUNCATION_MARKER)).toBe(true);
  });

  it('cuts at a UTF-8 character boundary', () => {
    const content = renderAntigravityRuleFile({ memory: '日本語'.repeat(5_000) });
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(ANTIGRAVITY_RULE_MAX_BYTES);
    expect(content).not.toContain('�');
  });

  it('leaves a file under the cap untouched', () => {
    expect(renderAntigravityRuleFile({ memory: 'short' })).not.toContain(ANTIGRAVITY_RULE_TRUNCATION_MARKER);
  });
});

describe('writers', () => {
  it('writes settings.json and mcp_config.json privately, atomically, and preserves other settings', () => {
    fs.mkdirSync(path.dirname(antigravitySettingsPath()), { recursive: true });
    fs.writeFileSync(antigravitySettingsPath(), JSON.stringify({ keepMe: 1 }));
    const mcp = antigravityMcpServersSection({ nanoclaw: { command: 'bun', args: ['run', 'x.ts'] } });

    writeAntigravityRuntimeFiles(mcp);

    expect(JSON.parse(fs.readFileSync(antigravitySettingsPath(), 'utf-8'))).toEqual({
      keepMe: 1,
      ...FORCED,
    });
    expect(fs.readFileSync(antigravityMcpConfigPath(), 'utf-8')).toBe(renderAntigravityMcpConfig(mcp));
    expect(fs.statSync(antigravityMcpConfigPath()).mode & 0o777).toBe(0o600);
    const configDir = path.dirname(antigravityMcpConfigPath());
    expect(fs.readdirSync(configDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(antigravityMcpConfigPath()).toBe(path.join(process.env.HOME!, '.gemini', 'config', 'mcp_config.json'));
  });

  it('writes the rule file from the memory hook only, leaving user rules alone', async () => {
    const rulesDir = path.dirname(antigravityRulePath());
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'mine.md'), 'USER RULE');

    await prepareAntigravityRules(fakeHook());

    const rule = fs.readFileSync(antigravityRulePath(), 'utf-8');
    expect(rule).toContain('MEMORY-SENTINEL');
    expect(fs.statSync(antigravityRulePath()).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(rulesDir, 'mine.md'), 'utf-8')).toBe('USER RULE');
    expect(antigravityRulePath()).toBe(path.join(process.env.HOME!, '.gemini', 'config', 'rules', 'nanoclaw.md'));
  });

  it('still writes the rule file when the memory hook fails', async () => {
    await prepareAntigravityRules(fakeHook({ exitCode: 3 }));
    const rule = fs.readFileSync(antigravityRulePath(), 'utf-8');
    expect(rule).toContain('Running headless inside NanoClaw');
    expect(rule).not.toContain('MEMORY-SENTINEL');
  });
});

describe('memory hook runner', () => {
  it('feeds the hook the SessionStart payload and returns its output', async () => {
    expect(await runAntigravityMemoryHook(fakeHook(), 'startup')).toBe('MEMORY-SENTINEL');
    expect(fs.readFileSync(path.join(dir, 'hook-stdin.log'), 'utf-8')).toBe(
      '{"hook_event_name":"SessionStart","source":"startup"}',
    );
  });

  it('returns nothing for a failing, empty, missing or non-declaring hook', async () => {
    expect(await runAntigravityMemoryHook(fakeHook({ exitCode: 1 }), 'startup')).toBeUndefined();
    expect(await runAntigravityMemoryHook(fakeHook({ body: '' }), 'startup')).toBeUndefined();
    expect(await runAntigravityMemoryHook(undefined, 'startup')).toBeUndefined();
    expect(await runAntigravityMemoryHook(fakeHook({ sources: ['compact'] }), 'startup')).toBeUndefined();
  });

  it('gives up at the deadline even when a background child keeps stdout open', async () => {
    const started = Date.now();
    const res = await runHookCommand('sleep 5 & echo partial; wait', '{}', 150);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.error?.message).toBe('timed out after 150ms');
    expect(res.stdout).toBe('partial\n');
  });
});

describe('agy process environment', () => {
  it('passes only allowlisted variables', () => {
    const env = buildAntigravityProcessEnv({
      PATH: '/usr/bin',
      HOME: '/home/node',
      GEMINI_API_KEY: ANTIGRAVITY_API_KEY_PLACEHOLDER,
      HTTPS_PROXY: 'http://gateway:8080',
      https_proxy: 'http://gateway:8080',
      HTTP_PROXY: 'http://gateway:8080',
      NO_PROXY: 'localhost',
      no_proxy: 'localhost',
      SSL_CERT_FILE: '/etc/gateway/ca.pem',
      SSL_CERT_DIR: '/etc/ssl/certs',
      NODE_EXTRA_CA_CERTS: '/etc/gateway/ca.pem',
      LANG: 'C.UTF-8',
      TZ: 'Europe/Berlin',
      TMPDIR: '/tmp',
      USER: 'node',
      ANTHROPIC_API_KEY: 'leak',
      CLAUDE_CODE_OAUTH_TOKEN: 'leak',
      NANOCLAW_AGENT_DIR: '/workspace/agent',
      GOOGLE_API_KEY: 'leak',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/node',
      GEMINI_API_KEY: ANTIGRAVITY_API_KEY_PLACEHOLDER,
      HTTPS_PROXY: 'http://gateway:8080',
      https_proxy: 'http://gateway:8080',
      HTTP_PROXY: 'http://gateway:8080',
      NO_PROXY: 'localhost',
      no_proxy: 'localhost',
      SSL_CERT_FILE: '/etc/gateway/ca.pem',
      SSL_CERT_DIR: '/etc/ssl/certs',
      NODE_EXTRA_CA_CERTS: '/etc/gateway/ca.pem',
      LANG: 'C.UTF-8',
      TZ: 'Europe/Berlin',
      TMPDIR: '/tmp',
      USER: 'node',
      AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    });
  });

  it('defaults HOME and the placeholder key, and pins auto-update off', () => {
    const env = buildAntigravityProcessEnv({ PATH: '/usr/bin', AGY_CLI_DISABLE_AUTO_UPDATE: 'false' });
    expect(env.HOME).toBe('/home/node');
    expect(env.GEMINI_API_KEY).toBe('nc-antigravity-placeholder');
    expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true');
  });
});
