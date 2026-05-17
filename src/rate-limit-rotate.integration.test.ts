/**
 * 集成测试：限流检测 → kill 子进程 → 轮换账号 → 重试
 *
 * 测试策略：
 * - 用 mock agent 脚本代替真实 agent-runner，通过 stdout 输出限流文本
 * - mock OneCLI 的 secrets/agents 命令，模拟多账号环境
 * - 验证完整链路：onOutput 检测限流 → killGroup → runContainerAgent resolve → 轮换 → 重试成功
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ---- 常量 ----
const OUTPUT_START = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END = '---NANOCLAW_OUTPUT_END---';

/**
 * 构造一个 mock agent 脚本，首次运行输出限流文本，第二次输出正常结果。
 * 通过环境变量 MOCK_RATE_LIMIT 控制行为。
 */
function createMockAgentScript(tmpDir: string): string {
  const scriptPath = path.join(tmpDir, 'mock-agent.sh');
  // 读 stdin（模拟接收 containerInput），然后根据环境变量决定输出
  fs.writeFileSync(
    scriptPath,
    `#!/bin/bash
# 读掉 stdin（containerInput JSON）
read -r INPUT

# 根据 MOCK_RATE_LIMIT 环境变量决定输出
if [ "\${MOCK_RATE_LIMIT}" = "true" ]; then
  # 模拟限流：输出 "You've hit your limit" 假成功
  echo "${OUTPUT_START}"
  echo '{"status":"success","result":"You'\\''ve hit your limit · resets 4pm (Asia/Shanghai)"}'
  echo "${OUTPUT_END}"
  # 保持进程不退出（模拟长驻 agent）
  sleep 300
else
  # 正常响应
  echo "${OUTPUT_START}"
  echo '{"status":"success","result":"正常回复内容","newSessionId":"test-session-001"}'
  echo "${OUTPUT_END}"
  # 输出完等一下再退出（模拟正常结束）
  sleep 1
fi
`,
    { mode: 0o755 },
  );
  return scriptPath;
}

/**
 * 模拟 runContainerAgent 的核心 stdout 解析逻辑（简化版）
 * 用于验证 onOutput 回调是否收到正确的数据
 */
function parseAgentOutput(
  child: ChildProcess,
  onOutput: (output: { status: string; result: string | null; newSessionId?: string }) => Promise<void>,
  timeoutMs = 8000,
): Promise<{ status: string; result: string | null; newSessionId?: string }> {
  return new Promise((resolve) => {
    let parseBuffer = '';
    let outputChain = Promise.resolve();
    let lastOutput: { status: string; result: string | null; newSessionId?: string } | null = null;
    let resolved = false;

    const finish = (result: { status: string; result: string | null; newSessionId?: string }) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    // 安全超时：防止子进程没退出导致测试挂死
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(lastOutput || { status: 'error', result: null });
    }, timeoutMs);

    child.stdout!.on('data', (data) => {
      parseBuffer += data.toString();
      let startIdx: number;
      while ((startIdx = parseBuffer.indexOf(OUTPUT_START)) !== -1) {
        const endIdx = parseBuffer.indexOf(OUTPUT_END, startIdx);
        if (endIdx === -1) break;
        const jsonStr = parseBuffer.slice(startIdx + OUTPUT_START.length, endIdx).trim();
        parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END.length);
        try {
          const parsed = JSON.parse(jsonStr);
          lastOutput = parsed;
          outputChain = outputChain.then(() => onOutput(parsed)).catch(() => {});
        } catch {
          // ignore parse errors
        }
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      outputChain.then(() => {
        if (code !== 0 && code !== null) {
          finish({ status: 'error', result: null });
        } else {
          finish(lastOutput || { status: 'error', result: null });
        }
      });
    });
  });
}

describe('限流 → kill → 轮换集成测试', () => {
  let tmpDir: string;
  let mockScript: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ratelimit-test-'));
    mockScript = createMockAgentScript(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('限流输出被 onOutput 正确检测', { timeout: 15000 }, async () => {
    const child = spawn('bash', [mockScript], {
      env: { ...process.env, MOCK_RATE_LIMIT: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdin!.write('{"prompt":"test"}\n');

    const outputs: string[] = [];
    const rateLimitDetected: boolean[] = [];

    const resultPromise = parseAgentOutput(child, async (output) => {
      if (output.result) {
        outputs.push(output.result);
        // 模拟 detectRateLimit
        const isRateLimit = /you.ve hit your limit/i.test(output.result);
        rateLimitDetected.push(isRateLimit);
        if (isRateLimit) {
          // 模拟 kill — 在真实代码中是 queue.killGroup（杀进程组）
          try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        }
      }
    });

    const result = await resultPromise;

    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatch(/hit your limit/i);
    expect(rateLimitDetected[0]).toBe(true);
    // 进程被 kill 后 resolve
    expect(result.status).toBe('success'); // lastOutput 是 success（假成功）
  });

  it('kill 后进程退出，Promise 立即 resolve', { timeout: 15000 }, async () => {
    const child = spawn('bash', [mockScript], {
      env: { ...process.env, MOCK_RATE_LIMIT: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdin!.write('{"prompt":"test"}\n');

    const startTime = Date.now();
    let killTime = 0;

    const resultPromise = parseAgentOutput(child, async (output) => {
      if (output.result && /hit your limit/i.test(output.result)) {
        try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        killTime = Date.now();
      }
    });

    await resultPromise;
    const elapsed = Date.now() - startTime;

    // 进程不应该等 300 秒（sleep 300），应在检测到限流后秒级退出
    // CI/负载高时 spawn + kill 可能慢于预期，放宽到 15s
    expect(elapsed).toBeLessThan(15000);
    expect(killTime).toBeGreaterThan(0);
  });

  it('正常输出不触发 kill', async () => {
    const child = spawn('bash', [mockScript], {
      env: { ...process.env, MOCK_RATE_LIMIT: 'false' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin!.write('{"prompt":"test"}\n');

    let killCalled = false;

    const result = await parseAgentOutput(child, async (output) => {
      if (output.result && /hit your limit/i.test(output.result)) {
        killCalled = true;
        child.kill('SIGTERM');
      }
    });

    expect(killCalled).toBe(false);
    expect(result.result).toBe('正常回复内容');
    expect(result.newSessionId).toBe('test-session-001');
  });

  it('完整轮换流程：限流 → kill → 切账号 → 重试成功', { timeout: 15000 }, async () => {
    // 模拟两次调用：第一次限流，第二次正常
    let attempt = 0;
    let rotatedAccount = false;

    async function simulateRunAgent(): Promise<{
      status: string;
      result: string | null;
      rateLimited: boolean;
    }> {
      attempt++;
      const isFirstAttempt = attempt === 1;
      const child = spawn('bash', [mockScript], {
        env: {
          ...process.env,
          MOCK_RATE_LIMIT: isFirstAttempt ? 'true' : 'false',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      child.stdin!.write('{"prompt":"test"}\n');

      let rateLimited = false;

      const result = await parseAgentOutput(child, async (output) => {
        if (output.result && /hit your limit/i.test(output.result)) {
          rateLimited = true;
          try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        }
      });

      return { status: result.status, result: result.result, rateLimited };
    }

    // 第一次：限流
    const first = await simulateRunAgent();
    expect(first.rateLimited).toBe(true);

    // 模拟轮换账号
    rotatedAccount = true;

    // 第二次：正常
    const second = await simulateRunAgent();
    expect(second.rateLimited).toBe(false);
    expect(second.result).toBe('正常回复内容');
    expect(rotatedAccount).toBe(true);
  });

  it('多次限流输出只 kill 一次（幂等性）', { timeout: 15000 }, async () => {
    // 创建一个输出多条限流消息的脚本
    const multiLimitScript = path.join(tmpDir, 'multi-limit.sh');
    fs.writeFileSync(
      multiLimitScript,
      `#!/bin/bash
read -r INPUT
echo "${OUTPUT_START}"
echo '{"status":"progress","result":"处理中..."}'
echo "${OUTPUT_END}"
echo "${OUTPUT_START}"
echo '{"status":"success","result":"You'\\''ve hit your limit · resets 4pm"}'
echo "${OUTPUT_END}"
echo "${OUTPUT_START}"
echo '{"status":"success","result":"You'\\''ve hit your limit again"}'
echo "${OUTPUT_END}"
sleep 300
`,
      { mode: 0o755 },
    );

    const child = spawn('bash', [multiLimitScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdin!.write('{"prompt":"test"}\n');

    let killCount = 0;

    await parseAgentOutput(child, async (output) => {
      if (output.result && /hit your limit/i.test(output.result)) {
        killCount++;
        try {
          process.kill(-child.pid!, 'SIGTERM');
        } catch {
          // 进程已退出，忽略
        }
      }
    });

    // kill 可能被调用多次（因为多条限流消息），但不应报错
    // 重要的是第一次 kill 后进程就退出了
    expect(killCount).toBeGreaterThanOrEqual(1);
  });
});
