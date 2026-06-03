import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- mocks ----

const mockGetAllChats = vi.fn(() => [] as any[]);

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  STORE_DIR: '/tmp/nanoclaw-test-store',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  TIMEZONE: 'Asia/Shanghai',
  ASSISTANT_NAME: 'test-bot',
  MAX_MESSAGES_PER_PROMPT: 20,
  IDLE_TIMEOUT: 1800000,
  DEFAULT_TRIGGER: '@test-bot',
  TRIGGER_PATTERN: /@test-bot(?=[\s\p{P}]|$)/iu,
  getTriggerPattern: (trigger?: string) =>
    new RegExp(
      `${(trigger || '@test-bot').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s\\p{P}]|$)`,
      'iu',
    ),
  buildTriggerPattern: (trigger: string) =>
    new RegExp(
      `${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s\\p{P}]|$)`,
      'iu',
    ),
  ONECLI_URL: 'http://localhost:10254',
  CHAT_INDEX_ENABLED: false,
  envConfig: {},
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./db.js', () => ({
  initDatabase: vi.fn(),
  getAllChats: () => mockGetAllChats(),
  getMessagesSince: vi.fn(() => []),
  upsertChat: vi.fn(),
  getRotateEnabled: vi.fn(() => false),
  getRotateIndex: vi.fn(() => 0),
  getLastRotateAt: vi.fn(() => null),
  setRotateIndex: vi.fn(),
  setLastRotateAt: vi.fn(),
  getChatName: vi.fn(),
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    `/tmp/nanoclaw-test-groups/${folder}`,
  resolveGroupIpcPath: (folder: string) =>
    `/tmp/nanoclaw-test-data/ipc/${folder}`,
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    getContainerConfig = vi.fn().mockResolvedValue({ env: {}, caCertificate: '' });
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    ensureAgent = vi.fn().mockResolvedValue({ id: 'test', created: false });
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => '{}'),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
    },
  };
});

import {
  parseModelPrefix,
  getAvailableGroups,
  _setRegisteredGroups,
  decideThinkingOnlyAction,
} from './index.js';
import { buildTriggerPattern } from './config.js';

// ---- parseModelPrefix ----

describe('parseModelPrefix', () => {
  it('"!! msg" → Sonnet adaptive', () => {
    const r = parseModelPrefix('!! hello world');
    expect(r).not.toBeNull();
    expect(r!.override).toEqual({
      model: 'claude-sonnet-4-6',
      thinking: 'adaptive',
    });
    expect(r!.cleanedText).toBe('hello world');
  });

  it('"! msg" → Sonnet disabled', () => {
    const r = parseModelPrefix('! quick answer');
    expect(r).not.toBeNull();
    expect(r!.override).toEqual({
      model: 'claude-sonnet-4-6',
      thinking: 'disabled',
    });
    expect(r!.cleanedText).toBe('quick answer');
  });

  it('"+ msg" → Opus adaptive', () => {
    const r = parseModelPrefix('+ deep thought');
    expect(r).not.toBeNull();
    expect(r!.override).toEqual({
      model: 'claude-opus-4-6',
      thinking: 'adaptive',
    });
    expect(r!.cleanedText).toBe('deep thought');
  });

  it('"~ msg" → disabled（无 model）', () => {
    const r = parseModelPrefix('~ no thinking');
    expect(r).not.toBeNull();
    expect(r!.override).toEqual({ thinking: 'disabled' });
    expect(r!.cleanedText).toBe('no thinking');
  });

  it('全角 "！！ msg" → 同 "!!"', () => {
    const r = parseModelPrefix('！！ 深度思考');
    expect(r).not.toBeNull();
    expect(r!.override.model).toBe('claude-sonnet-4-6');
    expect(r!.override.thinking).toBe('adaptive');
    expect(r!.cleanedText).toBe('深度思考');
  });

  it('全角 "！ msg" → 同 "!"', () => {
    const r = parseModelPrefix('！ 快速');
    expect(r).not.toBeNull();
    expect(r!.override.model).toBe('claude-sonnet-4-6');
    expect(r!.override.thinking).toBe('disabled');
    expect(r!.cleanedText).toBe('快速');
  });

  it('混合 "!！ msg" → 同 "!!"', () => {
    const r = parseModelPrefix('!！ mixed');
    expect(r).not.toBeNull();
    expect(r!.override.thinking).toBe('adaptive');
  });

  it('无前缀 → null', () => {
    expect(parseModelPrefix('普通消息')).toBeNull();
  });

  it('空字符串 → null', () => {
    expect(parseModelPrefix('')).toBeNull();
  });

  it('只有前缀没有内容 "! " → null（trim 后无空格）', () => {
    // "! " trim 后变成 "!"，不含空格，不触发
    expect(parseModelPrefix('! ')).toBeNull();
  });

  it('"! a" 前缀+单字符 → 正常触发', () => {
    const r = parseModelPrefix('! a');
    expect(r).not.toBeNull();
    expect(r!.override.model).toBe('claude-sonnet-4-6');
    expect(r!.cleanedText).toBe('a');
  });

  it('前缀后无空格 "!msg" → null（不触发）', () => {
    expect(parseModelPrefix('!msg')).toBeNull();
  });

  it('"!!msg" 无空格 → null', () => {
    expect(parseModelPrefix('!!msg')).toBeNull();
  });

  it('"+" 无空格 → null', () => {
    expect(parseModelPrefix('+msg')).toBeNull();
  });

  it('"~" 无空格 → null', () => {
    expect(parseModelPrefix('~msg')).toBeNull();
  });

  it('前导空白被 trim 后仍匹配', () => {
    const r = parseModelPrefix('  !! spaced');
    expect(r).not.toBeNull();
    expect(r!.override.thinking).toBe('adaptive');
  });
});

// ---- getAvailableGroups ----

describe('getAvailableGroups', () => {
  beforeEach(() => {
    mockGetAllChats.mockReturnValue([]);
    _setRegisteredGroups({});
  });

  it('过滤 __group_sync__ 键', () => {
    mockGetAllChats.mockReturnValue([
      { jid: '__group_sync__', name: 'sync', last_message_time: '2026-01-01', is_group: true },
      { jid: 'fs:oc_real', name: 'real', last_message_time: '2026-01-01', is_group: true },
    ]);
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('fs:oc_real');
  });

  it('只返回 is_group 为 true 的', () => {
    mockGetAllChats.mockReturnValue([
      { jid: 'fs:oc_g1', name: 'group', last_message_time: '2026-01-01', is_group: true },
      { jid: 'fs:ou_priv', name: 'private', last_message_time: '2026-01-01', is_group: false },
    ]);
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('fs:oc_g1');
  });

  it('空输入返回空数组', () => {
    mockGetAllChats.mockReturnValue([]);
    expect(getAvailableGroups()).toEqual([]);
  });

  it('isRegistered 正确标注', () => {
    mockGetAllChats.mockReturnValue([
      { jid: 'fs:oc_reg', name: '注册群', last_message_time: '2026-01-01', is_group: true },
      { jid: 'fs:oc_unreg', name: '未注册', last_message_time: '2026-01-01', is_group: true },
    ]);
    _setRegisteredGroups({
      'fs:oc_reg': { name: '注册群', folder: 'reg', jid: 'fs:oc_reg' } as any,
    });
    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'fs:oc_reg');
    const unreg = groups.find((g) => g.jid === 'fs:oc_unreg');
    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });
});

// ---- buildTriggerPattern ----
// 注意：这里测的是 mock 中的 buildTriggerPattern（与真实 config.ts 实现逻辑一致）。
// 目的是验证正则模式本身的行为，不是对 config 模块的集成测试。

describe('buildTriggerPattern', () => {
  it('正则 trigger 匹配成功', () => {
    const pattern = buildTriggerPattern('@大狗');
    expect(pattern.test('@大狗 你好')).toBe(true);
  });

  it('结尾 @大狗 也匹配', () => {
    const pattern = buildTriggerPattern('@大狗');
    expect(pattern.test('你好 @大狗')).toBe(true);
  });

  it('后面无空格/标点也匹配（行尾）', () => {
    const pattern = buildTriggerPattern('@大狗');
    expect(pattern.test('@大狗')).toBe(true);
  });
});

// ---- decideThinkingOnlyAction ----

describe('decideThinkingOnlyAction', () => {
  const base = {
    hasText: false,
    textSentToUser: false,
    outputTokens: 100,
    retryCount: 0,
    maxRetries: 1,
  };

  it('thinking-only 且未重试过 → retry', () => {
    expect(decideThinkingOnlyAction(base)).toBe('retry');
  });

  it('thinking-only 且已达上限 → giveup（防死循环）', () => {
    expect(decideThinkingOnlyAction({ ...base, retryCount: 1 })).toBe('giveup');
  });

  it('thinking-only 且超过上限 → giveup', () => {
    expect(decideThinkingOnlyAction({ ...base, retryCount: 5 })).toBe('giveup');
  });

  it('有 text 输出 → none（正常结果，不重试）', () => {
    expect(decideThinkingOnlyAction({ ...base, hasText: true })).toBe('none');
  });

  it('本轮已发过真实文本（CLI 流式）→ none，即使 final result 无 text', () => {
    expect(
      decideThinkingOnlyAction({ ...base, textSentToUser: true }),
    ).toBe('none');
  });

  it('只发过工具进度卡、没发真实文本 → retry', () => {
    // 回归保护：工具卡不能算用户已收到回复，否则会跳过 thinking-only 重试，
    // 最后只发 usage-only 空卡。
    expect(
      decideThinkingOnlyAction({ ...base, textSentToUser: false }),
    ).toBe('retry');
  });

  it('outputTokens 为 0 → none（空 turn，非 thinking-only）', () => {
    expect(decideThinkingOnlyAction({ ...base, outputTokens: 0 })).toBe('none');
  });

  it('maxRetries=0 时首次就 giveup（禁用重试）', () => {
    expect(
      decideThinkingOnlyAction({ ...base, retryCount: 0, maxRetries: 0 }),
    ).toBe('giveup');
  });

  it('边界：retryCount 正好等于 maxRetries → giveup', () => {
    expect(
      decideThinkingOnlyAction({ ...base, retryCount: 2, maxRetries: 2 }),
    ).toBe('giveup');
  });

  it('边界：retryCount 比 maxRetries 小 1 → retry', () => {
    expect(
      decideThinkingOnlyAction({ ...base, retryCount: 1, maxRetries: 2 }),
    ).toBe('retry');
  });

  it('混合态：hasText 且 textSentToUser 都为 true → none', () => {
    expect(
      decideThinkingOnlyAction({
        ...base,
        hasText: true,
        textSentToUser: true,
      }),
    ).toBe('none');
  });
});
