import { describe, expect, it } from 'vitest';

import {
  DISABLE_SEND_MESSAGE_ENV,
  buildSendMessageToolEnv,
  shouldRegisterSendMessage,
} from './mcp-tool-policy.js';

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
});
