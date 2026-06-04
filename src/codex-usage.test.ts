/**
 * codex-usage 测试 — 用临时目录造真实 rollout 文件验证解析链路
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// db.js 被 usage-api 依赖,mock 成空避免打开 sqlite
vi.mock('./db.js', () => ({
  getOAuthCredential: () => null,
  getAllOAuthCredentials: () => [],
  updateOAuthTokens: () => {},
  updateOAuthUsageCache: () => {},
}));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// container-runner 有 OneCLI 副作用,mock 掉只留 resolveCliMode
let mockCliMode = 'codex';
vi.mock('./container-runner.js', () => ({
  resolveCliMode: () => mockCliMode,
}));
let mockGroupPath = '';
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: () => mockGroupPath,
}));

const {
  findLatestCodexRollout,
  extractCodexRateLimits,
  codexToRateLimits,
  formatCodexUsage,
  getCodexUsage,
} = await import('./codex-usage.js');

// 真实 rollout 里 token_count 事件的一行(实测 codex-cli 0.136.0 结构)
function tokenCountLine(primaryPct: number, secondaryPct: number, plan = 'plus') {
  return JSON.stringify({
    timestamp: '2026-06-04T22:40:51.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: 1000 } },
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: primaryPct, window_minutes: 300, resets_at: 1780588999 },
        secondary: { used_percent: secondaryPct, window_minutes: 10080, resets_at: 1781175799 },
        plan_type: plan,
      },
    },
  });
}

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-test-'));
  mockGroupPath = tmpRoot;
  mockCliMode = 'codex';
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeRollout(home: string, dateDir: string, name: string, lines: string[]) {
  const dir = path.join(home, 'sessions', dateDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('findLatestCodexRollout', () => {
  it('sessions 目录不存在时返回 null', () => {
    expect(findLatestCodexRollout(path.join(tmpRoot, 'nope'))).toBeNull();
  });

  it('递归找到最新 mtime 的 rollout-*.jsonl', () => {
    const home = path.join(tmpRoot, '.codex-home');
    const old = writeRollout(home, '2026/06/01', 'rollout-2026-06-01T01-00-00-aaa.jsonl', [tokenCountLine(10, 5)]);
    fs.utimesSync(old, new Date('2026-06-01'), new Date('2026-06-01'));
    const recent = writeRollout(home, '2026/06/04', 'rollout-2026-06-04T22-40-51-bbb.jsonl', [tokenCountLine(40, 16)]);
    fs.utimesSync(recent, new Date('2026-06-04'), new Date('2026-06-04'));
    expect(findLatestCodexRollout(home)).toBe(recent);
  });

  it('忽略非 rollout 文件', () => {
    const home = path.join(tmpRoot, '.codex-home');
    const dir = path.join(home, 'sessions', '2026/06/04');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'history.jsonl'), 'x');
    expect(findLatestCodexRollout(home)).toBeNull();
  });
});

describe('extractCodexRateLimits', () => {
  it('抓最后一个带 rate_limits 的 token_count 事件', () => {
    const home = path.join(tmpRoot, '.codex-home');
    const file = writeRollout(home, '2026/06/04', 'rollout-x.jsonl', [
      '{"type":"thread.started"}',
      tokenCountLine(10, 5),
      tokenCountLine(99, 16, 'prolite'), // 应取这个
    ]);
    const res = extractCodexRateLimits(file)!;
    expect(res.planType).toBe('prolite');
    expect(res.rateLimits.primary!.used_percent).toBe(99);
  });

  it('没有 rate_limits 时返回 null', () => {
    const home = path.join(tmpRoot, '.codex-home');
    const file = writeRollout(home, '2026/06/04', 'rollout-y.jsonl', ['{"type":"turn.started"}']);
    expect(extractCodexRateLimits(file)).toBeNull();
  });

  it('跳过畸形 JSON 行', () => {
    const home = path.join(tmpRoot, '.codex-home');
    const file = writeRollout(home, '2026/06/04', 'rollout-z.jsonl', [
      'not json but has rate_limits text',
      tokenCountLine(50, 8),
    ]);
    expect(extractCodexRateLimits(file)!.rateLimits.primary!.used_percent).toBe(50);
  });
});

describe('codexToRateLimits', () => {
  it('primary→5h, secondary→7d, 百分比取整并 clamp', () => {
    const rl = codexToRateLimits({
      primary: { used_percent: 100, resets_at: 1780588999 },
      secondary: { used_percent: 16.4, resets_at: 1781175799 },
    })!;
    expect(rl.fiveHourPercent).toBe(100);
    expect(rl.weeklyPercent).toBe(16);
    expect(rl.fiveHourResetsAt).toBe(new Date(1780588999 * 1000).toISOString());
  });

  it('primary/secondary 都缺时返回 null', () => {
    expect(codexToRateLimits({})).toBeNull();
  });
});

describe('formatCodexUsage', () => {
  it('正常输出含进度条与 plan', () => {
    const out = formatCodexUsage({
      rateLimits: { fiveHourPercent: 100, weeklyPercent: 16, fiveHourResetsAt: null, weeklyResetsAt: null },
      planType: 'prolite',
    });
    expect(out).toContain('📊 codex (prolite)');
    expect(out).toContain('5h:');
    expect(out).toContain('100%');
    expect(out).toContain('7d:');
  });

  it('各 error 状态有对应提示', () => {
    expect(formatCodexUsage({ rateLimits: null, error: 'not_codex' })).toContain('不是 codex 模式');
    expect(formatCodexUsage({ rateLimits: null, error: 'no_session' })).toContain('还没有会话');
    expect(formatCodexUsage({ rateLimits: null, error: 'no_data' })).toContain('未记录配额');
  });
});

describe('getCodexUsage (集成)', () => {
  it('非 codex 模式返回 not_codex', () => {
    mockCliMode = 'sdk';
    const res = getCodexUsage({ folder: 'g', containerConfig: {} } as any);
    expect(res.error).toBe('not_codex');
  });

  it('codex 模式无 session 返回 no_session', () => {
    const res = getCodexUsage({ folder: 'g', containerConfig: { cliMode: 'codex' } } as any);
    expect(res.error).toBe('no_session');
  });

  it('codex 模式有 rollout 时解析出配额', () => {
    const home = path.join(tmpRoot, '.codex-home');
    writeRollout(home, '2026/06/04', 'rollout-ok.jsonl', [tokenCountLine(42, 7, 'plus')]);
    const res = getCodexUsage({ folder: 'g', containerConfig: { cliMode: 'codex' } } as any);
    expect(res.error).toBeUndefined();
    expect(res.planType).toBe('plus');
    expect(res.rateLimits!.fiveHourPercent).toBe(42);
    expect(res.rateLimits!.weeklyPercent).toBe(7);
  });
});
