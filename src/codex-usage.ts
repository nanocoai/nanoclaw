/**
 * Codex Usage — 读取 codex 模式群的配额使用率
 *
 * 与 Claude 的 usage-api 不同：codex(ChatGPT 账号登录)没有公开的 usage 查询 API，
 * rate_limit 只由 `codex exec` 在每轮跑完时写进 per-group CODEX_HOME 下的 rollout 文件。
 * 因此这里读「最近一次 rollout」里最后一个带 rate_limits 的 token_count 事件——
 * 配额本身是窗口制(5h / 7d),几分钟的快照延迟无影响。
 */

import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import type { RateLimits, RegisteredGroup } from './types.js';
import { formatResetTime, progressBar } from './usage-api.js';

/** codex rollout 里 token_count 事件携带的 rate_limits 结构(实测 codex-cli 0.136.0) */
interface CodexRateLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number; // unix 秒
}
interface CodexRateLimits {
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
  plan_type?: string | null;
}

export interface CodexUsageResult {
  rateLimits: RateLimits | null;
  planType?: string | null;
  error?: 'no_session' | 'no_data';
}

// codex sessions 固定 年/月/日/文件 4 层,留余量防异常深层嵌套导致栈溢出
const MAX_WALK_DEPTH = 8;

/**
 * 在 CODEX_HOME/sessions 下递归找最新的 rollout-*.jsonl。
 * 主排序键 mtime,同毫秒时以文件名(内含完整时间戳)降序兜底,保证确定性。
 */
export function findLatestCodexRollout(codexHome: string): string | null {
  const sessionsRoot = path.join(codexHome, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;

  let latest: { file: string; name: string; mtime: number } | null = null;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
        try {
          const mtime = fs.statSync(full).mtimeMs;
          const newer =
            !latest ||
            mtime > latest.mtime ||
            (mtime === latest.mtime && e.name > latest.name);
          if (newer) latest = { file: full, name: e.name, mtime };
        } catch {
          // 跳过无法 stat 的文件
        }
      }
    }
  };
  walk(sessionsRoot, 0);
  return latest ? (latest as { file: string }).file : null;
}

/** unix 秒 → ISO 字符串(复用 usage-api 的 formatResetTime) */
function unixToIso(sec: number | undefined): string | null {
  if (sec == null || !isFinite(sec)) return null;
  return new Date(sec * 1000).toISOString();
}

function toPercent(v: number | undefined): number {
  if (v == null || !isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * 从 rollout 文件里抓最后一个带 rate_limits 的 token_count 事件。
 * 从文件末尾往前找最快,但 rollout 通常不大(几百行),这里顺序扫描记录最后一个即可。
 */
export function extractCodexRateLimits(
  rolloutPath: string,
): { rateLimits: CodexRateLimits; planType: string | null } | null {
  let content: string;
  try {
    content = fs.readFileSync(rolloutPath, 'utf-8');
  } catch {
    return null;
  }
  const lines = content.split('\n');
  let found: CodexRateLimits | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('rate_limits')) continue;
    try {
      const obj = JSON.parse(trimmed);
      const payload = obj?.payload;
      if (payload?.type === 'token_count' && payload.rate_limits) {
        found = payload.rate_limits as CodexRateLimits;
      }
    } catch {
      // 跳过畸形行
    }
  }
  if (!found) return null;
  return { rateLimits: found, planType: found.plan_type ?? null };
}

/** 把 codex rate_limits 转成通用 RateLimits 形状(primary→5h, secondary→7d) */
export function codexToRateLimits(raw: CodexRateLimits): RateLimits | null {
  const p = raw.primary;
  const s = raw.secondary;
  if (!p && !s) return null;
  return {
    fiveHourPercent: toPercent(p?.used_percent),
    fiveHourResetsAt: unixToIso(p?.resets_at),
    weeklyPercent: s ? toPercent(s.used_percent) : undefined,
    weeklyResetsAt: unixToIso(s?.resets_at),
  };
}

/**
 * 清洗 plan_type:来自 rollout 文件。plan_type 本是单 token(plus/pro/prolite),
 * 移除所有非 [\w-] 字符(含换行/标签),截断 24 字,防异常值破坏输出格式。
 */
function sanitizePlanType(plan: string | null): string | null {
  if (!plan) return null;
  const cleaned = plan.replace(/[^\w-]/g, '').slice(0, 24);
  return cleaned || null;
}

/**
 * 主入口:给定 codex 模式群,读最近 rollout 返回配额。
 * 调用方负责确认 group 已是 codex 模式(本函数不再校验 cliMode,避免耦合 container-runner)。
 */
export function getCodexUsage(group: RegisteredGroup): CodexUsageResult {
  const codexHome = path.join(
    resolveGroupFolderPath(group.folder),
    '.codex-home',
  );
  const rollout = findLatestCodexRollout(codexHome);
  if (!rollout) {
    return { rateLimits: null, error: 'no_session' };
  }
  const extracted = extractCodexRateLimits(rollout);
  if (!extracted) {
    return { rateLimits: null, error: 'no_data' };
  }
  const rateLimits = codexToRateLimits(extracted.rateLimits);
  if (!rateLimits) {
    return { rateLimits: null, error: 'no_data' };
  }
  const planType = sanitizePlanType(extracted.planType);
  logger.info(
    { group: group.folder, rollout: path.basename(rollout), plan: planType },
    'codex usage 读取成功',
  );
  return { rateLimits, planType };
}

/** 格式化 codex 配额输出(复用 Claude usage 的进度条/重置时间样式) */
export function formatCodexUsage(result: CodexUsageResult): string {
  if (result.error === 'no_session') {
    return '⚠️ codex: 还没有会话记录，先跑一轮对话再查';
  }
  if (result.error === 'no_data' || !result.rateLimits) {
    return '⚠️ codex: 最近一次会话未记录配额数据，再跑一轮试试';
  }

  const r = result.rateLimits;
  const plan = result.planType ? ` (${result.planType})` : '';
  const lines: string[] = [`📊 codex${plan}`];
  lines.push(
    `5h:  ${progressBar(r.fiveHourPercent)} ${r.fiveHourPercent}% ${formatResetTime(r.fiveHourResetsAt)}`,
  );
  if (r.weeklyPercent != null) {
    lines.push(
      `7d:  ${progressBar(r.weeklyPercent)} ${r.weeklyPercent}% ${formatResetTime(r.weeklyResetsAt)}`,
    );
  }
  return lines.join('\n');
}
