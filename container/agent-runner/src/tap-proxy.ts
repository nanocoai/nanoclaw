/**
 * Tap Proxy — MITM 代理，拦截 Claude CLI 到 Anthropic API 的 SSE 响应流
 *
 * 架构：
 *   Claude CLI ──HTTPS_PROXY──▶ Tap Proxy (localhost:PORT)
 *                                  │ TLS 终止（自签 CA）
 *                                  │ 拦截 SSE 响应
 *                                  ▼
 *                              ──HTTPS_PROXY──▶ OneCLI (localhost:10254)
 *                                                  │ 注入 API key
 *                                                  ▼
 *                                              api.anthropic.com
 *
 * 拦截仅针对 api.anthropic.com 的 POST /v1/messages 请求。
 * 其他请求直接透传到上游代理。
 */

import http from 'http';
import https from 'https';
import net from 'net';
import tls from 'tls';
import { EventEmitter } from 'events';
import { URL } from 'url';
import { StringDecoder } from 'node:string_decoder';
import {
  parseSseLines,
  parseSseEvent,
  type SseEvent,
} from './sse-parser.js';

// ---- 证书管理 ----

/**
 * 生成自签 CA 证书（用于 TLS 终止）
 * 使用 Node.js 内置 crypto（无需 openssl CLI）
 */
export async function generateCaCertificate(): Promise<{ cert: string; key: string }> {
  // 动态导入 node-forge（如果可用）或回退到 openssl 命令
  const { execSync } = await import('child_process');
  const os = await import('os');
  const path = await import('path');
  const fs = await import('fs');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-ca-'));
  const keyPath = path.join(tmpDir, 'ca.key');
  const certPath = path.join(tmpDir, 'ca.crt');

  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" ` +
      `-days 365 -nodes -subj "/CN=NanoClaw Tap Proxy CA" 2>/dev/null`,
    );
    const key = fs.readFileSync(keyPath, 'utf-8');
    const cert = fs.readFileSync(certPath, 'utf-8');
    return { cert, key };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
}

/**
 * 为指定域名生成服务器证书（由 CA 签发）
 */
export async function generateServerCertificate(
  caCert: string,
  caKey: string,
  hostname: string,
): Promise<{ cert: string; key: string }> {
  const { execSync } = await import('child_process');
  const os = await import('os');
  const path = await import('path');
  const fs = await import('fs');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-srv-'));
  const caKeyPath = path.join(tmpDir, 'ca.key');
  const caCertPath = path.join(tmpDir, 'ca.crt');
  const srvKeyPath = path.join(tmpDir, 'srv.key');
  const srvCsrPath = path.join(tmpDir, 'srv.csr');
  const srvCertPath = path.join(tmpDir, 'srv.crt');
  const extPath = path.join(tmpDir, 'ext.cnf');

  try {
    fs.writeFileSync(caKeyPath, caKey);
    fs.writeFileSync(caCertPath, caCert);
    fs.writeFileSync(extPath, `subjectAltName=DNS:${hostname}\n`);

    // 生成服务器密钥 + CSR
    execSync(
      `openssl req -newkey rsa:2048 -keyout "${srvKeyPath}" -out "${srvCsrPath}" ` +
      `-nodes -subj "/CN=${hostname}" 2>/dev/null`,
    );
    // CA 签发
    execSync(
      `openssl x509 -req -in "${srvCsrPath}" -CA "${caCertPath}" -CAkey "${caKeyPath}" ` +
      `-CAcreateserial -out "${srvCertPath}" -days 365 -extfile "${extPath}" 2>/dev/null`,
    );

    return {
      cert: fs.readFileSync(srvCertPath, 'utf-8'),
      key: fs.readFileSync(srvKeyPath, 'utf-8'),
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
}

// ---- SSE 事件路由 ----

export interface TapSubscription {
  onEvent: (event: SseEvent) => void;
  onError: (error: Error) => void;
  onEnd: () => void;
  /** SSE 流数量变化通知（+1 开始新流，-1 流结束） */
  onActiveStreamsChange?: (activeCount: number) => void;
}

// ---- Tap Proxy 主类 ----

export interface TapProxyConfig {
  /** 上游代理 URL（OneCLI），如 http://x:<token>@localhost:10254 */
  upstreamProxy: string;
  /** 上游代理的 CA 证书 PEM（信任 OneCLI 的自签 CA） */
  upstreamCaCert?: string;
  /** Credential Proxy（cli-proxy-api）— 直接 HTTP 转发，用 OAuth 凭证调 API */
  credentialProxy?: { url: string; apiKey: string };
  /** 日志函数 */
  log: (message: string) => void;
}

export class TapProxy extends EventEmitter {
  private server: http.Server | null = null;
  private port = 0;
  private caCert = '';
  private caKey = '';
  private serverCertCache = new Map<string, { cert: string; key: string }>();
  private subscriptions = new Map<string, TapSubscription>();
  private activeSseStreams = new Map<string, number>();
  private upstreamProxy: URL;
  private upstreamCaCert?: string;
  private credentialProxy?: { url: URL; apiKey: string };
  private log: (message: string) => void;
  // 运行时可更新的上游 token（按 session 标识）
  private upstreamTokenOverrides = new Map<string, string>();

  constructor(config: TapProxyConfig) {
    super();
    this.upstreamProxy = new URL(config.upstreamProxy);
    this.upstreamCaCert = config.upstreamCaCert;
    if (config.credentialProxy) {
      this.credentialProxy = {
        url: new URL(config.credentialProxy.url),
        apiKey: config.credentialProxy.apiKey,
      };
    }
    this.log = config.log;
  }

  /** 启动代理，返回监听端口 */
  async start(): Promise<number> {
    // 生成 CA
    const ca = await generateCaCertificate();
    this.caCert = ca.cert;
    this.caKey = ca.key;

    this.server = http.createServer();

    // 处理 CONNECT 隧道请求
    this.server.on('connect', (req, clientSocket: net.Socket, head) => {
      this.handleConnect(req, clientSocket, head);
    });

    // 普通 HTTP 请求直接透传（不应该出现，但以防万一）
    this.server.on('request', (_req, res) => {
      res.writeHead(405);
      res.end('Only CONNECT tunnels are supported');
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address() as net.AddressInfo;
        this.port = addr.port;
        this.log(`[tap-proxy] listening on 127.0.0.1:${this.port}`);
        resolve(this.port);
      });
      this.server!.on('error', reject);
    });
  }

  /** 获取 CA 证书 PEM（供 Claude CLI 信任） */
  getCaCertificate(): string {
    return this.caCert;
  }

  /** 获取监听端口 */
  getPort(): number {
    return this.port;
  }

  /** 注册 SSE 事件订阅（按 session token 区分） */
  subscribe(sessionToken: string, subscription: TapSubscription): void {
    this.subscriptions.set(sessionToken, subscription);
  }

  /** 取消订阅 */
  unsubscribe(sessionToken: string): void {
    this.subscriptions.delete(sessionToken);
  }

  /** 更新指定 session 的上游 proxy token（账号轮换） */
  updateUpstreamToken(sessionToken: string, newToken: string): void {
    this.upstreamTokenOverrides.set(sessionToken, newToken);
    this.log(`[tap-proxy] upstream token updated for session ${sessionToken.slice(0, 8)}...`);
  }

  /** 停止代理（关闭所有活跃连接） */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        // closeAllConnections 关闭所有活跃 socket（Node 18.2+）
        this.server.closeAllConnections();
        this.server.close(() => {
          this.log('[tap-proxy] stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /** 构建代理 URL（供 Claude CLI 的 HTTPS_PROXY 使用） */
  getProxyUrl(sessionToken: string): string {
    return `http://x:${sessionToken}@127.0.0.1:${this.port}`;
  }

  // ---- 内部方法 ----

  private async handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    const target = req.url || '';
    const [hostname, portStr] = target.split(':');
    const port = parseInt(portStr) || 443;

    // 从 Proxy-Authorization header 或 URL 中提取 session token
    const proxyAuth = req.headers['proxy-authorization'];
    let sessionToken = '';
    if (proxyAuth) {
      // Basic base64(user:password) — password 可能包含冒号（如 chatJid 中的 "fs:oc_xxx"），
      // 所以只按第一个冒号分割（user:rest），rest 整体作为 sessionToken。
      const decoded = Buffer.from(proxyAuth.replace('Basic ', ''), 'base64').toString();
      const colonIdx = decoded.indexOf(':');
      sessionToken = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : '';
    }

    this.log(`[tap-proxy] CONNECT ${target} (session: ${sessionToken.slice(0, 8)}...)`);

    // 只拦截 api.anthropic.com，其他直接透传到上游
    if (!hostname.includes('anthropic.com')) {
      this.tunnelToUpstream(clientSocket, head, target, sessionToken);
      return;
    }

    // 拦截模式：TLS 终止 + 读取明文 HTTP
    try {
      // 告诉客户端隧道已建立
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      // 获取或生成该域名的服务器证书
      let serverCert = this.serverCertCache.get(hostname);
      if (!serverCert) {
        serverCert = await generateServerCertificate(this.caCert, this.caKey, hostname);
        this.serverCertCache.set(hostname, serverCert);
      }

      // 创建 TLS 服务端（与 Claude CLI 建立 TLS）
      const tlsSocket = new tls.TLSSocket(clientSocket, {
        isServer: true,
        secureContext: tls.createSecureContext({
          cert: serverCert.cert,
          key: serverCert.key,
        }),
      });

      // 处理初始数据
      if (head.length > 0) {
        tlsSocket.unshift(head);
      }

      // 读取 TLS 解密后的 HTTP 请求
      this.handleDecryptedConnection(tlsSocket, hostname, port, sessionToken);
    } catch (err) {
      this.log(`[tap-proxy] TLS setup error: ${err}`);
      clientSocket.destroy();
    }
  }

  /** 非拦截目标：直接隧道到上游代理 */
  private tunnelToUpstream(
    clientSocket: net.Socket,
    head: Buffer,
    target: string,
    sessionToken: string,
  ): void {
    const upstreamToken = this.upstreamTokenOverrides.get(sessionToken) || this.upstreamProxy.password;
    const upstreamHost = this.upstreamProxy.hostname;
    const upstreamPort = parseInt(this.upstreamProxy.port) || 10254;

    const upstream = net.connect(upstreamPort, upstreamHost, () => {
      // 发送 CONNECT 到上游代理
      const auth = Buffer.from(`x:${upstreamToken}`).toString('base64');
      upstream.write(
        `CONNECT ${target} HTTP/1.1\r\n` +
        `Host: ${target}\r\n` +
        `Proxy-Authorization: Basic ${auth}\r\n` +
        `\r\n`,
      );
    });

    let connected = false;
    let buffer = '';

    upstream.on('data', (data: Buffer) => {
      if (!connected) {
        buffer += data.toString();
        if (buffer.includes('\r\n\r\n')) {
          // 校验上游 CONNECT 响应状态码
          const statusLine = buffer.split('\r\n')[0];
          if (!statusLine.includes(' 200 ')) {
            this.log(`[tap-proxy] upstream CONNECT failed: ${statusLine}`);
            clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\n`);
            clientSocket.destroy();
            upstream.destroy();
            return;
          }
          connected = true;
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length > 0) upstream.write(head);
          clientSocket.pipe(upstream);
          upstream.pipe(clientSocket);
        }
      }
    });

    upstream.on('error', (err) => {
      this.log(`[tap-proxy] upstream tunnel error: ${err.message}`);
      clientSocket.destroy();
    });
    clientSocket.on('error', () => upstream.destroy());
  }

  /** 处理 TLS 解密后的明文 HTTP 连接 */
  private handleDecryptedConnection(
    tlsSocket: tls.TLSSocket,
    hostname: string,
    port: number,
    sessionToken: string,
  ): void {
    // 使用 Buffer 收集 body，避免 chunk.toString() 截断多字节 UTF-8 字符
    let headerBuffer = Buffer.alloc(0);
    let inBody = false;
    let contentLength = 0;
    let bodyReceived = 0;
    let currentMethod = '';
    let currentPath = '';
    let currentHeaders: Record<string, string> = {};
    let bodyParts: Buffer[] = [];
    const CRLFCRLF = Buffer.from('\r\n\r\n');

    const resetRequest = () => {
      headerBuffer = Buffer.alloc(0);
      inBody = false;
      contentLength = 0;
      bodyReceived = 0;
      currentMethod = '';
      currentPath = '';
      currentHeaders = {};
      bodyParts = [];
    };

    tlsSocket.on('data', (chunk: Buffer) => {
      if (!inBody) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);

        // 在原始 Buffer 中查找 header 边界
        const headerEnd = headerBuffer.indexOf(CRLFCRLF);
        if (headerEnd === -1) return;

        // 解析 header（HTTP header 是 ASCII，string 转换安全）
        const headerStr = headerBuffer.subarray(0, headerEnd).toString('ascii');
        const lines = headerStr.split('\r\n');
        const [method, path] = (lines[0] || '').split(' ');
        currentMethod = method || '';
        currentPath = path || '';

        for (let i = 1; i < lines.length; i++) {
          const colonIdx = lines[i].indexOf(':');
          if (colonIdx > 0) {
            const key = lines[i].slice(0, colonIdx).trim().toLowerCase();
            const value = lines[i].slice(colonIdx + 1).trim();
            currentHeaders[key] = value;
          }
        }

        contentLength = parseInt(currentHeaders['content-length'] || '0');
        inBody = true;

        // 剩余数据作为 body 的一部分（保持 Buffer，不做 string 转换）
        const bodyStart = headerBuffer.subarray(headerEnd + 4);
        if (bodyStart.length > 0) {
          bodyParts.push(Buffer.from(bodyStart));
          bodyReceived += bodyStart.length;
        }
      } else {
        bodyParts.push(chunk);
        bodyReceived += chunk.length;
      }

      // body 收完了，转发请求
      // 此时 Buffer.concat 再 toString('utf-8') 一次性转换，不会截断多字节字符
      if (inBody && (bodyReceived >= contentLength || contentLength === 0)) {
        const body = Buffer.concat(bodyParts).toString('utf-8');
        this.forwardAndIntercept(
          tlsSocket, hostname, port, sessionToken,
          currentMethod, currentPath, currentHeaders, body,
        );
        resetRequest();
      }
    });

    tlsSocket.on('error', (err) => {
      this.log(`[tap-proxy] tls socket error: ${err.message}`);
    });

    tlsSocket.on('close', () => {
      this.log(`[tap-proxy] tls connection closed (session: ${sessionToken.slice(0, 8)}...)`);
    });
  }

  /** 转发请求到上游并拦截 SSE 响应 */
  private forwardAndIntercept(
    clientTlsSocket: tls.TLSSocket,
    hostname: string,
    port: number,
    sessionToken: string,
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string,
  ): void {
    // 只拦截 POST /v1/messages（真正的 prompt 请求）
    // GET /v1/messages、PUT /v1/messages 等不拦截
    const isMessagesApi = method === 'POST' && path.includes('/v1/messages');
    const subscription = this.subscriptions.get(sessionToken);
    const shouldIntercept = isMessagesApi && subscription;

    if (shouldIntercept) {
      this.log(`[tap-proxy] intercepting ${method} ${path} (body: ${Buffer.byteLength(body || '', 'utf-8')} bytes)`);
    } else if (isMessagesApi && !subscription) {
      this.log(`[tap-proxy] ⚠️ messages API 请求未匹配 subscription (session: ${sessionToken.slice(0, 8)}..., 已注册: [${[...this.subscriptions.keys()].map(k => k.slice(0, 8)).join(', ')}])`);
    }

    // 优先走 credential proxy（直接 HTTP 转发，OAuth 凭证）
    if (this.credentialProxy) {
      this.forwardViaCredentialProxy(
        clientTlsSocket, sessionToken, method, path, headers, body,
        shouldIntercept ? subscription : null,
      );
      return;
    }

    // 回退：走 CONNECT 隧道到上游代理
    this.forwardViaConnectTunnel(
      clientTlsSocket, hostname, port, sessionToken, method, path, headers, body,
      shouldIntercept ? subscription : null,
    );
  }

  /** 通过 credential proxy（如 cli-proxy-api）直接 HTTP 转发 */
  private forwardViaCredentialProxy(
    clientTlsSocket: tls.TLSSocket,
    sessionToken: string,
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string,
    subscription: TapSubscription | null,
  ): void {
    const proxy = this.credentialProxy!;
    const proxyHost = proxy.url.hostname;
    const proxyPort = parseInt(proxy.url.port) || 8317;

    // 替换 auth header 为 credential proxy 的 API key
    const reqHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      // 跳过 CLI 自带的 auth header、proxy header 和 content-length（需重新计算）
      // 当拦截 SSE 时也跳过 accept-encoding，避免压缩数据无法解析
      if (lk === 'x-api-key' || lk === 'authorization' || lk === 'proxy-authorization' || lk === 'content-length') continue;
      if (lk === 'accept-encoding' && subscription) continue;
      reqHeaders[k] = v;
    }
    reqHeaders['x-api-key'] = proxy.apiKey;
    reqHeaders['host'] = `${proxyHost}:${proxyPort}`;
    // body 经过 chunk.toString() 拼接后字节数可能和原始 Content-Length 不一致，重新计算
    if (body) {
      reqHeaders['content-length'] = String(Buffer.byteLength(body, 'utf-8'));
    }

    this.log(`[tap-proxy] credential proxy → ${method} ${path} (body: ${Buffer.byteLength(body || '', 'utf-8')} bytes, host: ${reqHeaders['host']}, content-type: ${reqHeaders['content-type'] || 'N/A'})`);

    // 直接 HTTP 请求到 credential proxy（必须绕过 http_proxy 环境变量）
    const reqOptions: http.RequestOptions = {
      hostname: proxyHost,
      port: proxyPort,
      path,
      method,
      headers: reqHeaders,
      agent: new http.Agent(), // 绕过 EnvHttpProxyAgent，直连 localhost
    };

    const proxyReq = http.request(reqOptions, (proxyRes) => {
      const ct = proxyRes.headers['content-type'] || '';
      this.log(`[tap-proxy] credential proxy ← ${proxyRes.statusCode} ${proxyRes.statusMessage} (content-type: ${ct}, subscription: ${!!subscription})`);
      // 构建 HTTP 响应发回客户端（CLI 期望 HTTPS 响应格式）
      // 注意：Node.js http module 自动解码 chunked encoding，
      // proxyRes.on('data') 给的是原始数据而非 chunked 编码的数据。
      // 因此必须过滤 transfer-encoding 和 content-length，避免客户端解析错误。
      let responseHeader = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        const lk = key.toLowerCase();
        // 过滤掉 transfer-encoding（Node.js 已解码）和 content-length（流式不知道总长度）
        if (lk === 'transfer-encoding' || lk === 'content-length') continue;
        if (Array.isArray(value)) {
          for (const v of value) responseHeader += `${key}: ${v}\r\n`;
        } else if (value) {
          responseHeader += `${key}: ${value}\r\n`;
        }
      }
      responseHeader += '\r\n';

      try { clientTlsSocket.write(responseHeader); } catch { /* client gone */ }

      const isSSE = ct.includes('text/event-stream');
      let sseLineBuffer = '';
      let currentSseBlock: string[] = [];
      let chunkCount = 0;

      // 追踪活跃 SSE 流数量
      if (subscription && isSSE) {
        const count = (this.activeSseStreams.get(sessionToken) || 0) + 1;
        this.activeSseStreams.set(sessionToken, count);
        subscription.onActiveStreamsChange?.(count);
      } else if (!subscription && isSSE) {
        this.log(`[tap-proxy] ⚠️ SSE 响应到达但无 subscription (session: ${sessionToken.slice(0, 8)}..., 已注册: [${[...this.subscriptions.keys()].map(k => k.slice(0, 8)).join(', ')}])`);
      }

      proxyRes.on('data', (chunk: Buffer) => {
        chunkCount++;
        // 始终透传给客户端
        try { clientTlsSocket.write(chunk); } catch { /* client gone */ }

        if (!subscription || !isSSE) return;
        if (chunkCount <= 2) {
          this.log(`[tap-proxy] SSE chunk #${chunkCount} (${chunk.length} bytes): ${chunk.toString().slice(0, 100).replace(/\n/g, '\\n')}`);
        }

        // 解析 SSE
        const result = this.processSseChunk(
          chunk.toString(), sseLineBuffer, currentSseBlock, subscription,
        );
        sseLineBuffer = result.lineBuffer;
        currentSseBlock = result.block;
      });

      proxyRes.on('end', () => {
        try { clientTlsSocket.end(); } catch { /* ignore */ }
        // 只对 SSE 流触发 subscription 回调；非 SSE 响应的 end 不应终结 subscription
        if (subscription && isSSE) {
          if (currentSseBlock.length > 0) {
            const parsed = parseSseLines(currentSseBlock);
            if (parsed) {
              const event = parseSseEvent(parsed.event, parsed.data);
              if (event) subscription.onEvent(event);
            }
          }
          // 递减活跃流计数，通知 subscription
          const remaining = Math.max(0, (this.activeSseStreams.get(sessionToken) || 1) - 1);
          this.activeSseStreams.set(sessionToken, remaining);
          subscription.onActiveStreamsChange?.(remaining);
          subscription.onEnd();
        }
      });

      proxyRes.on('error', (err) => {
        this.log(`[tap-proxy] credential proxy response error: ${err.message}`);
        if (subscription && isSSE) {
          // 递减活跃流计数
          const remaining = Math.max(0, (this.activeSseStreams.get(sessionToken) || 1) - 1);
          this.activeSseStreams.set(sessionToken, remaining);
          subscription.onActiveStreamsChange?.(remaining);
          subscription.onError(err);
        }
        try { clientTlsSocket.destroy(); } catch { /* ignore */ }
      });
    });

    proxyReq.on('error', (err: NodeJS.ErrnoException) => {
      this.log(`[tap-proxy] credential proxy request error: ${err.message} (code: ${err.code || 'N/A'}, hostname: ${proxyHost}:${proxyPort})`);
      if (subscription) subscription.onError(err);
      clientTlsSocket.destroy();
    });

    proxyReq.on('socket', (socket) => {
      socket.on('connect', () => {
        this.log(`[tap-proxy] credential proxy TCP connected to ${socket.remoteAddress}:${socket.remotePort}`);
      });
    });

    if (body) proxyReq.write(body);
    proxyReq.end();

    clientTlsSocket.on('close', () => {
      proxyReq.destroy();
    });
  }

  /** 通过 CONNECT 隧道转发到上游代理（原逻辑） */
  private forwardViaConnectTunnel(
    clientTlsSocket: tls.TLSSocket,
    hostname: string,
    port: number,
    sessionToken: string,
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string,
    subscription: TapSubscription | null,
  ): void {
    const upstreamToken = this.upstreamTokenOverrides.get(sessionToken) || this.upstreamProxy.password;
    const upstreamHost = this.upstreamProxy.hostname;
    const upstreamPort = parseInt(this.upstreamProxy.port) || 10254;

    const proxySocket = net.connect(upstreamPort, upstreamHost, () => {
      const auth = Buffer.from(`x:${upstreamToken}`).toString('base64');
      proxySocket.write(
        `CONNECT ${hostname}:${port} HTTP/1.1\r\n` +
        `Host: ${hostname}:${port}\r\n` +
        `Proxy-Authorization: Basic ${auth}\r\n` +
        `\r\n`,
      );
    });

    let proxyConnected = false;
    let proxyHeaderBuffer = '';
    let upstreamTlsSocket: tls.TLSSocket | null = null;

    proxySocket.on('data', (data: Buffer) => {
      if (proxyConnected) return;

      proxyHeaderBuffer += data.toString();
      if (!proxyHeaderBuffer.includes('\r\n\r\n')) return;

      const statusLine = proxyHeaderBuffer.split('\r\n')[0];
      if (!statusLine.includes(' 200 ')) {
        this.log(`[tap-proxy] upstream CONNECT failed for ${hostname}: ${statusLine}`);
        if (subscription) subscription.onError(new Error(`Upstream CONNECT failed: ${statusLine}`));
        clientTlsSocket.destroy();
        proxySocket.destroy();
        return;
      }

      proxyConnected = true;

      const tlsOptions: tls.ConnectionOptions = {
        socket: proxySocket,
        servername: hostname,
        ...(this.upstreamCaCert ? {
          ca: this.upstreamCaCert,
        } : {
          rejectUnauthorized: false,
        }),
      };

      upstreamTlsSocket = tls.connect(tlsOptions, () => {
        const reqHeaders = { ...headers };
        delete reqHeaders['proxy-authorization'];
        reqHeaders['host'] = hostname;

        // 当需要拦截 SSE 响应时，移除 accept-encoding 让 API 返回明文
        // 否则 gzip 压缩数据无法作为 SSE 文本解析
        if (subscription) {
          for (const k of Object.keys(reqHeaders)) {
            if (k.toLowerCase() === 'accept-encoding') {
              delete reqHeaders[k];
            }
          }
        }

        let reqStr = `${method} ${path} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(reqHeaders)) {
          reqStr += `${k}: ${v}\r\n`;
        }
        reqStr += `\r\n`;

        upstreamTlsSocket!.write(reqStr);
        if (body) {
          upstreamTlsSocket!.write(body);
        }

        this.readUpstreamResponse(
          upstreamTlsSocket!,
          clientTlsSocket,
          subscription,
        );
      });

      upstreamTlsSocket.on('error', (err) => {
        this.log(`[tap-proxy] upstream TLS error: ${err.message}`);
        clientTlsSocket.destroy();
        proxySocket.destroy();
      });
    });

    proxySocket.on('error', (err) => {
      this.log(`[tap-proxy] proxy socket error: ${err.message}`);
      clientTlsSocket.destroy();
    });

    clientTlsSocket.on('close', () => {
      if (upstreamTlsSocket) upstreamTlsSocket.destroy();
      proxySocket.destroy();
    });
  }

  /** 读取上游响应，同时透传给客户端和拦截 SSE */
  private readUpstreamResponse(
    upstream: tls.TLSSocket,
    client: tls.TLSSocket,
    subscription: TapSubscription | null,
  ): void {
    let headerDone = false;
    let headerRawBuf = Buffer.alloc(0);
    let isSSE = false;
    let sseLineBuffer = '';
    let currentSseBlock: string[] = [];
    // StringDecoder 会缓存不完整的多字节 UTF-8 序列，等下一个 chunk 补齐后再输出
    // 避免 chunk.toString() 在字符边界处截断导致乱码，进而破坏 SSE 解析
    const decoder = new StringDecoder('utf-8');

    upstream.on('data', (chunk: Buffer) => {
      // 始终透传给客户端（原始 Buffer，不经过解码）
      try {
        client.write(chunk);
      } catch {
        // 客户端断开，继续读完上游
      }

      if (!subscription) return;

      if (!headerDone) {
        headerRawBuf = Buffer.concat([headerRawBuf, chunk]);
        const CRLFCRLF = Buffer.from('\r\n\r\n');
        const headerEnd = headerRawBuf.indexOf(CRLFCRLF);
        if (headerEnd === -1) return;

        // HTTP 响应头是 ASCII，直接 toString 安全
        const headerStr = headerRawBuf.subarray(0, headerEnd).toString('ascii').toLowerCase();
        isSSE = headerStr.includes('text/event-stream');
        headerDone = true;

        if (!isSSE) return;

        // 剩余数据作为 SSE 内容，通过 StringDecoder 安全解码
        const sseRaw = headerRawBuf.subarray(headerEnd + 4);
        if (sseRaw.length > 0) {
          const sseData = decoder.write(sseRaw);
          const result = this.processSseChunk(sseData, sseLineBuffer, currentSseBlock, subscription);
          sseLineBuffer = result.lineBuffer;
          currentSseBlock = result.block;
        }
        return;
      }

      if (!isSSE) return;

      // 通过 StringDecoder 安全解码，处理跨 chunk 的多字节字符
      const data = decoder.write(chunk);
      if (data) {
        const result = this.processSseChunk(data, sseLineBuffer, currentSseBlock, subscription);
        sseLineBuffer = result.lineBuffer;
        currentSseBlock = result.block;
      }
    });

    upstream.on('end', () => {
      try {
        client.end();
      } catch { /* ignore */ }

      if (subscription) {
        // flush StringDecoder 残留的不完整字符
        const remaining = decoder.end();
        if (remaining && isSSE) {
          const result = this.processSseChunk(remaining, sseLineBuffer, currentSseBlock, subscription);
          sseLineBuffer = result.lineBuffer;
          currentSseBlock = result.block;
        }
        // 处理残留的 SSE block
        if (currentSseBlock.length > 0) {
          const parsed = parseSseLines(currentSseBlock);
          if (parsed) {
            const event = parseSseEvent(parsed.event, parsed.data);
            if (event) subscription.onEvent(event);
          }
        }
        subscription.onEnd();
      }
    });

    upstream.on('error', (err) => {
      this.log(`[tap-proxy] upstream response error: ${err.message}`);
      if (subscription) {
        subscription.onError(err);
      }
      try { client.destroy(); } catch { /* ignore */ }
    });
  }

  /** 处理 SSE 数据块，返回更新的缓冲区状态 */
  private processSseChunk(
    data: string,
    lineBuffer: string,
    block: string[],
    subscription: TapSubscription,
  ): { lineBuffer: string; block: string[] } {
    lineBuffer += data;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || ''; // 最后一行可能不完整
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, '');

      if (trimmed === '') {
        // 空行 = SSE 事件分隔符
        if (block.length > 0) {
          const parsed = parseSseLines(block);
          if (parsed) {
            const event = parseSseEvent(parsed.event, parsed.data);
            if (event) {
              try {
                subscription.onEvent(event);
              } catch (err) {
                this.log(`[tap-proxy] subscription onEvent error: ${err}`);
              }
            }
          }
          block = [];
        }
      } else {
        block.push(trimmed);
      }
    }

    return { lineBuffer, block };
  }
}
