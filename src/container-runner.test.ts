import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  CRASH_BACKOFF_BASE_MS,
  CRASH_BACKOFF_MAX_MS,
  CRASH_FAST_FAIL_MS,
  CRASH_GIVEUP_COOLDOWN_MS,
  MAX_CRASH_RESPAWNS,
  decideCrashExit,
  resolveProviderName,
  type CrashBreakerState,
} from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('buildContainerArgs ordering invariant (structural)', () => {
  // The OneCLI gateway apply (SDK applyContainerConfig) appends credential-stub
  // mounts — e.g. the codex auth.json sentinel nested INSIDE our RW
  // /home/node/.codex mount. Docker applies binds in argument order, so the
  // stub must land AFTER its parent mount or the parent shadows it and the
  // agent silently degrades to loginless auth. Driving the real
  // buildContainerArgs needs a live gateway + container runtime, so this
  // guards the invariant structurally: the gateway apply must appear after
  // the volume-mounts loop in the source.
  it('applies the OneCLI gateway after the volume mounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
  });
});

describe('decideCrashExit', () => {
  const NOW = 1_000_000;

  it('resets on a healthy exit (code 0)', () => {
    expect(decideCrashExit({ fails: 3, notBefore: 0 }, 0, 100, NOW)).toEqual({ kind: 'reset' });
  });

  it('resets on a signalled exit (code null, e.g. host SIGKILL)', () => {
    expect(decideCrashExit({ fails: 2, notBefore: 0 }, null, 100, NOW)).toEqual({ kind: 'reset' });
  });

  it('resets on a long-running crash (alive past fast-fail window)', () => {
    // crashed nonzero but ran long enough to do real work — not a spawn loop
    expect(decideCrashExit({ fails: 1, notBefore: 0 }, 1, CRASH_FAST_FAIL_MS + 1, NOW)).toEqual({
      kind: 'reset',
    });
  });

  it('backs off with exponential delay on the first fast-fails', () => {
    const d1 = decideCrashExit(undefined, 127, 500, NOW);
    expect(d1).toMatchObject({ kind: 'backoff', backoffMs: CRASH_BACKOFF_BASE_MS });
    expect((d1 as { state: CrashBreakerState }).state).toEqual({
      fails: 1,
      notBefore: NOW + CRASH_BACKOFF_BASE_MS,
    });

    const d2 = decideCrashExit({ fails: 1, notBefore: 0 }, 127, 500, NOW);
    expect(d2).toMatchObject({ kind: 'backoff', backoffMs: CRASH_BACKOFF_BASE_MS * 2 });
  });

  it('caps the backoff at CRASH_BACKOFF_MAX_MS', () => {
    // fails high enough that 2^(fails-1)*base would exceed the cap, but still
    // below the give-up threshold
    const prev = { fails: MAX_CRASH_RESPAWNS - 2, notBefore: 0 };
    const d = decideCrashExit(prev, 1, 500, NOW);
    expect(d.kind).toBe('backoff');
    expect((d as { backoffMs: number }).backoffMs).toBeLessThanOrEqual(CRASH_BACKOFF_MAX_MS);
  });

  it('opens the breaker after MAX_CRASH_RESPAWNS consecutive fast-fails', () => {
    const prev = { fails: MAX_CRASH_RESPAWNS - 1, notBefore: 0 };
    const d = decideCrashExit(prev, 127, 500, NOW);
    expect(d).toMatchObject({ kind: 'open', consecutiveFails: MAX_CRASH_RESPAWNS });
    expect((d as { state: CrashBreakerState }).state).toEqual({
      fails: 0,
      notBefore: NOW + CRASH_GIVEUP_COOLDOWN_MS,
    });
  });
});
