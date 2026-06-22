/**
 * NanoClaw Logger — 双模输出 + AsyncLocalStorage correlation + 日志轮转
 *
 * - JSON 模式（非 TTY / LOG_FORMAT=json）：ndjson，可 jq 解析
 * - Pretty 模式（TTY / LOG_FORMAT=pretty）：ANSI 彩色，开发调试
 * - AsyncLocalStorage 自动注入 traceId（零调用点改动）
 * - RotatingFileStream 按大小轮转（JSON 模式写文件，Pretty 模式写 stdout/stderr）
 */
import fs from 'node:fs';
import path from 'node:path';
import { logContext } from './log-context.js';

// ── 日志级别 ──────────────────────────────────────────────
const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const threshold =
  LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

// ── 输出格式 ──────────────────────────────────────────────
const LOG_FORMAT: 'json' | 'pretty' =
  (process.env.LOG_FORMAT as 'json' | 'pretty') ||
  (process.stdout.isTTY ? 'pretty' : 'json');

// ── ANSI 颜色（仅 pretty 模式使用） ────────────────────────
const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

// ── 时间戳 ────────────────────────────────────────────────

function tsISO(): string {
  return new Date().toISOString();
}

function tsPretty(): string {
  const d = new Date();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${MM}-${DD} ${hh}:${mm}:${ss}.${ms}`;
}

// ── Error 序列化 ─────────────────────────────────────────

function serializeErr(
  err: unknown,
): { type: string; message: string; stack?: string } | unknown {
  if (err instanceof Error) {
    return {
      type: err.constructor.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return err;
}

function formatErrPretty(err: unknown): string {
  if (err instanceof Error) {
    return `{\n      "type": "${err.constructor.name}",\n      "message": "${err.message}",\n      "stack":\n          ${err.stack}\n    }`;
  }
  return JSON.stringify(err);
}

function formatDataPretty(data: Record<string, unknown>): string {
  let out = '';
  for (const [k, v] of Object.entries(data)) {
    if (k === 'err') {
      out += `\n    ${KEY_COLOR}err${RESET}: ${formatErrPretty(v)}`;
    } else {
      out += `\n    ${KEY_COLOR}${k}${RESET}: ${JSON.stringify(v)}`;
    }
  }
  return out;
}

// ── RotatingFileStream ───────────────────────────────────

const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const LOG_MAX_SIZE = parseInt(process.env.LOG_MAX_SIZE || '10485760', 10); // 10MB
const LOG_MAX_FILES = parseInt(process.env.LOG_MAX_FILES || '7', 10);

class RotatingFileStream {
  private fd: number;
  private currentSize: number;
  private filePath: string;
  private maxSize: number;
  private maxFiles: number;

  constructor(filePath: string, opts: { maxSize: number; maxFiles: number }) {
    this.filePath = filePath;
    this.maxSize = opts.maxSize;
    this.maxFiles = opts.maxFiles;

    // 确保目录存在
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    // 打开文件（append 模式）
    this.fd = fs.openSync(filePath, 'a');
    try {
      this.currentSize = fs.fstatSync(this.fd).size;
    } catch {
      this.currentSize = 0;
    }
  }

  write(data: string): void {
    const buf = Buffer.from(data);
    if (this.maxSize > 0 && this.currentSize + buf.length > this.maxSize) {
      this.rotate();
    }
    fs.writeSync(this.fd, buf);
    this.currentSize += buf.length;
  }

  private rotate(): void {
    fs.closeSync(this.fd);

    // 删除最旧的归档
    const oldest = `${this.filePath}.${this.maxFiles}`;
    try {
      fs.unlinkSync(oldest);
    } catch {
      /* 不存在则忽略 */
    }

    // shift: .6 → .7, .5 → .6, ... .1 → .2
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = `${this.filePath}.${i}`;
      const to = `${this.filePath}.${i + 1}`;
      try {
        fs.renameSync(from, to);
      } catch {
        /* 不存在则忽略 */
      }
    }

    // 当前文件 → .1
    try {
      fs.renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      /* 忽略 */
    }

    // 打开新文件
    this.fd = fs.openSync(this.filePath, 'a');
    this.currentSize = 0;
  }

  /** 用于测试 */
  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* 忽略 */
    }
  }
}

// JSON 模式下创建 RotatingFileStream
let logStream: RotatingFileStream | null = null;
if (LOG_FORMAT === 'json') {
  try {
    logStream = new RotatingFileStream(path.join(LOG_DIR, 'nanoclaw.log'), {
      maxSize: LOG_MAX_SIZE,
      maxFiles: LOG_MAX_FILES,
    });
  } catch {
    // fallback: 如果无法创建文件流，退回 stdout
    logStream = null;
  }
}

// ── 核心 log 函数 ─────────────────────────────────────────

function log(
  level: Level,
  dataOrMsg: Record<string, unknown> | string,
  msg?: string,
): void {
  if (LEVELS[level] < threshold) return;

  // 读取 AsyncLocalStorage context
  const ctx = logContext.getStore();

  const data: Record<string, unknown> | undefined =
    typeof dataOrMsg === 'string' ? undefined : dataOrMsg;
  const message = typeof dataOrMsg === 'string' ? dataOrMsg : (msg ?? '');

  if (LOG_FORMAT === 'json') {
    // ── JSON 输出 ──
    const record: Record<string, unknown> = {
      level: level,
      time: tsISO(),
      pid: process.pid,
      msg: message,
    };

    // 注入 correlation context
    if (ctx) {
      record.traceId = ctx.traceId;
      if (ctx.chatJid) record.chatJid = ctx.chatJid;
      if (ctx.groupFolder) record.groupFolder = ctx.groupFolder;
      if (ctx.sender) record.sender = ctx.sender;
    }

    // 合并 data 字段
    if (data) {
      for (const [k, v] of Object.entries(data)) {
        record[k] = k === 'err' ? serializeErr(v) : v;
      }
    }

    const line = JSON.stringify(record) + '\n';
    if (logStream) {
      logStream.write(line);
    } else {
      process.stdout.write(line);
    }
  } else {
    // ── Pretty 输出 ──
    const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
    const stream =
      LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
    const traceTag = ctx?.traceId ? ` [${ctx.traceId}]` : '';

    if (!data) {
      stream.write(
        `[${tsPretty()}]${traceTag} ${tag} (${process.pid}): ${MSG_COLOR}${message}${RESET}\n`,
      );
    } else {
      stream.write(
        `[${tsPretty()}]${traceTag} ${tag} (${process.pid}): ${MSG_COLOR}${message}${RESET}${formatDataPretty(data)}\n`,
      );
    }
  }
}

// ── 导出 ──────────────────────────────────────────────────

export const logger = {
  debug: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('debug', dataOrMsg, msg),
  info: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('info', dataOrMsg, msg),
  warn: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('warn', dataOrMsg, msg),
  error: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('error', dataOrMsg, msg),
  fatal: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('fatal', dataOrMsg, msg),
};

// 导出给测试用
export { RotatingFileStream, LOG_FORMAT };

// Route uncaught errors through logger so they get timestamps
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
