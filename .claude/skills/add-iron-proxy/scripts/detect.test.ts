import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectInstalledIronProxy } from './detect.js';
import {
  centralHostGatewayArgs,
  centralInstallLabel,
} from './setup.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Iron Proxy installation detection', () => {
  it("requires this install's configured central container to be running", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-detect-'));
    roots.push(root);
    const inspect = vi.fn(() => true);

    expect(detectInstalledIronProxy(root, inspect)).toBe(false);
    expect(inspect).not.toHaveBeenCalled();

    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_IRON_PROXY_CONTAINER=nanoclaw-iron-proxy-test\n');
    expect(detectInstalledIronProxy(root, inspect)).toBe(true);
    expect(inspect).toHaveBeenCalledWith('nanoclaw-iron-proxy-test');

    inspect.mockReturnValue(false);
    expect(detectInstalledIronProxy(root, inspect)).toBe(false);
  });

  it('lets the central proxy reach local model endpoints on Linux', () => {
    expect(centralHostGatewayArgs('linux')).toEqual(['--add-host', 'host.docker.internal:host-gateway']);
    expect(centralHostGatewayArgs('darwin')).toEqual([]);
  });

  it('uses the generic install label so uninstall removes the central container', () => {
    expect(centralInstallLabel('/tmp/nanoclaw-install')).toMatch(/^nanoclaw-install=[0-9a-f]{8}$/);
  });
});
