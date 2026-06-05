import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeInteractivePaneCompletion,
  countPendingIpcInputs,
  findLatestClaudeSessionId,
  isRealClaudeSessionId,
  shouldEmitInteractiveSessionKeepalive,
  shouldReleaseBlockedTurn,
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

describe('analyzeInteractivePaneCompletion', () => {
  it('识别工具调用解析失败后已回到 prompt 的终止态', () => {
    const pane = [
      "The model's tool call could not be parsed (retry also failed).",
      '',
      '❯',
      '⏵⏵ bypass permissions on · /effort',
    ].join('\n');

    const result = analyzeInteractivePaneCompletion(pane);

    expect(result.done).toBe(true);
    expect(result.status).toBe('error');
    expect(result.error).toContain('工具调用解析失败');
  });

  it('解析失败但还没回到 prompt 时不结束', () => {
    const pane = [
      "The model's tool call could not be parsed (retry also failed).",
      '✻ Thinking...',
    ].join('\n');

    expect(analyzeInteractivePaneCompletion(pane).done).toBe(false);
  });

  it('正常 prompt 不误判为终止态', () => {
    const pane = [
      'Claude Code v2.1.162',
      '❯',
      '⏵⏵ bypass permissions on · /effort',
    ].join('\n');

    expect(analyzeInteractivePaneCompletion(pane).done).toBe(false);
  });
});

describe('shouldReleaseBlockedTurn', () => {
  it('ready 稳定、SSE 静默、无 active stream 且有 backlog 时释放阻塞 turn', () => {
    expect(shouldReleaseBlockedTurn({
      readyStableMs: 5000,
      sseQuietMs: 15000,
      activeSseStreams: 0,
      currentTurnState: 'busy',
      backlogCount: 1,
      hasPendingOutput: false,
      hasPendingText: false,
    })).toBe(true);
  });

  it('没有 backlog 时不释放，避免截断正常长任务', () => {
    expect(shouldReleaseBlockedTurn({
      readyStableMs: 10_000,
      sseQuietMs: 20_000,
      activeSseStreams: 0,
      currentTurnState: 'busy',
      backlogCount: 0,
      hasPendingOutput: false,
      hasPendingText: false,
    })).toBe(false);
  });

  it('仍有 active SSE stream 时不释放', () => {
    expect(shouldReleaseBlockedTurn({
      readyStableMs: 10_000,
      sseQuietMs: 20_000,
      activeSseStreams: 1,
      currentTurnState: 'busy',
      backlogCount: 2,
      hasPendingOutput: false,
      hasPendingText: false,
    })).toBe(false);
  });

  it('存在 pending output 或 pending text 时不释放，避免丢 final', () => {
    expect(shouldReleaseBlockedTurn({
      readyStableMs: 10_000,
      sseQuietMs: 20_000,
      activeSseStreams: 0,
      currentTurnState: 'busy',
      backlogCount: 2,
      hasPendingOutput: true,
      hasPendingText: false,
    })).toBe(false);

    expect(shouldReleaseBlockedTurn({
      readyStableMs: 10_000,
      sseQuietMs: 20_000,
      activeSseStreams: 0,
      currentTurnState: 'busy',
      backlogCount: 2,
      hasPendingOutput: false,
      hasPendingText: true,
    })).toBe(false);
  });

  it('ready 或 SSE 静默时间未达阈值时不释放', () => {
    expect(shouldReleaseBlockedTurn({
      readyStableMs: 4999,
      sseQuietMs: 20_000,
      activeSseStreams: 0,
      currentTurnState: 'busy',
      backlogCount: 2,
      hasPendingOutput: false,
      hasPendingText: false,
    })).toBe(false);

    expect(shouldReleaseBlockedTurn({
      readyStableMs: 10_000,
      sseQuietMs: 14_999,
      activeSseStreams: 0,
      currentTurnState: 'busy',
      backlogCount: 2,
      hasPendingOutput: false,
      hasPendingText: false,
    })).toBe(false);
  });
});

describe('countPendingIpcInputs', () => {
  it('只统计 input 目录中的普通 json 消息文件', () => {
    const ipcDir = makeTempDir();
    const inputDir = path.join(ipcDir, 'input');
    fs.mkdirSync(path.join(inputDir, '.inflight'), { recursive: true });
    fs.writeFileSync(path.join(inputDir, '1780589641918-5kkv.json'), '{}');
    fs.writeFileSync(path.join(inputDir, '1780589641919-abcd.json'), '{}');
    fs.writeFileSync(path.join(inputDir, '_close'), '');
    fs.writeFileSync(path.join(inputDir, '.hidden.json'), '{}');
    fs.writeFileSync(path.join(inputDir, 'note.txt'), 'ignore');
    fs.writeFileSync(path.join(inputDir, '.inflight', 'turn-1.json'), '{}');

    expect(countPendingIpcInputs(ipcDir)).toBe(2);
  });

  it('input 目录不存在时返回 0', () => {
    expect(countPendingIpcInputs(makeTempDir())).toBe(0);
  });
});

describe('shouldEmitInteractiveSessionKeepalive', () => {
  it('已有 session、本轮没有结果且没有发过终态 output 时补 keepalive', () => {
    expect(shouldEmitInteractiveSessionKeepalive('session-id', {
      result: undefined,
      terminalOutputEmitted: false,
    })).toBe(true);
  });

  it('degraded/error 已经发过终态 output 时不补空 success', () => {
    expect(shouldEmitInteractiveSessionKeepalive('session-id', {
      result: undefined,
      terminalOutputEmitted: true,
    })).toBe(false);
  });

  it('已有文本结果或没有 session 时不补 keepalive', () => {
    expect(shouldEmitInteractiveSessionKeepalive('session-id', {
      result: 'ok',
      terminalOutputEmitted: true,
    })).toBe(false);

    expect(shouldEmitInteractiveSessionKeepalive(undefined, {
      result: undefined,
      terminalOutputEmitted: false,
    })).toBe(false);
  });
});
