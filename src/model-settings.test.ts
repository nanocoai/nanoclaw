import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizeClaudeModelName,
  readGroupModelSettings,
} from '../container/agent-runner/src/model-settings.js';

const tempDirs: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-model-settings-'));
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
  it('剥离历史 1m 后缀', () => {
    expect(normalizeClaudeModelName('claude-opus-4-8[1m]')).toBe('claude-opus-4-8');
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

    expect(readGroupModelSettings({
      groupPath: path.join(root, 'groups', 'g'),
      groupFolder: 'g',
    })).toEqual({
      model: 'claude-fable-5',
      effortLevel: 'medium',
    });
  });

  it('缺失或非法配置时返回空对象', () => {
    const root = makeTempRoot();
    expect(readGroupModelSettings({
      groupPath: path.join(root, 'groups', 'g'),
      groupFolder: 'g',
    })).toEqual({});
  });
});
