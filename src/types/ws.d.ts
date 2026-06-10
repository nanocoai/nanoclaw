/**
 * `ws` 库最小类型声明。
 *
 * 背景：node_modules 里有 ws@8.20.0（传递依赖）但没有 @types/ws，
 * 本仓库禁止 npm install（会破坏 better-sqlite3 native module），
 * 所以手写只覆盖 voice-ws.ts 用到的 API 面。
 */
declare module 'ws' {
  import type { IncomingMessage } from 'http';

  class WebSocket {
    static readonly OPEN: number;
    readonly readyState: number;
    /** 客户端构造（测试用） */
    constructor(address: string);
    send(data: string): void;
    ping(): void;
    terminate(): void;
    close(code?: number, reason?: string): void;
    on(event: 'open', listener: () => void): this;
    on(
      event: 'message',
      listener: (data: Buffer | ArrayBuffer | Buffer[]) => void,
    ): this;
    on(event: 'pong', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(
      event: 'close',
      listener: (code: number, reason: Buffer) => void,
    ): this;
  }

  class WebSocketServer {
    constructor(options: { port: number; host?: string });
    readonly clients: Set<WebSocket>;
    on(
      event: 'connection',
      listener: (ws: WebSocket, req: IncomingMessage) => void,
    ): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'listening', listener: () => void): this;
    close(cb?: (err?: Error) => void): void;
  }

  export { WebSocket, WebSocketServer };
}
