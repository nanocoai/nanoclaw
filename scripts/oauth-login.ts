#!/usr/bin/env npx tsx
/**
 * OAuth PKCE 登录脚本 — 为 NanoClaw /usage 命令绑定 refresh token
 *
 * 用法：
 *   npx tsx scripts/oauth-login.ts <secret-name>
 *
 * 例：
 *   npx tsx scripts/oauth-login.ts anthropic-tian
 *
 * 流程：
 *   1. 生成 PKCE code_verifier + code_challenge
 *   2. 打开浏览器让用户在 claude.ai 授权
 *   3. 本地 HTTP 服务器接收回调，拿到 authorization code
 *   4. 用 code 换 access_token + refresh_token
 *   5. 存入 NanoClaw SQLite (oauth_credentials 表)
 */

import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CALLBACK_PORT = 18923;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const AUTH_HOST = 'claude.com';
const TOKEN_HOST = 'platform.claude.com';
const TOKEN_PATH = '/v1/oauth/token';
const SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload org:create_api_key';

// --- 工具函数（照搬 Claude Code src/services/oauth/crypto.ts）---

function base64URLEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generatePKCE() {
  const verifier = base64URLEncode(crypto.randomBytes(32));
  const challenge = base64URLEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function buildAuthUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    code: 'true',
    client_id: OAUTH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `https://${AUTH_HOST}/cai/oauth/authorize?${params.toString()}`;
}

function exchangeCode(
  code: string,
  verifier: string,
  state: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: OAUTH_CLIENT_ID,
      code_verifier: verifier,
      state,
    });

    const req = https.request(
      {
        hostname: TOKEN_HOST,
        path: TOKEN_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`JSON 解析失败: ${data}`));
            }
          } else {
            reject(new Error(`Token 交换失败 (${res.statusCode}): ${data}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.end(body);
  });
}

function refreshForScope(
  refreshToken: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number; scope: string } | null> {
  return new Promise((resolve) => {
    // 必须用 form-urlencoded 且不带 scope（与 Claude Code 一致）
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }).toString();

    const req = https.request(
      {
        hostname: TOKEN_HOST,
        path: TOKEN_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': String(Buffer.byteLength(body)),
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(null);
            }
          } else {
            console.warn(`Token 刷新失败 (${res.statusCode}): ${data}`);
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

function openBrowser(url: string) {
  try {
    if (process.platform === 'darwin') {
      execSync(`open "${url}"`);
    } else if (process.platform === 'linux') {
      execSync(`xdg-open "${url}"`);
    } else {
      console.log(`请手动打开: ${url}`);
    }
  } catch {
    console.log(`请手动打开: ${url}`);
  }
}

function getDbPath(): string {
  // 找 NanoClaw 的 store 目录
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const storePath = path.join(projectRoot, 'store', 'messages.db');
  if (fs.existsSync(storePath)) return storePath;

  // fallback: 环境变量
  const envStore = process.env.NANOCLAW_STORE_DIR;
  if (envStore) return path.join(envStore, 'messages.db');

  throw new Error(`找不到数据库文件: ${storePath}`);
}

// --- 主流程 ---

async function main() {
  const secretName = process.argv[2];
  if (!secretName) {
    console.error('用法: npx tsx scripts/oauth-login.ts <secret-name>');
    console.error('例:   npx tsx scripts/oauth-login.ts anthropic-tian');
    console.error('\n可用的 secret names:');
    try {
      const secrets = JSON.parse(
        execSync('onecli secrets list', { encoding: 'utf-8', timeout: 5000 }),
      ) as Array<{ name: string }>;
      secrets.forEach((s) => console.error(`  • ${s.name}`));
    } catch {
      console.error('  (无法读取 OneCLI secrets)');
    }
    process.exit(1);
  }

  const dbPath = getDbPath();
  console.log(`数据库: ${dbPath}`);
  console.log(`账号: ${secretName}`);
  console.log('');

  const { verifier, challenge } = generatePKCE();
  const state = base64URLEncode(crypto.randomBytes(32));

  // 启动本地 HTTP 服务器等待回调
  const codePromise = new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      const error = url.searchParams.get('error');
      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>❌ 授权失败</h1><p>${error}: ${url.searchParams.get('error_description') || ''}</p>`);
        server.close();
        reject(new Error(`OAuth 错误: ${error}`));
        return;
      }

      const returnedState = url.searchParams.get('state');
      if (returnedState !== state) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>❌ State 不匹配</h1>');
        server.close();
        reject(new Error('State mismatch'));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>❌ 缺少 authorization code</h1>');
        server.close();
        reject(new Error('Missing code'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>✅ 授权成功！</h1><p>可以关闭此页面。</p>');
      server.close();
      resolve(code);
    });

    server.listen(CALLBACK_PORT, () => {
      console.log(`等待授权回调 (http://localhost:${CALLBACK_PORT}/callback)...`);
    });

    // 60 秒超时
    setTimeout(() => {
      server.close();
      reject(new Error('授权超时 (60s)'));
    }, 60000);
  });

  // 打开浏览器
  const authUrl = buildAuthUrl(challenge, state);
  console.log('正在打开浏览器...');
  console.log(`如果浏览器没有自动打开，请手动访问:\n${authUrl}\n`);
  openBrowser(authUrl);

  // 等待 authorization code
  const code = await codePromise;
  console.log('收到授权码，正在交换 token...');

  // 交换 token
  const tokens = await exchangeCode(code, verifier, state);
  console.log('Token 交换成功！');

  // 用 refresh token 重新获取带 user:profile scope 的 access token
  // （初始授权返回的 token 可能缺少 user:profile scope，refresh 时可以 expand）
  console.log('正在刷新 token 以获取完整 scope...');
  const refreshed = await refreshForScope(tokens.refresh_token);
  if (refreshed) {
    console.log('Token 刷新成功，scope:', refreshed.scope);
  } else {
    console.log('补 scope 刷新未确认（网络抖动或已被轮换），进入验证刷新…');
  }

  // ⚠️ 存库前必须验证刷新一次（2026-06-12 复盘）：
  // Anthropic 的 refresh token 是 rotation 制——刷新请求一旦到达服务端，旧 token 立即作废。
  // 若上一步刷新的【响应】在网络抖动中丢失，本地手里的 token 其实已经死了；
  // 旧逻辑静默回退存入这个死 token，表面绑定成功，等 access_token 过期后必现
  // "凭证已失效"。这就是 tian/Elizabeth 反复"刚绑就失效"的根因。
  // 验证刷新拿到 200 响应才存库；拿不到就报错退出，绝不存可疑 token。
  const candidate = refreshed ?? tokens;
  console.log('正在验证 refresh token（存库前最后一道闸）...');
  const verified = await refreshForScope(candidate.refresh_token);
  if (!verified) {
    console.error('');
    console.error('❌ 验证刷新失败，token 状态不可信，已放弃存库。');
    console.error('   可能原因：1) 网络抖动导致轮换响应丢失（token 已被服务端作废）');
    console.error('            2) 到 platform.claude.com 的链路不通');
    console.error('   请确认网络稳定后重新跑一遍本脚本。数据库中的旧凭证未被覆盖。');
    process.exit(1);
  }
  const finalTokens = verified;
  console.log('验证通过，scope:', verified.scope);

  // 存入数据库
  const db = new Database(dbPath);

  // 确保表存在
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_credentials (
      secret_name TEXT PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      expires_at INTEGER,
      cached_usage TEXT,
      last_usage_check INTEGER,
      error_state TEXT,
      updated_at TEXT NOT NULL
    )
  `);

  db.prepare(
    `INSERT INTO oauth_credentials (secret_name, refresh_token, access_token, expires_at, error_state, cached_usage, last_usage_check, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)
     ON CONFLICT(secret_name) DO UPDATE SET
       refresh_token = excluded.refresh_token,
       access_token = excluded.access_token,
       expires_at = excluded.expires_at,
       error_state = NULL,
       cached_usage = NULL,
       last_usage_check = NULL,
       updated_at = excluded.updated_at`,
  ).run(
    secretName,
    finalTokens.refresh_token,
    finalTokens.access_token,
    Date.now() + finalTokens.expires_in * 1000,
    new Date().toISOString(),
  );

  db.close();

  console.log('');
  console.log(`✅ 已绑定 ${secretName}`);
  console.log(`   refresh_token: ${tokens.refresh_token.slice(0, 20)}...`);
  console.log(`   access_token 有效期: ${Math.round(tokens.expires_in / 3600)}h`);
  console.log('');
  console.log('现在可以在飞书群里用 /usage 查询配额了。');
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
