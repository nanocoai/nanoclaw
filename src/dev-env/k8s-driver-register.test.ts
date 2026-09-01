/**
 * Registration config resolution — the half a unit suite over the driver
 * itself cannot see, and the half that broke in production.
 *
 * The host resolves `NANOCLAW_DEV_ENV_DRIVER` as process.env-then-`.env`, so a
 * deployment that configures the driver in `.env` gets a live driver. Every
 * knob beside it once read process.env ONLY: on the POC the driver came up
 * with `pools: {}` and the configured warm pool silently never filled — no
 * error, no warning, just a pool that wasn't there.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDevEnvDriverFactory } from './driver-registry.js';
import './k8s-driver-register.js';

import type { K8sStampConfig } from './k8s-driver.js';

const KEYS = [
  'NANOCLAW_DEV_ENV_K8S_POOLS',
  'NANOCLAW_DEV_ENV_K8S_PREFIX',
  'NANOCLAW_DEV_ENV_K8S_STAMPS',
  'NANOCLAW_DEV_ENV_K8S_MATERIALS',
  'NANOCLAW_DEV_ENV_K8S_HOST_SUBJECT',
];

let cwd: string;
let dir: string;

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-env-register-'));
  process.chdir(dir);
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const key of KEYS) delete process.env[key];
});

describe('k8s driver registration', () => {
  it('reads its configuration from .env, exactly like the driver flag beside it', () => {
    fs.writeFileSync(
      path.join(dir, '.env'),
      [
        'NANOCLAW_DEV_ENV_DRIVER=k8s',
        'NANOCLAW_DEV_ENV_K8S_POOLS={"sample-app":2}',
        'NANOCLAW_DEV_ENV_K8S_PREFIX=custom-dev',
        'NANOCLAW_DEV_ENV_K8S_STAMPS={"sample-app":{}}',
        '',
      ].join('\n'),
    );

    const driver = getDevEnvDriverFactory('k8s')!({ installScope: 'reg-suite' });

    // The pool is driver-private, so assert through what it produces: a
    // configured pool starts a reconciler, an empty one does not.
    expect((driver as unknown as { pools: Record<string, number> }).pools).toEqual({ 'sample-app': 2 });
    expect((driver as unknown as { prefix: string }).prefix).toBe('custom-dev');
  });

  it('process.env still wins over .env', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'NANOCLAW_DEV_ENV_K8S_PREFIX=from-file\n');
    process.env.NANOCLAW_DEV_ENV_K8S_PREFIX = 'from-process';

    const driver = getDevEnvDriverFactory('k8s')!({ installScope: 'reg-suite' });

    expect((driver as unknown as { prefix: string }).prefix).toBe('from-process');
  });

  it('an absent .env leaves every knob at its default', () => {
    const driver = getDevEnvDriverFactory('k8s')!({ installScope: 'reg-suite' });

    expect((driver as unknown as { pools: Record<string, number> }).pools).toEqual({});
    expect((driver as unknown as { prefix: string }).prefix).toBe('nanoclaw-dev');
  });

  it('legacy stamp entries ({image, port, …}) wrap as {app}; current shapes pass through', () => {
    // The stamp table predates childManifests, and deployments configured it
    // as bare app specs. Both grammars must keep working: a config that
    // claimed fine yesterday must not refuse to construct today.
    process.env.NANOCLAW_DEV_ENV_K8S_STAMPS = JSON.stringify({
      legacy: { image: 'img:1', port: 9090 },
      bare: {},
      current: { app: { image: 'img:2', presence: 'node-local', port: 8081 } },
      child: { childManifests: '{}', readiness: { deployment: 'd', namespace: 'n' } },
    });

    const driver = getDevEnvDriverFactory('k8s')!({ installScope: 'reg-suite' });

    const stamps = (driver as unknown as { stamps: Record<string, K8sStampConfig> }).stamps;
    // The legacy grammar predates image origins (C15); its meaning always WAS
    // node-local, and the wrap now says so explicitly — a bare qualified ref
    // reads as the pull origin, which a code-provided table cannot carry.
    expect(stamps.legacy).toEqual({ app: { image: 'img:1', presence: 'node-local', port: 9090 } });
    expect(stamps.bare).toEqual({});
    expect(stamps.current).toEqual({ app: { image: 'img:2', presence: 'node-local', port: 8081 } });
    expect(stamps.child).toEqual({ childManifests: '{}', readiness: { deployment: 'd', namespace: 'n' } });
  });

  it('refuses a stamp entry that is not an object, by name', () => {
    // `in` on a primitive is a bare TypeError; the operator gets the entry's
    // name and the actual rule instead.
    process.env.NANOCLAW_DEV_ENV_K8S_STAMPS = JSON.stringify({ web: 'nginx:1.27' });

    expect(() => getDevEnvDriverFactory('k8s')!({ installScope: 'reg-suite' })).toThrow(/entry 'web'/);
  });

  it('refuses an entry mixing the legacy grammar with stamp-config fields', () => {
    // Wrapping such an entry as {app} would silently discard its
    // childManifests and readiness — the config lie the constructor refusals
    // exist to catch would never reach them.
    process.env.NANOCLAW_DEV_ENV_K8S_STAMPS = JSON.stringify({
      mixed: { image: 'img:1', port: 80, childManifests: '{}', readiness: { deployment: 'd', namespace: 'n' } },
    });

    expect(() => getDevEnvDriverFactory('k8s')!({ installScope: 'reg-suite' })).toThrow(/mixes/);
  });
});
