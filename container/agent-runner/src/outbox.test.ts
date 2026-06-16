import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, closeSessionDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { enqueueFileOut } from './outbox.js';

let outboxDir: string;
let srcDir: string;

beforeEach(() => {
  initTestSessionDb();
  outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-outbox-'));
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-src-'));
  process.env.NANOCLAW_OUTBOX_DIR = outboxDir;
});

afterEach(() => {
  closeSessionDb();
  delete process.env.NANOCLAW_OUTBOX_DIR;
  fs.rmSync(outboxDir, { recursive: true, force: true });
  fs.rmSync(srcDir, { recursive: true, force: true });
});

function writeSrc(name: string, bytes: string): string {
  const p = path.join(srcDir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

describe('enqueueFileOut', () => {
  it('stages the file under the outbox and enqueues a messages_out row with files[]', () => {
    const src = writeSrc('ig_abc.png', 'PNGDATA');

    const { id, filename } = enqueueFileOut({
      srcPath: src,
      routing: { platform_id: 'chan-1', channel_type: 'discord', thread_id: 'thr-9', in_reply_to: 'm1' },
      text: 'here you go',
    });

    // Bytes staged at <outbox>/<id>/<filename> for the host to read.
    const staged = path.join(outboxDir, id, filename);
    expect(fs.existsSync(staged)).toBe(true);
    expect(fs.readFileSync(staged, 'utf8')).toBe('PNGDATA');

    // Exactly one outbound row, carrying the file reference + routing.
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const row = out[0];
    expect(row.platform_id).toBe('chan-1');
    expect(row.channel_type).toBe('discord');
    expect(row.thread_id).toBe('thr-9');
    expect(row.in_reply_to).toBe('m1');
    const content = JSON.parse(row.content);
    expect(content.files).toEqual(['ig_abc.png']);
    expect(content.text).toBe('here you go');
  });

  it('defaults filename to the basename and text to empty', () => {
    const src = writeSrc('chart.png', 'X');

    const { filename } = enqueueFileOut({
      srcPath: src,
      routing: { platform_id: 'C-1', channel_type: 'slack', thread_id: null },
    });

    expect(filename).toBe('chart.png');
    const row = getUndeliveredMessages()[0];
    expect(row.in_reply_to).toBeNull();
    const content = JSON.parse(row.content);
    expect(content.text).toBe('');
    expect(content.files).toEqual(['chart.png']);
  });

  it('throws when the source file is missing — callers decide how to surface it', () => {
    expect(() =>
      enqueueFileOut({
        srcPath: path.join(srcDir, 'does-not-exist.png'),
        routing: { platform_id: 'C-1', channel_type: 'slack', thread_id: null },
      }),
    ).toThrow();
    // Nothing enqueued on failure.
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
