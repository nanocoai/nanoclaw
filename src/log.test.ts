import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from './log.js';

describe('log never throws on unserializable data', () => {
  let written: string[];

  beforeEach(() => {
    written = [];
    const capture = (chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  });

  afterEach(() => vi.restoreAllMocks());

  const throwingTraps: ProxyHandler<object> = {
    get: () => {
      throw new Error('get trap');
    },
    ownKeys: () => {
      throw new Error('ownKeys trap');
    },
    getOwnPropertyDescriptor: () => {
      throw new Error('descriptor trap');
    },
  };

  it('logs a circular non-Error err value', () => {
    const err: Record<string, unknown> = { code: 'E_SINK' };
    err.self = err;
    expect(() => log.warn('sink failed', { err })).not.toThrow();
    expect(written.join('')).toContain('[Circular');
  });

  it('logs a circular value under any other key', () => {
    const node: Record<string, unknown> = { id: 1 };
    node.parent = { child: node };
    expect(() => log.error('bad node', { node })).not.toThrow();
    expect(written.join('')).toContain('[Circular');
  });

  it('logs BigInt values', () => {
    expect(() => log.warn('big', { err: 10n })).not.toThrow();
    expect(written.join('')).toContain('10n');
  });

  it('honors a top-level toJSON whose result holds a BigInt', () => {
    const value = {
      token: 'SECRET',
      toJSON() {
        return { id: 1n };
      },
    };
    expect(() => log.warn('redacted', { err: value })).not.toThrow();
    const out = written.join('');
    expect(out).toContain('1n');
    expect(out).not.toContain('SECRET');
  });

  it('passes the root key to toJSON, as JSON.stringify does', () => {
    const value = {
      token: 'SECRET',
      toJSON(key: string) {
        return key === '' ? { id: 1n } : this;
      },
    };
    log.warn('keyed', { err: value });
    expect(written.join('')).not.toContain('SECRET');
  });

  it('never prints the raw value when toJSON throws', () => {
    const value = {
      token: 'SECRET',
      toJSON() {
        throw new Error('no');
      },
    };
    expect(() => log.warn('throwing toJSON', { err: value })).not.toThrow();
    const out = written.join('');
    expect(out).not.toContain('SECRET');
    expect(out).toContain('[unserializable]');
  });

  it('keeps other fields, but not the value, when a toJSON getter throws', () => {
    const err = {
      token: 'SECRET',
      get toJSON(): never {
        throw new Error('getter');
      },
    };
    log.warn('getter toJSON', { requestId: 'req-123', err });
    const out = written.join('');
    expect(out).toContain('req-123');
    expect(out).not.toContain('SECRET');
  });

  it('does not call toJSON twice', () => {
    const value = {
      token: 'SECRET',
      toJSON() {
        delete (this as { toJSON?: unknown }).toJSON;
        return { id: 1n };
      },
    };
    log.warn('once', { err: value });
    const out = written.join('');
    expect(out).toContain('1n');
    expect(out).not.toContain('SECRET');
  });

  it('keeps fields four levels deep next to a BigInt', () => {
    const err = { n: 1n, a: { b: { c: { d: { code: 'E_DEEP' } } } } };
    log.warn('deep', { err });
    expect(written.join('')).toContain('E_DEEP');
  });

  const redactor = () => ({
    token: 'SECRET',
    toJSON() {
      return { token: '[redacted]' };
    },
  });

  it('honors a nested toJSON when a sibling is a BigInt', () => {
    log.warn('nested bigint', { err: { creds: redactor(), n: 1n } });
    const out = written.join('');
    expect(out).toContain('[redacted]');
    expect(out).toContain('1n');
    expect(out).not.toContain('SECRET');
  });

  it('honors a nested toJSON when the value has a cycle', () => {
    const err: Record<string, unknown> = { creds: redactor() };
    err.self = err;
    log.warn('nested cycle', { err });
    const out = written.join('');
    expect(out).toContain('[redacted]');
    expect(out).toContain('[Circular');
    expect(out).not.toContain('SECRET');
  });

  it('does not mark a shared, non-circular reference as circular', () => {
    const x = { a: 1 };
    log.warn('shared', { v: { p: x, q: x, r: [x] }, n: 1n });
    expect(written.join('')).not.toContain('[Circular');
  });

  it('marks a cycle inside a toJSON result', () => {
    const value = {
      token: 'SECRET',
      toJSON() {
        const o: Record<string, unknown> = { token: '[redacted]' };
        o.self = o;
        return o;
      },
    };
    log.warn('toJSON cycle', { err: { creds: value } });
    const out = written.join('');
    expect(out).toContain('[Circular');
    expect(out).not.toContain('SECRET');
  });

  it('honors a top-level toJSON', () => {
    log.warn('top-level', { err: redactor() });
    const out = written.join('');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('SECRET');
  });

  it('survives a Proxy with throwing traps, as a value or as the data bag', () => {
    expect(() => log.warn('proxy value', { err: new Proxy({}, throwingTraps) })).not.toThrow();
    expect(() => log.warn('proxy bag', new Proxy({}, throwingTraps) as Record<string, unknown>)).not.toThrow();
    const out = written.join('');
    expect(out).toContain('proxy value');
    expect(out).toContain('proxy bag');
  });

  it('survives a throwing getter on the data bag itself', () => {
    const data = {
      ok: 1,
      get boom(): never {
        throw new Error('getter');
      },
    };
    expect(() => log.error('bag', data)).not.toThrow();
    expect(written.join('')).toContain('[log data unserializable]');
  });
});

describe('log redacts secrets', () => {
  let written: string[];

  beforeEach(() => {
    written = [];
    const capture = (chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  });

  afterEach(() => vi.restoreAllMocks());

  const token = ['ghp', 'T3stT0kenQ9wErTy5uIoP1aSdFgH2jKlZx8C'].join('_');

  it('from the message', () => {
    log.info(`cloning https://x-access-token:${token}@github.test/repo.git`);
    expect(written.join('')).not.toContain(token);
  });

  it('from an Error message and stack', () => {
    log.error('push failed', { err: new Error(`Command failed: git push https://${token}@github.test/r.git`) });
    const out = written.join('');
    expect(out).not.toContain(token);
    expect(out).toContain('Command failed: git push');
  });

  it('from a secret-named field even when the value has no known shape', () => {
    log.warn('adapter config', { botToken: 'opaqueTESTVALUE', channel: 'test' });
    const out = written.join('');
    expect(out).not.toContain('opaqueTESTVALUE');
    expect(out).toContain('test');
  });

  it('from nested headers and non-Error error objects', () => {
    log.error('request failed', {
      err: { status: 401, config: { headers: { Authorization: 'Bearer opaqueTESTVALUE', 'x-api-key': 'opaqueKEY' } } },
      response: { body: `{"echo":"${token}"}` },
    });
    const out = written.join('');
    expect(out).not.toContain('opaqueTESTVALUE');
    expect(out).not.toContain('opaqueKEY');
    expect(out).not.toContain(token);
    expect(out).toContain('401');
  });

  it('keeps the issuer prefix and last 4 of a prefixed key in a secret-named field', () => {
    const key = `sk-ant-api03-${'x'.repeat(40)}WXYZ`;
    log.warn('provider config', { apiKey: key, password: 'hunter2hunter2' });
    const out = written.join('');
    expect(out).toContain('sk-ant-api03-[REDACTED]…WXYZ');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('x'.repeat(40));
  });

  it('masks a secret-named field that only looks like a hint', () => {
    log.warn('config', { password: 'hunter2hunter2[REDACTED]…WXYZ' });
    expect(written.join('')).not.toContain('hunter2');
  });

  it('keeps the name of the env key it reports', () => {
    log.info('Updated .env', { key: 'TELEGRAM_BOT_TOKEN', existed: true });
    expect(written.join('')).toContain('TELEGRAM_BOT_TOKEN');
  });
});
