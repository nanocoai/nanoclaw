import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { createSessionFileSink } from './session-file-log.js';
import type { SessionKey } from './types.js';

const key: SessionKey = { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' };
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-file-log-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.NANOCLAW_SESSION_LOG_DIR;
  delete process.env.NANOCLAW_SESSION_LOG_MAX_BYTES;
});

const read = (name = 's1.log') => fs.readFileSync(path.join(dir, name), 'utf8').trimEnd().split('\n');

describe('createSessionFileSink', () => {
  it('writes a header and timestamped lines, creating the directory', () => {
    const nested = path.join(dir, 'a', 'b');
    const writer = createSessionFileSink(() => ({ dir: nested, maxBytes: 1_000_000 }))(key, 'ncl-spike-s1')!;
    writer.write('[agent-runner] starting');
    writer.close!();

    const lines = fs.readFileSync(path.join(nested, 's1.log'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z --- container ncl-spike-s1 started ---$/);
    expect(lines[1]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \[agent-runner\] starting$/);
  });

  it('appends when the same session starts another container', () => {
    const sink = createSessionFileSink(() => ({ dir, maxBytes: 1_000_000 }));
    for (const name of ['first', 'second']) {
      const writer = sink(key, name)!;
      writer.write(`line from ${name}`);
      writer.close!();
    }
    expect(read().map((l) => l.slice(l.indexOf(' ') + 1))).toEqual([
      '--- container first started ---',
      'line from first',
      '--- container second started ---',
      'line from second',
    ]);
  });

  it('stops at the size cap with a single marker line', () => {
    const writer = createSessionFileSink(() => ({ dir, maxBytes: 150 }))(key, 'ncl-spike-s1')!;
    for (let i = 0; i < 20; i++) writer.write(`line ${i} ${'x'.repeat(20)}`);
    writer.close!();

    const lines = read();
    expect(lines.filter((l) => l.includes('log capped'))).toHaveLength(1);
    expect(lines.at(-1)).toContain('log capped at 150 bytes');
    expect(fs.statSync(path.join(dir, 's1.log')).size).toBeLessThan(150 + 120);
  });

  it('counts bytes already in the file toward the cap', () => {
    fs.writeFileSync(path.join(dir, 's1.log'), 'x'.repeat(500));
    const writer = createSessionFileSink(() => ({ dir, maxBytes: 100 }))(key, 'ncl-spike-s1')!;
    writer.write('late one');
    writer.write('late two');
    writer.close!();

    const content = fs.readFileSync(path.join(dir, 's1.log'), 'utf8');
    expect(content).not.toContain('late');
    expect(content.match(/log capped/g)).toHaveLength(1);
  });

  it('keeps a hostile session id inside the log directory', () => {
    const writer = createSessionFileSink(() => ({ dir, maxBytes: 1000 }))(
      { ...key, sessionId: '../../etc/x' },
      'ncl-spike-s1',
    )!;
    writer.close!();
    expect(fs.readdirSync(dir)).toEqual(['.._.._etc_x.log']);
  });

  it('declines the session when no options resolve', () => {
    expect(createSessionFileSink(() => null)(key, 'ncl-spike-s1')).toBeUndefined();
  });
});

describe('registration through the drivers barrel', () => {
  it('persists a session opened by the seam', async () => {
    // Importing the real barrel is what breaks if the skill's import line is
    // removed or the module stops evaluating.
    await import('./installed.js');
    const { openSessionLog } = await import('./session-log-sink.js');

    process.env.NANOCLAW_SESSION_LOG_DIR = dir;
    const writer = openSessionLog(key, 'ncl-spike-s1')!;
    expect(writer).not.toBeNull();
    writer.write('hello from the container');
    writer.close();

    expect(read().at(-1)).toMatch(/ hello from the container$/);
  });

  it('writes nothing under test when no directory is configured', async () => {
    await import('./installed.js');
    const { openSessionLog } = await import('./session-log-sink.js');

    expect(openSessionLog(key, 'ncl-spike-s1')).toBeNull();
  });

  it('honors the per-file cap from the environment', async () => {
    await import('./installed.js');
    const { openSessionLog } = await import('./session-log-sink.js');

    process.env.NANOCLAW_SESSION_LOG_DIR = dir;
    process.env.NANOCLAW_SESSION_LOG_MAX_BYTES = '120';
    const writer = openSessionLog(key, 'ncl-spike-s1')!;
    for (let i = 0; i < 10; i++) writer.write(`line ${i} ${'x'.repeat(30)}`);
    writer.close();

    expect(read().at(-1)).toContain('log capped at 120 bytes');
  });
});
