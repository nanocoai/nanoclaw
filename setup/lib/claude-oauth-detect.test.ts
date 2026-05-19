import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectClaudeOAuthToken } from './claude-oauth-detect.js';

describe('detectClaudeOAuthToken', () => {
  let tmp: string;
  let fakeHome: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-oauth-test-'));
    fakeHome = path.join(tmp, 'home');
    fs.mkdirSync(fakeHome, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns "file" when ~/.claude/.credentials.json exists', () => {
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"x"}}');
    const deps = {
      execKeychainQuery: vi.fn(() => {
        throw new Error('keychain absent');
      }),
    };
    expect(detectClaudeOAuthToken({ HOME: fakeHome, platform: 'darwin' }, deps)).toBe('file');
  });

  it('returns "keychain" when only macOS keychain has the entry', () => {
    const deps = {
      fileExists: vi.fn(() => false),
      execKeychainQuery: vi.fn(() => '{"claudeAiOauth":{"accessToken":"x"}}'),
    };
    expect(detectClaudeOAuthToken({ HOME: fakeHome, platform: 'darwin' }, deps)).toBe('keychain');
  });

  it('prefers "file" when both file and keychain are present', () => {
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"x"}}');
    const deps = {
      execKeychainQuery: vi.fn(() => '{"claudeAiOauth":{"accessToken":"y"}}'),
    };
    expect(detectClaudeOAuthToken({ HOME: fakeHome, platform: 'darwin' }, deps)).toBe('file');
  });

  it('returns null when neither source has anything', () => {
    const deps = {
      execKeychainQuery: vi.fn(() => {
        throw new Error('keychain absent');
      }),
    };
    expect(detectClaudeOAuthToken({ HOME: fakeHome, platform: 'darwin' }, deps)).toBeNull();
  });

  it('skips keychain probe on linux', () => {
    const deps = {
      execKeychainQuery: vi.fn(() => {
        throw new Error('should not be called');
      }),
    };
    expect(detectClaudeOAuthToken({ HOME: fakeHome, platform: 'linux' }, deps)).toBeNull();
    expect(deps.execKeychainQuery).not.toHaveBeenCalled();
  });

  it('returns "file" on linux when ~/.claude/.credentials.json exists', () => {
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"x"}}');
    const deps = {
      execKeychainQuery: vi.fn(),
    };
    expect(detectClaudeOAuthToken({ HOME: fakeHome, platform: 'linux' }, deps)).toBe('file');
  });
});
