import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _initTestDatabase,
  getRotateEnabled,
  setRotateEnabled,
  getRotateIndex,
  setRotateIndex,
  setLastRotateAt,
} from './db.js';
import { detectRateLimit, getSecretCount, rotateAccount } from './container-runner.js';

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  ONECLI_URL: 'http://localhost:10254',
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
    },
  };
});

// Mock env
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    `/tmp/nanoclaw-test-groups/${folder}`,
  resolveGroupIpcPath: (folder: string) =>
    `/tmp/nanoclaw-test-data/ipc/${folder}`,
}));

// Mock child_process — 控制 execSync 的返回值
const mockExecSync = vi.fn();
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => mockExecSync(...args),
    spawn: vi.fn(),
  };
});

// --- detectRateLimit 测试 ---

describe('detectRateLimit', () => {
  it('匹配 429 状态码', () => {
    expect(detectRateLimit('Error: 429 Too Many Requests')).toBe(true);
  });

  it('匹配 rate_limit_error', () => {
    expect(
      detectRateLimit('{"type":"error","error":{"type":"rate_limit_error"}}'),
    ).toBe(true);
  });

  it('匹配 rate limit（带空格）', () => {
    expect(detectRateLimit('Rate limit exceeded')).toBe(true);
  });

  it('匹配 overloaded', () => {
    expect(
      detectRateLimit('{"type":"error","error":{"type":"overloaded_error"}}'),
    ).toBe(true);
  });

  it('匹配 quota exceeded', () => {
    expect(detectRateLimit('API quota exceeded for this billing period')).toBe(
      true,
    );
  });

  it('匹配 too many requests', () => {
    expect(detectRateLimit('too many requests, please slow down')).toBe(true);
  });

  it('不匹配普通错误', () => {
    expect(detectRateLimit('TypeError: Cannot read property')).toBe(false);
  });

  it('不匹配空字符串', () => {
    expect(detectRateLimit('')).toBe(false);
  });

  it('匹配 stderr 中的混合输出', () => {
    const stderr = `[debug] starting container\nError: 429 rate_limit_error\n[debug] exiting`;
    expect(detectRateLimit(stderr)).toBe(true);
  });

  it('匹配 Claude Code 假成功限流 "You\'ve hit your limit"', () => {
    expect(detectRateLimit("You've hit your limit · resets 6pm")).toBe(true);
  });

  it('匹配 smart quote 变体 "You\u2019ve hit your limit"', () => {
    expect(detectRateLimit('You\u2019ve hit your limit')).toBe(true);
  });

  it('匹配 "You have hit your usage limit" 变体', () => {
    expect(detectRateLimit('You have hit your usage limit')).toBe(true);
  });

  // --- 误匹配防御测试（回归 bug：正常对话被误判为限流） ---

  it('不误匹配单独的 429（如 bug 编号）', () => {
    expect(detectRateLimit('修复了 bug 429')).toBe(false);
    expect(detectRateLimit('error code 4290 不是限流')).toBe(false);
  });

  it('不误匹配单独讨论 rate limit 话题', () => {
    expect(detectRateLimit('我们来讨论一下 rate limit 的设计')).toBe(false);
    expect(
      detectRateLimit('rate-limit 检测的正则需要更严格'),
    ).toBe(false);
  });

  it('不误匹配讨论 hit your limit 话题', () => {
    // 正则要求 "hit your (usage )?limit"，"the" 不匹配
    expect(
      detectRateLimit('如果用户触发 hit the limit 场景'),
    ).toBe(false);
  });

  it('不误匹配讨论 overloaded / quota 普通语义', () => {
    expect(detectRateLimit('服务器看起来 overloaded 了')).toBe(false);
    expect(detectRateLimit('quota 机制是啥')).toBe(false);
  });

  it('匹配明确的 HTTP 429 错误', () => {
    expect(detectRateLimit('HTTP 429 error returned')).toBe(true);
    expect(detectRateLimit('status: 429')).toBe(true);
  });
});

// --- DB 持久化测试 ---

describe('account_rotate_config DB', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('默认 rotateEnabled = true（默认开启）', () => {
    expect(getRotateEnabled()).toBe(true);
  });

  it('setRotateEnabled → getRotateEnabled 保持一致', () => {
    setRotateEnabled(true);
    expect(getRotateEnabled()).toBe(true);
    setRotateEnabled(false);
    expect(getRotateEnabled()).toBe(false);
  });

  it('默认 rotateIndex = 0', () => {
    expect(getRotateIndex()).toBe(0);
  });

  it('setRotateIndex → getRotateIndex 保持一致', () => {
    setRotateIndex(3);
    expect(getRotateIndex()).toBe(3);
  });

  // --- per-group 隔离测试 ---

  it('per-group rotateIndex 互不干扰', () => {
    setRotateIndex(1, 'group_a');
    setRotateIndex(5, 'group_b');
    expect(getRotateIndex('group_a')).toBe(1);
    expect(getRotateIndex('group_b')).toBe(5);
    // 无 groupFolder 的全局值不受影响
    expect(getRotateIndex()).toBe(0);
  });
});

// --- rotateAccount 测试 ---

describe('rotateAccount', () => {
  beforeEach(() => {
    _initTestDatabase();
    mockExecSync.mockReset();
  });

  it('未开启时返回 null', () => {
    setRotateEnabled(false);
    expect(rotateAccount('test-agent', 'test_group')).toBeNull();
  });

  it('成功轮换到下一个 secret（无防抖）', () => {
    setRotateEnabled(true);
    setRotateIndex(0, 'test_group');

    const secrets = [
      { id: 'sec-1', name: 'account-a', type: 'anthropic' },
      { id: 'sec-2', name: 'account-b', type: 'anthropic' },
      { id: 'sec-3', name: 'account-c', type: 'anthropic' },
    ];
    const agents = [
      { id: 'agent-1', identifier: 'test-agent', isDefault: false },
    ];

    mockExecSync
      .mockReturnValueOnce(JSON.stringify(secrets))
      .mockReturnValueOnce(JSON.stringify(agents))
      .mockReturnValueOnce('');

    const result = rotateAccount('test-agent', 'test_group');
    expect(result).toEqual({ success: true, newSecretName: 'account-b', oldSecretName: 'account-a' });
    expect(getRotateIndex('test_group')).toBe(1);
  });

  it('连续轮换走完一圈回到 index 0', () => {
    setRotateEnabled(true);
    setRotateIndex(2, 'test_group');

    const secrets = [
      { id: 'sec-1', name: 'account-a', type: 'anthropic' },
      { id: 'sec-2', name: 'account-b', type: 'anthropic' },
      { id: 'sec-3', name: 'account-c', type: 'anthropic' },
    ];
    const agents = [
      { id: 'agent-1', identifier: 'test-agent', isDefault: false },
    ];

    mockExecSync
      .mockReturnValueOnce(JSON.stringify(secrets))
      .mockReturnValueOnce(JSON.stringify(agents))
      .mockReturnValueOnce('');

    const result = rotateAccount('test-agent', 'test_group');
    expect(result).toEqual({ success: true, newSecretName: 'account-a', oldSecretName: 'account-c' });
    expect(getRotateIndex('test_group')).toBe(0);
  });

  it('只有一个 secret 时返回 null', () => {
    setRotateEnabled(true);

    mockExecSync.mockReturnValueOnce(
      JSON.stringify([{ id: 'sec-1', name: 'account-a', type: 'anthropic' }]),
    );

    expect(rotateAccount('test-agent', 'test_group')).toBeNull();
  });

  it('agent 不存在 → 自动注册后切换成功（不 fallback 到 Default）', () => {
    setRotateEnabled(true);
    setRotateIndex(0, 'test_group');

    const secrets = [
      { id: 'sec-1', name: 'account-a', type: 'anthropic' },
      { id: 'sec-2', name: 'account-b', type: 'anthropic' },
    ];
    // 第一次 list：没有 test-agent，只有 default 和 other
    const agentsBefore = [
      { id: 'agent-default', identifier: 'default-agent', isDefault: true },
      { id: 'agent-other', identifier: 'other-agent', isDefault: false },
    ];
    // create 之后第二次 list：新建的 test-agent 出现了
    const agentsAfter = [
      ...agentsBefore,
      { id: 'agent-new', identifier: 'test-agent', isDefault: false },
    ];

    mockExecSync
      .mockReturnValueOnce(JSON.stringify(secrets)) // secrets list
      .mockReturnValueOnce(JSON.stringify(agentsBefore)) // agents list（找不到）
      .mockReturnValueOnce('') // agents create
      .mockReturnValueOnce(JSON.stringify(agentsAfter)) // 重新 agents list（找到）
      .mockReturnValueOnce(''); // set-secrets

    const result = rotateAccount('test-agent', 'test_group');
    expect(result).toEqual({
      success: true,
      newSecretName: 'account-b',
      oldSecretName: 'account-a',
    });
    // 验证调用了 create，且用的是专属 identifier（不是 default）
    const createCall = mockExecSync.mock.calls.find((c) =>
      String(c[0]).includes('agents create'),
    );
    expect(createCall).toBeTruthy();
    expect(String(createCall?.[0])).toContain('--identifier test-agent');
  });

  it('agent 不存在且自动注册失败 → 返回 null', () => {
    setRotateEnabled(true);

    const secrets = [
      { id: 'sec-1', name: 'account-a', type: 'anthropic' },
      { id: 'sec-2', name: 'account-b', type: 'anthropic' },
    ];
    const agents = [
      { id: 'agent-other', identifier: 'other-agent', isDefault: false },
    ];

    mockExecSync
      .mockReturnValueOnce(JSON.stringify(secrets)) // secrets list
      .mockReturnValueOnce(JSON.stringify(agents)) // agents list（找不到）
      .mockImplementationOnce(() => {
        throw new Error('create failed'); // agents create 失败
      });

    const result = rotateAccount('test-agent', 'test_group');
    expect(result).toBeNull();
  });

  it('per-group 防抖隔离：A 群防抖不影响 B 群', () => {
    setRotateEnabled(true);
    // A 群刚轮换过（防抖中）
    setLastRotateAt(Date.now() - 30_000, 'group_a');
    // B 群很久没轮换
    setLastRotateAt(Date.now() - 120_000, 'group_b');

    const secrets = [
      { id: 'sec-1', name: 'account-a', type: 'anthropic' },
      { id: 'sec-2', name: 'account-b', type: 'anthropic' },
    ];
    const agents = [
      { id: 'agent-a', identifier: 'group-a', isDefault: false },
      { id: 'agent-b', identifier: 'group-b', isDefault: false },
    ];

    // A 群应该被防抖
    expect(rotateAccount('group-a', 'group_a')).toBeNull();

    // B 群应该正常轮换
    mockExecSync
      .mockReturnValueOnce(JSON.stringify(secrets))
      .mockReturnValueOnce(JSON.stringify(agents))
      .mockReturnValueOnce('');

    const result = rotateAccount('group-b', 'group_b');
    expect(result).toEqual({ success: true, newSecretName: 'account-b', oldSecretName: 'account-a' });
  });
  it('per-group index 隔离：各群独立维护轮换位置', () => {
    setRotateEnabled(true);
    setRotateIndex(0, 'group_a');
    setRotateIndex(1, 'group_b');

    const secrets = [
      { id: 'sec-1', name: 'account-a', type: 'anthropic' },
      { id: 'sec-2', name: 'account-b', type: 'anthropic' },
      { id: 'sec-3', name: 'account-c', type: 'anthropic' },
    ];
    const agents = [
      { id: 'agent-a', identifier: 'group-a', isDefault: false },
      { id: 'agent-b', identifier: 'group-b', isDefault: false },
    ];

    // A 群从 index 0 → 1
    mockExecSync
      .mockReturnValueOnce(JSON.stringify(secrets))
      .mockReturnValueOnce(JSON.stringify(agents))
      .mockReturnValueOnce('');
    const resultA = rotateAccount('group-a', 'group_a');
    expect(resultA?.newSecretName).toBe('account-b');
    expect(getRotateIndex('group_a')).toBe(1);

    // B 群从 index 1 → 2
    mockExecSync
      .mockReturnValueOnce(JSON.stringify(secrets))
      .mockReturnValueOnce(JSON.stringify(agents))
      .mockReturnValueOnce('');
    const resultB = rotateAccount('group-b', 'group_b');
    expect(resultB?.newSecretName).toBe('account-c');
    expect(getRotateIndex('group_b')).toBe(2);

    // 互不干扰
    expect(getRotateIndex('group_a')).toBe(1);
  });

  it('连续调用无防抖：可以立即再次轮换', () => {
    setRotateEnabled(true);
    setRotateIndex(0, 'test_group');

    const secrets = [
      { id: 'sec-1', name: 'account-a', type: 'anthropic' },
      { id: 'sec-2', name: 'account-b', type: 'anthropic' },
      { id: 'sec-3', name: 'account-c', type: 'anthropic' },
    ];
    const agents = [
      { id: 'agent-1', identifier: 'test-agent', isDefault: false },
    ];

    // 第一次轮换 0 → 1
    mockExecSync
      .mockReturnValueOnce(JSON.stringify(secrets))
      .mockReturnValueOnce(JSON.stringify(agents))
      .mockReturnValueOnce('');
    const r1 = rotateAccount('test-agent', 'test_group');
    expect(r1?.newSecretName).toBe('account-b');

    // 立即第二次轮换 1 → 2（无防抖）
    mockExecSync
      .mockReturnValueOnce(JSON.stringify(secrets))
      .mockReturnValueOnce(JSON.stringify(agents))
      .mockReturnValueOnce('');
    const r2 = rotateAccount('test-agent', 'test_group');
    expect(r2?.newSecretName).toBe('account-c');

    // 立即第三次轮换 2 → 0
    mockExecSync
      .mockReturnValueOnce(JSON.stringify(secrets))
      .mockReturnValueOnce(JSON.stringify(agents))
      .mockReturnValueOnce('');
    const r3 = rotateAccount('test-agent', 'test_group');
    expect(r3?.newSecretName).toBe('account-a');
  });
});

describe('getSecretCount', () => {
  it('返回 secrets 数量', () => {
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([
        { id: 'sec-1', name: 'a', type: 'anthropic' },
        { id: 'sec-2', name: 'b', type: 'anthropic' },
      ]),
    );
    expect(getSecretCount()).toBe(2);
  });

  it('onecli 失败时返回 1', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('onecli not found');
    });
    expect(getSecretCount()).toBe(1);
  });

  it('只统计 anthropic 账号，排除 openai（codex）', () => {
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([
        { id: 'sec-1', name: 'codex-tian', type: 'openai' },
        { id: 'sec-2', name: 'alex', type: 'anthropic' },
        { id: 'sec-3', name: 'tian', type: 'anthropic' },
      ]),
    );
    expect(getSecretCount()).toBe(2);
  });

  it('兼容 onecli 新版 {hint,data} 包装格式', () => {
    mockExecSync.mockReturnValueOnce(
      JSON.stringify({
        hint: 'Manage your secrets',
        data: [
          { id: 'sec-1', name: 'alex', type: 'anthropic' },
          { id: 'sec-2', name: 'tian', type: 'anthropic' },
        ],
      }),
    );
    expect(getSecretCount()).toBe(2);
  });
});
