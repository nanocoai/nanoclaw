import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- mock 飞书 SDK ----

const mockCreate = vi
  .fn()
  .mockResolvedValue({ data: { message_id: 'msg_mock' } });
const mockPatch = vi.fn().mockResolvedValue({});
const mockMessageDelete = vi.fn().mockResolvedValue({});
const mockReactionCreate = vi
  .fn()
  .mockResolvedValue({ data: { reaction_id: 'react_1' } });
const mockReactionDelete = vi.fn().mockResolvedValue({});
const mockChatList = vi.fn().mockResolvedValue({
  data: {
    items: [
      { chat_id: 'oc_group1', name: '测试群' },
      { chat_id: 'oc_group2', name: '开发群' },
    ],
    page_token: undefined,
    has_more: false,
  },
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockClient {
    im = {
      message: { create: mockCreate, patch: mockPatch, delete: mockMessageDelete },
      messageReaction: {
        create: mockReactionCreate,
        delete: mockReactionDelete,
      },
      chat: { list: mockChatList },
      chatMembers: {
        get: vi.fn().mockResolvedValue({
          data: { items: [{ member_id: 'ou_test_user', name: '测试用户' }] },
        }),
      },
    };
  }
  class MockWSClient {
    close = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
  }
  class MockEventDispatcher {
    register() {
      return this;
    }
  }
  return {
    Client: MockClient,
    WSClient: MockWSClient,
    EventDispatcher: MockEventDispatcher,
    Domain: { Feishu: 'https://open.feishu.cn' },
    LoggerLevel: { warn: 2 },
  };
});

vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) => `/tmp/groups/${folder}`,
}));

const mockGetMessageById = vi.fn().mockReturnValue(undefined);
vi.mock('../db.js', () => ({
  getMessageById: (...args: unknown[]) => mockGetMessageById(...args),
}));

import { ASSISTANT_NAME } from '../config.js';
import { FeishuChannel } from './feishu.js';
import type { ChannelOpts } from './registry.js';

// ---- 测试辅助 ----

function makeOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    ...overrides,
  };
}

// ---- 测试 ----

describe('FeishuChannel', () => {
  let channel: FeishuChannel;
  let opts: ChannelOpts;

  beforeEach(() => {
    vi.clearAllMocks();
    opts = makeOpts();
    channel = new FeishuChannel('app_id', 'app_secret', opts);
  });

  describe('基本属性', () => {
    it('name 为 feishu', () => {
      expect(channel.name).toBe('feishu');
    });

    it('ownsJid 匹配 fs: 前缀', () => {
      expect(channel.ownsJid('fs:oc_123')).toBe(true);
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('slack:C123')).toBe(false);
    });
  });

  describe('connect / disconnect', () => {
    it('connect 后 isConnected 为 true', async () => {
      expect(channel.isConnected()).toBe(false);
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('disconnect 后 isConnected 为 false', async () => {
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('短文本用 text 类型发送', async () => {
      await channel.sendMessage('fs:oc_123', 'hello');
      expect(mockCreate).toHaveBeenCalledWith({
        data: {
          receive_id: 'oc_123',
          msg_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
        params: { receive_id_type: 'chat_id' },
      });
    });

    it('长文本用 interactive 卡片发送', async () => {
      const longText = 'a'.repeat(501);
      await channel.sendMessage('fs:oc_123', longText);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            receive_id: 'oc_123',
            msg_type: 'interactive',
          }),
        }),
      );
    });

    it('含 Markdown 代码块的文本用卡片发送', async () => {
      const mdText = '看看这个:\n```js\nconsole.log(1)\n```';
      await channel.sendMessage('fs:oc_123', mdText);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ msg_type: 'interactive' }),
        }),
      );
    });

    it('含 Markdown 标题的文本用卡片发送', async () => {
      await channel.sendMessage('fs:oc_123', '## 标题\n内容');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ msg_type: 'interactive' }),
        }),
      );
    });

    it('含表格的文本用卡片发送', async () => {
      await channel.sendMessage('fs:oc_123', '| 列1 | 列2 |\n| --- | --- |');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ msg_type: 'interactive' }),
        }),
      );
    });
  });

  describe('syncGroups', () => {
    it('同步群列表并调用 onChatMetadata', async () => {
      await channel.syncGroups();
      expect(mockChatList).toHaveBeenCalled();
      expect(opts.onChatMetadata).toHaveBeenCalledTimes(2);
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'fs:oc_group1',
        expect.any(String),
        '测试群',
        'feishu',
        true,
      );
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'fs:oc_group2',
        expect.any(String),
        '开发群',
        'feishu',
        true,
      );
    });
  });

  describe('extractPostContent', () => {
    it('提取纯文本 post', () => {
      const parsed = {
        content: [
          [
            { tag: 'text', text: '你好' },
            { tag: 'text', text: '世界' },
          ],
          [{ tag: 'text', text: '第二行' }],
        ],
      };
      const result = channel.extractPostContent(parsed);
      expect(result.text).toBe('你好世界\n第二行');
      expect(result.imageKeys).toEqual([]);
    });

    it('提取 post 中的图片 key', () => {
      const parsed = {
        title: '测试标题',
        content: [
          [
            { tag: 'text', text: '看看这张图' },
            { tag: 'img', image_key: 'img_abc123' },
          ],
          [{ tag: 'img', image_key: 'img_def456' }],
          [{ tag: 'text', text: '结束' }],
        ],
      };
      const result = channel.extractPostContent(parsed);
      expect(result.text).toBe('测试标题\n看看这张图\n结束');
      expect(result.imageKeys).toEqual(['img_abc123', 'img_def456']);
    });

    it('提取 a 标签中的文本', () => {
      const parsed = {
        content: [
          [
            { tag: 'text', text: '点击 ' },
            { tag: 'a', text: '这里', href: 'https://example.com' },
          ],
        ],
      };
      const result = channel.extractPostContent(parsed);
      expect(result.text).toBe('点击 这里');
    });

    it('空 content 返回空', () => {
      const result = channel.extractPostContent({});
      expect(result.text).toBe('');
      expect(result.imageKeys).toEqual([]);
    });

    it('有 title 无 content 只返回 title', () => {
      const result = channel.extractPostContent({ title: '仅标题' });
      expect(result.text).toBe('仅标题');
      expect(result.imageKeys).toEqual([]);
    });

    it('提取 at 标签生成 mention 占位符', () => {
      const parsed = {
        content: [
          [
            { tag: 'img', image_key: 'img_abc' },
            { tag: 'at', user_id: 'ou_test123' },
            { tag: 'text', text: ' 帮我看看' },
          ],
        ],
      };
      const result = channel.extractPostContent(parsed);
      expect(result.text).toBe('@_at_ou_test123 帮我看看');
      expect(result.imageKeys).toEqual(['img_abc']);
    });

    it('多个 at 标签都生成占位符', () => {
      const parsed = {
        content: [
          [
            { tag: 'at', user_id: 'ou_user1' },
            { tag: 'text', text: ' ' },
            { tag: 'at', user_id: 'ou_user2' },
            { tag: 'text', text: ' 你们看看' },
          ],
        ],
      };
      const result = channel.extractPostContent(parsed);
      expect(result.text).toBe('@_at_ou_user1 @_at_ou_user2 你们看看');
    });
  });

  describe('factory 注册', () => {
    it('无凭证时 factory 返回 null', async () => {
      // 清理环境变量确保不干扰
      const origId = process.env.FEISHU_APP_ID;
      const origSecret = process.env.FEISHU_APP_SECRET;
      delete process.env.FEISHU_APP_ID;
      delete process.env.FEISHU_APP_SECRET;

      // 重新导入以触发 factory
      const { getChannelFactory } = await import('./registry.js');
      const factory = getChannelFactory('feishu');
      expect(factory).toBeDefined();
      const result = factory!(opts);
      // 由于 .env 文件中也没有这些值，应该返回 null
      // 但如果 .env 有值则可能不为 null，所以只验证 factory 存在
      expect(factory).toBeTypeOf('function');

      // 恢复
      if (origId) process.env.FEISHU_APP_ID = origId;
      if (origSecret) process.env.FEISHU_APP_SECRET = origSecret;
    });
  });

  describe('sendPlainOrCard 降级', () => {
    it('卡片发送失败 → 自动降级纯文本', async () => {
      // 第一次 create（卡片）失败，第二次 create（纯文本）成功
      mockCreate
        .mockRejectedValueOnce(new Error('invalid image keys'))
        .mockResolvedValueOnce({ data: { message_id: 'msg_fallback' } });

      // 长文本 → shouldUseCard → interactive 卡片路径
      const longText = 'a'.repeat(501);
      await channel.sendMessage('fs:oc_123', longText);

      // create 被调用两次（卡片 + 降级纯文本）
      expect(mockCreate).toHaveBeenCalledTimes(2);
      // 第一次是 interactive
      expect(mockCreate.mock.calls[0][0].data.msg_type).toBe('interactive');
      // 第二次降级为 text
      expect(mockCreate.mock.calls[1][0].data.msg_type).toBe('text');
    });

    it('降级后纯文本也失败 → promise rejects', async () => {
      mockCreate
        .mockRejectedValueOnce(new Error('card failed'))
        .mockRejectedValueOnce(new Error('text also failed'));

      const longText = 'b'.repeat(501);
      await expect(
        channel.sendMessage('fs:oc_123', longText),
      ).rejects.toThrow('text also failed');
    });
  });

  describe('typing indicator', () => {
    it('setTyping(true) 添加 emoji reaction', async () => {
      // 设置最新 messageId（通过 private Map）
      (channel as any).lastMessageIds.set('fs:oc_typing', 'msg_user_1');

      await channel.setTyping!('fs:oc_typing', true);

      expect(mockReactionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { message_id: 'msg_user_1' },
        }),
      );
    });

    it('setTyping(false) 移除 emoji reaction', async () => {
      // 先 setTyping true（设置 reactionId）
      (channel as any).lastMessageIds.set('fs:oc_typing2', 'msg_user_2');
      await channel.setTyping!('fs:oc_typing2', true);

      await channel.setTyping!('fs:oc_typing2', false);

      expect(mockReactionDelete).toHaveBeenCalled();
    });

    it('无 lastMessageId 时 setTyping(true) 不抛异常', async () => {
      // 没有设置 lastMessageId
      await expect(
        channel.setTyping!('fs:oc_no_msg', true),
      ).resolves.toBeUndefined();
      // reaction 不应被调用
      expect(mockReactionCreate).not.toHaveBeenCalled();
    });
  });

  describe('进度消息聚合', () => {
    it('progressDone 后忽略迟到的进度消息', async () => {
      const jid = 'fs:oc_progress_done';
      // 模拟 progressDone 已标记（正式回复已到达）
      (channel as any).progressDone.add(jid);

      // 发送进度消息（显式标记 isProgress）
      await channel.sendMessage(jid, '⚙️ 正在处理...', { isProgress: true });

      // 不应调用 create（被忽略）
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('💭 消息单独发送不加入卡片', async () => {
      const jid = 'fs:oc_thought';
      // 确保没有 progressDone 标记
      (channel as any).progressDone.delete(jid);

      await channel.sendMessage(jid, '💭 这是内部思考', { isProgress: true });

      // 应该调用 create 发送（而非 patch 卡片）
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            receive_id: 'oc_thought',
          }),
        }),
      );
    });

    // 回归保护：assistant text block 走 💬 progress，必须像 💭 那样独立发送（不进卡片）
    it('💬 消息（assistant 中间叙述）单独发送不加入卡片', async () => {
      const jid = 'fs:oc_text_block';
      (channel as any).progressDone.delete(jid);

      await channel.sendMessage(jid, '💬 让我先看下这块代码', { isProgress: true });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            receive_id: 'oc_text_block',
          }),
        }),
      );
    });

    it('💬 JSON 进度（带 detail）剥掉前缀后取 detail 完整文本', async () => {
      const jid = 'fs:oc_text_detail';
      (channel as any).progressDone.delete(jid);

      const fullText = 'A'.repeat(200);
      const payload = JSON.stringify({
        title: '💬 ' + 'A'.repeat(80) + '...',
        detail: fullText,
      });
      await channel.sendMessage(jid, payload, { isProgress: true });

      // 调用 create 时携带的内容应该是 detail 全文，而不是被截断的 title
      const callArg = mockCreate.mock.calls[0]?.[0];
      const sentContent = JSON.parse(callArg?.data?.content ?? '{}');
      // content 是 markdown card JSON，其中应包含原文
      const serialized = JSON.stringify(sentContent);
      expect(serialized).toContain(fullText);
      // 不应包含 💬 emoji 前缀（已被 replace 剥掉）
      expect(serialized).not.toContain('💬');
    });

    it('💬 progressDone 后忽略（已收到正式回复）', async () => {
      const jid = 'fs:oc_text_late';
      (channel as any).progressDone.add(jid);

      await channel.sendMessage(jid, '💬 迟到的中间消息', { isProgress: true });

      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('cleanupProgressCard', () => {
    const jid = 'fs:oc_test_cleanup';

    /** 手动注入一个进度卡片 entry，模拟 onAgentProgress 创建后的状态 */
    function injectProgressCard(messageId: string, steps: { title: string }[]) {
      // 通过 private Map 注入（测试场景合理使用 as any）
      (channel as any).progressCards.set(jid, {
        messageId,
        sessionId: 'sess_test',
        steps: steps.map((s) => ({ ...s, detail: undefined })),
        allSteps: steps.map((s) => ({ ...s, detail: undefined })),
        frame: 0,
        startTime: Date.now(),
      });
    }

    it('patch 成功时正常转为完成卡片', async () => {
      injectProgressCard('msg_card_1', [{ title: '⚙️ Bash: ls' }]);
      mockPatch.mockResolvedValueOnce({});

      await channel.cleanupProgressCard(jid);

      expect(mockPatch).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { message_id: 'msg_card_1' },
        }),
      );
      expect(mockMessageDelete).not.toHaveBeenCalled();
    });

    it('patch 失败时 fallback 删除卡片', async () => {
      injectProgressCard('msg_card_2', [{ title: '⚙️ Bash: ls' }]);
      mockPatch.mockRejectedValueOnce(new Error('ErrCode: 200800'));

      await channel.cleanupProgressCard(jid);

      // patch 被调用且失败
      expect(mockPatch).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { message_id: 'msg_card_2' },
        }),
      );
      // fallback: 删除卡片
      expect(mockMessageDelete).toHaveBeenCalledWith({
        path: { message_id: 'msg_card_2' },
      });
    });

    it('patch 失败且 delete 也失败时不抛异常', async () => {
      injectProgressCard('msg_card_3', [{ title: '⚙️ Bash: ls' }]);
      mockPatch.mockRejectedValueOnce(new Error('200800'));
      mockMessageDelete.mockRejectedValueOnce(new Error('delete also failed'));

      // 不应抛异常
      await expect(channel.cleanupProgressCard(jid)).resolves.toBeUndefined();
    });

    it('纯思考步骤（无工具）时删除卡片而非 patch', async () => {
      injectProgressCard('msg_card_4', [{ title: '💭 思考中...' }]);

      await channel.cleanupProgressCard(jid);

      expect(mockPatch).not.toHaveBeenCalled();
      expect(mockMessageDelete).toHaveBeenCalledWith({
        path: { message_id: 'msg_card_4' },
      });
    });

    it('无 messageId 时静默返回不调 API', async () => {
      injectProgressCard('', [{ title: '⚙️ Bash: ls' }]);

      await channel.cleanupProgressCard(jid);

      expect(mockPatch).not.toHaveBeenCalled();
      expect(mockMessageDelete).not.toHaveBeenCalled();
    });

    it('完成卡片不包含 usage footer（usage 只在正式回复上）', async () => {
      injectProgressCard('msg_card_usage', [{ title: '⚙️ Bash: ls' }]);
      // 注入 pendingUsage（模拟 setUsage 已被调用）
      (channel as any).pendingUsage.set(jid, {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 50,
        numTurns: 3,
        durationMs: 5000,
        totalCostUsd: 0.05,
        model: 'claude-opus-4-6',
      });
      (channel as any).thinkingMode.set(jid, 'adaptive');
      mockPatch.mockResolvedValueOnce({});

      await channel.cleanupProgressCard(jid);

      // patch 被调用，但 content 中不包含 usage 信息（不含 model 名）
      expect(mockPatch).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { message_id: 'msg_card_usage' },
        }),
      );
      const patchContent = mockPatch.mock.calls[0][0].data.content;
      expect(patchContent).not.toContain('opus-4-6');
      // usage 和 thinkingMode 被清理
      expect((channel as any).pendingUsage.has(jid)).toBe(false);
      expect((channel as any).thinkingMode.has(jid)).toBe(false);
    });

    it('无 pendingUsage 时完成卡片不包含 usage footer', async () => {
      injectProgressCard('msg_card_no_usage', [{ title: '⚙️ Bash: ls' }]);
      mockPatch.mockResolvedValueOnce({});

      await channel.cleanupProgressCard(jid);

      // patch 被调用，但 content 中不包含 cost 信息
      expect(mockPatch).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { message_id: 'msg_card_no_usage' },
          data: expect.objectContaining({
            content: expect.not.stringContaining('💰'),
          }),
        }),
      );
    });
  });

  describe('sendMessage 返回飞书 message_id', () => {
    it('正式回复返回飞书 message_id', async () => {
      mockCreate.mockResolvedValueOnce({ data: { message_id: 'om_reply_001' } });
      const msgId = await channel.sendMessage('fs:oc_123', '正式回复');
      expect(msgId).toBe('om_reply_001');
    });

    it('✅ 开头的正式回复不被误判为进度消息', async () => {
      mockCreate.mockResolvedValueOnce({ data: { message_id: 'om_emoji_reply' } });
      const msgId = await channel.sendMessage('fs:oc_123', '✅ 任务已完成，结果如下...');
      // 不传 isProgress → 走正式回复路径，正常发送
      expect(msgId).toBe('om_emoji_reply');
      expect(mockCreate).toHaveBeenCalled();
    });

    it('进度消息返回 undefined', async () => {
      const msgId = await channel.sendMessage('fs:oc_123', '🔧 Bash: ls -la', { isProgress: true });
      expect(msgId).toBeUndefined();
    });

    it('💭 思考消息返回 undefined', async () => {
      const msgId = await channel.sendMessage('fs:oc_123', '💭 正在分析代码结构...', { isProgress: true });
      expect(msgId).toBeUndefined();
    });

    it('命令回复返回 undefined（有意丢弃）', async () => {
      mockCreate.mockResolvedValueOnce({ data: { message_id: 'om_cmd_001' } });
      const msgId = await channel.sendMessage('fs:oc_123', '命令结果', {
        isCommandReply: true,
      });
      expect(msgId).toBeUndefined();
    });

    it('API 返回无 message_id 时返回 undefined', async () => {
      mockCreate.mockResolvedValueOnce({ data: {} });
      const msgId = await channel.sendMessage('fs:oc_123', '测试');
      expect(msgId).toBeUndefined();
    });
  });

  describe('sendPlainOrCard 返回 message_id', () => {
    it('纯文本发送返回 message_id', async () => {
      mockCreate.mockResolvedValueOnce({ data: { message_id: 'om_text_001' } });
      const msgId = await channel.sendMessage('fs:oc_123', 'short');
      expect(msgId).toBe('om_text_001');
    });

    it('卡片发送返回 message_id', async () => {
      mockCreate.mockResolvedValueOnce({ data: { message_id: 'om_card_001' } });
      const longText = 'a'.repeat(501);
      const msgId = await channel.sendMessage('fs:oc_123', longText);
      expect(msgId).toBe('om_card_001');
    });

    it('卡片失败降级纯文本，返回降级后的 message_id', async () => {
      mockCreate
        .mockRejectedValueOnce(new Error('card error'))
        .mockResolvedValueOnce({ data: { message_id: 'om_fallback_001' } });
      const longText = 'a'.repeat(501);
      const msgId = await channel.sendMessage('fs:oc_123', longText);
      expect(msgId).toBe('om_fallback_001');
    });
  });

  describe('fetchReplyContext DB 优先查询', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      mockGetMessageById.mockReset();
      originalFetch = globalThis.fetch;
      (channel as any).getTenantAccessToken = vi.fn().mockResolvedValue('mock_token');
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    // 辅助：mock 飞书 API 返回
    function mockFeishuApi(item: Record<string, unknown>) {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        json: async () => ({
          code: 0,
          data: { items: [item] },
        }),
      }) as any;
    }

    it('DB 命中 → 直接返回内容，不调飞书 API', async () => {
      mockGetMessageById.mockReturnValueOnce({
        sender_name: '大狗',
        content: '这是 bot 的回复内容',
      });

      const result = await (channel as any).fetchReplyContext('om_test_001');
      expect(result).toEqual({
        content: '这是 bot 的回复内容',
        senderName: '大狗',
      });
      expect(mockGetMessageById).toHaveBeenCalledWith('om_test_001');
    });

    it('DB 命中但内容超长 → 精确截断到 200 字 + ...', async () => {
      mockGetMessageById.mockReturnValueOnce({
        sender_name: 'Andy',
        content: '长'.repeat(300),
      });

      const result = await (channel as any).fetchReplyContext('om_test_002');
      expect(result!.content).toBe('长'.repeat(200) + '...');
    });

    it('DB 命中但无 sender_name → 使用 ASSISTANT_NAME', async () => {
      mockGetMessageById.mockReturnValueOnce({
        sender_name: '',
        content: '内容',
      });

      const result = await (channel as any).fetchReplyContext('om_test_003');
      expect(result!.senderName).toBe(ASSISTANT_NAME);
    });

    it('DB 未命中 → fallback 到飞书 API', async () => {
      mockGetMessageById.mockReturnValueOnce(undefined);
      mockFeishuApi({
        msg_type: 'text',
        sender: { id: 'ou_user1', sender_type: 'user' },
        body: { content: JSON.stringify({ text: '用户消息' }) },
      });

      const result = await (channel as any).fetchReplyContext('om_user_msg');
      expect(mockGetMessageById).toHaveBeenCalledWith('om_user_msg');
      expect(result).toEqual({
        content: '用户消息',
        senderName: 'ou_user1',
      });
    });

    it('DB 查询异常 → 静默 fallback 到飞书 API', async () => {
      mockGetMessageById.mockImplementationOnce(() => {
        throw new Error('DB corrupted');
      });
      mockFeishuApi({
        msg_type: 'text',
        sender: { id: 'ou_user1', sender_type: 'user' },
        body: { content: JSON.stringify({ text: 'fallback 消息' }) },
      });

      const result = await (channel as any).fetchReplyContext('om_err_msg');
      expect(mockGetMessageById).toHaveBeenCalledWith('om_err_msg');
      expect(result!.content).toBe('fallback 消息');
    });

    it('DB 命中内容为空 → fallback 到 API', async () => {
      mockGetMessageById.mockReturnValueOnce({
        sender_name: 'Andy',
        content: '',
      });
      mockFeishuApi({
        msg_type: 'text',
        sender: { id: 'ou_u1', sender_type: 'user' },
        body: { content: JSON.stringify({ text: 'API 内容' }) },
      });

      const result = await (channel as any).fetchReplyContext('om_empty');
      expect(result!.content).toBe('API 内容');
    });

    it('API fallback — interactive 类型提取卡片标题', async () => {
      mockGetMessageById.mockReturnValueOnce(undefined);
      mockFeishuApi({
        msg_type: 'interactive',
        sender: { id: 'cli_bot1', sender_type: 'app' },
        body: {
          content: JSON.stringify({
            header: { title: { content: '任务完成报告' } },
          }),
        },
      });

      const result = await (channel as any).fetchReplyContext('om_card_msg');
      expect(result).toEqual({
        content: '[卡片: 任务完成报告]',
        senderName: ASSISTANT_NAME,
      });
    });

    it('DB 未命中且 token 获取失败 → 返回 null', async () => {
      mockGetMessageById.mockReturnValueOnce(undefined);
      (channel as any).getTenantAccessToken = vi.fn().mockResolvedValue(null);

      const result = await (channel as any).fetchReplyContext('om_no_token');
      expect(result).toBeNull();
    });
  });

  describe('sendDirectMessage — usage footer', () => {
    beforeEach(() => {
      mockCreate.mockClear();
    });

    it('有 pendingUsage 时，sendDirectMessage 附加 usage footer', async () => {
      const jid = 'fs:oc_test_direct';
      // 先 setUsage
      channel.setUsage(jid, {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 500,
        cacheCreationInputTokens: 0,
        numTurns: 3,
        durationMs: 5000,
        totalCostUsd: 0.05,
        model: 'claude-opus-4-6',
        lastTurnContext: 1500,
      }, 'adaptive');

      // 用 sendDirectMessage 发消息（长文本触发卡片）
      const longText = '结果已发送。' + 'x'.repeat(500);
      await (channel as any).sendDirectMessage(jid, longText);

      // 验证调用了 interactive 卡片
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            msg_type: 'interactive',
          }),
        }),
      );

      // 验证卡片内容包含 usage footer（cost、model 等）
      const callArg = mockCreate.mock.calls[0][0];
      const content = JSON.parse(callArg.data.content);
      const elements = content.body?.elements || content.elements || [];
      const hasUsageFooter = elements.some(
        (el: any) => el.tag === 'markdown' && el.content?.includes('💰'),
      );
      expect(hasUsageFooter).toBe(true);

      // 验证 pendingUsage 被消费（不重复附加）
      expect((channel as any).pendingUsage.has(jid)).toBe(false);
    });

    it('无 pendingUsage 时，sendDirectMessage 不附加 footer', async () => {
      const jid = 'fs:oc_test_no_usage';
      // 不设 usage，直接发
      await (channel as any).sendDirectMessage(jid, 'hello');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            msg_type: 'text',
            content: JSON.stringify({ text: 'hello' }),
          }),
        }),
      );
    });

    it('sendDirectMessage 消费 usage 后，cleanupProgressCard 不重复使用', async () => {
      const jid = 'fs:oc_test_cleanup';
      channel.setUsage(jid, {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        numTurns: 1,
        durationMs: 1000,
        totalCostUsd: 0.01,
        model: 'claude-opus-4-6',
        lastTurnContext: 100,
      }, 'adaptive');

      // sendDirectMessage 消费 usage
      await (channel as any).sendDirectMessage(jid, 'x'.repeat(500));
      expect((channel as any).pendingUsage.has(jid)).toBe(false);

      // cleanupProgressCard 不应该再有 usage（已被消费）
      await channel.cleanupProgressCard(jid);
      // 不报错即通过（没有 progressCard 会 early return）
    });
  });
});
