import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'bun:test';

import { TIMEZONE, formatLocalStamp } from '../timezone.js';
import { archiveClaudeTranscript, type ClaudeHistoryClock } from './claude-history.js';

// The pre-compact archive is Claude-internal: the PreCompact hook calls it
// with the real clock. These pin what a reader can observe — the archive
// name, its local date, and the log lines — under a fixed clock.

const REAL_CLOCK: ClaudeHistoryClock = { now: () => Date.now() };

function fixedClock(ms: number): ClaudeHistoryClock {
  return { now: () => ms };
}

describe('archiveClaudeTranscript', () => {
  it('archives a transcript into the conversations directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-${process.pid}-`));
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '{"type":"user","message":{"content":"hello"}}\n');

    try {
      const clockMs = Date.parse('2027-02-03T23:59:59.900Z');
      const clockDate = new Date(clockMs);
      const logs: string[] = [];
      expect(
        archiveClaudeTranscript(
          { transcriptPath, sessionId: 'session', assistantName: 'Claude', log: (line) => logs.push(line) },
          fixedClock(clockMs),
        ),
      ).toBe(true);
      const [archive] = fs.readdirSync(conversationsDir);
      const time = `${clockDate.getHours().toString().padStart(2, '0')}${clockDate
        .getMinutes()
        .toString()
        .padStart(2, '0')}`;
      expect(archive).toBe(`${formatLocalStamp(clockDate, TIMEZONE).slice(0, 10)}-conversation-${time}.md`);
      expect(fs.readFileSync(path.join(conversationsDir, archive), 'utf-8')).toContain('**User**: hello');
      expect(logs[0]).toContain('Archived conversation to');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps empty transcripts a no-op before reading the optional sessions index', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-noop-${process.pid}-`));
    const transcriptPath = path.join(root, 'empty.jsonl');
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '');

    try {
      fs.mkdirSync(path.join(root, 'sessions-index.json'));
      const logs: string[] = [];
      expect(
        archiveClaudeTranscript({ transcriptPath, sessionId: 'empty', log: (line) => logs.push(line) }, REAL_CLOCK),
      ).toBe(false);
      expect(logs).toEqual([]);
      expect(fs.existsSync(conversationsDir)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a failed archive write instead of throwing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-blocked-${process.pid}-`));
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const conversationsDir = path.join(root, 'not-a-directory');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '{"type":"user","message":{"content":"hello"}}\n');
    fs.writeFileSync(conversationsDir, 'blocked');

    try {
      const logs: string[] = [];
      expect(
        archiveClaudeTranscript({ transcriptPath, sessionId: 'session', log: (line) => logs.push(line) }, REAL_CLOCK),
      ).toBe(false);
      expect(logs[0]).toContain('Failed to archive transcript:');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
