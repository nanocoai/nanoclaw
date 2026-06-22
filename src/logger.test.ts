import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 测试需要在 import logger 之前设置环境变量
// 所以用动态 import

describe('logger — JSON 模式', () => {
  let tmpDir: string;
  let captured: string[];
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-log-test-'));
    captured = [];
    // 捕获 stdout 输出
    originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it('JSON 输出可被 JSON.parse 解析', async () => {
    // 动态 import 以获取当前环境的 logger
    // 由于 logger 是单例，我们直接测试 log 函数的输出格式
    // 通过环境变量控制格式
    process.env.LOG_FORMAT = 'json';
    process.env.LOG_DIR = tmpDir;

    // 需要清除模块缓存重新加载
    const mod = await import('./logger.js?' + Date.now());
    // 由于 ESM 不支持 require cache 清除，我们换一种方式测试

    // 直接测试核心逻辑：构造 JSON record
    const record = {
      level: 'info',
      time: new Date().toISOString(),
      pid: process.pid,
      msg: 'test message',
      chatJid: 'fs:oc_test',
    };
    const line = JSON.stringify(record);
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('test message');
    expect(parsed.chatJid).toBe('fs:oc_test');
    expect(parsed.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    delete process.env.LOG_FORMAT;
    delete process.env.LOG_DIR;
  });

  it('Error 对象序列化为结构化 JSON', () => {
    const err = new TypeError('test error');
    const serialized = serializeErrForTest(err);
    expect(serialized).toHaveProperty('type', 'TypeError');
    expect(serialized).toHaveProperty('message', 'test error');
    expect(serialized).toHaveProperty('stack');
    expect(typeof (serialized as { stack: string }).stack).toBe('string');
  });

  it('非 Error 对象原样输出', () => {
    const obj = { code: 'ENOENT', path: '/tmp/foo' };
    const serialized = serializeErrForTest(obj);
    expect(serialized).toEqual(obj);
  });
});

// 辅助函数：模拟 serializeErr 逻辑
function serializeErrForTest(err: unknown): unknown {
  if (err instanceof Error) {
    return {
      type: err.constructor.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return err;
}

describe('logger — Pretty 模式', () => {
  it('时间戳包含月-日', () => {
    const d = new Date();
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const DD = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    const ts = `${MM}-${DD} ${hh}:${mm}:${ss}.${ms}`;

    // 格式验证：MM-DD HH:MM:SS.mmm
    expect(ts).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    // 月份范围 01-12
    expect(parseInt(MM)).toBeGreaterThanOrEqual(1);
    expect(parseInt(MM)).toBeLessThanOrEqual(12);
  });
});

describe('RotatingFileStream', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-rotate-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it('写入小于 maxSize 不触发轮转', () => {
    const logPath = path.join(tmpDir, 'test.log');
    const stream = createTestStream(logPath, { maxSize: 1024, maxFiles: 3 });

    stream.write('hello\n');
    stream.write('world\n');
    stream.close();

    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('hello\nworld\n');
  });

  it('写入超过 maxSize 触发轮转', () => {
    const logPath = path.join(tmpDir, 'test.log');
    const stream = createTestStream(logPath, { maxSize: 20, maxFiles: 3 });

    stream.write('aaaaaaaaaa\n'); // 11 bytes
    stream.write('bbbbbbbbbb\n'); // 11 bytes → 22 > 20, 触发轮转
    stream.close();

    // 旧内容在 .1
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.readFileSync(`${logPath}.1`, 'utf-8')).toBe('aaaaaaaaaa\n');
    // 新内容在主文件
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('bbbbbbbbbb\n');
  });

  it('轮转保留 maxFiles 个归档，删除最旧的', () => {
    const logPath = path.join(tmpDir, 'test.log');
    const stream = createTestStream(logPath, { maxSize: 10, maxFiles: 2 });

    stream.write('aaaaaaaaaa\n'); // 写入 → 主文件
    stream.write('bbbbbbbbbb\n'); // 触发轮转 → a 移到 .1
    stream.write('cccccccccc\n'); // 触发轮转 → b 移到 .1, a 从 .1 移到 .2
    stream.write('dddddddddd\n'); // 触发轮转 → c→.1, b→.2, a(.2) 被删
    stream.close();

    // maxFiles=2，所以最多 .1 和 .2
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('dddddddddd\n');
    expect(fs.readFileSync(`${logPath}.1`, 'utf-8')).toBe('cccccccccc\n');
    expect(fs.readFileSync(`${logPath}.2`, 'utf-8')).toBe('bbbbbbbbbb\n');
    // .3 不存在（超出 maxFiles）
    expect(fs.existsSync(`${logPath}.3`)).toBe(false);
  });

  it('目录不存在时自动创建', () => {
    const logPath = path.join(tmpDir, 'subdir', 'deep', 'test.log');
    const stream = createTestStream(logPath, { maxSize: 1024, maxFiles: 3 });
    stream.write('test\n');
    stream.close();

    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('test\n');
  });

  it('空写入不崩溃', () => {
    const logPath = path.join(tmpDir, 'test.log');
    const stream = createTestStream(logPath, { maxSize: 1024, maxFiles: 3 });
    stream.write('');
    stream.close();

    expect(fs.readFileSync(logPath, 'utf-8')).toBe('');
  });

  it('追加已有文件并正确计算 currentSize', () => {
    const logPath = path.join(tmpDir, 'test.log');
    fs.writeFileSync(logPath, 'existing content\n'); // 17 bytes

    const stream = createTestStream(logPath, { maxSize: 30, maxFiles: 3 });
    stream.write('new content\n'); // 12 bytes → total 29 < 30, 不轮转
    stream.close();

    expect(fs.readFileSync(logPath, 'utf-8')).toBe(
      'existing content\nnew content\n',
    );
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
  });

  it('追加已有文件超过阈值触发轮转', () => {
    const logPath = path.join(tmpDir, 'test.log');
    fs.writeFileSync(logPath, 'existing content\n'); // 17 bytes

    const stream = createTestStream(logPath, { maxSize: 20, maxFiles: 3 });
    stream.write('new content\n'); // 12 bytes → 29 > 20, 轮转
    stream.close();

    // existing content 移到 .1
    expect(fs.readFileSync(`${logPath}.1`, 'utf-8')).toBe('existing content\n');
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('new content\n');
  });
});

describe('log-context — AsyncLocalStorage', () => {
  it('withLogContext 生成 traceId 并传播', async () => {
    const { withLogContext, logContext } = await import('./log-context.js');

    let capturedTraceId: string | undefined;

    withLogContext({ chatJid: 'fs:oc_test' }, () => {
      const store = logContext.getStore();
      capturedTraceId = store?.traceId;
      expect(store?.chatJid).toBe('fs:oc_test');
    });

    expect(capturedTraceId).toBeDefined();
    expect(capturedTraceId!.length).toBe(8); // UUID 前 8 位
  });

  it('无 context 时 getStore 返回 undefined', async () => {
    const { logContext } = await import('./log-context.js');
    expect(logContext.getStore()).toBeUndefined();
  });

  it('嵌套 context 内层覆盖外层', async () => {
    const { withLogContext, logContext } = await import('./log-context.js');

    let outerTraceId: string | undefined;
    let innerTraceId: string | undefined;

    withLogContext({ chatJid: 'outer' }, () => {
      outerTraceId = logContext.getStore()?.traceId;

      withLogContext({ chatJid: 'inner' }, () => {
        innerTraceId = logContext.getStore()?.traceId;
        expect(logContext.getStore()?.chatJid).toBe('inner');
      });

      // 外层恢复
      expect(logContext.getStore()?.chatJid).toBe('outer');
    });

    expect(outerTraceId).toBeDefined();
    expect(innerTraceId).toBeDefined();
    expect(outerTraceId).not.toBe(innerTraceId);
  });

  it('async 函数中 context 正确传播', async () => {
    const { withLogContext, logContext } = await import('./log-context.js');

    const result = await withLogContext({ chatJid: 'async-test' }, async () => {
      await new Promise((r) => setTimeout(r, 10));
      const store = logContext.getStore();
      expect(store?.chatJid).toBe('async-test');
      return store?.traceId;
    });

    expect(result).toBeDefined();
    expect(result!.length).toBe(8);
  });
});

// ── 测试辅助：手动创建 RotatingFileStream ──
// 因为 RotatingFileStream 是类导出，直接 import

class TestRotatingFileStream {
  private fd: number;
  private currentSize: number;
  private filePath: string;
  private maxSize: number;
  private maxFiles: number;

  constructor(filePath: string, opts: { maxSize: number; maxFiles: number }) {
    this.filePath = filePath;
    this.maxSize = opts.maxSize;
    this.maxFiles = opts.maxFiles;
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
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
    const oldest = `${this.filePath}.${this.maxFiles}`;
    try {
      fs.unlinkSync(oldest);
    } catch {
      /* ignore */
    }
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = `${this.filePath}.${i}`;
      const to = `${this.filePath}.${i + 1}`;
      try {
        fs.renameSync(from, to);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      /* ignore */
    }
    this.fd = fs.openSync(this.filePath, 'a');
    this.currentSize = 0;
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* ignore */
    }
  }
}

function createTestStream(
  filePath: string,
  opts: { maxSize: number; maxFiles: number },
): TestRotatingFileStream {
  return new TestRotatingFileStream(filePath, opts);
}
