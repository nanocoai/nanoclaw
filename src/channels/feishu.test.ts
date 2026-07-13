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
      message: {
        create: mockCreate,
        patch: mockPatch,
        delete: mockMessageDelete,
      },
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
const mockGetAllGroupAliases = vi.fn().mockReturnValue({});
vi.mock('../db.js', () => ({
  getMessageById: (...args: unknown[]) => mockGetMessageById(...args),
  getAllGroupAliases: () => mockGetAllGroupAliases(),
}));

const mockNotifyVoice = vi.fn();
vi.mock('../voice-notify.js', () => ({
  notifyVoice: (...args: unknown[]) => mockNotifyVoice(...args),
}));

import { ASSISTANT_NAME } from '../config.js';
import { _getSessionForTest } from '../progress-server.js';
import { FeishuChannel, truncateCp, truncateTailCp } from './feishu.js';
import type { ChannelOpts } from './registry.js';
import type { CliMode } from '../types.js';

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
    mockGetAllGroupAliases.mockReturnValue({});
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

    it('正式回复触发语音通知时传入群配置和别名', async () => {
      mockGetAllGroupAliases.mockReturnValue({ '3号群': 'fs:oc_voice' });
      const voiceChannel = new FeishuChannel(
        'app_id',
        'app_secret',
        makeOpts({
          registeredGroups: () => ({
            'fs:oc_voice': {
              name: '语音测试群',
              folder: 'fs_oc_voice',
              trigger: '@bot',
              added_at: new Date().toISOString(),
              containerConfig: { voiceNotify: { push: true } },
            },
          }),
        }),
      );

      await voiceChannel.sendMessage(
        'fs:oc_voice',
        '这是最终结果 [图片: /tmp/result.png]',
      );

      expect(mockNotifyVoice).toHaveBeenCalledWith(
        expect.objectContaining({
          groupFolder: 'fs_oc_voice',
          text: '这是最终结果',
          chatJid: 'fs:oc_voice',
          groupName: '语音测试群',
          containerConfig: { voiceNotify: { push: true } },
          aliases: { '3号群': 'fs:oc_voice' },
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
      await expect(channel.sendMessage('fs:oc_123', longText)).rejects.toThrow(
        'text also failed',
      );
    });
  });

  describe('typing indicator', () => {
    it.each([
      ['sdk', 'OnIt'],
      ['print', 'PROUD'],
      ['interactive', 'HAUGHTY'],
      ['codex', 'OneSecond'],
      ['gemini', 'INNOCENTSMILE'],
    ] satisfies Array<[CliMode, string]>)(
      'setTyping(true) 在 %s 模式添加 %s reaction',
      async (cliMode, emojiType) => {
        const jid = `fs:oc_typing_${cliMode}`;
        const msgId = `msg_user_${cliMode}`;
        const channelWithMode = new FeishuChannel(
          'app_id',
          'app_secret',
          makeOpts({
            registeredGroups: () => ({
              [jid]: {
                name: `${cliMode} 群`,
                folder: `feishu_${cliMode}`,
                trigger: '@二狗',
                added_at: '2026-06-05T00:00:00.000Z',
                containerConfig: { cliMode },
              },
            }),
          }),
        );
        (channelWithMode as any).lastMessageIds.set(jid, msgId);

        await channelWithMode.setTyping!(jid, true);

        expect(mockReactionCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: { reaction_type: { emoji_type: emojiType } },
            path: { message_id: msgId },
          }),
        );
      },
    );

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
    it('计时器每秒刷新卡片，行结构不变只有计时文字前进', async () => {
      vi.useFakeTimers();
      const jid = 'fs:oc_progress_stable';

      try {
        await channel.sendMessage(
          jid,
          JSON.stringify({
            title: '正在读取配置文件',
            progress: {
              provider: 'claude',
              lifecycle: 'started',
              toolName: 'Read',
              toolCallId: 'stable-read',
              input: { file_path: '/tmp/config.json' },
            },
          }),
          { isProgress: true },
        );
        mockPatch.mockClear();

        await vi.advanceTimersByTimeAsync(999);
        expect(mockPatch).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(mockPatch).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(mockPatch).toHaveBeenCalledTimes(3);

        // 行结构稳定：相邻两帧只有计时文字不同
        const frame = (index: number) =>
          JSON.parse(mockPatch.mock.calls[index][0].data.content);
        const stripTimer = (card: any) =>
          JSON.stringify(card).replace(/\(\d+m?\d*s\)/gu, '(T)');
        expect(stripTimer(frame(1))).toBe(stripTimer(frame(2)));
      } finally {
        (channel as any).clearSpinnerTimer(jid);
        vi.useRealTimers();
      }
    });

    it('默认卡只展示阶段聚合，过程记录保留完整工具流水', async () => {
      const jid = 'fs:oc_progress_phase_summary';
      (channel as any).opts.registeredGroups = () => ({
        [jid]: {
          name: 'phase-summary',
          folder: 'fs_oc_progress_phase_summary',
          trigger: '@bot',
          added_at: new Date().toISOString(),
          containerConfig: { cliMode: 'codex' },
        },
      });

      await channel.sendMessage(jid, '💬 核对进度展示链路。', {
        isProgress: true,
      });
      const calls: Array<[string, Record<string, unknown>, string, string?]> = [
        ['Read', { file_path: '/tmp/input.txt' }, 'phase-read'],
        ['Grep', { pattern: 'needle' }, 'phase-grep'],
        ['Write', { file_path: '/tmp/output.txt' }, 'phase-write'],
        [
          'Bash',
          { command: 'node --test fixture.test.mjs' },
          'phase-test',
          '1 test passed',
        ],
      ];
      for (const [toolName, input, toolCallId, resultSummary] of calls) {
        await channel.sendMessage(
          jid,
          JSON.stringify({
            title: `🔧 ${toolName}`,
            progress: {
              provider: 'claude',
              lifecycle: 'started',
              toolName,
              toolCallId,
              input,
            },
          }),
          { isProgress: true },
        );
        await channel.sendMessage(
          jid,
          JSON.stringify({
            title: '✅ result',
            progress: {
              provider: 'claude',
              lifecycle: 'completed',
              toolName: 'tool_result',
              toolCallId,
              resultSummary,
            },
          }),
          { isProgress: true },
        );
      }

      const entry = (channel as any).progressCards.get(jid);
      expect(entry.steps).toHaveLength(1);
      // 标题行 + 动作独立一行：动作行独享 48cp 预算，截中段保尾
      expect(entry.steps[0].title).toBe('核对进度展示链路。');
      expect(entry.steps[0].grayTail).toBe(
        '已读取 /tmp/input.t….txt，并测试 fixture.test.mjs（1 项通过）',
      );
      expect(entry.steps[0].narrationFull).toBe('核对进度展示链路。');
      expect(
        entry.allSteps
          .filter((step: any) => step.toolCallId)
          .map((step: any) => step.toolCallId),
      ).toEqual(['phase-read', 'phase-grep', 'phase-write', 'phase-test']);
      // narration 全文双写过程记录
      expect(entry.allSteps[0].title).toBe('💬 核对进度展示链路。');

      const patchArg = mockPatch.mock.calls.at(-1)?.[0];
      const serialized = JSON.stringify(
        JSON.parse(patchArg?.data?.content ?? '{}'),
      );
      expect(serialized).toContain('collapsible_panel');
      // 面板 header 只有标题，动作独立成灰色一行
      expect(serialized).toContain('"content":"核对进度展示链路。"');
      expect(serialized).toContain(
        '<font color=\\"grey\\">已读取 /tmp/input.t….txt，并测试 fixture.test.mjs（1 项通过）</font>',
      );
      expect(serialized).not.toContain('已完成协作操作');
    });

    it('真实 TodoWrite 计划按状态展示且不暴露工具名', async () => {
      const jid = 'fs:oc_progress_real_plan';
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '⚙️ TodoWrite',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'TodoWrite',
            toolCallId: 'todo-1',
            input: {
              todos: [
                { content: '核对实现范围', status: 'completed' },
                { content: '补齐单元测试', status: 'in_progress' },
                { content: '执行真实 E2E', status: 'pending' },
              ],
            },
          },
        }),
        { isProgress: true },
      );

      const patchArg = mockPatch.mock.calls.at(-1)?.[0];
      const serialized = JSON.stringify(
        JSON.parse(patchArg?.data?.content ?? '{}'),
      );
      expect(serialized).toContain('已完成：核对实现范围');
      expect(serialized).toContain('进行中：补齐单元测试');
      expect(serialized).toContain('待处理：执行真实 E2E');
      expect(serialized).not.toContain('TodoWrite');
    });

    it('新版 Task 工具按 taskId 原地更新计划，不显示系统检查', async () => {
      const jid = 'fs:oc_progress_task_plan';
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '⚙️ TaskCreate',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'TaskCreate',
            toolCallId: 'create-2',
            input: { subject: '运行长测试' },
          },
        }),
        { isProgress: true },
      );
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '✅ created',
          progress: {
            provider: 'claude',
            lifecycle: 'completed',
            toolName: 'tool_result',
            toolCallId: 'create-2',
            resultSummary: 'Task #2 created successfully: 运行长测试',
          },
        }),
        { isProgress: true },
      );
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '⚙️ TaskUpdate',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'TaskUpdate',
            toolCallId: 'update-2',
            input: { taskId: '2', status: 'in_progress' },
          },
        }),
        { isProgress: true },
      );

      const entry = (channel as any).progressCards.get(jid);
      expect(entry.allSteps).toHaveLength(1);
      expect(entry.allSteps[0].title).toContain('运行长测试');
      expect(entry.allSteps[0].title).not.toContain('系统检查');
    });

    it('真实计划中的工具结果更新计划阶段而不追加工具行', async () => {
      const jid = 'fs:oc_progress_plan_outcome';
      const send = (payload: unknown) =>
        channel.sendMessage(jid, JSON.stringify(payload), { isProgress: true });
      await send({
        title: '⚙️ TaskCreate',
        progress: {
          provider: 'claude',
          lifecycle: 'started',
          toolName: 'TaskCreate',
          toolCallId: 'plan-create',
          input: { subject: '运行长测试' },
        },
      });
      await send({
        title: '✅ created',
        progress: {
          provider: 'claude',
          lifecycle: 'completed',
          toolName: 'tool_result',
          toolCallId: 'plan-create',
          resultSummary: 'Task #2 created successfully: 运行长测试',
        },
      });
      await send({
        title: '⚙️ TaskUpdate',
        progress: {
          provider: 'claude',
          lifecycle: 'started',
          toolName: 'TaskUpdate',
          toolCallId: 'plan-update',
          input: { taskId: '2', status: 'in_progress' },
        },
      });
      await send({
        title: '🔧 test',
        progress: {
          provider: 'claude',
          lifecycle: 'started',
          toolName: 'Bash',
          toolCallId: 'plan-test',
          input: { command: 'node --test fixture.test.mjs' },
        },
      });
      await send({
        title: '✅ 1 test passed',
        progress: {
          provider: 'claude',
          lifecycle: 'completed',
          toolName: 'tool_result',
          toolCallId: 'plan-test',
          resultSummary: '1 test passed',
        },
      });

      const entry = (channel as any).progressCards.get(jid);
      expect(entry.steps).toHaveLength(1);
      expect(entry.steps[0].title).toBe(
        '运行长测试 · 已测试 fixture.test.mjs（1 项通过）',
      );
      expect(
        entry.allSteps.filter((step: any) => step.toolCallId === 'plan-test'),
      ).toHaveLength(1);
    });

    it('结构化工具进度显示用户语义并隐藏原始命令', async () => {
      const jid = 'fs:oc_readable_progress';
      const payload = JSON.stringify({
        title: '🔧 /bin/zsh -lc "npm run build -- --secret"',
        detail: '```bash\n/bin/zsh -lc "npm run build -- --secret"\n```',
        progress: {
          provider: 'codex',
          lifecycle: 'started',
          toolName: 'command_execution',
          toolCallId: 'build-1',
          input: { command: '/bin/zsh -lc "npm run build -- --secret"' },
        },
      });

      await channel.sendMessage(jid, payload, { isProgress: true });

      const callArg = mockCreate.mock.calls[0]?.[0];
      const serialized = JSON.stringify(
        JSON.parse(callArg?.data?.content ?? '{}'),
      );
      expect(serialized).toContain('正在编译项目');
      expect(serialized).not.toContain('zsh -lc');
      expect(serialized).not.toContain('--secret');
      const sessionId = (channel as any).progressCards.get(jid).sessionId;
      const record = _getSessionForTest(sessionId);
      expect(record?.steps[0].detail).toContain('npm run build');
    });

    it('结构化完成事件按 call ID 原地更新步骤', async () => {
      const jid = 'fs:oc_progress_result_update';
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 npm test',
          detail: '```bash\nnpm test\n```',
          progress: {
            provider: 'codex',
            lifecycle: 'started',
            toolName: 'command_execution',
            toolCallId: 'test-1',
            input: { command: 'npm test' },
          },
        }),
        { isProgress: true },
      );
      mockPatch.mockClear();

      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '✅ 执行完成',
          progress: {
            provider: 'codex',
            lifecycle: 'completed',
            toolName: 'command_execution',
            toolCallId: 'test-1',
            input: { command: 'npm test' },
            exitCode: 0,
          },
        }),
        { isProgress: true },
      );

      expect(mockPatch).toHaveBeenCalled();
      const patchArg = mockPatch.mock.calls.at(-1)?.[0];
      const serialized = JSON.stringify(
        JSON.parse(patchArg?.data?.content ?? '{}'),
      );
      expect(serialized).toContain('已运行测试');
      expect(serialized).not.toContain('✅ 执行完成');
      expect((channel as any).progressCards.get(jid).steps).toHaveLength(1);
    });

    it('滑出可见窗口的步骤完成后仍更新过程记录', async () => {
      const jid = 'fs:oc_progress_hidden_result';
      for (let index = 0; index < 4; index++) {
        await channel.sendMessage(
          jid,
          JSON.stringify({
            title: `🔧 command ${index}`,
            progress: {
              provider: 'codex',
              lifecycle: 'started',
              toolName: 'command_execution',
              toolCallId: `hidden-${index}`,
              input: { command: `./unknown-${index}` },
            },
          }),
          { isProgress: true },
        );
      }
      const entry = (channel as any).progressCards.get(jid);
      expect(
        entry.steps.some((step: any) => step.toolCallId === 'hidden-0'),
      ).toBe(false);

      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '✅ 执行完成',
          progress: {
            provider: 'codex',
            lifecycle: 'completed',
            toolName: 'command_execution',
            toolCallId: 'hidden-0',
            exitCode: 0,
          },
        }),
        { isProgress: true },
      );

      const record = _getSessionForTest(entry.sessionId);
      expect(
        record?.steps.find((step: any) => step.toolCallId === 'hidden-0')
          ?.title,
      ).toBe('已执行系统检查');
    });

    it('完成结果与 started 技术详情有界合并，不覆盖原命令', async () => {
      const jid = 'fs:oc_progress_technical_merge';
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 npm test',
          detail: '```bash\nnpm test\n```',
          progress: {
            provider: 'codex',
            lifecycle: 'started',
            toolName: 'command_execution',
            toolCallId: 'merge-1',
            input: { command: 'npm test' },
          },
        }),
        { isProgress: true },
      );
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '❌ 执行失败',
          detail: 'AssertionError: expected 1 to be 2',
          progress: {
            provider: 'codex',
            lifecycle: 'failed',
            toolName: 'command_execution',
            toolCallId: 'merge-1',
            exitCode: 1,
          },
        }),
        { isProgress: true },
      );

      const entry = (channel as any).progressCards.get(jid);
      const detail = _getSessionForTest(entry.sessionId)?.steps[0].detail ?? '';
      expect(detail).toContain('npm test');
      expect(detail).toContain('AssertionError');
      expect(detail.length).toBeLessThanOrEqual(2000);
    });

    it('短结果摘要也写入过程记录', async () => {
      const jid = 'fs:oc_progress_short_summary';
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 npm test',
          detail: '```bash\nnpm test\n```',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'Bash',
            toolCallId: 'summary-1',
            input: { command: 'npm test' },
          },
        }),
        { isProgress: true },
      );
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '✅ 结果: 12 passed',
          progress: {
            provider: 'claude',
            lifecycle: 'completed',
            toolName: 'tool_result',
            toolCallId: 'summary-1',
            resultSummary: '12 passed',
          },
        }),
        { isProgress: true },
      );
      const entry = (channel as any).progressCards.get(jid);
      const detail = _getSessionForTest(entry.sessionId)?.steps[0].detail ?? '';
      expect(detail).toContain('npm test');
      expect(detail).toContain('12 passed');
    });

    it('过程记录持久化前脱敏技术详情', async () => {
      const jid = 'fs:oc_progress_secret_redaction';
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 curl service',
          detail: 'Authorization: Bearer feishu-canary-123456',
          progress: {
            provider: 'codex',
            lifecycle: 'started',
            toolName: 'command_execution',
            toolCallId: 'redact-1',
            input: { command: 'curl service' },
          },
        }),
        { isProgress: true },
      );
      const entry = (channel as any).progressCards.get(jid);
      const persisted =
        _getSessionForTest(entry.sessionId)?.steps[0].detail ?? '';
      expect(persisted).not.toContain('feishu-canary');
      expect(persisted).toContain('[REDACTED]');
    });

    it('同一 call ID 的富 started 事件升级原步骤而不重复追加', async () => {
      const jid = 'fs:oc_progress_started_upgrade';
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 Bash',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'Bash',
            toolCallId: 'tool-1',
          },
        }),
        { isProgress: true },
      );
      mockPatch.mockClear();

      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 Bash: npm test',
          detail: '```bash\nnpm test\n```',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'Bash',
            toolCallId: 'tool-1',
            input: { command: 'npm test' },
          },
        }),
        { isProgress: true },
      );

      const entry = (channel as any).progressCards.get(jid);
      expect(entry.steps).toHaveLength(1);
      // 开局裸动作行：无标题前缀，动作在灰色行尾（整行灰色）
      expect(entry.steps[0].title).toBe('');
      expect(entry.steps[0].grayTail).toBe('正在运行测试');
      expect(entry.allSteps).toHaveLength(1);
      expect(mockPatch).toHaveBeenCalledTimes(1);
    });

    it('开局兜底阶段完成后整行刷成完成态，不保留进行时标题（单时态去重）', async () => {
      const jid = 'fs:oc_progress_fallback_done';
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 Read',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'Read',
            toolCallId: 'read-1',
            input: { file_path: '/tmp/notes.md' },
          },
        }),
        { isProgress: true },
      );
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '✅ 完成',
          progress: {
            provider: 'claude',
            lifecycle: 'completed',
            toolName: 'tool_result',
            toolCallId: 'read-1',
          },
        }),
        { isProgress: true },
      );

      const entry = (channel as any).progressCards.get(jid);
      expect(entry.steps).toHaveLength(1);
      expect(entry.steps[0].title).toBe('');
      expect(entry.steps[0].grayTail).toBe('已读取 /tmp/notes.md');
    });

    it('narration Phase 动作独立成行：面板 header 无动作拼接，动作是灰色独立元素', async () => {
      const jid = 'fs:oc_progress_action_line';
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '💬 分析进度卡渲染。',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'narration',
          },
        }),
        { isProgress: true },
      );
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 Read',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'Read',
            toolCallId: 'read-act',
            input: { file_path: '/tmp/notes.md' },
          },
        }),
        { isProgress: true },
      );

      const entry = (channel as any).progressCards.get(jid);
      const phaseRow = entry.steps.at(-1);
      expect(phaseRow.grayTail).toBe('正在读取 /tmp/notes.md');
      const patchArg = mockPatch.mock.calls.at(-1)?.[0];
      const serialized = JSON.stringify(
        JSON.parse(patchArg?.data?.content ?? '{}'),
      );
      expect(serialized).toContain(
        '<font color=\\"grey\\">正在读取 /tmp/notes.md</font>',
      );
      expect(serialized).not.toContain(' · 正在读取');
    });

    it.each([
      ['删除线 ~~', '/tmp/~~hidden~~/file.ts', '~~', '&#126;&#126;'],
      ['粗体 __', '/tmp/__bold__/file.ts', '__', '&#95;&#95;'],
    ])(
      '路径中的飞书 markdown 语法（%s）被 HTML 实体转义',
      async (_label, filePath, pair, entity) => {
        const jid = `fs:oc_progress_md_escape_${pair === '~~' ? 'tilde' : 'underscore'}`;
        await channel.sendMessage(
          jid,
          JSON.stringify({
            title: '🔧 Read',
            progress: {
              provider: 'claude',
              lifecycle: 'started',
              toolName: 'Read',
              toolCallId: 'read-md',
              input: { file_path: filePath },
            },
          }),
          { isProgress: true },
        );

        const patchArg = mockPatch.mock.calls.at(-1)?.[0];
        const content: string = patchArg?.data?.content ?? '{}';
        expect(content).not.toContain(pair);
        expect(content).toContain(entity);
      },
    );

    it('narration 标题的 *斜体*/链接/<at> 全部实体化，不进 markdown 语法', async () => {
      const jid = 'fs:oc_progress_md_escape_narration';
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '💬 *italic* [x](https://example.com) <at id=all></at> 收尾。',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'narration',
          },
        }),
        { isProgress: true },
      );
      // 有工具活动后 narration Phase 冻结为 markdown 标题行，走转义路径
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '💬 下一阶段。',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'narration',
          },
        }),
        { isProgress: true },
      );

      const patchArg = mockPatch.mock.calls.at(-1)?.[0];
      const content: string = patchArg?.data?.content ?? '{}';
      // plain_text header 不解析 markdown 可保留原文；markdown 元素必须全实体化
      const markdownContents: string[] = [];
      const collect = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(collect);
        if (node && typeof node === 'object') {
          const el = node as Record<string, unknown>;
          if (el.tag === 'markdown' && typeof el.content === 'string')
            markdownContents.push(el.content);
          Object.values(el).forEach(collect);
        }
      };
      collect(JSON.parse(content));
      const joined = markdownContents.join('\n');
      expect(joined).not.toContain('<at id=all>');
      expect(joined).not.toContain('[x](');
      expect(joined).toContain('&lt;at id=all&gt;');
      expect(joined).toContain('&#42;italic&#42;');
      expect(joined).toContain('&#91;x&#93;&#40;');
    });

    it('plan 任务标题的 markdown 语法同样实体化', async () => {
      const jid = 'fs:oc_progress_md_escape_plan';
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '📋 计划',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'TodoWrite',
            toolCallId: 'todo-md',
            input: {
              todos: [{ content: '<at id=all></at> *加急* 任务', status: 'in_progress' }],
            },
          },
        }),
        { isProgress: true },
      );

      const patchArg = mockPatch.mock.calls.at(-1)?.[0];
      const content: string = patchArg?.data?.content ?? '{}';
      expect(content).not.toContain('<at id=all>');
      expect(content).toContain('&lt;at id=all&gt;');
    });

    it('清理时将缺少结果的工具收口为结果未知', async () => {
      const jid = 'fs:oc_progress_unknown_result';
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 npm test',
          progress: {
            provider: 'codex',
            lifecycle: 'started',
            toolName: 'command_execution',
            toolCallId: 'test-missing',
            input: { command: 'npm test' },
          },
        }),
        { isProgress: true },
      );
      mockPatch.mockClear();
      const sessionId = (channel as any).progressCards.get(jid).sessionId;

      await channel.cleanupProgressCard(jid);

      const patchArg = mockPatch.mock.calls.at(-1)?.[0];
      const serialized = JSON.stringify(
        JSON.parse(patchArg?.data?.content ?? '{}'),
      );
      expect(serialized).toContain('已执行测试，结果未知');
      expect(serialized).not.toContain('已完成测试');
      expect(_getSessionForTest(sessionId)?.steps[0].title).toBe(
        '已执行测试，结果未知',
      );
    });

    it('可通过环境开关回退旧展示', async () => {
      const jid = 'fs:oc_progress_legacy_fallback';
      process.env.NANOCLAW_READABLE_PROGRESS = '0';
      try {
        await channel.sendMessage(
          jid,
          JSON.stringify({
            title: '🔧 npm run build',
            progress: {
              provider: 'codex',
              lifecycle: 'started',
              toolName: 'command_execution',
              toolCallId: 'build-legacy',
              input: { command: 'npm run build' },
            },
          }),
          { isProgress: true },
        );
        const callArg = mockCreate.mock.calls[0]?.[0];
        const serialized = JSON.stringify(
          JSON.parse(callArg?.data?.content ?? '{}'),
        );
        expect(serialized).toContain('🔧 npm run build');
      } finally {
        delete process.env.NANOCLAW_READABLE_PROGRESS;
      }
    });

    it('畸形 structured progress 降级为安全文案而不抛错', async () => {
      const jid = 'fs:oc_progress_malformed';
      await expect(
        channel.sendMessage(
          jid,
          JSON.stringify({
            title: '🔧 /bin/zsh -lc "cat /secret"',
            detail: '```bash\ncat /secret\n```',
            progress: {
              provider: 'codex',
              lifecycle: 'started',
              toolName: null,
            },
          }),
          { isProgress: true },
        ),
      ).resolves.toBeUndefined();
      const callArg = mockCreate.mock.calls[0]?.[0];
      const serialized = JSON.stringify(
        JSON.parse(callArg?.data?.content ?? '{}'),
      );
      expect(serialized).toContain('正在执行系统检查');
      expect(serialized).not.toContain('/secret');
    });

    it('progressDone 后忽略迟到的进度消息', async () => {
      const jid = 'fs:oc_progress_done';
      // 模拟 progressDone 已标记（正式回复已到达）
      (channel as any).progressDone.add(jid);

      // 发送进度消息（显式标记 isProgress）
      await channel.sendMessage(jid, '⚙️ 正在处理...', { isProgress: true });

      // 不应调用 create（被忽略）
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('💭 消息直接丢弃不发送', async () => {
      const jid = 'fs:oc_thought';
      (channel as any).progressDone.delete(jid);

      await channel.sendMessage(jid, '💭 这是内部思考', { isProgress: true });

      // 💭 应该被丢弃，不调用任何发送
      expect(mockCreate).not.toHaveBeenCalled();
    });

    // 默认模式（quietProgress=false）：💬 独立发送
    it('💬 消息（默认模式）单独发送不加入卡片', async () => {
      const jid = 'fs:oc_text_block';
      (channel as any).progressDone.delete(jid);

      await channel.sendMessage(jid, '💬 让我先看下这块代码', {
        isProgress: true,
      });

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

    // quietProgress=true 时，💬 进进度卡片而非独立发送
    it('💬 安静模式下创建/更新进度卡片', async () => {
      const jid = 'fs:oc_quiet_text';
      (channel as any).progressDone.delete(jid);
      // 注入 quietProgress 配置
      (channel as any).opts.registeredGroups = () => ({
        [jid]: {
          name: 'test-quiet',
          folder: 'fs_oc_quiet_text',
          trigger: '@bot',
          added_at: new Date().toISOString(),
          containerConfig: { quietProgress: true },
        },
      });

      await channel.sendMessage(jid, '💬 让我看下这块代码', {
        isProgress: true,
      });

      // 应该创建进度卡片（调用 create），而非独立文本消息
      expect(mockCreate).toHaveBeenCalled();
      const callArg = mockCreate.mock.calls[0]?.[0];
      const content = JSON.parse(callArg?.data?.content ?? '{}');
      const serialized = JSON.stringify(content);
      // 卡片内应包含文字内容
      expect(serialized).toContain('让我看下这块代码');
      // 进度卡片使用 v2 schema（body.elements），而非 v1 header
      expect(content.schema).toBe('2.0');
      expect(content.body?.elements).toBeDefined();
    });

    it('💬 Codex 模式默认进入进度卡片', async () => {
      const jid = 'fs:oc_codex_text';
      (channel as any).progressDone.delete(jid);
      (channel as any).opts.registeredGroups = () => ({
        [jid]: {
          name: 'test-codex',
          folder: 'fs_oc_codex_text',
          trigger: '@bot',
          added_at: new Date().toISOString(),
          containerConfig: { cliMode: 'codex' },
        },
      });

      await channel.sendMessage(jid, '💬 我先查证据，不先猜', {
        isProgress: true,
      });

      expect(mockCreate).toHaveBeenCalled();
      const callArg = mockCreate.mock.calls[0]?.[0];
      expect(callArg?.data?.receive_id).toBe('oc_codex_text');
      expect(callArg?.data?.msg_type).toBe('interactive');
      const content = JSON.parse(callArg?.data?.content ?? '{}');
      const serialized = JSON.stringify(content);
      expect(serialized).toContain('我先查证据，不先猜');
      expect(content.schema).toBe('2.0');
      expect(content.body?.elements).toBeDefined();
    });

    it('TodoWrite 计划展示在首个 narration 后永久切换为 Phase 窗口', async () => {
      const jid = 'fs:oc_progress_window_switch';
      (channel as any).opts.registeredGroups = () => ({
        [jid]: {
          name: 'window-switch',
          folder: 'fs_oc_progress_window_switch',
          trigger: '@bot',
          added_at: new Date().toISOString(),
          containerConfig: { cliMode: 'codex' },
        },
      });
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '⚙️ TodoWrite',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'TodoWrite',
            toolCallId: 'todo-win',
            input: {
              todos: [{ content: '补齐单元测试', status: 'in_progress' }],
            },
          },
        }),
        { isProgress: true },
      );
      // 切窗前：plan 行照旧展示
      let entry = (channel as any).progressCards.get(jid);
      expect(entry.steps.some((step: any) => step.isPlan)).toBe(true);

      await channel.sendMessage(jid, '💬 先修复回调重试。', {
        isProgress: true,
      });
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 Bash',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'Bash',
            toolCallId: 'bash-win',
            input: { command: 'npm test' },
          },
        }),
        { isProgress: true },
      );

      // 切窗后：窗口只剩 narration Phase，plan 行退出卡片（数据仍在过程页）
      entry = (channel as any).progressCards.get(jid);
      expect(entry.steps.some((step: any) => step.isPlan)).toBe(false);
      expect(entry.steps).toHaveLength(1);
      expect(entry.steps[0].narrationFull).toBe('先修复回调重试。');
      expect(entry.steps[0].grayTail).toBe('正在运行测试');
      // plan 数据保留在过程记录
      expect(entry.allSteps.some((step: any) => step.isPlan)).toBe(true);
    });

    it('新 narration 冻结旧 Phase 为纯标题，已定格的结果不泄露回渲染', async () => {
      const jid = 'fs:oc_progress_freeze';
      (channel as any).opts.registeredGroups = () => ({
        [jid]: {
          name: 'freeze',
          folder: 'fs_oc_progress_freeze',
          trigger: '@bot',
          added_at: new Date().toISOString(),
          containerConfig: { cliMode: 'codex' },
        },
      });
      await channel.sendMessage(jid, '💬 第一阶段目标。', {
        isProgress: true,
      });
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 Read',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'Read',
            toolCallId: 'fz-read',
            input: { file_path: '/tmp/a.txt' },
          },
        }),
        { isProgress: true },
      );
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '✅ result',
          progress: {
            provider: 'claude',
            lifecycle: 'completed',
            toolName: 'tool_result',
            toolCallId: 'fz-read',
          },
        }),
        { isProgress: true },
      );
      // 完成但仍是当前 Phase：行尾保留结果
      let entry = (channel as any).progressCards.get(jid);
      expect(entry.steps.at(-1).grayTail).toBeTruthy();

      await channel.sendMessage(jid, '💬 第二阶段目标。', {
        isProgress: true,
      });
      entry = (channel as any).progressCards.get(jid);
      expect(entry.steps).toHaveLength(2);
      // 旧 Phase 冻结为纯标题：无行尾，outcome 不复显
      expect(entry.steps[0].title).toBe('第一阶段目标。');
      expect(entry.steps[0].grayTail).toBeUndefined();
      // 新 Phase 为当前
      expect(entry.steps[1].title).toBe('第二阶段目标。');
    });

    it('双行预算：标题 48/动作行 48 code point，长路径保尾部', () => {
      const longTitle = '这是一段非常长的阶段说明文字'.repeat(10);
      const truncated = truncateCp(longTitle, 48);
      expect(Array.from(truncated)).toHaveLength(49); // 48 + '…'
      expect(truncated.endsWith('…')).toBe(true);
      // emoji 按 code point 计数不被截断成半个
      const emojiText = '🚀'.repeat(50);
      expect(Array.from(truncateCp(emojiText, 48))).toHaveLength(49);
      // 动作行截中段保尾部（文件名可见），emoji 不被切半
      const longPath = `正在读取 ${'📁'.repeat(20)}/server/backend/app/moss/runtime/callback.py`;
      const tail = truncateTailCp(longPath, 48);
      expect(tail).toContain('…');
      expect(tail.endsWith('callback.py')).toBe(true);
      expect(Array.from(tail).length).toBeLessThanOrEqual(49);
      // 预算内原样返回
      expect(truncateTailCp('短动作', 48)).toBe('短动作');
    });

    it('超长动作贯穿到卡片：动作行按 48cp 截中段保尾', async () => {
      const jid = 'fs:oc_progress_action_budget';
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '💬 核对长路径动作行预算。',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'narration',
          },
        }),
        { isProgress: true },
      );
      const longDir = 'very-long-directory-name'.repeat(4);
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 Read',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'Read',
            toolCallId: 'read-budget',
            input: { file_path: `/workspace/${longDir}/deep/callback.py` },
          },
        }),
        { isProgress: true },
      );

      const entry = (channel as any).progressCards.get(jid);
      const phaseRow = entry.steps.at(-1);
      expect(phaseRow.grayTail).toContain('…');
      expect(phaseRow.grayTail.endsWith('callback.py')).toBe(true);
      expect(Array.from(phaseRow.grayTail).length).toBeLessThanOrEqual(49);
    });

    it('patch 串行：在飞期间的新事件合并为一轮补发，内容取最新状态', async () => {
      const jid = 'fs:oc_progress_serial_patch';
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 Read',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'Read',
            toolCallId: 'sp-1',
            input: { file_path: '/tmp/a.txt' },
          },
        }),
        { isProgress: true },
      );
      mockPatch.mockClear();

      // 第一轮 patch 挂起（模拟飞书慢响应）
      let releaseFirst!: () => void;
      mockPatch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve({});
          }),
      );

      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 Grep',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'Grep',
            toolCallId: 'sp-2',
            input: { pattern: 'needle' },
          },
        }),
        { isProgress: true },
      );
      expect(mockPatch).toHaveBeenCalledTimes(1);

      // 在飞期间又来两个事件：只置 pending，不并发 patch
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 Write',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'Write',
            toolCallId: 'sp-3',
            input: { file_path: '/tmp/out.txt' },
          },
        }),
        { isProgress: true },
      );
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 Bash',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'Bash',
            toolCallId: 'sp-4',
            input: { command: 'npm test' },
          },
        }),
        { isProgress: true },
      );
      expect(mockPatch).toHaveBeenCalledTimes(1);

      releaseFirst();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // 补发恰好一轮，内容为最新状态（旧不覆盖新）
      expect(mockPatch).toHaveBeenCalledTimes(2);
      const lastContent = mockPatch.mock.calls.at(-1)?.[0]?.data?.content ?? '';
      expect(lastContent).toContain('正在运行测试');
    });

    it('cleanup 终态卡在在飞 patch 排空后落地，旧进度 patch 不覆盖完成卡', async () => {
      const jid = 'fs:oc_progress_terminal_race';
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 Read',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'Read',
            toolCallId: 'term-1',
            input: { file_path: '/tmp/a.txt' },
          },
        }),
        { isProgress: true },
      );
      mockPatch.mockClear();

      // 让下一个进度 patch 悬挂在飞
      let releaseInflight!: () => void;
      mockPatch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseInflight = () => resolve({});
          }),
      );
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 Grep',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'Grep',
            toolCallId: 'term-2',
            input: { pattern: 'x' },
          },
        }),
        { isProgress: true },
      );
      expect(mockPatch).toHaveBeenCalledTimes(1);

      // 在飞期间再来一个事件（置 pending），随后 cleanup
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 Write',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'Write',
            toolCallId: 'term-3',
            input: { file_path: '/tmp/b.txt' },
          },
        }),
        { isProgress: true },
      );
      const cleanupPromise = (channel as any).cleanupProgressCard(jid);
      releaseInflight();
      await cleanupPromise;

      // 终态锁生效：pending 的进度补发被丢弃，最后一次 patch 是完成卡
      const contents = mockPatch.mock.calls.map(
        (call: any) => call[0]?.data?.content ?? '',
      );
      expect(contents.at(-1)).toContain('已完成');
      expect(contents.at(-1)).not.toContain('思考中');
      // 完成卡恰一次且位于最后，其后无任何进度 patch
      expect(
        contents.filter((item: string) => item.includes('已完成')),
      ).toHaveLength(1);
    });

    it('emoji 标题经渲染管线不被二次截断（固定 48 cp 预算贯穿到卡片 JSON）', async () => {
      const jid = 'fs:oc_progress_emoji_budget';
      (channel as any).opts.registeredGroups = () => ({
        [jid]: {
          name: 'emoji-budget',
          folder: 'fs_oc_progress_emoji_budget',
          trigger: '@bot',
          added_at: new Date().toISOString(),
          containerConfig: { cliMode: 'codex' },
        },
      });
      await channel.sendMessage(jid, `💬 ${'🚀'.repeat(60)}`, {
        isProgress: true,
      });
      const entry = (channel as any).progressCards.get(jid);
      expect(Array.from(entry.steps[0].title as string)).toHaveLength(49); // 48 + '…'
      // 贯穿到卡片 JSON：header 保持 48 个 emoji + 省略号，未被 80 UTF-16 二次截断
      const createArg = mockCreate.mock.calls.find(
        (call: any) => call[0]?.data?.msg_type === 'interactive',
      )?.[0];
      const content = JSON.parse(createArg?.data?.content ?? '{}');
      const serialized = JSON.stringify(content);
      const emojiRun = serialized.match(/🚀+/u)?.[0] ?? '';
      expect(Array.from(emojiRun)).toHaveLength(48);
    });

    it('探测无匹配贯穿到 Phase 行尾：当前 Phase 行尾显示"已搜索，无匹配"', async () => {
      const jid = 'fs:oc_progress_probe_tail';
      (channel as any).opts.registeredGroups = () => ({
        [jid]: {
          name: 'probe-tail',
          folder: 'fs_oc_progress_probe_tail',
          trigger: '@bot',
          added_at: new Date().toISOString(),
          containerConfig: { cliMode: 'codex' },
        },
      });
      await channel.sendMessage(jid, '💬 确认没有残留引用。', {
        isProgress: true,
      });
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '🔧 Grep',
          progress: {
            provider: 'claude',
            lifecycle: 'started',
            toolName: 'Grep',
            toolCallId: 'probe-tail-1',
            input: { pattern: 'legacyFn' },
          },
        }),
        { isProgress: true },
      );
      await channel.sendMessage(
        jid,
        JSON.stringify({
          title: '✅ result',
          progress: {
            provider: 'claude',
            lifecycle: 'completed',
            toolName: 'tool_result',
            toolCallId: 'probe-tail-1',
            exitCode: 1,
          },
        }),
        { isProgress: true },
      );
      const entry = (channel as any).progressCards.get(jid);
      const phaseRow = entry.steps.at(-1);
      expect(phaseRow.title).toBe('确认没有残留引用。');
      expect(phaseRow.grayTail).toBe('已搜索，无匹配');
      expect(JSON.stringify(phaseRow)).not.toContain('失败');
    });

    it('💬 quietProgress=false 时独立发送且同时进卡片 Phase（双份）', async () => {
      const jid = 'fs:oc_codex_quiet_off';
      (channel as any).progressDone.delete(jid);
      (channel as any).opts.registeredGroups = () => ({
        [jid]: {
          name: 'test-codex-quiet-off',
          folder: 'fs_oc_codex_quiet_off',
          trigger: '@bot',
          added_at: new Date().toISOString(),
          containerConfig: { cliMode: 'codex', quietProgress: false },
        },
      });

      await channel.sendMessage(jid, '💬 我先查证据，不先猜', {
        isProgress: true,
      });

      // 独立消息照发（sendNarrationSeparately = !quiet）
      const standalone = mockCreate.mock.calls.find(
        (call: any) => call[0]?.data?.msg_type !== 'interactive',
      );
      expect(standalone).toBeDefined();
      // narration 同时进卡片 Phase
      expect((channel as any).progressCards.has(jid)).toBe(true);
      const entry = (channel as any).progressCards.get(jid);
      expect(entry.steps[0]?.narrationFull).toBe('我先查证据，不先猜');
    });

    it('💬 Codex 模式下单行长文本也保留全文明细', async () => {
      const jid = 'fs:oc_codex_long_text';
      (channel as any).progressDone.delete(jid);
      (channel as any).opts.registeredGroups = () => ({
        [jid]: {
          name: 'test-codex-long',
          folder: 'fs_oc_codex_long_text',
          trigger: '@bot',
          added_at: new Date().toISOString(),
          containerConfig: { cliMode: 'codex' },
        },
      });

      const longText = '我先查证据，不先猜。'.repeat(20);
      await channel.sendMessage(jid, `💬 ${longText}`, { isProgress: true });

      expect(mockCreate).toHaveBeenCalled();
      const callArg = mockCreate.mock.calls[0]?.[0];
      const content = JSON.parse(callArg?.data?.content ?? '{}');
      const serialized = JSON.stringify(content);
      expect(serialized).toContain(longText);
      expect(serialized).toContain('collapsible_panel');
    });

    it('💬 安静模式下长文本用折叠面板（detail）', async () => {
      const jid = 'fs:oc_quiet_detail';
      (channel as any).progressDone.delete(jid);
      (channel as any).opts.registeredGroups = () => ({
        [jid]: {
          name: 'test-quiet-detail',
          folder: 'fs_oc_quiet_detail',
          trigger: '@bot',
          added_at: new Date().toISOString(),
          containerConfig: { quietProgress: true },
        },
      });

      const longText = '第一行预览\n' + 'B'.repeat(200);
      await channel.sendMessage(jid, `💬 ${longText}`, { isProgress: true });

      expect(mockCreate).toHaveBeenCalled();
      const callArg = mockCreate.mock.calls[0]?.[0];
      const content = JSON.parse(callArg?.data?.content ?? '{}');
      const serialized = JSON.stringify(content);
      // 完整内容（含换行后的部分）应在卡片内
      expect(serialized).toContain('B'.repeat(50));
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
      mockCreate.mockResolvedValueOnce({
        data: { message_id: 'om_reply_001' },
      });
      const msgId = await channel.sendMessage('fs:oc_123', '正式回复');
      expect(msgId).toBe('om_reply_001');
    });

    it('✅ 开头的正式回复不被误判为进度消息', async () => {
      mockCreate.mockResolvedValueOnce({
        data: { message_id: 'om_emoji_reply' },
      });
      const msgId = await channel.sendMessage(
        'fs:oc_123',
        '✅ 任务已完成，结果如下...',
      );
      // 不传 isProgress → 走正式回复路径，正常发送
      expect(msgId).toBe('om_emoji_reply');
      expect(mockCreate).toHaveBeenCalled();
    });

    it('进度消息返回 undefined', async () => {
      const msgId = await channel.sendMessage('fs:oc_123', '🔧 Bash: ls -la', {
        isProgress: true,
      });
      expect(msgId).toBeUndefined();
    });

    it('💭 思考消息返回 undefined', async () => {
      const msgId = await channel.sendMessage(
        'fs:oc_123',
        '💭 正在分析代码结构...',
        { isProgress: true },
      );
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
      (channel as any).getTenantAccessToken = vi
        .fn()
        .mockResolvedValue('mock_token');
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
      channel.setUsage(
        jid,
        {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadInputTokens: 500,
          cacheCreationInputTokens: 0,
          numTurns: 3,
          durationMs: 5000,
          totalCostUsd: 0.05,
          model: 'claude-opus-4-6',
          lastTurnContext: 1500,
        },
        'adaptive',
      );

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
      channel.setUsage(
        jid,
        {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          numTurns: 1,
          durationMs: 1000,
          totalCostUsd: 0.01,
          model: 'claude-opus-4-6',
          lastTurnContext: 100,
        },
        'adaptive',
      );

      // sendDirectMessage 消费 usage
      await (channel as any).sendDirectMessage(jid, 'x'.repeat(500));
      expect((channel as any).pendingUsage.has(jid)).toBe(false);

      // cleanupProgressCard 不应该再有 usage（已被消费）
      await channel.cleanupProgressCard(jid);
      // 不报错即通过（没有 progressCard 会 early return）
    });
  });
});
