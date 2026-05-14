/**
 * CLI Runner 单元测试
 * 测试 agent-runner/src/cli-runner.ts 中导出的纯函数
 */
import { describe, it, expect } from 'vitest';
import {
  parseStreamJsonLine,
  buildCliArgs,
  buildMcpConfig,
  mapToContainerOutput,
  buildCliEnv,
  type ContainerOutput,
} from '../container/agent-runner/src/cli-runner.js';

// ---- P0: parseStreamJsonLine ----

describe('parseStreamJsonLine', () => {
  it('解析有效的 system init 消息', () => {
    const line = '{"type":"system","subtype":"init","session_id":"abc-123","tools":[],"model":"claude-opus-4-7"}';
    const result = parseStreamJsonLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('system');
    expect(result!.subtype).toBe('init');
    expect(result!.session_id).toBe('abc-123');
  });

  it('解析 assistant 消息（含 text content）', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '好的，我来处理' }],
        model: 'claude-opus-4-7',
      },
    });
    const result = parseStreamJsonLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('assistant');
    expect(result!.message!.content![0].text).toBe('好的，我来处理');
  });

  it('解析 assistant 消息（含 tool_use）', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }],
      },
    });
    const result = parseStreamJsonLine(line);
    expect(result).not.toBeNull();
    expect(result!.message!.content![0].name).toBe('Bash');
  });

  it('解析 result 消息', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '任务完成',
      session_id: 'sess-456',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
      total_cost_usd: 0.05,
      num_turns: 3,
      duration_ms: 5000,
    });
    const result = parseStreamJsonLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('result');
    expect(result!.result).toBe('任务完成');
    expect(result!.session_id).toBe('sess-456');
  });

  it('解析 rate_limit_event', () => {
    const line = JSON.stringify({ type: 'rate_limit_event', resetsAt: '2026-05-14T12:00:00Z' });
    const result = parseStreamJsonLine(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('rate_limit_event');
  });

  it('空行返回 null', () => {
    expect(parseStreamJsonLine('')).toBeNull();
    expect(parseStreamJsonLine('   ')).toBeNull();
  });

  it('非 JSON 返回 null', () => {
    expect(parseStreamJsonLine('not json at all')).toBeNull();
    expect(parseStreamJsonLine('{broken json')).toBeNull();
  });

  it('缺少 type 字段返回 null', () => {
    expect(parseStreamJsonLine('{"foo":"bar"}')).toBeNull();
  });

  it('非对象的 JSON 返回 null', () => {
    expect(parseStreamJsonLine('"string"')).toBeNull();
    expect(parseStreamJsonLine('42')).toBeNull();
    expect(parseStreamJsonLine('null')).toBeNull();
  });
});

// ---- P0: buildMcpConfig ----

describe('buildMcpConfig', () => {
  it('生成正确的 MCP 配置结构', () => {
    const config = buildMcpConfig(
      '/path/to/mcp-server.js',
      'chat-jid-123',
      'test-group',
      true,
      '/path/to/ipc',
    );

    expect(config).toEqual({
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: ['/path/to/mcp-server.js'],
          env: {
            NANOCLAW_CHAT_JID: 'chat-jid-123',
            NANOCLAW_GROUP_FOLDER: 'test-group',
            NANOCLAW_IS_MAIN: '1',
            NANOCLAW_IPC_DIR: '/path/to/ipc',
          },
        },
      },
    });
  });

  it('isMain=false 时传 0', () => {
    const config = buildMcpConfig('/mcp.js', 'jid', 'grp', false, '/ipc');
    const env = (config.mcpServers as Record<string, Record<string, Record<string, string>>>).nanoclaw.env;
    expect(env.NANOCLAW_IS_MAIN).toBe('0');
  });
});

// ---- P0: buildCliArgs ----

describe('buildCliArgs', () => {
  it('基础参数：--print --output-format --input-format --verbose', () => {
    const args = buildCliArgs({ mcpConfigPath: '/tmp/mcp.json' });
    expect(args).toContain('--print');
    expect(args).toContain('--verbose');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--input-format');
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');
  });

  it('指定 model', () => {
    const args = buildCliArgs({ model: 'claude-haiku-4-5-20251001', mcpConfigPath: '/tmp/mcp.json' });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-haiku-4-5-20251001');
  });

  it('不指定 model 时不包含 --model', () => {
    const args = buildCliArgs({ mcpConfigPath: '/tmp/mcp.json' });
    expect(args).not.toContain('--model');
  });

  it('指定 sessionId 时包含 --resume', () => {
    const args = buildCliArgs({ sessionId: 'sess-abc', mcpConfigPath: '/tmp/mcp.json' });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-abc');
  });

  it('不指定 sessionId 时不包含 --resume', () => {
    const args = buildCliArgs({ mcpConfigPath: '/tmp/mcp.json' });
    expect(args).not.toContain('--resume');
  });

  it('默认包含 --dangerously-skip-permissions', () => {
    const args = buildCliArgs({ mcpConfigPath: '/tmp/mcp.json' });
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('dangerouslySkipPermissions=false 时不包含', () => {
    const args = buildCliArgs({ mcpConfigPath: '/tmp/mcp.json', dangerouslySkipPermissions: false });
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('传入 MCP 配置路径', () => {
    const args = buildCliArgs({ mcpConfigPath: '/tmp/my-mcp.json' });
    expect(args).toContain('--mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/my-mcp.json');
  });

  it('传入额外目录', () => {
    const args = buildCliArgs({
      mcpConfigPath: '/tmp/mcp.json',
      additionalDirectories: ['/dir1', '/dir2'],
    });
    const addDirIndices = args.reduce<number[]>((acc, v, i) => {
      if (v === '--add-dir') acc.push(i);
      return acc;
    }, []);
    expect(addDirIndices).toHaveLength(2);
    expect(args[addDirIndices[0] + 1]).toBe('/dir1');
    expect(args[addDirIndices[1] + 1]).toBe('/dir2');
  });

  it('传入 systemPromptAppend', () => {
    const args = buildCliArgs({
      mcpConfigPath: '/tmp/mcp.json',
      systemPromptAppend: 'You are a helpful dog.',
    });
    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('You are a helpful dog.');
  });
});

// ---- P0: mapToContainerOutput ----

describe('mapToContainerOutput', () => {
  it('system init 返回空数组（session_id 由调用方提取）', () => {
    const msg = { type: 'system' as const, subtype: 'init', session_id: 'sess-1' };
    expect(mapToContainerOutput(msg)).toEqual([]);
  });

  it('assistant tool_use 映射为 progress', () => {
    const msg = {
      type: 'assistant' as const,
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hello' } }],
      },
    };
    const outputs = mapToContainerOutput(msg);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].status).toBe('progress');
    expect(outputs[0].progressType).toBe('tool_use');
    expect(outputs[0].result).toContain('Bash');
    expect(outputs[0].result).toContain('echo hello');
  });

  it('assistant text 映射为 thinking progress', () => {
    const msg = {
      type: 'assistant' as const,
      message: {
        content: [{ type: 'text', text: '我来分析一下这个问题，需要先检查日志' }],
      },
    };
    const outputs = mapToContainerOutput(msg);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].status).toBe('progress');
    expect(outputs[0].progressType).toBe('thinking');
    expect(outputs[0].result).toContain('💭');
  });

  it('短文本（<=5字符）不产生输出', () => {
    const msg = {
      type: 'assistant' as const,
      message: {
        content: [{ type: 'text', text: 'OK' }],
      },
    };
    expect(mapToContainerOutput(msg)).toEqual([]);
  });

  it('result 映射为 success + usage', () => {
    const msg = {
      type: 'result' as const,
      result: '任务完成',
      session_id: 'sess-new',
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 100,
      },
      total_cost_usd: 0.05,
      num_turns: 5,
      duration_ms: 10000,
    };
    const outputs = mapToContainerOutput(msg, 'sess-old');
    expect(outputs).toHaveLength(1);
    expect(outputs[0].status).toBe('success');
    expect(outputs[0].result).toBe('任务完成');
    expect(outputs[0].newSessionId).toBe('sess-new');
    expect(outputs[0].usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 100,
      numTurns: 5,
      durationMs: 10000,
      totalCostUsd: 0.05,
      model: undefined,
    });
  });

  it('result 无 session_id 时回退到传入的 sessionId', () => {
    const msg = { type: 'result' as const, result: 'done' };
    const outputs = mapToContainerOutput(msg, 'fallback-sess');
    expect(outputs[0].newSessionId).toBe('fallback-sess');
  });

  it('result 无 usage 时 usage 为 undefined', () => {
    const msg = { type: 'result' as const, result: 'done' };
    const outputs = mapToContainerOutput(msg);
    expect(outputs[0].usage).toBeUndefined();
  });

  it('system error 映射为 error', () => {
    const msg = { type: 'system' as const, subtype: 'error', message: 'Something went wrong' };
    const outputs = mapToContainerOutput(msg);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].status).toBe('error');
    expect(outputs[0].error).toBe('Something went wrong');
  });

  it('system error 非字符串 message 回退为默认', () => {
    const msg = { type: 'system' as const, subtype: 'error', message: { role: 'error', content: [] } };
    const outputs = mapToContainerOutput(msg as any);
    expect(outputs[0].error).toBe('CLI error');
  });

  it('未知类型返回空数组', () => {
    expect(mapToContainerOutput({ type: 'rate_limit_event' as any })).toEqual([]);
    expect(mapToContainerOutput({ type: 'stream_event' as any })).toEqual([]);
  });

  it('assistant 无 content 返回空数组', () => {
    const msg = { type: 'assistant' as const, message: {} };
    expect(mapToContainerOutput(msg)).toEqual([]);
  });

  it('assistant 混合 text + tool_use 全部返回', () => {
    const msg = {
      type: 'assistant' as const,
      message: {
        content: [
          { type: 'text', text: '让我来检查一下这个文件的内容' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/test.ts' } },
        ],
      },
    };
    const outputs = mapToContainerOutput(msg);
    expect(outputs).toHaveLength(2);
    expect(outputs[0].progressType).toBe('thinking');
    expect(outputs[1].progressType).toBe('tool_use');
  });

  it('工具名 emoji 映射正确', () => {
    const tools = [
      { name: 'Read', emoji: '📖' },
      { name: 'Write', emoji: '✏️' },
      { name: 'Edit', emoji: '✏️' },
      { name: 'Grep', emoji: '🔍' },
      { name: 'Glob', emoji: '📋' },
      { name: 'Bash', emoji: '🔧' },
      { name: 'CustomTool', emoji: '⚙️' },
    ];
    for (const { name, emoji } of tools) {
      const msg = {
        type: 'assistant' as const,
        message: { content: [{ type: 'tool_use', name, input: {} }] },
      };
      const outputs = mapToContainerOutput(msg);
      expect(outputs[0].result).toContain(emoji);
    }
  });
});

// ---- P0: buildCliEnv ----

describe('buildCliEnv', () => {
  it('移除 CLAUDE_AGENT_SDK_CLIENT_APP', () => {
    const env = buildCliEnv({
      HOME: '/home/user',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'nanoclaw',
      PATH: '/usr/bin',
    });
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBeUndefined();
    expect(env.HOME).toBe('/home/user');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('移除 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', () => {
    const env = buildCliEnv({
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    });
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined();
  });

  it('不影响其他环境变量', () => {
    const env = buildCliEnv({
      HOME: '/home/user',
      HTTPS_PROXY: 'http://proxy:8080',
      NODE_ENV: 'production',
    });
    expect(env.HOME).toBe('/home/user');
    expect(env.HTTPS_PROXY).toBe('http://proxy:8080');
    expect(env.NODE_ENV).toBe('production');
  });

  it('原 env 不被修改（纯函数）', () => {
    const original = {
      CLAUDE_AGENT_SDK_CLIENT_APP: 'test',
      HOME: '/home',
    };
    buildCliEnv(original);
    expect(original.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('test');
  });
});

// ---- P1: 集成场景（复合纯函数） ----

describe('CLI 模式集成场景', () => {
  it('完整的 stream-json 输出序列解析', () => {
    const lines = [
      '{"type":"system","subtype":"init","session_id":"s1","tools":[],"model":"claude-opus-4-7"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"让我来处理这个问题"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}',
      '{"type":"result","subtype":"success","result":"完成","session_id":"s1","usage":{"input_tokens":50,"output_tokens":20},"total_cost_usd":0.01,"num_turns":1,"duration_ms":2000}',
    ];

    let sessionId: string | undefined;
    const allOutputs: ContainerOutput[] = [];

    for (const line of lines) {
      const msg = parseStreamJsonLine(line);
      expect(msg).not.toBeNull();

      if (msg!.type === 'system' && msg!.subtype === 'init') {
        sessionId = msg!.session_id;
      }

      const outputs = mapToContainerOutput(msg!, sessionId);
      allOutputs.push(...outputs);
    }

    expect(sessionId).toBe('s1');
    expect(allOutputs).toHaveLength(3); // thinking + tool_use + result
    expect(allOutputs[0].progressType).toBe('thinking');
    expect(allOutputs[1].progressType).toBe('tool_use');
    expect(allOutputs[2].status).toBe('success');
    expect(allOutputs[2].result).toBe('完成');
  });

  it('buildCliArgs + buildMcpConfig 组合使用', () => {
    const mcpConfig = buildMcpConfig('/mcp.js', 'jid-1', 'grp-1', false, '/ipc');
    // 验证 mcpConfig 是可序列化的
    const json = JSON.stringify(mcpConfig);
    expect(JSON.parse(json)).toEqual(mcpConfig);

    const args = buildCliArgs({
      model: 'claude-haiku-4-5-20251001',
      sessionId: 'sess-resume',
      mcpConfigPath: '/tmp/mcp.json',
    });
    expect(args).toContain('--resume');
    expect(args).toContain('--model');
    expect(args).toContain('--mcp-config');
  });
});
