import fs from 'node:fs';
import net, { type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getLaunchdLabel } from '../../src/install-slug.js';
import { buildSetupReceipt, inspectService, queryHostHealth } from './service-health.js';

async function stalledServer(root: string): Promise<{ server: Server; sockets: Set<Socket> }> {
  const socketPath = path.join(root, 'data', 'ncl.sock');
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { server, sockets };
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('inspectService', () => {
  it.skipIf(process.platform !== 'darwin')('uses the launchd PID and verifies the NanoClaw script identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-health-'));
    const calls: string[][] = [];
    const result = inspectService(root, (file, args) => {
      calls.push([file, ...args]);
      if (file === 'launchctl') return `${process.pid}\t0\t${getLaunchdLabel(root)}`;
      if (file === 'ps') return `node ${root}/dist/index.js`;
      throw new Error('not used');
    });
    expect(result.state).toBe('running');
    expect(result.manager).toBe('launchd');
    expect(result.pid).toBe(process.pid);
    expect(result.checkoutRoot).toBe(root);
    expect(calls.some(([file]) => file === 'ps')).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== 'darwin')('verifies a NanoClaw script path containing spaces', () => {
    const root = '/tmp/nano claw';
    const result = inspectService(root, (file) => {
      if (file === 'launchctl') return `${process.pid}\t0\t${getLaunchdLabel(root)}`;
      if (file === 'ps') return `node ${root}/dist/index.js`;
      throw new Error('not used');
    });

    expect(result).toMatchObject({
      state: 'running',
      manager: 'launchd',
      pid: process.pid,
      checkoutRoot: root,
    });
  });
});

describe('buildSetupReceipt', () => {
  const root = process.cwd();
  const service = { state: 'running' as const, manager: 'pidfile' as const, pid: 42, checkoutRoot: root };
  const health = {
    status: 'healthy' as const,
    checkoutRoot: root,
    process: { pid: 42, ppid: 1, executable: '/usr/bin/node', script: `${root}/dist/index.js`, cwd: root },
    resources: {
      groups: { state: 'empty' as const, count: 0 },
      policies: { state: 'empty' as const, count: 0 },
      skills: { state: 'empty' as const, count: 0 },
    },
  };

  it('builds a complete-ready receipt for a valid zero-group health report', () => {
    const result = buildSetupReceipt(root, service, health);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receipt.resources.groups).toEqual({ state: 'empty', count: 0 });
      expect(result.receipt.resources.policies).toEqual({ state: 'empty', count: 0 });
      expect(result.receipt.health.status).toBe('healthy');
    }
  });

  it('rejects mismatched service PID, checkout, or unhealthy health', () => {
    expect(buildSetupReceipt(root, { ...service, pid: 43 }, health)).toMatchObject({
      ok: false,
      code: 'health_postcondition_failed',
    });
    expect(buildSetupReceipt('/other/checkout', service, health)).toMatchObject({
      ok: false,
      code: 'service_identity_unproven',
    });
    expect(buildSetupReceipt(root, service, { ...health, status: 'unhealthy' })).toMatchObject({
      ok: false,
      code: 'health_postcondition_failed',
    });
  });
});

describe('queryHostHealth', () => {
  it('bounds a stalled socket request', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-health-socket-'));
    const { server, sockets } = await stalledServer(root);
    try {
      await expect(queryHostHealth(root, { timeoutMs: 20 })).resolves.toBeNull();
    } finally {
      await closeServer(server, sockets);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cancels an in-flight socket request', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-health-abort-'));
    const { server, sockets } = await stalledServer(root);
    const controller = new AbortController();
    try {
      const pending = queryHostHealth(root, { signal: controller.signal, timeoutMs: 5_000 });
      controller.abort();
      await expect(pending).resolves.toBeNull();
    } finally {
      await closeServer(server, sockets);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
