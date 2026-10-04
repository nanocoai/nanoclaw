/**
 * Direct browser egress — the shim and the PATH placement.
 *
 * The network attachment itself is a live-Docker behavior and is covered where
 * it is realized (`src/drivers/docker-driver.test.ts` asserts the driver issues
 * the connect; only a real daemon can prove the resulting route works). What is
 * unit-testable here is the part that decides WHICH process loses the proxy —
 * and that is exactly the part a regression would silently widen or silently
 * neuter.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import {
  BROWSER_SHIM_CONTAINER_DIR,
  BROWSER_SHIM_SCRIPT,
  browserShimMount,
  withBrowserShimOnPath,
} from './browser-direct-egress.js';
import { FIXTURE_POLICY, fixtureSpec } from './drivers/spec-fixture.js';
import { classRequiredByPath, validateSpec } from './drivers/types.js';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-browser-egress-'));
}

describe('the shim script', () => {
  it('clears every proxy variable the gateway contribution sets, in both cases', () => {
    // The gateway sets HTTPS_PROXY *and* https_proxy; Chromium reads the
    // lowercase pair natively on Linux, so dropping either half leaves the
    // browser proxied and the feature silently inert.
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      expect(BROWSER_SHIM_SCRIPT).toMatch(new RegExp(`\\bunset\\b[^\\n]*\\b${key}\\b`));
    }
  });

  it('clears NODE_USE_ENV_PROXY too', () => {
    // agent-browser's Node half honors the env proxy only because of this flag;
    // leaving it set proxies its own HTTP calls even with the URLs unset.
    expect(BROWSER_SHIM_SCRIPT).toMatch(/\bunset\b[^\n]*\bNODE_USE_ENV_PROXY\b/);
  });

  it('delegates to the real pnpm launcher rather than reimplementing it', () => {
    // /pnpm/agent-browser is a generated pnpm shim that exports NODE_PATH before
    // exec'ing the package's own entry. Re-implementing that here would drift
    // the day the pinned version in container/cli-tools.json moves.
    expect(BROWSER_SHIM_SCRIPT).toContain('exec /pnpm/agent-browser "$@"');
  });

  it('touches nothing but the proxy variables', () => {
    // A shim that exported anything else would be changing the environment of
    // a process the operator only agreed to un-proxy.
    const exports = BROWSER_SHIM_SCRIPT.split('\n').filter((line) => /^\s*(export|unset)\b/.test(line));
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatch(/^unset /);
  });
});

describe('browserShimMount', () => {
  it('writes an executable shim and mounts it read-only over the real name', () => {
    const dir = tmpDir();
    const mount = browserShimMount('agent-1', dir);

    expect(mount.containerPath).toBe(`${BROWSER_SHIM_CONTAINER_DIR}/agent-browser`);
    expect(mount.mode).toBe('ro');
    expect(mount.groupScope).toBe('agent-1');
    expect(fs.readFileSync(mount.hostPath, 'utf-8')).toBe(BROWSER_SHIM_SCRIPT);
  });

  it('restores the executable bit on an existing file', () => {
    // writeFileSync keeps an existing file's mode, and a non-executable shim
    // fails as a bare "permission denied" inside a --rm container with no logs.
    const dir = tmpDir();
    const first = browserShimMount('agent-1', dir);
    fs.chmodSync(first.hostPath, 0o600);
    const second = browserShimMount('agent-1', dir);
    if (process.platform !== 'win32') {
      expect(fs.statSync(second.hostPath).mode & 0o111).not.toBe(0);
    }
  });
});

describe('withBrowserShimOnPath', () => {
  it('prepends the shim directory ahead of the image PATH, computed in-container', () => {
    const [arg] = withBrowserShimOnPath(['exec bun run /app/src/index.ts']);
    // `$PATH` unexpanded on the host is the point: the image puts /pnpm first,
    // and the host must not have to restate what the image's PATH is.
    expect(arg).toBe(`export PATH="${BROWSER_SHIM_CONTAINER_DIR}:$PATH"; exec bun run /app/src/index.ts`);
    expect(arg).toContain(':$PATH');
  });

  it('keeps the original command as the tail that actually runs', () => {
    const [arg] = withBrowserShimOnPath(['exec bun run /app/src/index.ts']);
    expect(arg.endsWith('exec bun run /app/src/index.ts')).toBe(true);
  });
});

describe('the shim mount against the spec contract', () => {
  it('is a path no class rule pins, so allowlisted-extra is the honest class', () => {
    // Under data/, but outside the materials root and outside every install
    // surface — the two roots whose class is derived from the path.
    expect(classRequiredByPath('/install/data/browser-direct-egress/agent-browser', FIXTURE_POLICY)).toBeNull();
  });

  it('survives validateSpec on an opted-in session', () => {
    const spec = fixtureSpec({ network: 'shared-private+direct' });
    spec.containers[0].mounts.push({
      class: 'allowlisted-extra',
      hostPath: '/install/data/browser-direct-egress/agent-browser',
      containerPath: `${BROWSER_SHIM_CONTAINER_DIR}/agent-browser`,
      mode: 'ro',
      groupScope: 'g1',
    });
    spec.containers[0].args = withBrowserShimOnPath(['exec bun run /app/src/index.ts']);
    expect(() => validateSpec(spec, FIXTURE_POLICY)).not.toThrow();
  });
});
