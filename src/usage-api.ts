/**
 * Usage API — 查询 Claude 订阅账号配额使用率
 *
 * 每个账号需单独绑定 refresh token（通过 PKCE 登录脚本获取）。
 * setup-token (sk-ant-oat01) 只有 user:inference scope，无权访问 usage API。
 */

import https from 'https';
import { execFileSync } from 'child_process';

import {
  getOAuthCredential,
  getAllOAuthCredentials,
  updateOAuthTokens,
  updateOAuthUsageCache,
} from './db.js';
import { logger } from './logger.js';
import type { RateLimits, UsageResult } from './types.js';

// --- 常量 ---

const CACHE_TTL_MS = 30_000; // 30 秒缓存
const API_TIMEOUT_MS = 10_000;
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_REFRESH_HOSTNAME = 'api.anthropic.com';
const TOKEN_REFRESH_PATH = '/v1/oauth/token';
const USAGE_API_HOSTNAME = 'api.anthropic.com';
const USAGE_API_PATH = '/api/oauth/usage';
const MAX_CONCURRENT = 3;

// --- HTTP 工具 ---

function httpsRequest(
  hostname: string,
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method, headers, timeout: API_TIMEOUT_MS },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode || 500, body: data }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('request timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}

// --- Token 刷新 ---

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function refreshAccessToken(
  secretName: string,
  refreshToken: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} | null> {
  // 用 JSON 格式，不带 scope（与 CLIProxyAPI 一致）
  // 端点用 api.anthropic.com（不用 platform.claude.com 避免 TLS 问题）
  const body = JSON.stringify({
    client_id: OAUTH_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  try {
    const res = await httpsRequest(
      TOKEN_REFRESH_HOSTNAME,
      TOKEN_REFRESH_PATH,
      'POST',
      {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      },
      body,
    );

    if (res.status !== 200) {
      logger.warn({ secretName, status: res.status }, 'Token 刷新失败');
      return null;
    }

    const parsed = JSON.parse(res.body) as TokenResponse;
    if (!parsed.access_token) return null;

    const result = {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token || refreshToken,
      expiresAt: Date.now() + parsed.expires_in * 1000,
    };

    // 更新 DB（含 refresh token rotation）
    updateOAuthTokens(
      secretName,
      result.accessToken,
      result.refreshToken,
      result.expiresAt,
    );

    return result;
  } catch (err) {
    logger.error({ err, secretName }, 'Token 刷新异常');
    return null;
  }
}

// --- Usage 查询 ---

interface UsageApiResponse {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  seven_day_sonnet?: { utilization?: number; resets_at?: string };
  seven_day_opus?: { utilization?: number; resets_at?: string };
  extra_usage?: { is_enabled?: boolean; used_credits?: number };
}

function toPercent(v: number | undefined): number {
  if (v == null || !isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function parseUsageResponse(response: UsageApiResponse): RateLimits | null {
  const fiveHour = response.five_hour?.utilization;
  const sevenDay = response.seven_day?.utilization;
  if (fiveHour == null && sevenDay == null) return null;

  const result: RateLimits = {
    fiveHourPercent: toPercent(fiveHour),
    weeklyPercent: toPercent(sevenDay),
    fiveHourResetsAt: response.five_hour?.resets_at ?? null,
    weeklyResetsAt: response.seven_day?.resets_at ?? null,
  };

  if (response.seven_day_sonnet?.utilization != null) {
    result.sonnetWeeklyPercent = toPercent(
      response.seven_day_sonnet.utilization,
    );
    result.sonnetWeeklyResetsAt = response.seven_day_sonnet.resets_at ?? null;
  }
  if (response.seven_day_opus?.utilization != null) {
    result.opusWeeklyPercent = toPercent(response.seven_day_opus.utilization);
    result.opusWeeklyResetsAt = response.seven_day_opus.resets_at ?? null;
  }

  return result;
}

async function fetchUsage(
  accessToken: string,
): Promise<{ data: RateLimits | null; status: number }> {
  try {
    const res = await httpsRequest(USAGE_API_HOSTNAME, USAGE_API_PATH, 'GET', {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    });

    if (res.status === 200) {
      const parsed = JSON.parse(res.body) as UsageApiResponse;
      return { data: parseUsageResponse(parsed), status: 200 };
    }
    return { data: null, status: res.status };
  } catch {
    return { data: null, status: 0 };
  }
}

// --- 对外接口 ---

export async function getUsageForSecret(
  secretName: string,
): Promise<UsageResult> {
  // OneCLI secret 名和 OAuth DB 的 secret_name 可能不一致（如 tian vs anthropic-tian）
  const cred =
    getOAuthCredential(secretName) ||
    getOAuthCredential(`anthropic-${secretName}`);
  if (!cred) {
    return { secretName, rateLimits: null, error: 'no_credentials' };
  }

  // 检查缓存
  if (
    cred.last_usage_check &&
    Date.now() - cred.last_usage_check < CACHE_TTL_MS &&
    cred.cached_usage &&
    !cred.error_state
  ) {
    try {
      return {
        secretName,
        rateLimits: JSON.parse(cred.cached_usage) as RateLimits,
      };
    } catch {
      // 缓存损坏，继续查询
    }
  }

  // 检查 access token 是否过期，需要刷新
  let accessToken = cred.access_token;
  let currentRefreshToken = cred.refresh_token;
  if (!accessToken || (cred.expires_at && cred.expires_at <= Date.now())) {
    const refreshed = await refreshAccessToken(secretName, currentRefreshToken);
    if (!refreshed) {
      updateOAuthUsageCache(secretName, null, 'auth');
      return { secretName, rateLimits: null, error: 'auth' };
    }
    accessToken = refreshed.accessToken;
    currentRefreshToken = refreshed.refreshToken;
  }

  // 查询 usage
  const result = await fetchUsage(accessToken);

  if (result.status === 401 || result.status === 403) {
    // access token 可能刚过期，尝试刷新一次（用最新的 refresh token）
    const refreshed = await refreshAccessToken(secretName, currentRefreshToken);
    if (refreshed) {
      const retry = await fetchUsage(refreshed.accessToken);
      if (retry.data) {
        updateOAuthUsageCache(secretName, JSON.stringify(retry.data));
        return { secretName, rateLimits: retry.data };
      }
    }
    updateOAuthUsageCache(secretName, null, 'auth');
    return { secretName, rateLimits: null, error: 'auth' };
  }

  if (result.status === 429) {
    // 更新 last_usage_check 防止限流螺旋（缓存 TTL 内不再重试）
    updateOAuthUsageCache(secretName, cred.cached_usage ?? null);
    if (cred.cached_usage) {
      try {
        return {
          secretName,
          rateLimits: JSON.parse(cred.cached_usage) as RateLimits,
          error: 'rate_limited',
          stale: true,
        };
      } catch {
        // fall through
      }
    }
    return { secretName, rateLimits: null, error: 'rate_limited' };
  }

  if (!result.data) {
    updateOAuthUsageCache(secretName, null, 'network');
    return { secretName, rateLimits: null, error: 'network' };
  }

  updateOAuthUsageCache(secretName, JSON.stringify(result.data));
  return { secretName, rateLimits: result.data };
}

export async function getUsageAll(): Promise<UsageResult[]> {
  const creds = getAllOAuthCredentials();
  if (creds.length === 0) return [];

  // 限流并发
  const results: UsageResult[] = [];
  for (let i = 0; i < creds.length; i += MAX_CONCURRENT) {
    const batch = creds.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.all(
      batch.map((c) => getUsageForSecret(c.secret_name)),
    );
    results.push(...batchResults);
  }
  return results;
}

/**
 * 获取当前群绑定的 OneCLI secret name
 */
export function getCurrentSecretName(
  chatJid: string,
  registeredGroups: Record<string, { folder: string }>,
): string | null {
  try {
    const group = registeredGroups[chatJid];
    if (!group) return null;

    const agentId = group.folder.toLowerCase().replace(/_/g, '-');
    const agents = JSON.parse(
      execFileSync('onecli', ['agents', 'list'], {
        encoding: 'utf-8',
        timeout: 5000,
      }),
    ) as Array<{ id: string; identifier: string; isDefault?: boolean }>;

    const agent =
      agents.find((a) => a.identifier === agentId) ||
      agents.find((a) => a.isDefault);
    if (!agent) return null;

    const secrets = JSON.parse(
      execFileSync('onecli', ['secrets', 'list'], {
        encoding: 'utf-8',
        timeout: 5000,
      }),
    ) as Array<{ id: string; name: string }>;

    const agentSecrets = JSON.parse(
      execFileSync('onecli', ['agents', 'secrets', '--id', agent.id], {
        encoding: 'utf-8',
        timeout: 5000,
      }),
    ) as Array<string | { id: string }>;

    const assignedIds = agentSecrets.map((s) =>
      typeof s === 'string' ? s : s.id,
    );
    const assigned = secrets.find((s) => assignedIds.includes(s.id));
    return assigned?.name ?? null;
  } catch {
    return null;
  }
}

// --- 格式化输出 ---

function progressBar(percent: number): string {
  const filled = Math.round(percent / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function formatResetTime(isoStr: string | null | undefined): string {
  if (!isoStr) return '';
  try {
    const resetAt = new Date(isoStr);
    if (isNaN(resetAt.getTime())) return '';
    const now = Date.now();
    const diffMs = resetAt.getTime() - now;
    if (diffMs <= 0) return '即将重置';

    const hours = Math.floor(diffMs / 3600000);
    const minutes = Math.floor((diffMs % 3600000) / 60000);
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const remainHours = hours % 24;
      return `${days}d${remainHours}h 重置`;
    }
    return `${hours}h${minutes}m 重置`;
  } catch {
    return '';
  }
}

export function formatUsage(result: UsageResult): string {
  if (result.error === 'no_credentials') {
    return `⚠️ ${result.secretName}: 未绑定 OAuth 凭证\n用 npx tsx scripts/oauth-login.ts 绑定`;
  }
  if (result.error === 'auth') {
    return `⚠️ ${result.secretName}: 凭证已失效，请重新绑定`;
  }
  if (result.error === 'network') {
    return `⚠️ ${result.secretName}: API 查询失败，请重试`;
  }
  if (result.error === 'rate_limited' && !result.rateLimits) {
    return `⚠️ ${result.secretName}: API 限流，稍后重试`;
  }

  if (!result.rateLimits) {
    return `⚠️ ${result.secretName}: 无数据`;
  }

  const r = result.rateLimits;
  const staleTag = result.stale ? ' (缓存)' : '';
  const lines: string[] = [`📊 ${result.secretName}${staleTag}`];

  lines.push(
    `5h:  ${progressBar(r.fiveHourPercent)} ${r.fiveHourPercent}% ${formatResetTime(r.fiveHourResetsAt)}`,
  );

  if (r.weeklyPercent != null) {
    lines.push(
      `7d:  ${progressBar(r.weeklyPercent)} ${r.weeklyPercent}% ${formatResetTime(r.weeklyResetsAt)}`,
    );
  }

  if (r.sonnetWeeklyPercent != null) {
    lines.push(
      `Son: ${progressBar(r.sonnetWeeklyPercent)} ${r.sonnetWeeklyPercent}% ${formatResetTime(r.sonnetWeeklyResetsAt)}`,
    );
  }

  if (r.opusWeeklyPercent != null) {
    lines.push(
      `Ops: ${progressBar(r.opusWeeklyPercent)} ${r.opusWeeklyPercent}% ${formatResetTime(r.opusWeeklyResetsAt)}`,
    );
  }

  return lines.join('\n');
}

export function formatUsageAll(
  results: UsageResult[],
  currentSecretName: string | null,
): string {
  if (results.length === 0) {
    return '⚠️ 未绑定任何 OAuth 凭证\n用 npx tsx scripts/oauth-login.ts 绑定';
  }
  return results
    .map((r) => {
      const marker = r.secretName === currentSecretName ? ' ← 当前' : '';
      return formatUsage(r) + marker;
    })
    .join('\n\n');
}
