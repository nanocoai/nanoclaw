import { describe, it, expect, vi, beforeEach } from 'vitest';

// registry 使用模块级 commands 数组，每个测试需要隔离
// 通过动态 import 并重置模块来隔离
let registerCommand: typeof import('./registry.js').registerCommand;
let dispatch: typeof import('./registry.js').dispatch;
let getHelp: typeof import('./registry.js').getHelp;
let getRegisteredCommands: typeof import('./registry.js').getRegisteredCommands;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import('./registry.js');
  registerCommand = mod.registerCommand;
  dispatch = mod.dispatch;
  getHelp = mod.getHelp;
  getRegisteredCommands = mod.getRegisteredCommands;
});

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    chatJid: 'test-jid',
    msg: { content: '/test', sender: 'user1', timestamp: '1' } as any,
    group: { name: 'test', folder: 'test_folder' } as any,
    channels: [
      {
        name: 'mock',
        ownsJid: () => true,
        sendMessage: vi.fn().mockResolvedValue(undefined),
        connect: vi.fn(),
      },
    ] as any,
    sessions: {} as Record<string, string>,
    queue: { killGroup: vi.fn() } as any,
    registeredGroups: {} as any,
    deleteSession: vi.fn(),
    setRegisteredGroup: vi.fn(),
    ...overrides,
  };
}

describe('registerCommand', () => {
  it('注册命令后可通过 getRegisteredCommands 获取', () => {
    registerCommand({
      name: '/foo',
      description: '测试',
      handler: async () => {},
    });
    expect(getRegisteredCommands()).toHaveLength(1);
    expect(getRegisteredCommands()[0].name).toBe('/foo');
  });

  it('重复注册同名命令抛异常', () => {
    registerCommand({
      name: '/dup',
      description: '第一次',
      handler: async () => {},
    });
    expect(() =>
      registerCommand({
        name: '/dup',
        description: '第二次',
        handler: async () => {},
      }),
    ).toThrow('命令 "/dup" 已注册');
  });
});

describe('dispatch', () => {
  it('精确匹配命令并执行 handler', async () => {
    const handler = vi.fn();
    registerCommand({ name: '/test', description: '测试', handler });

    const deps = makeDeps();
    const handled = await dispatch('/test', deps);

    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].chatJid).toBe('test-jid');
    expect(handler.mock.calls[0][0].args).toBe('');
  });

  it('前缀匹配命令（hasArgs: true）并提取 args', async () => {
    const handler = vi.fn();
    registerCommand({
      name: '/cmd',
      description: '测试',
      hasArgs: true,
      handler,
    });

    const deps = makeDeps();
    const handled = await dispatch('/cmd hello world', deps);

    expect(handled).toBe(true);
    expect(handler.mock.calls[0][0].args).toBe('hello world');
  });

  it('hasArgs 命令无参数时 args 为空字符串', async () => {
    const handler = vi.fn();
    registerCommand({
      name: '/cmd',
      description: '测试',
      hasArgs: true,
      handler,
    });

    const deps = makeDeps();
    await dispatch('/cmd', deps);
    expect(handler.mock.calls[0][0].args).toBe('');
  });

  it('未匹配的命令返回 false', async () => {
    registerCommand({
      name: '/foo',
      description: '测试',
      handler: vi.fn(),
    });

    const deps = makeDeps();
    const handled = await dispatch('/bar', deps);
    expect(handled).toBe(false);
  });

  it('"/ " 开头不算命令', async () => {
    registerCommand({
      name: '/test',
      description: '测试',
      handler: vi.fn(),
    });

    const deps = makeDeps();
    const handled = await dispatch('/ test', deps);
    expect(handled).toBe(false);
  });

  it('精确匹配优先于前缀匹配', async () => {
    const exactHandler = vi.fn();
    const prefixHandler = vi.fn();
    // /exact 精确匹配，/ex 前缀匹配 — 输入 "/exact" 应命中精确而非前缀
    registerCommand({
      name: '/ex',
      description: '前缀',
      hasArgs: true,
      handler: prefixHandler,
    });
    registerCommand({
      name: '/exact',
      description: '精确',
      handler: exactHandler,
    });

    const deps = makeDeps();
    const handled = await dispatch('/exact', deps);
    expect(handled).toBe(true);
    expect(exactHandler).toHaveBeenCalledOnce();
    expect(prefixHandler).not.toHaveBeenCalled();
  });

  it('channel 找不到时返回 true（不穿透）', async () => {
    registerCommand({
      name: '/test',
      description: '测试',
      handler: vi.fn(),
    });

    const deps = makeDeps({ channels: [] }); // 无 channel
    const handled = await dispatch('/test', deps);
    expect(handled).toBe(true);
  });

  it('requiresMain 检查：非 main group 被拒绝', async () => {
    registerCommand({
      name: '/admin',
      description: '管理',
      requiresMain: true,
      handler: vi.fn(),
    });

    const deps = makeDeps({
      group: { name: 'test', folder: 'test', isMain: false },
    });
    const handled = await dispatch('/admin', deps);

    expect(handled).toBe(true);
    const sendMsg = deps.channels[0].sendMessage;
    // 权限拒绝现在走 commandChannel，带 isCommandReply 避免打断 agent
    expect(sendMsg).toHaveBeenCalledWith('test-jid', '此命令仅限主群使用', {
      isCommandReply: true,
    });
  });

  it('handler 抛异常时捕获并回复错误', async () => {
    registerCommand({
      name: '/boom',
      description: '炸',
      handler: async () => {
        throw new Error('爆炸了');
      },
    });

    const deps = makeDeps();
    const handled = await dispatch('/boom', deps);

    expect(handled).toBe(true);
    const sendMsg = deps.channels[0].sendMessage;
    expect(sendMsg).toHaveBeenCalledWith('test-jid', '命令执行失败: 爆炸了', {
      isCommandReply: true,
    });
  });
});

describe('getHelp', () => {
  it('无 prefix 时返回 "可用命令：" 开头', () => {
    registerCommand({
      name: '/foo',
      description: '做事',
      handler: async () => {},
    });
    const help = getHelp();
    expect(help).toMatch(/^可用命令：/);
    expect(help).toContain('/foo — 做事');
  });

  it('有 prefix 时拼在最前面', () => {
    registerCommand({
      name: '/bar',
      description: '干活',
      handler: async () => {},
    });
    const help = getHelp('❓ 未知命令，');
    expect(help).toMatch(/^❓ 未知命令，可用命令：/);
  });

  it('包含 subcommands', () => {
    registerCommand({
      name: '/cmd',
      description: '主命令',
      hasArgs: true,
      subcommands: [{ usage: '/cmd foo', description: '子命令' }],
      handler: async () => {},
    });
    const help = getHelp();
    expect(help).toContain('/cmd foo — 子命令');
  });

  it('按 order 排序', () => {
    registerCommand({
      name: '/z',
      description: '最后',
      order: 99,
      handler: async () => {},
    });
    registerCommand({
      name: '/a',
      description: '最前',
      order: 1,
      handler: async () => {},
    });
    const help = getHelp();
    const zIdx = help.indexOf('/z');
    const aIdx = help.indexOf('/a');
    expect(aIdx).toBeLessThan(zIdx);
  });

  it('包含模型前缀修饰符说明', () => {
    const help = getHelp();
    expect(help).toContain('Sonnet 快速（无思考）');
    expect(help).toContain('Sonnet 深度思考');
    expect(help).toContain('Opus 4.6 深度思考');
    expect(help).toContain('关闭思考（默认模型）');
  });
});

describe('模式过滤 (getHelp)', () => {
  function reg() {
    registerCommand({ name: '/common', description: '通用', order: 1 });
    registerCommand({
      name: '/claude-only',
      description: 'Claude 专属',
      order: 2,
      modes: ['sdk', 'print', 'interactive'],
    });
    registerCommand({
      name: '/codex-only',
      description: 'codex 专属',
      order: 3,
      modes: ['codex'],
    });
    registerCommand({
      name: '/usage-like',
      description: '带子命令',
      order: 4,
      modes: ['sdk', 'print', 'interactive', 'codex'],
      subcommands: [
        { usage: '/usage-like', description: '主' },
        { usage: '/usage-like all', description: '仅 Claude', modes: ['sdk', 'print', 'interactive'] },
      ],
    });
  }

  it('codex 模式：隐藏 Claude 专属、显示 codex 专属与通用', () => {
    reg();
    const help = getHelp(undefined, 'codex');
    expect(help).toContain('/common');
    expect(help).toContain('/codex-only');
    expect(help).not.toContain('/claude-only');
  });

  it('sdk 模式：显示 Claude 专属、隐藏 codex 专属', () => {
    reg();
    const help = getHelp(undefined, 'sdk');
    expect(help).toContain('/claude-only');
    expect(help).not.toContain('/codex-only');
  });

  it('思考修饰符仅 Claude 系模式显示', () => {
    reg();
    expect(getHelp(undefined, 'sdk')).toContain('Sonnet 快速');
    expect(getHelp(undefined, 'interactive')).toContain('Opus');
    expect(getHelp(undefined, 'codex')).not.toContain('Sonnet');
    expect(getHelp(undefined, 'gemini')).not.toContain('修饰符');
  });

  it('subcommand 按模式过滤：codex 不显示仅 Claude 子命令', () => {
    reg();
    const codexHelp = getHelp(undefined, 'codex');
    expect(codexHelp).toContain('/usage-like — 带子命令');
    expect(codexHelp).not.toContain('仅 Claude');
    const sdkHelp = getHelp(undefined, 'sdk');
    expect(sdkHelp).toContain('仅 Claude');
  });

  it('默认模式 sdk（不传 mode）', () => {
    reg();
    const help = getHelp();
    expect(help).toContain('/claude-only');
    expect(help).not.toContain('/codex-only');
  });
});

describe('模式拦截 (dispatch)', () => {
  it('codex 群打仅 Claude 命令被拦截，handler 不执行', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerCommand({
      name: '/claude-cmd',
      description: 'Claude 专属',
      modes: ['sdk', 'print', 'interactive'],
      handler,
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      group: { name: 't', folder: 'f', containerConfig: { cliMode: 'codex' } },
      channels: [{ name: 'mock', ownsJid: () => true, sendMessage, connect: vi.fn() }],
    });
    const handled = await dispatch('/claude-cmd', deps as any);
    expect(handled).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      'test-jid',
      expect.stringContaining('不可用'),
      { isCommandReply: true },
    );
  });

  it('适用模式下正常执行 handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerCommand({
      name: '/codex-cmd',
      description: 'codex 专属',
      modes: ['codex'],
      handler,
    });
    const deps = makeDeps({
      group: { name: 't', folder: 'f', containerConfig: { cliMode: 'codex' } },
    });
    const handled = await dispatch('/codex-cmd', deps as any);
    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('无 modes 的命令在任何模式都执行', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerCommand({ name: '/any', description: '通用', handler });
    const deps = makeDeps({
      group: { name: 't', folder: 'f', containerConfig: { cliMode: 'gemini' } },
    });
    await dispatch('/any', deps as any);
    expect(handler).toHaveBeenCalledOnce();
  });
});
