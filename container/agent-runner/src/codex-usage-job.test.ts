import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  calculateUsageDelta,
  finishCodexUsageJob,
  formatUsageDelta,
  setCodexUsageCommandRunnerForTest,
  startCodexUsageJob,
  type CodexUsageSnapshot,
} from './codex-usage-job.js';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from './db/connection.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  setCodexUsageCommandRunnerForTest(null);
  delete process.env.NANOCLAW_CODEX_USAGE_COMMAND_JSON;
  delete process.env.FAKE_CODEX_USAGE_COUNTER;
  closeSessionDb();
});

const DISCORD_ROUTING = {
  platformId: 'discord-channel',
  channelType: 'discord',
  threadId: 'thread-1',
  inReplyTo: 'm1',
  taskRun: false,
};

function snapshot(jobId: string, numeric_values: Record<string, number>): CodexUsageSnapshot {
  return {
    schema_version: 'codex-usage-snapshot.v1',
    phase: 'pre',
    job_id: jobId,
    captured_at: '2026-07-31T00:00:00Z',
    command: ['nanoclaw-codex-app-server'],
    exit_code: 0,
    stdout: '{}',
    stderr: '',
    numeric_values,
  };
}

describe('Codex usage job routines', () => {
  it('calculates deltas for overlapping numeric usage fields', () => {
    const delta = calculateUsageDelta(
      snapshot('job-1', { 'tokens.input': 10, 'tokens.output': 2, other: 5 }),
      snapshot('job-1', { 'tokens.input': 25, 'tokens.output': 7, unrelated: 9 }),
      '/pre.json',
      '/post.json',
    );

    expect(delta.deltas).toEqual({ 'tokens.input': 15, 'tokens.output': 5 });
    expect(delta.unavailable_reason).toBeUndefined();
  });

  it('stores pre/post snapshots locally and reports the delta through Discord routing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
    let calls = 0;
    setCodexUsageCommandRunnerForTest(async () => {
      calls += 1;
      return {
        exit_code: 0,
        stdout: JSON.stringify({ tokens: { input: calls === 1 ? 100 : 125, output: calls === 1 ? 40 : 44 } }),
        stderr: '',
      };
    });

    const job = await startCodexUsageJob({ providerName: 'codex', cwd: tmp, routing: DISCORD_ROUTING });
    expect(job).not.toBeNull();
    expect(fs.existsSync(job!.prePath)).toBe(true);

    const delta = await finishCodexUsageJob(job);
    expect(delta?.deltas).toEqual({ 'tokens.input': 25, 'tokens.output': 4 });
    expect(fs.existsSync(delta!.post_path)).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.nanoclaw/codex-usage', `${delta!.job_id}-delta.json`))).toBe(true);

    const rows = getOutboundDb().prepare("SELECT * FROM messages_out WHERE kind = 'chat'").all() as Array<{
      channel_type: string | null;
      platform_id: string | null;
      content: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].channel_type).toBe('discord');
    expect(rows[0].platform_id).toBe('discord-channel');
    expect(JSON.parse(rows[0].content).text).toContain('tokens.input: 25');
  });

  it('reads usage through the Codex app-server JSONL protocol', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-app-server-'));
    const counterPath = path.join(tmp, 'counter.txt');
    const fakeAppServerPath = path.join(tmp, 'fake-codex-app-server.mjs');
    fs.writeFileSync(
      fakeAppServerPath,
      `
import fs from 'node:fs';
import { createInterface } from 'node:readline';

const counterPath = process.env.FAKE_CODEX_USAGE_COUNTER;
const rl = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === 1) {
    send({ id: 1, result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' } });
  }
  if (message.id === 2) {
    const count = counterPath && fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;
    const next = count + 1;
    if (counterPath) fs.writeFileSync(counterPath, String(next));
    send({
      id: 2,
      result: {
        summary: { lifetimeTokens: next === 1 ? 1000 : 1125 },
        dailyUsageBuckets: [{ startDate: '2026-08-01', tokens: next === 1 ? 400 : 425 }],
      },
    });
  }
});
`,
    );
    process.env.FAKE_CODEX_USAGE_COUNTER = counterPath;
    process.env.NANOCLAW_CODEX_USAGE_COMMAND_JSON = JSON.stringify([process.execPath, fakeAppServerPath]);

    const job = await startCodexUsageJob({ providerName: 'codex', cwd: tmp, routing: DISCORD_ROUTING });
    const delta = await finishCodexUsageJob(job);

    expect(delta?.command).toEqual([process.execPath, fakeAppServerPath]);
    expect(delta?.deltas['summary.lifetimeTokens']).toBe(125);
    expect(delta?.deltas['dailyUsageBuckets[0].tokens']).toBe(25);
    delete process.env.FAKE_CODEX_USAGE_COUNTER;
  });

  it('formats unavailable usage when app-server output has no comparable numeric JSON', () => {
    const text = formatUsageDelta({
      job_id: 'job-1',
      pre_path: '/pre.json',
      post_path: '/post.json',
      command: ['nanoclaw-codex-app-server'],
      deltas: {},
      unavailable_reason: 'Codex app-server usage output did not contain comparable numeric JSON fields',
    });

    expect(text).toContain('Usage delta unavailable');
    expect(text).toContain('/pre.json');
    expect(text).toContain('/post.json');
  });
});
