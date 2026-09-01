/**
 * Registration config resolution for the docker driver — the half a unit
 * suite over the driver itself cannot see.
 *
 * The precedence is the same one the k8s knobs had to learn the expensive
 * way: `NANOCLAW_DEV_ENV_DRIVER` resolves as process.env-then-`.env`, so a
 * deployment that configures the driver in `.env` gets a live driver, and a
 * knob that read process.env ONLY came up silently at its default.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import './docker-driver-register.js';
import { getDevEnvDriverFactory, listDevEnvDriverKinds } from './driver-registry.js';
import type { K8sStampConfig } from './docker-driver.js';

const KEYS = [
  'NANOCLAW_DEV_ENV_DOCKER_STAMPS',
  'NANOCLAW_DEV_ENV_DOCKER_PROBE_IMAGE',
  'NANOCLAW_DEV_ENV_DOCKER_BOOT_TIMEOUT_MS',
];

let cwd: string;
let dir: string;

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-env-docker-register-'));
  process.chdir(dir);
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const key of KEYS) delete process.env[key];
});

describe('docker driver registration', () => {
  it('registers under its own kind, beside every other installed driver', () => {
    // Registration, never selection editing: the overlay appends an import to
    // installed.ts and the seam's kind list grows by one.
    expect(listDevEnvDriverKinds()).toContain('docker');
    expect(getDevEnvDriverFactory('docker')!({ installScope: 'reg-suite' }).kind).toBe('docker');
  });

  it('reads its configuration from .env, exactly like the driver flag beside it', () => {
    fs.writeFileSync(
      path.join(dir, '.env'),
      [
        'NANOCLAW_DEV_ENV_DRIVER=docker',
        'NANOCLAW_DEV_ENV_DOCKER_PROBE_IMAGE=mirror.gcr.io/library/busybox:1.36',
        'NANOCLAW_DEV_ENV_DOCKER_BOOT_TIMEOUT_MS=90000',
        '',
      ].join('\n'),
    );

    const driver = getDevEnvDriverFactory('docker')!({ installScope: 'reg-suite' });

    expect((driver as unknown as { proberImage: string }).proberImage).toBe('mirror.gcr.io/library/busybox:1.36');
    expect((driver as unknown as { bootTimeoutMs: number }).bootTimeoutMs).toBe(90_000);
  });

  it('process.env still wins over .env', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'NANOCLAW_DEV_ENV_DOCKER_PROBE_IMAGE=from-file/img:1\n');
    process.env.NANOCLAW_DEV_ENV_DOCKER_PROBE_IMAGE = 'from-process/img:1';

    const driver = getDevEnvDriverFactory('docker')!({ installScope: 'reg-suite' });

    expect((driver as unknown as { proberImage: string }).proberImage).toBe('from-process/img:1');
  });

  it('an absent .env leaves every knob at its default — the builtin stamp table included', () => {
    const driver = getDevEnvDriverFactory('docker')!({ installScope: 'reg-suite' });

    const stamps = (driver as unknown as { stamps: Record<string, K8sStampConfig> }).stamps;
    expect(Object.keys(stamps)).toContain('sample-app');
    expect((driver as unknown as { proberImage: string }).proberImage).toBe('mirror.gcr.io/library/alpine:3.20');
  });

  it('refuses a stamp entry that is not an object, by name', () => {
    // `in` on a primitive is a bare TypeError; the operator gets the entry's
    // name and the actual rule instead.
    process.env.NANOCLAW_DEV_ENV_DOCKER_STAMPS = JSON.stringify({ web: 'nginx:1.27' });

    expect(() => getDevEnvDriverFactory('docker')!({ installScope: 'reg-suite' })).toThrow(/entry 'web'/);
  });

  it('refuses a malformed boot budget rather than defaulting past it', () => {
    process.env.NANOCLAW_DEV_ENV_DOCKER_BOOT_TIMEOUT_MS = 'soon';

    expect(() => getDevEnvDriverFactory('docker')!({ installScope: 'reg-suite' })).toThrow(/positive number/);
  });

  it('earns the shared stamp refusals at construction, in front of the operator who configured them', () => {
    // The same refusal set the registry's write path earns, so a
    // hand-configured table cannot smuggle past what an approver would see.
    process.env.NANOCLAW_DEV_ENV_DOCKER_STAMPS = JSON.stringify({
      broken: { childManifests: '{}' }, // no readiness declaration
    });

    expect(() => getDevEnvDriverFactory('docker')!({ installScope: 'reg-suite' })).toThrow(/readiness/);
  });
});
