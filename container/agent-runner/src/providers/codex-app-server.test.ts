import { describe, expect, it, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  type AppServer,
  CODEX_APP_SERVER_ARGS,
  attachCodexAutoApproval,
  buildCodexProcessEnv,
  startCodexTurn,
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
  it('escapes basic strings', () => {
    expect(tomlBasicString('a "quoted" \\\\ value')).toBe('"a \\"quoted\\" \\\\\\\\ value"');
  });

  it('escapes control characters TOML forbids raw', () => {
    expect(tomlBasicString('bell\u0007tab\tdel\u007f')).toBe('"bell\\u0007tab\\u0009del\\u007F"');
  });

  it('rejects newlines', () => {
    expect(() => tomlBasicString('bad\nvalue')).toThrow(/newline/);
  });

  it('hardcodes danger-full-access + never and writes model, effort, and MCP servers', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    process.env.HOME = tmpHome;

    writeCodexConfigToml(
      {
        nanoclaw: {
          command: 'bun',
          args: ['run', '/app/src/mcp-tools/index.ts'],
          env: { FOO: 'bar' },
          disabledTools: ['send_message', 'add_reaction'],
        },
        docs: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { 'X-Api-Version': '2024-06' },
          enabledTools: ['search', 'extract'],
        },
      },
      MEMORY_SESSION_HOOK,
      { model: 'gpt-5', effort: 'medium', webSearchMode: 'disabled', builtinToolMode: 'mcp-only' },
    );

    const content = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(content).toContain('sandbox_mode = "danger-full-access"');
    expect(content).toContain('approval_policy = "never"');
    expect(content).toContain('project_doc_max_bytes = 32768');
    expect(content).toContain('respect_system_proxy = true');
    expect(content).toContain('model = "gpt-5"');
    expect(content).toContain('model_reasoning_effort = "medium"');
    expect(content).toContain('web_search = "disabled"');
    expect(content).toContain('[features]\nmemories = false');
    for (const feature of [
      'shell_tool',
      'unified_exec',
      'code_mode',
      'js_repl',
      'browser_use',
      'browser_use_external',
      'in_app_browser',
      'computer_use',
      'apps',
      'connectors',
      'plugins',
      'tool_search',
      'search_tool',
      'standalone_web_search',
      'web_search',
    ]) {
      expect(content).toContain(`${feature} = false`);
    }
    expect(content).toContain('[memories]\nuse_memories = false\ngenerate_memories = false');
    expect(content).not.toContain('[sandbox_workspace_write]');
    expect(content).not.toContain('writable_roots =');
    expect(content).toContain('[mcp_servers.nanoclaw]');
    expect(content).toContain('disabled_tools = ["send_message", "add_reaction"]');
    expect(content).toContain('command = "bun"');
    expect(content).toContain('args = ["run", "/app/src/mcp-tools/index.ts"]');
    expect(content).toContain('[mcp_servers.nanoclaw.env]');
    expect(content).toContain('FOO = "bar"');
    expect(content).toContain(
      '[mcp_servers.docs]\nenabled_tools = ["search", "extract"]\nurl = "https://mcp.example.com/mcp"\n[mcp_servers.docs.http_headers]\n"X-Api-Version" = "2024-06"',
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
    expect(content).not.toContain('web_search =');
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
});

describe('Codex thread SessionStart source', () => {
  it('sets startup only for a new thread', async () => {
    const { server, requests } = autoRespondingServer();

    await startOrResumeCodexThread(server, undefined, { cwd: '/workspace/agent' });

    expect(requests[0].method).toBe('thread/start');
    expect(requests[0].params.sessionStartSource).toBe('startup');
  });

  it('does not send startup when resuming', async () => {
    const { server, requests } = autoRespondingServer();

    await startOrResumeCodexThread(server, 'thread-existing', { cwd: '/workspace/agent' });

    expect(requests[0].method).toBe('thread/resume');
    expect(requests[0].params.sessionStartSource).toBeUndefined();
  });

  it('removes Codex workspace environments for MCP-only groups', async () => {
    const { server, requests } = autoRespondingServer();

    await startOrResumeCodexThread(server, undefined, {
      cwd: '/workspace/agent',
      builtinToolMode: 'mcp-only',
    });

    expect(requests[0]).toMatchObject({
      method: 'thread/start',
      params: { environments: [] },
    });
  });

  it('does not send unsupported environments to thread/resume', async () => {
    const { server, requests } = autoRespondingServer();

    await startOrResumeCodexThread(server, 'thread-existing', {
      cwd: '/workspace/agent',
      builtinToolMode: 'mcp-only',
    });

    expect(requests[0]).toMatchObject({ method: 'thread/resume' });
    expect(requests[0].params.environments).toBeUndefined();
  });

  it('removes Codex workspace environments on every MCP-only turn', async () => {
    const { server, requests } = autoRespondingServer();

    await startCodexTurn(server, {
      threadId: 'thread-existing',
      inputText: 'hello',
      cwd: '/workspace/agent',
      builtinToolMode: 'mcp-only',
    });

    expect(requests[0]).toMatchObject({
      method: 'turn/start',
      params: { environments: [] },
    });
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
          server.pending.get(request.id)?.resolve({
            id: request.id,
            result: { thread: { id: threadId }, turn: { id: 'turn-new' } },
          });
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
