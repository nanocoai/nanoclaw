import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

import {
  buildGeminiArgs,
  buildGeminiEnv,
  buildGeminiSettings,
  extractGeminiError,
  mapGeminiUsage,
  parseGeminiEventLine,
  runGeminiQuery,
} from '../container/agent-runner/src/gemini-runner.js';

describe('gemini-runner', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  interface GeminiSettingsForTest {
    security: { auth: { selectedType: string } };
    mcpServers: {
      nanoclaw: {
        command: string;
        args: string[];
        trust: boolean;
        env: Record<string, string>;
      };
    };
  }

  it('解析 stream-json 事件行', () => {
    expect(parseGeminiEventLine('')).toBeNull();
    expect(parseGeminiEventLine('Warning: terminal')).toBeNull();
    expect(parseGeminiEventLine('{"type":"init","session_id":"s1","model":"gemini-3-pro-preview"}')).toEqual({
      type: 'init',
      session_id: 's1',
      model: 'gemini-3-pro-preview',
    });
  });

  it('构建 headless 参数并支持 resume、模型和额外目录', () => {
    const args = buildGeminiArgs({
      prompt: '你好',
      sessionId: 'session-1',
      model: 'gemini-3-pro-preview',
      additionalDirectories: ['/a', '/b'],
    });

    expect(args).toEqual([
      '-p',
      '你好',
      '--output-format',
      'stream-json',
      '--skip-trust',
      '--approval-mode',
      'yolo',
      '--resume',
      'session-1',
      '--model',
      'gemini-3-pro-preview',
      '--include-directories',
      '/a',
      '--include-directories',
      '/b',
    ]);
  });

  it('生成 Gemini MCP settings', () => {
    const settings = buildGeminiSettings({
      mcpServerPath: '/runner/ipc-mcp-stdio.js',
      chatJid: 'oc_test',
      groupFolder: 'Gemini3_1',
      isMain: false,
      ipcDir: '/ipc',
      senderId: 'ou_user',
    }) as unknown as GeminiSettingsForTest;

    expect(settings.security.auth.selectedType).toBe('oauth-personal');
    expect(settings.mcpServers.nanoclaw.command).toBe('node');
    expect(settings.mcpServers.nanoclaw.args).toEqual(['/runner/ipc-mcp-stdio.js']);
    expect(settings.mcpServers.nanoclaw.trust).toBe(true);
    expect(settings.mcpServers.nanoclaw.env).toEqual({
      NANOCLAW_CHAT_JID: 'oc_test',
      NANOCLAW_GROUP_FOLDER: 'Gemini3_1',
      NANOCLAW_IS_MAIN: '0',
      NANOCLAW_IPC_DIR: '/ipc',
      NANOCLAW_SENDER_ID: 'ou_user',
      NANOCLAW_DISABLE_SEND_MESSAGE: '1',
    });
  });

  it('定时任务保留 send_message 工具用于主动通知', () => {
    const settings = buildGeminiSettings({
      mcpServerPath: '/runner/ipc-mcp-stdio.js',
      chatJid: 'oc_test',
      groupFolder: 'Gemini3_1',
      isMain: false,
      ipcDir: '/ipc',
      senderId: 'ou_user',
      isScheduledTask: true,
    }) as unknown as GeminiSettingsForTest;

    expect(
      settings.mcpServers.nanoclaw.env.NANOCLAW_DISABLE_SEND_MESSAGE,
    ).toBeUndefined();
  });

  it('构建 per-group HOME 环境', () => {
    const env = buildGeminiEnv({ HOME: '/real-home', HTTPS_PROXY: 'http://proxy' }, '/group-home');
    expect(env.HOME).toBe('/group-home');
    expect(env.HTTPS_PROXY).toBe('http://proxy');
  });

  it('映射 usage，auto 模型取 token 最高的实际模型', () => {
    const usage = mapGeminiUsage({
      type: 'result',
      stats: {
        input_tokens: 10,
        output_tokens: 2,
        cached: 3,
        duration_ms: 100,
        models: {
          'gemini-3.1-flash-lite': { total_tokens: 5 },
          'gemini-3-flash': { total_tokens: 12 },
        },
      },
    }, 'auto');

    expect(usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      durationMs: 100,
      model: 'gemini-3-flash',
    });
  });

  it('显式模型优先于 stats 里的实际模型名', () => {
    const usage = mapGeminiUsage({
      type: 'result',
      stats: {
        input_tokens: 10,
        output_tokens: 2,
        models: {
          'gemini-3-flash': { total_tokens: 12 },
        },
      },
    }, 'gemini-3-pro-preview');

    expect(usage?.model).toBe('gemini-3-pro-preview');
  });

  it('提取错误正文', () => {
    expect(extractGeminiError({ type: 'error', message: 'bad auth' })).toBe('bad auth');
    expect(extractGeminiError({ type: 'result', status: 'failed', error: { message: 'quota' } })).toBe('quota');
    expect(extractGeminiError({ type: 'result', status: 'success' })).toBeUndefined();
  });

  it('spawn error 后 close 不会二重 writeOutput', async () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
    };
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    spawnMock.mockReturnValueOnce(proc as unknown as ChildProcess);

    const outputs: Array<{ status: string; error?: string }> = [];
    const promise = runGeminiQuery(
      {
        prompt: 'hi',
        mcpServerPath: '/tmp/mcp.js',
        chatJid: 'chat',
        groupFolder: 'group',
        isMain: true,
        ipcDir: '/tmp/ipc',
        cwd: '/tmp',
        env: { HOME: '/tmp' },
        geminiHome: '/tmp/gemini-home-test',
      },
      (output) => outputs.push({ status: output.status, error: output.error }),
      () => undefined,
    );

    proc.emit('error', new Error('spawn gemini ENOENT'));
    proc.emit('close', null);

    await expect(promise).resolves.toEqual({});
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('npm install -g @google/gemini-cli'),
    });
  });

  it('resume session 不存在时改用新会话重跑', async () => {
    const first = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
    };
    first.stdin = new PassThrough();
    first.stdout = new PassThrough();
    first.stderr = new PassThrough();

    const second = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
    };
    second.stdin = new PassThrough();
    second.stdout = new PassThrough();
    second.stderr = new PassThrough();

    spawnMock
      .mockReturnValueOnce(first as unknown as ChildProcess)
      .mockReturnValueOnce(second as unknown as ChildProcess);

    const outputs: Array<{ status: string; result?: string | null; newSessionId?: string }> = [];
    const logs: string[] = [];
    const promise = runGeminiQuery(
      {
        prompt: 'hi',
        sessionId: 'missing-session',
        mcpServerPath: '/tmp/mcp.js',
        chatJid: 'chat',
        groupFolder: 'group',
        isMain: true,
        ipcDir: '/tmp/ipc',
        cwd: '/tmp',
        env: { HOME: '/tmp' },
        geminiHome: '/tmp/gemini-home-test',
      },
      (output) => outputs.push({
        status: output.status,
        result: output.result,
        newSessionId: output.newSessionId,
      }),
      (message) => logs.push(message),
    );

    first.stderr.write('Error resuming session: No previous sessions found for this project.\n');
    first.emit('close', 42);

    second.stdout.write('{"type":"init","session_id":"fresh-session","model":"gemini-3-pro-preview"}\n');
    second.stdout.write('{"type":"message","role":"assistant","content":"好了"}\n');
    second.stdout.write('{"type":"result","status":"success","stats":{"input_tokens":1,"output_tokens":1}}\n');
    second.emit('close', 0);

    await expect(promise).resolves.toMatchObject({
      newSessionId: 'fresh-session',
      result: '好了',
    });

    expect(outputs).toEqual([
      {
        status: 'success',
        result: '好了',
        newSessionId: 'fresh-session',
      },
    ]);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0][1]).toContain('--resume');
    expect(spawnMock.mock.calls[1][1]).not.toContain('--resume');
    expect(logs.some((line) => line.includes('改用新 session 重跑'))).toBe(true);
  });
});
