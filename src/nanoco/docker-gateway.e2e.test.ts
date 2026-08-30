import { spawn, execFileSync, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrepareSessionEgressContext, SessionEgressHandle } from '../session-egress.js';
import { GatewaySessionChannelProvisioner } from './gateway-provisioner.js';
import { DockerSessionSidecarDriver, NanoCoSessionSidecarManager } from './session-sidecar.js';

const enabled = process.env.NANOCO_DOCKER_E2E === '1';
const gatewayCheckout = process.env.NANOCO_GW_CHECKOUT ?? '';
const sidecarImage = process.env.NANOCO_SIDECAR_IMAGE ?? 'nanoco-sidecar:e2e';
const agentImage = process.env.NANOCO_E2E_AGENT_IMAGE ?? 'curlimages/curl:8.14.1';

interface FixtureReady {
  ready: true;
  gatewayAddress: string;
  gatewayServerName: string;
  controlUrl: string;
  controlServerName: string;
  upstreamUrl: string;
  deploymentId: string;
  agentId: string;
  sessionId: string;
  runtimeId: string;
  containerInstanceId: string;
  channelId: string;
}

describe.skipIf(!enabled)('NanoCo real Docker + Gateway mTLS boundary', () => {
  let materialDir = '';
  let gateway: ChildProcessWithoutNullStreams | null = null;
  let ready: FixtureReady;
  let handle: SessionEgressHandle | null = null;

  beforeAll(async () => {
    if (!gatewayCheckout || !path.isAbsolute(gatewayCheckout)) {
      throw new Error('NANOCO_GW_CHECKOUT must be an absolute Gateway checkout path');
    }
    execFileSync('docker', ['build', '--file', 'Dockerfile.sidecar', '--tag', sidecarImage, '.'], {
      cwd: gatewayCheckout,
      stdio: 'inherit',
      timeout: 600_000,
    });
    materialDir = fs.mkdtempSync(path.join(gatewayCheckout, '.nanoco-e2e-'));
    const fixtureProcess = spawn(
      'cargo',
      ['run', '--quiet', '--example', 'session_channel_gateway_fixture', '--', materialDir],
      {
        cwd: gatewayCheckout,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    fixtureProcess.stdin.end();
    gateway = fixtureProcess;
    ready = await waitForFixture(fixtureProcess);
  }, 660_000);

  afterAll(async () => {
    if (handle) {
      await handle.close('e2e-finalizer').catch(() => {});
      handle = null;
    }
    if (gateway && gateway.exitCode === null) {
      gateway.kill('SIGTERM');
      await waitForExit(gateway);
    }
    if (materialDir) fs.rmSync(materialDir, { recursive: true, force: true });
  });

  it('runs a credential-free agent request through its isolated sidecar and trusted Gateway identity', async () => {
    const sessionMaterialRoot = path.join(materialDir, 'session-materials');
    const provisioner = new GatewaySessionChannelProvisioner({
      deploymentId: ready.deploymentId,
      controlUrl: ready.controlUrl,
      controlServerName: ready.controlServerName,
      gatewayAddress: ready.gatewayAddress,
      gatewayServerName: ready.gatewayServerName,
      gatewayCaPath: path.join(materialDir, 'gateway-ca.pem'),
      deploymentCertificatePath: path.join(materialDir, 'deployment-cert.pem'),
      deploymentPrivateKeyPath: path.join(materialDir, 'deployment-key.pem'),
      proxyCaPath: path.join(materialDir, 'proxy-ca.pem'),
      materialRoot: sessionMaterialRoot,
    });
    const manager = new NanoCoSessionSidecarManager(
      { deploymentId: ready.deploymentId, sidecarImage },
      provisioner,
      new DockerSessionSidecarDriver(),
      () => ready.runtimeId,
    );
    const context: PrepareSessionEgressContext = {
      session: {
        id: ready.sessionId,
        agent_group_id: ready.agentId,
        messaging_group_id: 'messaging-docker-e2e',
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: null,
        created_at: '2026-07-22T00:00:00.000Z',
      },
      agentGroup: {
        id: ready.agentId,
        name: 'Docker E2E Agent',
        folder: 'docker-e2e-agent',
        agent_provider: null,
        created_at: '2026-07-22T00:00:00.000Z',
      },
      containerName: 'nanoco-docker-e2e-agent',
    };

    handle = await manager.prepare(context);
    const args = ['run', '--rm', ...handle.agentNetworkArgs];
    for (const [name, value] of Object.entries(handle.agentEnvironment)) {
      args.push('--env', `${name}=${value}`);
    }
    for (const mount of handle.agentMounts ?? []) {
      args.push('--volume', `${mount.hostPath}:${mount.containerPath}:ro`);
    }
    args.push(
      agentImage,
      '--silent',
      '--show-error',
      '--fail',
      '--retry',
      '30',
      '--retry-connrefused',
      '--retry-delay',
      '0',
      '--max-time',
      '30',
      '--proxy',
      'http://sidecar:15001',
      '--noproxy',
      '',
      '--header',
      'X-Agent-Id: forged-agent',
      '--header',
      'X-Session-Id: forged-session',
      '--header',
      'X-Channel-Id: forged-channel',
      '--header',
      'X-Owner-Id: forged-owner',
      ready.upstreamUrl,
    );

    const response = execFileSync('docker', args, { encoding: 'utf-8', timeout: 60_000 });
    expect(response).toBe('session-channel-ok');
    expect(readJson(path.join(materialDir, 'trusted-identity.json'))).toEqual({
      deploymentId: ready.deploymentId,
      agentId: ready.agentId,
      sessionId: ready.sessionId,
      containerInstanceId: ready.containerInstanceId,
      channelId: ready.channelId,
    });
    expect(readJson(path.join(materialDir, 'forwarded-request.json'))).toEqual({
      proxyAuthorizationForwarded: false,
      agentIdentityForwarded: false,
      sessionIdentityForwarded: false,
      channelIdentityForwarded: false,
      ownerIdentityForwarded: false,
    });

    const sidecarName = `${context.containerName}-sidecar`;
    expect(
      execFileSync('docker', ['inspect', '--format', '{{.Name}}', sidecarName], {
        encoding: 'utf-8',
      }).trim(),
    ).toBe(`/${sidecarName}`);
    const sidecarLogs = spawnSync('docker', ['logs', sidecarName], { encoding: 'utf-8' });
    expect(sidecarLogs.status).toBe(0);
    const combinedLogs = `${sidecarLogs.stdout}${sidecarLogs.stderr}`;
    expect(combinedLogs).toContain('sidecar relay accepted');
    expect(combinedLogs).toContain('sidecar relay authenticated with Gateway mTLS');
    expect(combinedLogs).toContain('sidecar relay closed');
    expect(combinedLogs).toMatch(/"(?:clean_close|peer_disconnected)"/);
    expect(combinedLogs).not.toContain('session-key.pem');
    expect(combinedLogs).not.toContain('session-cert.pem');

    await handle.close('e2e-complete');
    handle = null;
    expect(fs.readdirSync(sessionMaterialRoot)).toEqual([]);
    const remaining = execFileSync(
      'docker',
      ['ps', '--all', '--filter', `label=nanoco-channel=${ready.channelId}`, '--format', '{{.Names}}'],
      { encoding: 'utf-8' },
    );
    expect(remaining.trim()).toBe('');
  }, 120_000);
});

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function waitForFixture(child: ChildProcessWithoutNullStreams): Promise<FixtureReady> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Gateway fixture readiness timed out: ${stderr}`)), 60_000);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Gateway fixture exited before readiness (code ${code}): ${stderr}`));
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const value = JSON.parse(line) as Partial<FixtureReady>;
        if (value.ready === true) {
          clearTimeout(timer);
          lines.close();
          resolve(value as FixtureReady);
        }
      } catch {
        // Ignore non-JSON diagnostics; the fixture readiness contract is one JSON line.
      }
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}
