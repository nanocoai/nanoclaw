import { describe, it, expect } from 'vitest';

import { computeUserSystemdEnv } from './systemd-user-env.js';

function existsFrom(paths: Set<string>) {
  return (p: string) => paths.has(p);
}

describe('computeUserSystemdEnv', () => {
  it('populates env when linger is on and the runtime dir exists (#2482 repro)', () => {
    const result = computeUserSystemdEnv({
      uid: 1000,
      user: 'nanoclaw',
      env: {},
      exists: existsFrom(
        new Set(['/var/lib/systemd/linger/nanoclaw', '/run/user/1000']),
      ),
    });

    expect(result).toEqual({
      reason: 'populated',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    });
  });

  it('no-ops when XDG_RUNTIME_DIR is already set (SSH login path)', () => {
    const result = computeUserSystemdEnv({
      uid: 1000,
      user: 'nanoclaw',
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      exists: existsFrom(
        new Set(['/var/lib/systemd/linger/nanoclaw', '/run/user/1000']),
      ),
    });

    expect(result.reason).toBe('already_set');
    expect(result.XDG_RUNTIME_DIR).toBeUndefined();
    expect(result.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
  });

  it('returns no_linger when the linger marker is absent', () => {
    const result = computeUserSystemdEnv({
      uid: 1000,
      user: 'nanoclaw',
      env: {},
      exists: existsFrom(new Set(['/run/user/1000'])),
    });

    expect(result.reason).toBe('no_linger');
    expect(result.XDG_RUNTIME_DIR).toBeUndefined();
  });

  it('returns no_runtime_dir when linger is on but /run/user/<uid> is missing', () => {
    // The defensive guard from #2482: without this we would point env vars
    // at a non-existent socket and the daemon-reload probe would fail with a
    // less recoverable error than the bare "No medium found".
    const result = computeUserSystemdEnv({
      uid: 1000,
      user: 'nanoclaw',
      env: {},
      exists: existsFrom(new Set(['/var/lib/systemd/linger/nanoclaw'])),
    });

    expect(result.reason).toBe('no_runtime_dir');
    expect(result.XDG_RUNTIME_DIR).toBeUndefined();
  });

  it('returns no_user when USER and LOGNAME are both missing', () => {
    const result = computeUserSystemdEnv({
      uid: 1000,
      user: undefined,
      env: {},
      exists: existsFrom(new Set()),
    });

    expect(result.reason).toBe('no_user');
  });

  it('returns no_uid when process.getuid is unavailable', () => {
    const result = computeUserSystemdEnv({
      uid: undefined,
      user: 'nanoclaw',
      env: {},
      exists: existsFrom(new Set()),
    });

    expect(result.reason).toBe('no_uid');
  });
});
