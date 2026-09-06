import { describe, expect, it, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  type AppServer,
  CODEX_APP_SERVER_ARGS,
  attachCodexAutoApproval,
  buildCodexConfigPlan,
  buildCodexProcessEnv,
  codexInferenceSection,
  renderCodexConfigToml,
  startOrResumeCodexThread,
  tomlBasicString,
  writeCodexConfigToml,
} from './codex-app-server.js';

const MEMORY_SESSION_HOOK = {
  command: 'bun /app/src/memory/hook.ts',
  legacyCommands: ['bun /app/src/memory-hook.ts'],
  sources: ['startup', 'clear', 'compact'],
} as const;

let tmpHome: string | null = null;
const originalHome = process.env.HOME;

afterEach(() => {
  process.env.HOME = originalHome;
  if (tmpHome) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = null;
  }
});

describe('Codex config TOML', () => {
  it('builds every declared configuration capability before rendering', () => {
    const mcpServers = { nanoclaw: { command: 'bun', args: ['run', 'server.ts'] } };
    const plan = buildCodexConfigPlan(mcpServers, { model: 'gpt-5', effort: 'medium', fastMode: true });

    expect(plan).toEqual({
      executionPolicy: {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        projectDocumentMaxBytes: 32768,
      },
      inference: { model: 'gpt-5', effort: 'medium', fastMode: true },
      memory: { memories: false, useMemories: false, generateMemories: false },
      mcpServers,
    });
    expect(renderCodexConfigToml(plan)).toContain('[mcp_servers.nanoclaw]');
  });

  it('renders the exact bytes, pinning line order and the trailing newline', () => {
    const content = renderCodexConfigToml(
      buildCodexConfigPlan(
        {
          nanoclaw: { command: 'bun', args: ['run', '/app/src/mcp-tools/index.ts'], env: { FOO: 'bar' } },
          docs: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Api-Version': '2024-06' } },
        },
        { model: 'gpt-5', effort: 'medium', fastMode: true },
      ),
    );
    expect(content).toBe(
      [
        'sandbox_mode = "danger-full-access"',
        'approval_policy = "never"',
        'project_doc_max_bytes = 32768',
        'model = "gpt-5"',
        'model_reasoning_effort = "medium"',
        'service_tier = "fast"',
        '',
        '[features]',
        'memories = false',
        '',
        '[memories]',
        'use_memories = false',
        'generate_memories = false',
        '',
        '[mcp_servers.nanoclaw]',
        'command = "bun"',
        'args = ["run", "/app/src/mcp-tools/index.ts"]',
        '[mcp_servers.nanoclaw.env]',
        'FOO = "bar"',
        '',
        '[mcp_servers.docs]',
        'url = "https://mcp.example.com/mcp"',
        '[mcp_servers.docs.http_headers]',
        '"X-Api-Version" = "2024-06"',
        '',
      ].join('\n'),
    );
  });

  // Core's speed property → Codex's service tier. `fast` is the only value
  // with a Codex rendering; `standard` (the core default) and anything else
  // emit no tier line, so Codex's own default serving tier stays in force.
  it('renders service_tier = "fast" only for speed fast', () => {
    const fast = renderCodexConfigToml({
      ...buildCodexConfigPlan({}, {}),
      inference: codexInferenceSection({ speed: 'fast' }),
    });
    expect(fast).toContain('service_tier = "fast"');
    // The tier is a plain top-level key: no feature flag rides along with it.
    expect(fast).not.toContain('fast_mode');

    const standard = renderCodexConfigToml({
      ...buildCodexConfigPlan({}, {}),
      inference: codexInferenceSection({ speed: 'standard' }),
    });
    expect(standard).not.toContain('service_tier');

    const unset = renderCodexConfigToml(buildCodexConfigPlan({}, {}));
    expect(unset).not.toContain('service_tier');
  });

  it('treats speed as a fast-or-default flag — other tier names are dropped, not passed through', () => {
    expect(codexInferenceSection({ speed: 'ultrafast' }).fastMode).toBeUndefined();
    const rendered = renderCodexConfigToml({
      ...buildCodexConfigPlan({}, {}),
      inference: codexInferenceSection({ speed: 'ultrafast' }),
    });
    expect(rendered).not.toContain('service_tier');
    expect(rendered).not.toContain('ultrafast');
  });

  it('escapes basic strings', () => {
    expect(tomlBasicString('a "quoted" \\\\ value')).toBe('"a \\"quoted\\" \\\\\\\\ value"');
  });

  it('escapes control characters TOML forbids raw', () => {
    expect(tomlBasicString('bell\u0007tab\tdel\u007f')).toBe('"bell\\u0007tab\\u0009del\\u007F"');
  });

  it('rejects newlines', () => {
    expect(() => tomlBasicString('bad\nvalue')).toThrow(/newline/);
  });

  it('hardcodes danger-full-access + never and writes model, effort, fast mode, and MCP servers', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    process.env.HOME = tmpHome;

    writeCodexConfigToml(
      {
        nanoclaw: {
          command: 'bun',
          args: ['run', '/app/src/mcp-tools/index.ts'],
          env: { FOO: 'bar' },
        },
        docs: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { 'X-Api-Version': '2024-06' },
        },
      },
      MEMORY_SESSION_HOOK,
      { model: 'gpt-5', effort: 'medium', fastMode: true },
    );

    const content = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(content).toContain('sandbox_mode = "danger-full-access"');
    expect(content).toContain('approval_policy = "never"');
    expect(content).toContain('project_doc_max_bytes = 32768');
    expect(content).toContain('model = "gpt-5"');
    expect(content).toContain('model_reasoning_effort = "medium"');
    expect(content).toContain('service_tier = "fast"');
    expect(content).toContain('[features]\nmemories = false');
    expect(content).toContain('[memories]\nuse_memories = false\ngenerate_memories = false');
    expect(content).not.toContain('[sandbox_workspace_write]');
    expect(content).not.toContain('writable_roots =');
    expect(content).toContain('[mcp_servers.nanoclaw]');
    expect(content).toContain('command = "bun"');
    expect(content).toContain('args = ["run", "/app/src/mcp-tools/index.ts"]');
    expect(content).toContain('[mcp_servers.nanoclaw.env]');
    expect(content).toContain('FOO = "bar"');
    expect(content).toContain(
      '[mcp_servers.docs]\nurl = "https://mcp.example.com/mcp"\n[mcp_servers.docs.http_headers]\n"X-Api-Version" = "2024-06"',
    );

    const hooks = JSON.parse(fs.readFileSync(path.join(tmpHome, '.codex', 'hooks.json'), 'utf-8'));
    expect(hooks.hooks.SessionStart).toEqual([
      {
        matcher: 'startup|clear|compact',
        hooks: [{ type: 'command', command: 'bun /app/src/memory/hook.ts', timeout: 10 }],
      },
    ]);
    expect(CODEX_APP_SERVER_ARGS).toContain('--dangerously-bypass-hook-trust');
  });

  it('emits cwd for a stdio server above the env sub-table, and omits it when absent', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    process.env.HOME = tmpHome;

    writeCodexConfigToml(
      {
        probe: {
          command: '/workspace/agent/plugins/sdr/run.js',
          args: ['--flag'],
          env: { FOO: 'bar' },
          cwd: '/workspace/agent/plugin-data/sdr',
        },
        plain: { command: 'bun' },
      },
      MEMORY_SESSION_HOOK,
    );

    const content = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(content).toContain(
      'command = "/workspace/agent/plugins/sdr/run.js"\n' +
        'cwd = "/workspace/agent/plugin-data/sdr"\n' +
        'args = ["--flag"]\n' +
        '[mcp_servers.probe.env]',
    );
    const plainTable = content.split('[mcp_servers.plain]')[1].split('[mcp_servers.')[0];
    expect(plainTable).toContain('command = "bun"');
    expect(plainTable).not.toContain('cwd =');
  });

  it('quotes non-bare server names and env keys so they cannot open new tables', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    process.env.HOME = tmpHome;

    writeCodexConfigToml(
      {
        'docs] [mcp_servers.evil]': {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { 'X-V': '1' },
        },
        plain: { command: 'bun', env: { 'BAD KEY': 'v' } },
      },
      MEMORY_SESSION_HOOK,
    );

    const content = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(content).toContain('[mcp_servers."docs] [mcp_servers.evil]"]');
    expect(content).toContain('[mcp_servers."docs] [mcp_servers.evil]".http_headers]');
    expect(content).not.toContain('\n[mcp_servers.evil]');
    expect(content).toContain('[mcp_servers.plain.env]');
    expect(content).toContain('"BAD KEY" = "v"');
  });

  it('fails closed on a server name containing a newline', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    process.env.HOME = tmpHome;

    expect(() =>
      writeCodexConfigToml(
        { 'docs]\n[mcp_servers.evil]': { type: 'http', url: 'https://mcp.example.com/mcp' } },
        MEMORY_SESSION_HOOK,
      ),
    ).toThrow(/newline/);
  });

  it('preserves unrelated hooks and refreshes only the NanoClaw memory entry', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    process.env.HOME = tmpHome;
    const hooksPath = path.join(tmpHome, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({
        version: 1,
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'custom-stop' }] }],
          SessionStart: [
            { matcher: 'resume', hooks: [{ type: 'command', command: 'custom-resume' }] },
            {
              matcher: '.*',
              hooks: [
                { type: 'command', command: 'bun /app/src/memory-hook.ts' },
                { type: 'command', command: 'custom-start' },
              ],
            },
          ],
        },
      }),
    );

    writeCodexConfigToml({}, MEMORY_SESSION_HOOK);
    writeCodexConfigToml({}, MEMORY_SESSION_HOOK);

    const config = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    expect(config.version).toBe(1);
    expect(config.hooks.Stop).toHaveLength(1);
    expect(config.hooks.SessionStart).toContainEqual({
      matcher: '.*',
      hooks: [{ type: 'command', command: 'custom-start' }],
    });
    expect(
      config.hooks.SessionStart.filter((entry: { hooks?: Array<{ command?: string }> }) =>
        entry.hooks?.some((hook) => hook.command === 'bun /app/src/memory/hook.ts'),
      ),
    ).toEqual([
      {
        matcher: 'startup|clear|compact',
        hooks: [{ type: 'command', command: 'bun /app/src/memory/hook.ts', timeout: 10 }],
      },
    ]);
  });

  it('replaces config.toml before malformed hooks.json fails', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    process.env.HOME = tmpHome;
    const codexDir = path.join(tmpHome, '.codex');
    const configPath = path.join(codexDir, 'config.toml');
    const hooksPath = path.join(codexDir, 'hooks.json');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(configPath, 'stale config');
    fs.writeFileSync(hooksPath, '{');

    expect(() => writeCodexConfigToml({}, MEMORY_SESSION_HOOK, { model: 'gpt-5' })).toThrow();
    expect(fs.readFileSync(configPath, 'utf-8')).toContain('model = "gpt-5"');
    expect(fs.readFileSync(configPath, 'utf-8')).not.toContain('stale config');
    expect(fs.readFileSync(hooksPath, 'utf-8')).toBe('{');
  });

  it('replaces config.toml before an existing empty hooks.json fails', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    process.env.HOME = tmpHome;
    const codexDir = path.join(tmpHome, '.codex');
    const configPath = path.join(codexDir, 'config.toml');
    const hooksPath = path.join(codexDir, 'hooks.json');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(configPath, 'stale config');
    fs.writeFileSync(hooksPath, '');

    expect(() => writeCodexConfigToml({}, MEMORY_SESSION_HOOK, { model: 'gpt-5' })).toThrow();
    expect(fs.readFileSync(configPath, 'utf-8')).toContain('model = "gpt-5"');
    expect(fs.readFileSync(configPath, 'utf-8')).not.toContain('stale config');
    expect(fs.readFileSync(hooksPath, 'utf-8')).toBe('');
  });
});

describe('Codex thread SessionStart source', () => {
  it('sets startup only for a new thread', async () => {
    const { server, requests } = autoRespondingServer();

    await startOrResumeCodexThread(server, undefined, { cwd: '/workspace/agent' });

    expect(requests[0].method).toBe('thread/start');
    expect(requests[0].params.config).toEqual({ bypass_hook_trust: true });
    expect(requests[0].params.sessionStartSource).toBe('startup');
  });

  it('does not send startup when resuming', async () => {
    const { server, requests } = autoRespondingServer();

    await startOrResumeCodexThread(server, 'thread-existing', { cwd: '/workspace/agent' });

    expect(requests[0].method).toBe('thread/resume');
    expect(requests[0].params.config).toEqual({ bypass_hook_trust: true });
    expect(requests[0].params.sessionStartSource).toBeUndefined();
  });
});

describe('Codex auto-approval', () => {
  // NanoClaw (container isolation + OneCLI) is the boundary, so the handler accepts
  // every request unconditionally — even paths/commands a sandbox policy would refuse.
  it('grants full filesystem + network for permission requests', () => {
    const { server, writes } = fakeServer();
    attachCodexAutoApproval(server);

    server.serverRequestHandlers[0]({
      id: 1,
      method: 'item/permissions/requestApproval',
      params: { permissions: { fileSystem: { read: ['/workspace/agent'], write: ['/workspace/agent'] } } },
    });

    const result = JSON.parse(writes[0]).result as {
      permissions: { fileSystem: { read: string[]; write: string[] }; network: { enabled: boolean } };
      scope: string;
    };
    expect(result.scope).toBe('turn');
    expect(result.permissions.fileSystem.read).toEqual(['/']);
    expect(result.permissions.fileSystem.write).toEqual(['/']);
    expect(result.permissions.network.enabled).toBe(true);
  });

  it('accepts file-change and command-exec approvals regardless of path', () => {
    const { server, writes } = fakeServer();
    attachCodexAutoApproval(server);

    server.serverRequestHandlers[0]({
      id: 2,
      method: 'item/fileChange/requestApproval',
      params: { grantRoot: '/etc' },
    });
    server.serverRequestHandlers[0]({
      id: 3,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'rm -rf /', cwd: '/' },
    });

    expect(JSON.parse(writes[0]).result).toEqual({ decision: 'accept' });
    expect(JSON.parse(writes[1]).result).toEqual({ decision: 'accept' });
  });

  it('approves legacy patch and command-exec approvals regardless of path', () => {
    const { server, writes } = fakeServer();
    attachCodexAutoApproval(server);

    server.serverRequestHandlers[0]({
      id: 4,
      method: 'applyPatchApproval',
      params: { fileChanges: { '/etc/passwd': {} } },
    });
    server.serverRequestHandlers[0]({
      id: 5,
      method: 'execCommandApproval',
      params: { command: 'rm -rf /', cwd: '/' },
    });

    expect(JSON.parse(writes[0]).result).toEqual({ decision: 'approved' });
    expect(JSON.parse(writes[1]).result).toEqual({ decision: 'approved' });
  });

  it('fails closed for unknown server requests', () => {
    const { server, writes } = fakeServer();
    attachCodexAutoApproval(server);

    server.serverRequestHandlers[0]({ id: 6, method: 'new/unknown/request' });

    const response = JSON.parse(writes[0]);
    expect(response.error.message).toContain('Unhandled Codex app-server request');
  });
});

describe('Codex process env', () => {
  it('forwards proxy/runtime env without leaking secret-like host env', () => {
    const env = buildCodexProcessEnv({
      PATH: '/bin',
      HOME: '/home/node',
      CODEX_HOME: '/home/node/.codex',
      HTTPS_PROXY: 'http://proxy',
      OPENAI_API_KEY: 'sk-test',
      ONECLI_API_KEY: 'onecli-secret',
      SOME_TOKEN: 'token',
    });

    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/home/node');
    expect(env.CODEX_HOME).toBe('/home/node/.codex');
    expect(env.HTTPS_PROXY).toBe('http://proxy');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ONECLI_API_KEY).toBeUndefined();
    expect(env.SOME_TOKEN).toBeUndefined();
  });
});

function fakeServer(): { server: AppServer; writes: string[] } {
  const writes: string[] = [];
  const server = {
    process: { stdin: { write: (line: string) => writes.push(line) } },
    readline: { close: () => {} },
    pending: new Map(),
    notificationHandlers: [],
    exitHandlers: [],
    serverRequestHandlers: [],
  } as unknown as AppServer;
  return { server, writes };
}

function autoRespondingServer(): {
  server: AppServer;
  requests: Array<{ id: number; method: string; params: Record<string, unknown> }>;
} {
  const requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  let server: AppServer;
  server = {
    process: {
      stdin: {
        write: (line: string) => {
          const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
          requests.push(request);
          const threadId = (request.params.threadId as string | undefined) ?? 'thread-new';
          server.pending.get(request.id)?.resolve({ id: request.id, result: { thread: { id: threadId } } });
        },
      },
    },
    readline: { close: () => {} },
    pending: new Map(),
    notificationHandlers: [],
    exitHandlers: [],
    serverRequestHandlers: [],
  } as unknown as AppServer;
  return { server, requests };
}
