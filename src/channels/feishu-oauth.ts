/**
 * 飞书 User Access Token OAuth 流程
 * - 本地 HTTP 回调 server 接收授权 code
 * - code 换 access_token + refresh_token
 * - token 缓存/刷新/持久化
 */
import http from 'http';
import os from 'os';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  getAllFeishuTokenUsers,
  getFeishuTokenByUserId,
  setFeishuToken,
} from '../db.js';

// ---- 配置 ----

const API_BASE = 'https://open.feishu.cn/open-apis';
const CALLBACK_PORT = 19876;
const CALLBACK_PATH = '/feishu-callback';

function getLocalIp(): string {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (
        iface.family === 'IPv4' &&
        !iface.internal &&
        !iface.address.startsWith('198.18')
      ) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const REDIRECT_URI = `http://${getLocalIp()}:${CALLBACK_PORT}${CALLBACK_PATH}`;
const REFRESH_AHEAD_MS = 5 * 60 * 1000; // 过期前 5 分钟刷新

function getAppCredentials(): { appId: string; appSecret: string } | null {
  const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const appId = process.env.FEISHU_APP_ID || env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET || env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

// ---- Token 内存缓存 ----

const tokenCache = new Map<string, { token: string; expiresAt: Date }>();
const refreshInFlight = new Map<string, Promise<string | null>>();

function cacheKey(userId: string): string {
  return userId;
}

// ---- 获取 App Access Token（用于 OIDC 接口） ----

async function getAppAccessToken(): Promise<string | null> {
  const creds = getAppCredentials();
  if (!creds) return null;
  try {
    const resp = await fetch(`${API_BASE}/auth/v3/app_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: creds.appId,
        app_secret: creds.appSecret,
      }),
    });
    const data = (await resp.json()) as { app_access_token?: string };
    return data.app_access_token ?? null;
  } catch {
    return null;
  }
}

// ---- 核心：获取用户 token（带缓存和自动刷新） ----

export async function getFeishuUserToken(
  userId: string,
): Promise<string | null> {
  const key = cacheKey(userId);
  const now = new Date();

  // 1. 内存缓存
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt.getTime() - REFRESH_AHEAD_MS > now.getTime()) {
    return cached.token;
  }

  // 2. 查 DB — 按 user_id 查，所有群共享同一 token
  const record = getFeishuTokenByUserId(userId);
  if (!record) return null;

  const expiresAt = new Date(record.expires_at);

  // 3. 未过期且不需要刷新
  if (expiresAt.getTime() - REFRESH_AHEAD_MS > now.getTime()) {
    tokenCache.set(key, { token: record.access_token, expiresAt });
    return record.access_token;
  }

  // 4. 需要刷新 — 加锁防止多 agent 并发刷新
  const existing = refreshInFlight.get(key);
  if (existing) return existing;

  const refreshPromise = (async (): Promise<string | null> => {
    try {
      const refreshed = await refreshUserToken(
        userId,
        record.chat_jid,
        record.refresh_token,
      );
      return refreshed?.accessToken ?? null;
    } finally {
      refreshInFlight.delete(key);
    }
  })();

  refreshInFlight.set(key, refreshPromise);
  return refreshPromise;
}

// ---- 刷新 token ----

async function refreshUserToken(
  userId: string,
  chatJid: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const appToken = await getAppAccessToken();
  if (!appToken) return null;

  try {
    const resp = await fetch(
      `${API_BASE}/authen/v1/oidc/refresh_access_token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${appToken}`,
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      },
    );
    const data = (await resp.json()) as {
      code?: number;
      data?: {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
    };

    if (data.code !== 0 || !data.data?.access_token) {
      logger.warn({ code: data.code }, '飞书 token 刷新失败');
      return null;
    }

    const newAccessToken = data.data.access_token;
    const newRefreshToken = data.data.refresh_token || refreshToken;
    const expiresIn = data.data.expires_in || 6900;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    // 更新 DB + 缓存
    setFeishuToken(
      userId,
      chatJid,
      newAccessToken,
      newRefreshToken,
      expiresAt.toISOString(),
    );
    tokenCache.set(cacheKey(userId), { token: newAccessToken, expiresAt });

    logger.info({ userId }, '飞书 user token 已刷新');
    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
  } catch (err) {
    logger.warn({ err }, '飞书 token 刷新异常');
    return null;
  }
}

// ---- code 换 token ----

async function exchangeCodeForToken(code: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  openId: string;
} | null> {
  const appToken = await getAppAccessToken();
  if (!appToken) return null;

  try {
    const resp = await fetch(`${API_BASE}/authen/v1/oidc/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${appToken}`,
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
      }),
    });
    const data = (await resp.json()) as {
      code?: number;
      data?: {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        open_id?: string;
      };
    };

    logger.info(
      {
        respCode: data.code,
        dataKeys: data.data ? Object.keys(data.data) : [],
      },
      '飞书 OIDC 响应',
    );
    if (data.code !== 0 || !data.data?.access_token) {
      logger.error(
        { code: data.code, data: JSON.stringify(data).slice(0, 500) },
        '飞书 code 换 token 失败',
      );
      return null;
    }

    let openId =
      data.data.open_id ||
      ((data.data as Record<string, unknown>).open_id as string) ||
      '';

    // OIDC 接口可能不直接返回 open_id，需要调 user_info 获取
    if (!openId && data.data.access_token) {
      try {
        const userInfoResp = await fetch(`${API_BASE}/authen/v1/user_info`, {
          headers: { Authorization: `Bearer ${data.data.access_token}` },
        });
        const userInfo = (await userInfoResp.json()) as {
          code?: number;
          data?: { open_id?: string };
        };
        if (userInfo.code === 0 && userInfo.data?.open_id) {
          openId = userInfo.data.open_id;
        }
      } catch (err) {
        logger.warn({ err }, '飞书 user_info 获取 open_id 失败');
      }
    }

    logger.info(
      {
        openId,
        hasRefresh: !!data.data.refresh_token,
        expiresIn: data.data.expires_in,
      },
      '飞书 token 获取成功',
    );

    return {
      accessToken: data.data.access_token,
      refreshToken: data.data.refresh_token || '',
      expiresIn: data.data.expires_in || 6900,
      openId,
    };
  } catch (err) {
    logger.error({ err }, '飞书 code 换 token 异常');
    return null;
  }
}

// ---- 生成授权 URL ----

// 授权时请求的权限范围
const OAUTH_SCOPES =
  'docx:document:readonly drive:drive wiki:wiki:readonly bitable:app:readonly';

export function buildAuthUrl(state: string): string {
  const creds = getAppCredentials();
  if (!creds) return '';
  return (
    `${API_BASE}/authen/v1/authorize` +
    `?app_id=${creds.appId}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(OAUTH_SCOPES)}` +
    `&state=${encodeURIComponent(state)}`
  );
}

// ---- OAuth 回调 HTTP server ----

export interface OAuthTokenResult {
  openId: string;
  chatJid: string;
  groupFolder: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export function startOAuthCallbackServer(
  onToken: (result: OAuthTokenResult) => Promise<void>,
): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${CALLBACK_PORT}`);

    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') || '';

    if (!code) {
      res.writeHead(400);
      res.end('Missing code parameter');
      return;
    }

    // state 格式: chatJid|groupFolder（chatJid 本身含冒号如 fs:oc_xxx，所以用 | 分隔）
    const sepIdx = state.lastIndexOf('|');
    const chatJid = sepIdx > 0 ? state.slice(0, sepIdx) : state;
    const groupFolder = sepIdx > 0 ? state.slice(sepIdx + 1) : '';

    const tokenResult = await exchangeCodeForToken(code);
    if (!tokenResult) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<html><body><h2>❌ 授权失败</h2><p>无法获取 token，请重试。</p></body></html>',
      );
      return;
    }

    // 存入 DB
    const expiresAt = new Date(
      Date.now() + tokenResult.expiresIn * 1000,
    ).toISOString();
    setFeishuToken(
      tokenResult.openId,
      chatJid || '',
      tokenResult.accessToken,
      tokenResult.refreshToken,
      expiresAt,
    );
    tokenCache.set(cacheKey(tokenResult.openId), {
      token: tokenResult.accessToken,
      expiresAt: new Date(Date.now() + tokenResult.expiresIn * 1000),
    });

    // 通知回调
    try {
      await onToken({
        openId: tokenResult.openId,
        chatJid: chatJid || '',
        groupFolder: groupFolder || '',
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken,
        expiresIn: tokenResult.expiresIn,
      });
    } catch (err) {
      logger.error({ err }, 'OAuth onToken 回调失败');
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;">' +
        '<div style="text-align:center"><h2>✅ 授权成功</h2><p>可以关闭此页面，返回飞书继续使用。</p></div>' +
        '</body></html>',
    );
  });

  server.listen(CALLBACK_PORT, '0.0.0.0', () => {
    logger.info({ port: CALLBACK_PORT }, '飞书 OAuth 回调 server 已启动');
  });

  server.on('error', (err) => {
    logger.warn({ err }, '飞书 OAuth 回调 server 启动失败（端口可能被占用）');
  });

  return server;
}

// ---- 定时主动刷新所有用户 token ----

const REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000; // 每 2 小时扫一次

export function startTokenRefreshTimer(): void {
  const tick = async () => {
    const users = getAllFeishuTokenUsers();
    for (const { user_id } of users) {
      try {
        await getFeishuUserToken(user_id);
      } catch (err) {
        logger.warn({ err, userId: user_id }, '飞书 token 定时刷新失败');
      }
    }
    if (users.length > 0) {
      logger.info({ count: users.length }, '飞书 token 定时刷新完成');
    }
  };

  // 启动后 30 秒先跑一次，之后每 2 小时
  setTimeout(tick, 30_000);
  setInterval(tick, REFRESH_INTERVAL_MS);
  logger.info('飞书 token 定时刷新已启动（每 2 小时）');
}
