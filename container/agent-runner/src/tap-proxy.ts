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
}

// ---- Tap Proxy 主类 ----

export interface TapProxyConfig {
  /** 上游代理 URL（OneCLI），如 http://x:<token>@localhost:10254 */
  upstreamProxy: string;
  /** 上游代理的 CA 证书 PEM（信任 OneCLI 的自签 CA） */
  upstreamCaCert?: string;
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
  private upstreamProxy: URL;
  private upstreamCaCert?: string;
  private log: (message: string) => void;
  // 运行时可更新的上游 token（按 session 标识）
  private upstreamTokenOverrides = new Map<string, string>();

  constructor(config: TapProxyConfig) {
    super();
    this.upstreamProxy = new URL(config.upstreamProxy);
    this.upstreamCaCert = config.upstreamCaCert;
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
      // Basic base64(user:password)
      const decoded = Buffer.from(proxyAuth.replace('Basic ', ''), 'base64').toString();
      sessionToken = decoded.split(':')[1] || '';
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
    let requestBuffer = '';
    let inBody = false;
    let contentLength = 0;
    let bodyReceived = 0;
    let currentMethod = '';
    let currentPath = '';
    let currentHeaders: Record<string, string> = {};
    let bodyParts: string[] = [];

    const resetRequest = () => {
      requestBuffer = '';
      inBody = false;
      contentLength = 0;
      bodyReceived = 0;
      currentMethod = '';
      currentPath = '';
      currentHeaders = {};
      bodyParts = [];
    };

    tlsSocket.on('data', (chunk: Buffer) => {
      const data = chunk.toString();

      if (!inBody) {
        requestBuffer += data;

        // 检查是否收到完整 header
        const headerEnd = requestBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        // 解析 header
        const headerStr = requestBuffer.slice(0, headerEnd);
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

        // 剩余数据作为 body 的一部分
        const bodyStart = requestBuffer.slice(headerEnd + 4);
        if (bodyStart.length > 0) {
          bodyParts.push(bodyStart);
          bodyReceived += Buffer.byteLength(bodyStart);
        }
      } else {
        bodyParts.push(data);
        bodyReceived += Buffer.byteLength(data);
      }

      // body 收完了，转发请求
      if (inBody && (bodyReceived >= contentLength || contentLength === 0)) {
        const body = bodyParts.join('');
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
    const isMessagesApi = path.includes('/v1/messages');
    const subscription = this.subscriptions.get(sessionToken);
    const shouldIntercept = isMessagesApi && subscription;

    if (shouldIntercept) {
      this.log(`[tap-proxy] intercepting ${method} ${path}`);
    }

    // 获取上游 token（可能被运行时更新过）
    const upstreamToken = this.upstreamTokenOverrides.get(sessionToken) || this.upstreamProxy.password;
    const upstreamHost = this.upstreamProxy.hostname;
    const upstreamPort = parseInt(this.upstreamProxy.port) || 10254;

    // 通过上游代理发送 CONNECT + 实际请求
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
      if (proxyConnected) return; // TLS 接管后不再处理

      proxyHeaderBuffer += data.toString();
      if (!proxyHeaderBuffer.includes('\r\n\r\n')) return;

      // 校验上游 CONNECT 响应状态码
      const statusLine = proxyHeaderBuffer.split('\r\n')[0];
      if (!statusLine.includes(' 200 ')) {
        this.log(`[tap-proxy] upstream CONNECT failed for ${hostname}: ${statusLine}`);
        if (subscription) subscription.onError(new Error(`Upstream CONNECT failed: ${statusLine}`));
        clientTlsSocket.destroy();
        proxySocket.destroy();
        return;
      }

      proxyConnected = true;

      // 建立到上游的 TLS 连接
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
        // TLS 握手成功，发送实际 HTTP 请求
        const reqHeaders = { ...headers };
        delete reqHeaders['proxy-authorization']; // 不转发 proxy auth
        reqHeaders['host'] = hostname;

        let reqStr = `${method} ${path} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(reqHeaders)) {
          reqStr += `${k}: ${v}\r\n`;
        }
        reqStr += `\r\n`;

        upstreamTlsSocket!.write(reqStr);
        if (body) {
          upstreamTlsSocket!.write(body);
        }

        // 读取上游响应
        this.readUpstreamResponse(
          upstreamTlsSocket!,
          clientTlsSocket,
          shouldIntercept ? subscription : null,
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

    // 客户端断开时清理上游连接
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
    let headerBuffer = '';
    let isSSE = false;
    let sseLineBuffer = '';
    let currentSseBlock: string[] = [];

    upstream.on('data', (chunk: Buffer) => {
      // 始终透传给客户端
      try {
        client.write(chunk);
      } catch {
        // 客户端断开，继续读完上游
      }

      if (!subscription) return;

      const data = chunk.toString();

      if (!headerDone) {
        headerBuffer += data;
        const headerEnd = headerBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        // 检查是否是 SSE 响应
        const headerStr = headerBuffer.slice(0, headerEnd).toLowerCase();
        isSSE = headerStr.includes('text/event-stream');
        headerDone = true;

        if (!isSSE) return;

        // 剩余数据作为 SSE 内容（直接调用 processSseChunk 并更新闭包状态）
        const sseData = headerBuffer.slice(headerEnd + 4);
        if (sseData) {
          const result = this.processSseChunk(sseData, sseLineBuffer, currentSseBlock, subscription);
          sseLineBuffer = result.lineBuffer;
          currentSseBlock = result.block;
        }
        return;
      }

      if (!isSSE) return;

      // 处理 SSE 数据
      const result = this.processSseChunk(data, sseLineBuffer, currentSseBlock, subscription);
      sseLineBuffer = result.lineBuffer;
      currentSseBlock = result.block;
    });

    upstream.on('end', () => {
      try {
        client.end();
      } catch { /* ignore */ }

      if (subscription) {
        // 处理残留数据
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
