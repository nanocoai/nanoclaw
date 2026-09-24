import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as yaml } from 'yaml';

import { controlCompose, controlPaths, controlPort } from './control.js';
import { emulatedControlImage, localControlImage, pinnedControlImage } from './control-image.js';
import { hasFrontProxy, frontProxyHash } from './build-managed-proxy.js';

const roots: string[] = [];
const temporary = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-control-test-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  delete process.env.NANOCLAW_IRON_CONTROL_PORT;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('official Iron Control installation', () => {
  it('isolates installs and exposes only the console on loopback', () => {
    const root = temporary();
    const other = temporary();
    const config = yaml(controlCompose(root, 18443));
    expect(config.name).not.toBe(yaml(controlCompose(other, 18443)).name);
    expect(config.services.web.ports).toEqual(['127.0.0.1:18443:3000']);
    expect(config.services.database.ports).toBeUndefined();
    expect(config.services.database.env_file).toEqual([controlPaths(root).databaseEnvironment]);
    expect(config.services.web.env_file).toEqual([controlPaths(root).environment]);
    expect(config.services.database.volumes).toEqual(['database:/var/lib/postgresql/data']);
    expect(config.services.web.image).toMatch(/^docker.io\/ironsh\/iron-control:.*@sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(config)).not.toContain('INITIAL_USER_PASSWORD');
  });

  it('uses the configured UI port and rejects invalid input before starting services', () => {
    const root = temporary();
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_IRON_CONTROL_PORT=18080\n');
    expect(controlPort(root)).toBe(18080);
    process.env.NANOCLAW_IRON_CONTROL_PORT = '18500';
    expect(controlPort(root)).toBe(18500);
    process.env.NANOCLAW_IRON_CONTROL_PORT = '70000';
    expect(() => controlPort(root)).toThrow('between 1 and 65535');
    delete process.env.NANOCLAW_IRON_CONTROL_PORT;
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_IRON_CONTROL_PORT=invalid\n');
    expect(() => controlPort(root)).toThrow('between 1 and 65535');
  });

  it('requires both the pinned source and the exact approval front', () => {
    const labels = {
      'org.opencontainers.image.revision': '2393dd175a8c419153fb49917fdeceb94cd9ed59',
      'ai.nanoclaw.approval-front': frontProxyHash,
    };
    expect(hasFrontProxy({ Config: { Labels: labels } })).toBe(true);
    expect(hasFrontProxy({ Config: { Labels: { ...labels, 'ai.nanoclaw.approval-front': 'old' } } })).toBe(false);
    expect(hasFrontProxy({ Config: {} })).toBe(false);
  });
});

describe('Iron Control compose per architecture', () => {
  it('writes the pinned amd64 image and platform byte for byte by default', () => {
    const root = temporary();
    const text = controlCompose(root, 18443);
    expect(text).toBe(controlCompose(root, 18443, pinnedControlImage()));
    const web = yaml(text).services.web;
    expect(Object.keys(web).slice(0, 3)).toEqual(['image', 'platform', 'restart']);
    expect(web.platform).toBe('linux/amd64');
    expect(web.image).toMatch(/^docker.io\/ironsh\/iron-control:.*@sha256:[a-f0-9]{64}$/);
    expect(web.pull_policy).toBeUndefined();
  });

  it('runs a locally built image natively and never pulls it', () => {
    const root = temporary();
    const config = yaml(controlCompose(root, 18443, localControlImage('arm64')));
    expect(config.services.web.image).toMatch(/^nanoclaw-iron-control:[0-9a-f]{7}-arm64$/);
    expect(config.services.web.platform).toBeUndefined();
    expect(config.services.web.pull_policy).toBe('never');
    expect(config.services.web.image).not.toContain('@sha256');
    // Everything else stays as on amd64: loopback port, env files, database.
    const pinned = yaml(controlCompose(root, 18443));
    const { image: _i, platform: _p, ...pinnedWeb } = pinned.services.web;
    const { image: _j, pull_policy: _q, ...localWeb } = config.services.web;
    expect(localWeb).toEqual(pinnedWeb);
    expect(config.services.database).toEqual(pinned.services.database);
  });

  it('keeps the platform pin when the pinned image runs under emulation', () => {
    const root = temporary();
    const config = yaml(controlCompose(root, 18443, emulatedControlImage('arm64')));
    expect(config.services.web.image).toBe(yaml(controlCompose(root, 18443)).services.web.image);
    expect(config.services.web.platform).toBe('linux/amd64');
    expect(config.services.web.pull_policy).toBeUndefined();
  });
});
