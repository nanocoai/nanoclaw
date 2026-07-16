import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeClaudeModelName,
  readCodexModelSettings,
  readGroupModelSettings,
} from '../container/agent-runner/src/model-settings.js';

const tempDirs: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-model-settings-'),
  );
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'groups', 'g'), { recursive: true });
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('normalizeClaudeModelName', () => {
  it('保留 [1m] 后缀传给 SDK', () => {
    expect(normalizeClaudeModelName('claude-opus-4-8[1m]')).toBe(
      'claude-opus-4-8[1m]',
    );
  });

  it('保留正常模型名', () => {
    expect(normalizeClaudeModelName('claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});

describe('readGroupModelSettings', () => {
  it('读取 per-group settings 并清洗 model', () => {
    const root = makeTempRoot();
    const settingsDir = path.join(root, 'data', 'sessions', 'g', '.claude');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ model: 'claude-fable-5[1m]', effortLevel: 'medium' }),
    );

    expect(
      readGroupModelSettings({
        groupPath: path.join(root, 'groups', 'g'),
        groupFolder: 'g',
      }),
    ).toEqual({
      model: 'claude-fable-5[1m]',
      effortLevel: 'medium',
    });
  });

  it('缺失或非法配置时返回空对象', () => {
    const root = makeTempRoot();
    expect(
      readGroupModelSettings({
        groupPath: path.join(root, 'groups', 'g'),
        groupFolder: 'g',
      }),
    ).toEqual({});
  });
});

describe('readCodexModelSettings', () => {
  it.each(['fast', 'standard'] as const)(
    '读取合法的群级 Codex serviceTier：%s',
    (serviceTier) => {
      const root = makeTempRoot();
      const settingsDir = path.join(root, 'data', 'sessions', 'g', '.claude');
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, 'settings.json'),
        JSON.stringify({ codex: { serviceTier } }),
      );

      expect(
        readCodexModelSettings({
          groupPath: path.join(root, 'groups', 'g'),
          groupFolder: 'g',
        }),
      ).toEqual({ serviceTier });
    },
  );

  it('忽略非法 serviceTier，保持标准模式', () => {
    const root = makeTempRoot();
    const settingsDir = path.join(root, 'data', 'sessions', 'g', '.claude');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ codex: { serviceTier: 'turbo' } }),
    );

    expect(
      readCodexModelSettings({
        groupPath: path.join(root, 'groups', 'g'),
        groupFolder: 'g',
      }),
    ).toEqual({});
  });

  it('不同群各读自己的 serviceTier，互不污染', () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, 'groups', 'other'), { recursive: true });
    for (const [groupFolder, serviceTier] of [
      ['g', 'fast'],
      ['other', 'standard'],
    ] as const) {
      const settingsDir = path.join(
        root,
        'data',
        'sessions',
        groupFolder,
        '.claude',
      );
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, 'settings.json'),
        JSON.stringify({ codex: { serviceTier } }),
      );
    }

    expect(
      readCodexModelSettings({
        groupPath: path.join(root, 'groups', 'g'),
        groupFolder: 'g',
      }).serviceTier,
    ).toBe('fast');
    expect(
      readCodexModelSettings({
        groupPath: path.join(root, 'groups', 'other'),
        groupFolder: 'other',
      }).serviceTier,
    ).toBe('standard');
  });
});
