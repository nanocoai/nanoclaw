import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { materializeNativeAuthBundle } from './bundle-materializer.js';

describe('materializeNativeAuthBundle', () => {
  let tmp: string;
  let sessionDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-bundle-test-'));
    sessionDir = path.join(tmp, 'session');
    fakeHome = path.join(tmp, 'home');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.codex', 'auth.json'), JSON.stringify({ access_token: 'real-token' }));
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('copies host: bundle into per-session dir and returns a mount spec', () => {
    const result = materializeNativeAuthBundle(
      {
        kind: 'native_auth_bundle',
        providerId: 'codex',
        bundleRef: 'host:~/.codex/auth.json',
        mountPath: '/home/node/.codex/auth.json',
        refreshPolicy: 'runtime',
      },
      sessionDir,
      { HOME: fakeHome } as NodeJS.ProcessEnv,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mount.containerPath).toBe('/home/node/.codex/auth.json');
    expect(fs.existsSync(result.mount.hostPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(result.mount.hostPath, 'utf-8'))).toEqual({
      access_token: 'real-token',
    });
    expect(result.mount.readonly).toBe(false);
  });

  it('honours absolute host paths', () => {
    const abs = path.join(fakeHome, '.codex', 'auth.json');
    const result = materializeNativeAuthBundle(
      {
        kind: 'native_auth_bundle',
        providerId: 'codex',
        bundleRef: `host:${abs}`,
        mountPath: '/home/node/.codex/auth.json',
        refreshPolicy: 'runtime',
      },
      sessionDir,
      { HOME: fakeHome } as NodeJS.ProcessEnv,
    );
    expect(result.ok).toBe(true);
  });

  it('returns missing_source when host file does not exist', () => {
    fs.rmSync(path.join(fakeHome, '.codex', 'auth.json'));
    const result = materializeNativeAuthBundle(
      {
        kind: 'native_auth_bundle',
        providerId: 'codex',
        bundleRef: 'host:~/.codex/auth.json',
        mountPath: '/home/node/.codex/auth.json',
        refreshPolicy: 'runtime',
      },
      sessionDir,
      { HOME: fakeHome } as NodeJS.ProcessEnv,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_source');
  });

  it('rejects unsupported bundleRef scheme', () => {
    const result = materializeNativeAuthBundle(
      {
        kind: 'native_auth_bundle',
        providerId: 'codex',
        bundleRef: 'onecli:bundle-123',
        mountPath: '/home/node/.codex/auth.json',
        refreshPolicy: 'runtime',
      },
      sessionDir,
      { HOME: fakeHome } as NodeJS.ProcessEnv,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unsupported_scheme');
  });

  it('respects readonly flag in the returned mount', () => {
    const result = materializeNativeAuthBundle(
      {
        kind: 'native_auth_bundle',
        providerId: 'codex',
        bundleRef: 'host:~/.codex/auth.json',
        mountPath: '/home/node/.codex/auth.json',
        refreshPolicy: 'runtime',
        readonly: true,
      },
      sessionDir,
      { HOME: fakeHome } as NodeJS.ProcessEnv,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mount.readonly).toBe(true);
  });
});
