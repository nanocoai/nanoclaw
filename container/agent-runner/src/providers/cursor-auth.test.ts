import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { TIMEZONE, formatLocalTime } from '../timezone.js';
import { formatMintedKeyMessage, mintCursorApiKey, parseCursorAuthArgs } from './cursor-auth.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function outputPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-auth-helper-'));
  dirs.push(dir);
  return path.join(dir, 'api-key');
}

describe('Cursor SDK auth helper', () => {
  it('mints without persistence and writes only to a mode-0600 handoff file', async () => {
    const keyPath = outputPath();
    let received: Record<string, unknown> | undefined;

    const result = await mintCursorApiKey({
      outputPath: keyPath,
      openBrowser: false,
      login: async (options) => {
        received = options as unknown as Record<string, unknown>;
        return {
          apiKey: 'cursor_minted_without_stdout',
          email: 'user@example.com',
          apiKeyExpiresAtMs: 123,
        };
      },
      onLoginUrl: () => {},
    });

    expect(received?.store).toBeNull();
    expect(received?.openBrowser).toBe(false);
    expect(received?.apiKeyName).toBe('NanoClaw');
    expect(fs.readFileSync(keyPath, 'utf-8')).toBe('cursor_minted_without_stdout');
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(result).toEqual({ email: 'user@example.com', apiKeyExpiresAtMs: 123 });
  });

  it('passes browser mode and the URL callback through to the SDK', async () => {
    const keyPath = outputPath();
    const onLoginUrl = () => {};
    let received: Record<string, unknown> | undefined;

    await mintCursorApiKey({
      outputPath: keyPath,
      openBrowser: true,
      onLoginUrl,
      login: async (options) => {
        received = options as unknown as Record<string, unknown>;
        return { apiKey: 'cursor_browser_key', apiKeyExpiresAtMs: 456 };
      },
    });

    expect(received?.openBrowser).toBe(true);
    expect(received?.onLoginUrl).toBe(onLoginUrl);
    expect(received?.store).toBeNull();
  });

  it('leaves no handoff file when SDK login fails', async () => {
    const keyPath = outputPath();
    await expect(
      mintCursorApiKey({
        outputPath: keyPath,
        openBrowser: false,
        login: async () => {
          throw new Error('login denied');
        },
      }),
    ).rejects.toThrow('login denied');
    expect(fs.existsSync(keyPath)).toBe(false);
  });

  it('rejects an empty SDK key instead of writing a zero-byte credential', async () => {
    const keyPath = outputPath();
    await expect(
      mintCursorApiKey({
        outputPath: keyPath,
        openBrowser: false,
        login: async () => ({ apiKey: '', apiKeyExpiresAtMs: 0 }),
      }),
    ).rejects.toThrow('empty API key');
    expect(fs.existsSync(keyPath)).toBe(false);
  });

  it('never overwrites an existing handoff file', async () => {
    const keyPath = outputPath();
    fs.writeFileSync(keyPath, 'do-not-overwrite', { mode: 0o600 });
    await expect(
      mintCursorApiKey({
        outputPath: keyPath,
        openBrowser: false,
        login: async () => ({ apiKey: 'cursor_new_key', apiKeyExpiresAtMs: 789 }),
      }),
    ).rejects.toThrow();
    expect(fs.readFileSync(keyPath, 'utf-8')).toBe('do-not-overwrite');
  });

  it('summarizes login with expiry and never echoes the key', () => {
    const apiKeyExpiresAtMs = Date.UTC(2026, 10, 18, 12, 0, 0);
    const message = formatMintedKeyMessage({
      email: 'user@example.com',
      apiKeyExpiresAtMs,
    });
    expect(message).toContain('as user@example.com');
    expect(message).toContain(formatLocalTime(new Date(apiKeyExpiresAtMs).toISOString(), TIMEZONE));
    expect(message).not.toMatch(/cursor_|sk-|key_/);
  });
});

describe('Cursor auth helper arguments', () => {
  it('defaults to browser login', () => {
    expect(parseCursorAuthArgs(['--output', '/tmp/key'])).toEqual({
      outputPath: '/tmp/key',
      openBrowser: true,
    });
  });

  it('supports URL-only login', () => {
    expect(parseCursorAuthArgs(['--no-browser', '--output', '/tmp/key'])).toEqual({
      outputPath: '/tmp/key',
      openBrowser: false,
    });
  });

  it('rejects a missing or empty output path', () => {
    expect(() => parseCursorAuthArgs([])).toThrow('Usage:');
    expect(() => parseCursorAuthArgs(['--output'])).toThrow('Usage:');
    expect(() => parseCursorAuthArgs(['--output', ''])).toThrow('Usage:');
  });
});
