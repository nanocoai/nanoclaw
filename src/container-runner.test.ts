import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'Asia/Shanghai',
  ONECLI_URL: 'http://localhost:10254',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      cpSync: vi.fn(),
    },
  };
});

// Mock env
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    `/tmp/nanoclaw-test-groups/${folder}`,
  resolveGroupIpcPath: (folder: string) =>
    `/tmp/nanoclaw-test-data/ipc/${folder}`,
}));

// Mock OneCLI SDK
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    getContainerConfig = vi.fn().mockResolvedValue({
      env: {
        HTTPS_PROXY: 'http://x:token@localhost:10255',
        NODE_EXTRA_CA_CERTS: '/tmp/onecli-gateway-ca.pem',
        NODE_USE_ENV_PROXY: '1',
        CLAUDE_CODE_OAUTH_TOKEN: 'placeholder',
      },
      caCertificate: 'mock-cert',
    });
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    ensureAgent = vi.fn().mockResolvedValue({ id: 'test', created: false });
  },
}));

// Mock db
vi.mock('./db.js', () => ({
  getRotateEnabled: vi.fn(() => false),
  getRotateIndex: vi.fn(() => 0),
  getLastRotateAt: vi.fn(() => null),
  setRotateIndex: vi.fn(),
  setLastRotateAt: vi.fn(),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    unref: ReturnType<typeof vi.fn>;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  proc.unref = vi.fn();
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    execFileSync: vi.fn(() => ''),
    execSync: vi.fn(() => '[]'),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  runContainerAgent,
  ContainerOutput,
  parseEnvOutput,
  checkAgentRunnerDist,
  resolveWorkspacePaths,
  prepareGroupSession,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import fs from 'fs';
import { spawn } from 'child_process';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('agent spawn and timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns node child process and writes workspacePaths', async () => {
    // Capture stdin writes
    const chunks: Buffer[] = [];
    const origWrite = fakeProc.stdin.write.bind(fakeProc.stdin);
    fakeProc.stdin.write = ((chunk: any, ...args: any[]) => {
      if (Buffer.isBuffer(chunk) || typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk));
      }
      return origWrite(chunk, ...args);
    }) as any;

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      vi.fn(),
    );

    // Let async buildLocalEnv settle
    await vi.advanceTimersByTimeAsync(10);

    // Verify spawn was called with node (not docker)
    expect(spawn).toHaveBeenCalledWith(
      expect.stringContaining('node'),
      [expect.stringContaining('agent-runner/dist/index.js')],
      expect.objectContaining({
        detached: true,
        cwd: expect.stringContaining('test-group'),
      }),
    );

    // Verify stdin contains workspacePaths
    const written = Buffer.concat(chunks).toString();
    if (written) {
      const parsed = JSON.parse(written);
      expect(parsed.workspacePaths).toBeDefined();
      expect(parsed.workspacePaths.group).toContain('test-group');
      expect(parsed.workspacePaths.ipc).toContain('test-group');
    }

    // Clean up
    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('结构化 error 输出后正常退出时保留精确错误语义', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'error',
      result: null,
      error: 'gemini 失败: quota',
      newSessionId: 'session-gemini',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result).toEqual({
      status: 'success',
      result: null,
      newSessionId: 'session-gemini',
    });
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        error: 'gemini 失败: quota',
        newSessionId: 'session-gemini',
      }),
    );
  });

  it('onOutput 抛异常时不阻塞后续消息且 resolve 正常', async () => {
    let callCount = 0;
    const onOutput = vi.fn(async (output: ContainerOutput) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('sendMessage failed');
      }
      // 第二次调用正常
    });

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // 第一条消息：onOutput 会抛异常
    emitOutputMarker(fakeProc, {
      status: 'progress',
      result: '⚙️ step 1',
    });
    await vi.advanceTimersByTimeAsync(10);

    // 第二条消息：应该正常处理，不被第一条的 rejection 阻断
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Final answer',
      newSessionId: 'session-789',
    });
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // 进程正常 resolve，不会挂死
    expect(result.status).toBe('success');
    // onOutput 被调用了两次
    expect(onOutput).toHaveBeenCalledTimes(2);
  });
});

describe('parseEnvOutput', () => {
  it('parses KEY=VALUE format', () => {
    expect(parseEnvOutput('FOO=bar\nBAZ=qux')).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('handles values containing =', () => {
    expect(parseEnvOutput('KEY=a=b=c')).toEqual({ KEY: 'a=b=c' });
  });

  it('skips empty lines', () => {
    expect(parseEnvOutput('A=1\n\nB=2\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('checkAgentRunnerDist', () => {
  it('does not throw when dist exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    expect(() => checkAgentRunnerDist()).not.toThrow();
  });

  it('throws with build:agent hint when dist missing', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(() => checkAgentRunnerDist()).toThrow(/build:agent/);
    vi.mocked(fs.existsSync).mockReturnValue(true); // restore
  });
});

describe('resolveWorkspacePaths', () => {
  it('main group includes project path', () => {
    const p = resolveWorkspacePaths(testGroup, true);
    expect(p.project).toBeDefined();
    expect(p.group).toContain('test-group');
    expect(p.ipc).toContain('test-group');
  });

  it('non-main group excludes project', () => {
    const p = resolveWorkspacePaths(testGroup, false);
    expect(p.project).toBeUndefined();
  });

  it('all paths are absolute', () => {
    const p = resolveWorkspacePaths(testGroup, true);
    for (const val of Object.values(p)) {
      if (val) expect(val).toMatch(/^\//);
    }
  });

  it('global points to groups/global', () => {
    const p = resolveWorkspacePaths(testGroup, true);
    expect(p.global).toMatch(/groups\/global$/);
  });
});

describe('prepareGroupSession', () => {
  it('returns different paths for different groups', () => {
    const a = prepareGroupSession('group-a');
    const b = prepareGroupSession('group-b');
    expect(a).toContain('group-a');
    expect(b).toContain('group-b');
    expect(a).not.toBe(b);
  });

  it('path ends with .claude', () => {
    const dir = prepareGroupSession('main');
    expect(dir).toMatch(/sessions\/main\/\.claude$/);
  });
});

// ---- Phase 2: 跨 chunk 拼接 / JSON 畸形 / 截断 ----

describe('输出解析边界', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('output marker 分两个 chunk 到达（跨 chunk 拼接）', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // 先发送前半段
    const json = JSON.stringify({
      status: 'success',
      result: 'cross-chunk',
      newSessionId: 'sess-cross',
    });
    fakeProc.stdout.push(`${OUTPUT_START_MARKER}\n${json.slice(0, 20)}`);
    await vi.advanceTimersByTimeAsync(10);

    // 再发送后半段 + 结束标记
    fakeProc.stdout.push(`${json.slice(20)}\n${OUTPUT_END_MARKER}\n`);
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'cross-chunk' }),
    );
  });

  it('JSON 畸形时 warn 但不中断后续消息', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // 发送畸形 JSON
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n{bad json\n${OUTPUT_END_MARKER}\n`,
    );
    await vi.advanceTimersByTimeAsync(10);

    // 发送正常 output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'after bad json',
      newSessionId: 'sess-ok',
    });
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    // 畸形 JSON 被跳过，只有正常的那条被回调
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'after bad json' }),
    );
  });

  it('缺少 OUTPUT_END_MARKER 时等待后续 chunk', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // 只发 start marker + JSON，没有 end marker
    const json = JSON.stringify({ status: 'progress', result: 'partial' });
    fakeProc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n`);
    await vi.advanceTimersByTimeAsync(10);

    // 此时不应调用 onOutput（等 end marker）
    expect(onOutput).not.toHaveBeenCalled();

    // 发送 end marker
    fakeProc.stdout.push(`${OUTPUT_END_MARKER}\n`);
    await vi.advanceTimersByTimeAsync(10);

    // 现在应该触发了
    expect(onOutput).toHaveBeenCalledTimes(1);

    // 清理
    emitOutputMarker(fakeProc, { status: 'success', result: 'done' });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('多个 output marker 连续到达时全部解析', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // 一次 push 包含 3 条消息
    const msg1 = JSON.stringify({ status: 'progress', result: 'step1' });
    const msg2 = JSON.stringify({ status: 'progress', result: 'step2' });
    const msg3 = JSON.stringify({
      status: 'success',
      result: 'final',
      newSessionId: 'sess-multi',
    });
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${msg1}\n${OUTPUT_END_MARKER}\n` +
        `${OUTPUT_START_MARKER}\n${msg2}\n${OUTPUT_END_MARKER}\n` +
        `${OUTPUT_START_MARKER}\n${msg3}\n${OUTPUT_END_MARKER}\n`,
    );
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(onOutput).toHaveBeenCalledTimes(3);
  });
});

// ---- error 退出路径必须先 drain outputChain 再 resolve（oc_7a6c05 死循环根因回归） ----

describe('error 退出 + outputChain 时序', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('进程异常退出时，pending 的 onOutput 必须在 resolve 之前跑完', async () => {
    // 这是核心回归：error 路径若不 await outputChain，wrappedOnOutput 的 session
    // 写回会发生在 stale 清理之后，把已清除的旧 sessionId 写回，造成永久死循环。
    const order: string[] = [];
    let releaseOnOutput!: () => void;
    const gate = new Promise<void>((r) => {
      releaseOnOutput = r;
    });
    const onOutput = vi.fn(async () => {
      await gate; // 模拟 onOutput 尚未完成（如 setSession/sendMessage 在途）
      order.push('onOutput');
    });

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    ).then((r) => {
      order.push('resolved');
      return r;
    });
    await vi.advanceTimersByTimeAsync(10);

    // 发一条携带 newSessionId 的输出，onOutput 会卡在 gate 上（outputChain 未完成）
    emitOutputMarker(fakeProc, {
      status: 'progress',
      result: 'step',
      newSessionId: 'sess-pending',
    });
    await vi.advanceTimersByTimeAsync(10);

    // 进程异常退出，此刻 outputChain 仍 pending
    fakeProc.stderr.push('crashed\n');
    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);

    // outputChain 没完成，resolve 不应发生
    expect(order).toEqual([]);

    // 放行 onOutput → outputChain 完成 → 才允许 resolve
    releaseOnOutput();
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    // 严格顺序：onOutput 先跑完，resolve 在后
    expect(order).toEqual(['onOutput', 'resolved']);
  });

  it('error 退出 + onOutput 抛异常时仍 resolve error，不挂死', async () => {
    const onOutput = vi.fn(async () => {
      throw new Error('sendMessage failed');
    });

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );
    await vi.advanceTimersByTimeAsync(10);

    emitOutputMarker(fakeProc, { status: 'progress', result: 'step' });
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.stderr.push('boom\n');
    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(onOutput).toHaveBeenCalledTimes(1);
  });

  it('error 退出且无任何 output 回调时直接 resolve error', async () => {
    const onOutput = vi.fn(async () => {});

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.stderr.push('fatal\n');
    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('code 1');
    expect(onOutput).not.toHaveBeenCalled();
  });
});
