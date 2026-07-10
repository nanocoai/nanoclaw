/**
 * Codex Runner 单元测试
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildGitNexusMcpServerConfig,
  buildCodexConfigToml,
  isGitNexusCommandAvailable,
  mapCodexUsage,
  readCodexModelInfo,
} from '../container/agent-runner/src/codex-runner.js';

describe('buildCodexConfigToml', () => {
  it('白名单注入 GitNexus MCP 且不把 secret 写进 TOML', () => {
    const config = buildCodexConfigToml({
      mcpServerPath: '/runner/ipc-mcp-stdio.js',
      chatJid: 'oc_test',
      groupFolder: 'Codex',
      isMain: false,
      ipcDir: '/ipc',
      senderId: 'ou_user',
      extraMcpServers: [buildGitNexusMcpServerConfig()],
    });

    expect(config).toContain('[mcp_servers.nanoclaw]');
    expect(config).toContain('[mcp_servers.gitnexus]');
    expect(config).toContain('command = "bash"');
    expect(config).toContain('GITNEXUS_BIN:-gitnexus');
    expect(config).toContain('exec');
    expect(config).not.toContain('[mcp_servers.gitnexus.env]');
    expect(config).not.toContain('GITNEXUS_EMBEDDING_API_KEY');
    expect(config).not.toContain('sk-');
  });

  it('GitNexus wrapper 缺 env 文件时仍继续启动 MCP', () => {
    const gitnexus = buildGitNexusMcpServerConfig();

    expect(gitnexus.command).toBe('bash');
    expect(gitnexus.args).toEqual([
      '-lc',
      'if [ -f "$HOME/.gitnexus/env" ]; then . "$HOME/.gitnexus/env"; fi; exec "${GITNEXUS_BIN:-gitnexus}" mcp',
    ]);
  });

  it('GitNexus 命令缺失时可判定为不可注入', () => {
    expect(isGitNexusCommandAvailable({ PATH: '' })).toBe(false);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-bin-'));
    const bin = path.join(dir, 'gitnexus');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(bin, 0o755);

    expect(isGitNexusCommandAvailable({ PATH: dir })).toBe(true);
  });

  it('普通会话隐藏 send_message 工具', () => {
    const config = buildCodexConfigToml({
      mcpServerPath: '/runner/ipc-mcp-stdio.js',
      chatJid: 'oc_test',
      groupFolder: 'Codex',
      isMain: false,
      ipcDir: '/ipc',
      senderId: 'ou_user',
    });

    expect(config).toContain('NANOCLAW_DISABLE_SEND_MESSAGE = "1"');
  });

  it('定时任务保留 send_message 工具用于主动通知', () => {
    const config = buildCodexConfigToml({
      mcpServerPath: '/runner/ipc-mcp-stdio.js',
      chatJid: 'oc_test',
      groupFolder: 'Codex',
      isMain: false,
      ipcDir: '/ipc',
      senderId: 'ou_user',
      isScheduledTask: true,
    });

    expect(config).not.toContain('NANOCLAW_DISABLE_SEND_MESSAGE');
  });
});

describe('mapCodexUsage', () => {
  it('用本轮 input + cached input 计算 lastTurnContext', () => {
    const usage = mapCodexUsage(
      {
        input_tokens: 1000,
        cached_input_tokens: 500,
        output_tokens: 200,
      },
      {
        model: 'gpt-5.5',
        modelContextWindow: 258400,
        lastTurnContext: 1200,
      },
    );

    expect(usage).toMatchObject({
      inputTokens: 1000,
      cacheReadInputTokens: 500,
      outputTokens: 200,
      lastTurnContext: 1200,
      model: 'gpt-5.5',
      modelContextWindows: { 'gpt-5.5': 258400 },
    });
  });

  it('从 rollout 读取 last_token_usage 作为当前上下文', () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    const sessionsDir = path.join(codexHome, 'sessions', '2026', '06', '04');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const threadId = '019e9331-b6a1-7eb1-bff1-ee6f8439d8ce';
    fs.writeFileSync(
      path.join(sessionsDir, `rollout-2026-06-04T15-12-49-${threadId}.jsonl`),
      [
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'task_started', model_context_window: 258400 },
        }),
        JSON.stringify({
          type: 'turn_context',
          payload: { model: 'gpt-5.5' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { input_tokens: 244077616 },
              last_token_usage: { input_tokens: 169477 },
            },
          },
        }),
      ].join('\n'),
    );

    expect(readCodexModelInfo(codexHome, threadId)).toEqual({
      model: 'gpt-5.5',
      modelContextWindow: 258400,
      lastTurnContext: 169477,
      lastTurnUsage: {
        input_tokens: 169477,
        cached_input_tokens: 0,
        output_tokens: 0,
      },
    });
  });
});
