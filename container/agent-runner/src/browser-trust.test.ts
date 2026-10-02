import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { trustGatewayCaForChromium } from './browser-trust.js';

const PEM = (body: string) => `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;

let dir: string;
let calls: string[][];
const run = (cmd: string, args: string[]) => {
  calls.push([cmd, ...args]);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-trust-'));
  calls = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('trustGatewayCaForChromium', () => {
  test('does nothing without a gateway CA', () => {
    expect(trustGatewayCaForChromium({ caPath: undefined, home: dir, run })).toBe(0);
    expect(trustGatewayCaForChromium({ caPath: path.join(dir, 'missing.pem'), home: dir, run })).toBe(0);
    expect(calls).toEqual([]);
  });

  test('creates the NSS database and imports each certificate in the bundle', () => {
    const ca = path.join(dir, 'ca.pem');
    fs.writeFileSync(ca, `${PEM('AAAA')}\n${PEM('BBBB')}\n`);

    expect(trustGatewayCaForChromium({ caPath: ca, home: dir, run })).toBe(2);

    const db = `sql:${path.join(dir, '.pki', 'nssdb')}`;
    expect(calls[0]).toEqual(['certutil', '-N', '-d', db, '--empty-password']);
    expect(calls.slice(1).map((c) => c.slice(0, 9))).toEqual([
      ['certutil', '-A', '-d', db, '-n', 'nanoclaw-gateway-ca-0', '-t', 'C,,', '-i'],
      ['certutil', '-A', '-d', db, '-n', 'nanoclaw-gateway-ca-1', '-t', 'C,,', '-i'],
    ]);
  });

  test('reuses an existing database', () => {
    const ca = path.join(dir, 'ca.pem');
    fs.writeFileSync(ca, PEM('AAAA'));
    fs.mkdirSync(path.join(dir, '.pki', 'nssdb'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.pki', 'nssdb', 'cert9.db'), '');

    trustGatewayCaForChromium({ caPath: ca, home: dir, run });

    expect(calls.map((c) => c[1])).toEqual(['-A']);
  });

  test('an unreadable CA path is logged, not thrown', () => {
    const logs: string[] = [];
    expect(trustGatewayCaForChromium({ caPath: dir, home: dir, run, log: (m) => logs.push(m) })).toBe(0);
    expect(calls).toEqual([]);
    expect(logs[0]).toContain('EISDIR');
  });

  test('a certutil failure is logged, not thrown', () => {
    const ca = path.join(dir, 'ca.pem');
    fs.writeFileSync(ca, PEM('AAAA'));
    const logs: string[] = [];

    const count = trustGatewayCaForChromium({
      caPath: ca,
      home: dir,
      run: () => {
        throw new Error('certutil: not found');
      },
      log: (m) => logs.push(m),
    });

    expect(count).toBe(0);
    expect(logs[0]).toContain('certutil: not found');
  });
});
