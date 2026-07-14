import { describe, expect, it, vi } from 'vitest';

import { finalizeInteractiveTurn } from './progress-turn-finalizer.js';

describe('finalizeInteractiveTurn', () => {
  it('text-only 原卡转正后不再发送 usage-only 或 cleanup', async () => {
    const calls: string[] = [];
    const channel = {
      tryFinalizeTextOnly: vi.fn(async () => {
        calls.push('direct');
        return true;
      }),
      sendUsageOnly: vi.fn(async () => calls.push('usage')),
      cleanupProgressCard: vi.fn(async () => calls.push('cleanup')),
    };

    await expect(
      finalizeInteractiveTurn(channel, 'fs:oc_direct', true),
    ).resolves.toBe(true);
    expect(calls).toEqual(['direct']);
  });

  it('无法原卡转正时按 usage-only 再 cleanup 的旧顺序收尾', async () => {
    const calls: string[] = [];
    const channel = {
      tryFinalizeTextOnly: vi.fn(async () => {
        calls.push('direct');
        return false;
      }),
      sendUsageOnly: vi.fn(async () => calls.push('usage')),
      cleanupProgressCard: vi.fn(async () => calls.push('cleanup')),
    };

    await expect(
      finalizeInteractiveTurn(channel, 'fs:oc_progress', true),
    ).resolves.toBe(false);
    expect(calls).toEqual(['direct', 'usage', 'cleanup']);
  });

  it('无 text-only 能力且没有真实文字时只执行 cleanup', async () => {
    const calls: string[] = [];
    const channel = {
      cleanupProgressCard: vi.fn(async () => calls.push('cleanup')),
    };

    await expect(
      finalizeInteractiveTurn(channel, 'fs:oc_legacy', false),
    ).resolves.toBe(false);
    expect(calls).toEqual(['cleanup']);
  });
});
