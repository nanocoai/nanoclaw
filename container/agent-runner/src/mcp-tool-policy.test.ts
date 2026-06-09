import { describe, expect, it } from 'vitest';

import {
  DISABLE_SEND_MESSAGE_ENV,
  buildSendMessageToolEnv,
  shouldRegisterSendMessage,
} from './mcp-tool-policy.js';
import { buildMcpConfig } from './cli-runner.js';
import { buildCodexConfigToml } from './codex-runner.js';
import { buildGeminiSettings } from './gemini-runner.js';

describe('mcp tool policy', () => {
  it('普通 SDK 会话默认隐藏 send_message 工具', () => {
    expect(buildSendMessageToolEnv(false)).toEqual({
      [DISABLE_SEND_MESSAGE_ENV]: '1',
    });
  });

  it('定时任务保留 send_message 工具用于主动通知', () => {
    expect(buildSendMessageToolEnv(true)).toEqual({});
  });

  it('MCP server 按环境变量决定是否注册 send_message', () => {
    expect(shouldRegisterSendMessage({ [DISABLE_SEND_MESSAGE_ENV]: '1' })).toBe(
      false,
    );
    expect(
      shouldRegisterSendMessage({ [DISABLE_SEND_MESSAGE_ENV]: undefined }),
    ).toBe(true);
    expect(shouldRegisterSendMessage({})).toBe(true);
  });

  it('CLI MCP 配置对普通会话隐藏 send_message，定时任务保留', () => {
    const normal = buildMcpConfig('mcp.js', 'chat', 'group', false, '/ipc');
    const normalEnv = (
      (normal.mcpServers as Record<string, { env: Record<string, string> }>).nanoclaw
        .env
    );
    expect(normalEnv[DISABLE_SEND_MESSAGE_ENV]).toBe('1');

    const scheduled = buildMcpConfig('mcp.js', 'chat', 'group', false, '/ipc', true);
    const scheduledEnv = (
      (scheduled.mcpServers as Record<string, { env: Record<string, string> }>)
        .nanoclaw.env
    );
    expect(scheduledEnv[DISABLE_SEND_MESSAGE_ENV]).toBeUndefined();
  });

  it('Codex MCP 配置对普通会话隐藏 send_message，定时任务保留', () => {
    const normal = buildCodexConfigToml({
      mcpServerPath: 'mcp.js',
      chatJid: 'chat',
      groupFolder: 'group',
      isMain: false,
      ipcDir: '/ipc',
    });
    expect(normal).toContain('NANOCLAW_DISABLE_SEND_MESSAGE = "1"');

    const scheduled = buildCodexConfigToml({
      mcpServerPath: 'mcp.js',
      chatJid: 'chat',
      groupFolder: 'group',
      isMain: false,
      ipcDir: '/ipc',
      isScheduledTask: true,
    });
    expect(scheduled).not.toContain('NANOCLAW_DISABLE_SEND_MESSAGE');
  });

  it('Gemini MCP 配置对普通会话隐藏 send_message，定时任务保留', () => {
    const normal = buildGeminiSettings({
      mcpServerPath: 'mcp.js',
      chatJid: 'chat',
      groupFolder: 'group',
      isMain: false,
      ipcDir: '/ipc',
    });
    const normalEnv = (
      (normal.mcpServers as Record<string, { env: Record<string, string> }>).nanoclaw
        .env
    );
    expect(normalEnv[DISABLE_SEND_MESSAGE_ENV]).toBe('1');

    const scheduled = buildGeminiSettings({
      mcpServerPath: 'mcp.js',
      chatJid: 'chat',
      groupFolder: 'group',
      isMain: false,
      ipcDir: '/ipc',
      isScheduledTask: true,
    });
    const scheduledEnv = (
      (scheduled.mcpServers as Record<string, { env: Record<string, string> }>)
        .nanoclaw.env
    );
    expect(scheduledEnv[DISABLE_SEND_MESSAGE_ENV]).toBeUndefined();
  });
});
