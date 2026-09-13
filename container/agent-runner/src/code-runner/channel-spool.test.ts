import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'bun:test';

import { listSpoolEntries, writeSpoolEntry } from './channel-spool.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-spool-'));
}

describe('channel spool', () => {
  it('round-trips entries and lists them in write order', () => {
    const dir = tempDir();
    const a = writeSpoolEntry({ content: 'first', meta: { ids: 'm1' } }, dir);
    const b = writeSpoolEntry({ content: 'second', meta: { ids: 'm2' } }, dir);
    expect(listSpoolEntries(dir)).toEqual([a, b]);
    expect(JSON.parse(fs.readFileSync(a, 'utf8'))).toEqual({ content: 'first', meta: { ids: 'm1' } });
  });

  it('never lists tmp files and reads a missing dir as empty', () => {
    const dir = tempDir();
    writeSpoolEntry({ content: 'kept', meta: {} }, dir);
    fs.writeFileSync(path.join(dir, 'zz.json.tmp-123'), 'torn');
    expect(listSpoolEntries(dir)).toHaveLength(1);
    expect(listSpoolEntries(path.join(dir, 'absent'))).toEqual([]);
  });
});
