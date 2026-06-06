import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  findSessionTranscript,
  readTranscriptCwd,
  resolveQueryCwdForSession,
} from './session-cwd.js';

describe('session cwd resolver', () => {
  it('从 Claude transcript 找到 session 文件和创建时 cwd', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cwd-'));
    const cwd = path.join(tmp, 'group');
    fs.mkdirSync(cwd, { recursive: true });
    const projectDir = path.join(tmp, '.claude', 'projects', '-tmp-group');
    fs.mkdirSync(projectDir, { recursive: true });
    const transcript = path.join(projectDir, 'sess-1.jsonl');
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'user', sessionId: 'sess-1', cwd }),
        JSON.stringify({ type: 'assistant', sessionId: 'sess-1', cwd }),
      ].join('\n') + '\n',
    );

    expect(findSessionTranscript(path.join(tmp, '.claude'), 'sess-1')).toBe(transcript);
    expect(readTranscriptCwd(transcript)).toBe(cwd);
  });

  it('resume 历史 session 时优先使用 transcript cwd', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cwd-'));
    const legacyCwd = path.join(tmp, 'groups', 'old-group');
    const defaultCwd = path.join(tmp, 'nine');
    fs.mkdirSync(legacyCwd, { recursive: true });
    fs.mkdirSync(defaultCwd, { recursive: true });
    const projectDir = path.join(tmp, '.claude', 'projects', '-legacy');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'sess-old.jsonl'),
      JSON.stringify({ type: 'assistant', sessionId: 'sess-old', cwd: legacyCwd }) + '\n',
    );

    const resolved = resolveQueryCwdForSession({
      configDir: path.join(tmp, '.claude'),
      sessionId: 'sess-old',
      defaultCwd,
    });

    expect(resolved.cwd).toBe(legacyCwd);
    expect(resolved.usedTranscriptCwd).toBe(true);
  });

  it('没有可用 transcript cwd 时保持默认 cwd', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cwd-'));
    const defaultCwd = path.join(tmp, 'nine');
    fs.mkdirSync(defaultCwd, { recursive: true });

    const resolved = resolveQueryCwdForSession({
      configDir: path.join(tmp, '.claude'),
      sessionId: 'missing',
      defaultCwd,
    });

    expect(resolved.cwd).toBe(defaultCwd);
    expect(resolved.usedTranscriptCwd).toBe(false);
  });
});
