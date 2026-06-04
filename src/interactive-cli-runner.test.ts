import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findLatestClaudeSessionId,
  isRealClaudeSessionId,
} from '../container/agent-runner/src/interactive-cli-runner.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-interactive-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('isRealClaudeSessionId', () => {
  it('只接受 Claude CLI 的 UUID session id', () => {
    expect(isRealClaudeSessionId('478eb1ce-d5f4-4da2-a3bd-3f44d5b82e37')).toBe(true);
    expect(isRealClaudeSessionId('new-fs:oc_df0d2dcb8747d8bcc2047c60ddcc7120-1779164795213')).toBe(false);
    expect(isRealClaudeSessionId('session_abc123')).toBe(false);
    expect(isRealClaudeSessionId(undefined)).toBe(false);
  });
});

describe('findLatestClaudeSessionId', () => {
  it('从 cwd 对应 project 目录找到本轮最新 UUID jsonl', () => {
    const claudeConfigDir = makeTempDir();
    const cwd = '/Users/dajay/AI_Workspace/nine';
    const projectDir = path.join(claudeConfigDir, 'projects', '-Users-dajay-AI-Workspace-nine');
    fs.mkdirSync(projectDir, { recursive: true });

    const oldSession = '11111111-1111-4111-8111-111111111111';
    const newSession = '22222222-2222-4222-8222-222222222222';
    const oldPath = path.join(projectDir, `${oldSession}.jsonl`);
    const newPath = path.join(projectDir, `${newSession}.jsonl`);
    fs.writeFileSync(oldPath, '{}\n');
    fs.writeFileSync(newPath, '{}\n');

    const sinceMs = Date.now() - 1000;
    fs.utimesSync(oldPath, new Date(sinceMs - 10_000), new Date(sinceMs - 10_000));
    fs.utimesSync(newPath, new Date(sinceMs + 1000), new Date(sinceMs + 1000));
    fs.writeFileSync(path.join(projectDir, 'new-fs:fake.jsonl'), '{}\n');

    expect(findLatestClaudeSessionId({ claudeConfigDir, cwd, sinceMs })).toBe(newSession);
  });

  it('没有本轮 UUID jsonl 时返回 undefined', () => {
    const claudeConfigDir = makeTempDir();
    expect(findLatestClaudeSessionId({
      claudeConfigDir,
      cwd: '/Users/dajay/AI_Workspace/nine',
      sinceMs: Date.now(),
    })).toBeUndefined();
  });
});
