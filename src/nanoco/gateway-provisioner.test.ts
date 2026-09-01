import { execFileSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { inspect } from 'util';

import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import {
  classifyGatewayRenewalFailure,
  GatewayControlRequestError,
  GatewaySessionChannelProvisioner,
} from './gateway-provisioner.js';
import {
  NanoCoSessionSidecarManager,
  SessionChannelProvisioningError,
  SessionChannelRenewalError,
  type SessionChannelLineage,
  type SessionSidecarDriver,
  type SessionSidecarProcess,
} from './session-sidecar.js';
import type { ContainerSpec } from '../drivers/types.js';
import type { PrepareSessionEgressContext } from '../session-egress.js';

const lineage: SessionChannelLineage = {
  deploymentId: 'deployment-1',
  agentId: 'agent-1',
  sessionId: 'session-1',
  containerInstanceId: 'container-1',
  channelId: 'channel-1',
};

/** A queued reply for the next renew call; absent means a normal 200. */
type RenewOutcome = { status: number; body: unknown };

/** What the in-test Gateway persists per channel — the idempotency ground truth. */
interface FixtureChannel {
  lineage: SessionChannelLineage;
  csrPem: string;
  certificatePem: string;
  leaseVersion: number;
  status: 'active' | 'revoked';
}

let fixture: ControlFixture;

beforeAll(async () => {
  fixture = await ControlFixture.start();
}, 30_000);

beforeEach(() => {
  fixture?.reset();
});

afterAll(async () => {
  await fixture?.close();
});

/** Keeps the composed-path test on the real provisioner without touching Docker. */
class NoopSidecarDriver implements SessionSidecarDriver {
  readonly sharesNetworkNamespace = false;
  contributedContainers(): readonly ContainerSpec[] {
    return [];
  }
  agentNetworkArgs(privateNetwork: string): readonly string[] {
    return ['--network', privateNetwork];
  }
  createNetwork(): void {}
  createSidecar(): void {}
  startSidecar(): SessionSidecarProcess {
    return { on: () => this } as unknown as SessionSidecarProcess;
  }
  stopSidecar(): void {}
  removeSidecar(): void {}
  removeNetwork(): void {}
}

const sidecarContext: PrepareSessionEgressContext = {
  session: {
    id: lineage.sessionId,
    agent_group_id: lineage.agentId,
    messaging_group_id: 'messaging-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-07-22T00:00:00.000Z',
  },
  agentGroup: {
    id: lineage.agentId,
    name: 'Agent One',
    folder: 'agent-one',
    agent_provider: null,
    created_at: '2026-07-22T00:00:00.000Z',
  },
  containerName: 'agent-container-1',
};

function newProvisioner(target: ControlFixture = fixture): GatewaySessionChannelProvisioner {
  return new GatewaySessionChannelProvisioner({
    deploymentId: lineage.deploymentId,
    controlUrl: target.url,
    controlServerName: 'localhost',
    gatewayAddress: 'gateway.example:9443',
    gatewayServerName: 'gateway.example',
    gatewayCaPath: target.serverCa,
    deploymentCertificatePath: target.deploymentCertificate,
    deploymentPrivateKeyPath: target.deploymentPrivateKey,
    proxyCaPath: target.proxyCa,
    materialRoot: target.materialRoot,
  });
}

it('generates the session key locally and drives provision renew revoke release over deployment mTLS', async () => {
  const provisioner = newProvisioner();

  const provisioned = await provisioner.provision(lineage);
  expect(provisioned.lineage).toEqual(lineage);
  expect(provisioned.gatewayAddress).toBe('gateway.example:9443');
  expect(provisioned.gatewayServerName).toBe('gateway.example');
  expect(provisioned.leaseVersion).toBe(1);
  expect(Date.parse(provisioned.expiresAt)).toBeGreaterThan(Date.now());
  expect(fs.readFileSync(provisioned.materials.clientCertificatePath(), 'utf8')).toContain('BEGIN CERTIFICATE');
  expect(fs.readFileSync(provisioned.materials.clientPrivateKeyPath(), 'utf8')).toContain('PRIVATE KEY');
  expect(fs.statSync(provisioned.materials.clientPrivateKeyPath()).mode & 0o777).toBe(0o600);
  // The CSR and lineage survive for re-adoption — public-key material and five
  // identifiers, never the key. Everything in the 0700 dir is 0600.
  const materialDir = path.dirname(provisioned.materials.clientPrivateKeyPath());
  expect(fs.readdirSync(materialDir).sort()).toEqual([
    'lineage.json',
    'session-cert.pem',
    'session-key.pem',
    'session.csr.pem',
  ]);
  expect(fs.statSync(path.join(materialDir, 'session.csr.pem')).mode & 0o777).toBe(0o600);
  expect(JSON.parse(fs.readFileSync(path.join(materialDir, 'lineage.json'), 'utf8'))).toEqual(lineage);

  const renewed = await provisioner.renew(provisioned);
  expect(renewed.leaseVersion).toBe(2);
  expect(renewed.materials).toBe(provisioned.materials);

  await provisioner.revoke(renewed, 'test-complete');
  const materialDirectory = path.dirname(renewed.materials.clientPrivateKeyPath());
  await provisioner.release(renewed);
  expect(fs.existsSync(materialDirectory)).toBe(false);
  expect(fixture.lifecycle).toEqual(['provision:channel-1', 'renew:channel-1:1', 'revoke:channel-1']);

  const debug = inspect(provisioner);
  expect(debug).toContain('[redacted]');
  expect(debug).not.toContain(fixture.deploymentPrivateKey);
});

it('retries transient provision control failures inside the spawn and keeps safe failure detail', async () => {
  fixture.provisionQueue.push({ status: 503, body: { error: 'control_unavailable' } });
  const provisioned = await newProvisioner().provision({ ...lineage, channelId: 'channel-provision-retry' });
  expect(provisioned.lineage.channelId).toBe('channel-provision-retry');
  expect(fixture.lifecycle).toEqual(['provision:channel-provision-retry', 'provision:channel-provision-retry']);

  fixture.provisionQueue.push(
    { status: 503, body: { error: 'control_unavailable' } },
    { status: 503, body: { error: 'control_unavailable' } },
    { status: 503, body: { error: 'control_unavailable' } },
  );
  const error = await newProvisioner().provision({ ...lineage, channelId: 'channel-provision-exhausted' })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SessionChannelProvisioningError);
  expect(error).toMatchObject({
    stage: 'control_request',
    status: 503,
    code: 'control_unavailable',
    transport: null,
  });
  expect(String(error)).not.toContain('BEGIN');
});

it('maps gateway statuses and transport failures onto renewal retry classes', () => {
  const cases: Array<[unknown, string]> = [
    [new GatewayControlRequestError({ status: 410, code: 'channel_revoked' }), 'fatal'],
    [new GatewayControlRequestError({ status: 410, code: 'certificate_expired' }), 'fatal'],
    [new GatewayControlRequestError({ status: 404, code: 'channel_not_found' }), 'fatal'],
    [new GatewayControlRequestError({ status: 403, code: 'deployment_mismatch' }), 'fatal'],
    // A revocation whose body never parsed is still a revocation.
    [new GatewayControlRequestError({ status: 410, code: null }), 'fatal'],
    [new GatewayControlRequestError({ status: 409, code: 'stale_lease_version' }), 'stale_version'],
    [new GatewayControlRequestError({ status: 500, code: 'control_unavailable' }), 'transient'],
    [new GatewayControlRequestError({ status: 502, code: null }), 'transient'],
    [new GatewayControlRequestError({ transport: 'timeout' }), 'transient'],
    [Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9444'), { code: 'ECONNREFUSED' }), 'transient'],
    [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'transient'],
    // Unknown transport codes are transient. An allowlist would have to predict
    // the substrate: these two are what a cluster produces during a rollout and
    // what an allowlist written against loopback docker would have missed.
    [Object.assign(new Error('getaddrinfo ENOTFOUND gateway.system.svc'), { code: 'ENOTFOUND' }), 'transient'],
    [Object.assign(new Error('write EPROTO'), { code: 'EPROTO' }), 'transient'],
    [new GatewayControlRequestError({ transport: 'ENOTFOUND' }), 'transient'],
    // ... but a Gateway we cannot authenticate is a trust problem, not a blip.
    [
      Object.assign(new Error('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
      'fatal',
    ],
    [Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }), 'fatal'],
    [new GatewayControlRequestError({ transport: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }), 'fatal'],
    [new Error('Gateway certificate does not match the generated session key'), 'fatal'],
  ];

  for (const [error, kind] of cases) {
    expect(classifyGatewayRenewalFailure(error).kind, String(error)).toBe(kind);
  }
});

it('recovers a renewal whose response was lost by retrying once at the next lease version', async () => {
  const provisioner = newProvisioner();
  const channel = await provisioner.provision({ ...lineage, channelId: 'channel-stale' });
  fixture.renewQueue.push({ status: 409, body: { error: 'stale_lease_version' } });

  const renewed = await provisioner.renew(channel);

  expect(renewed.leaseVersion).toBe(3);
  expect(fixture.lifecycle).toEqual(['provision:channel-stale', 'renew:channel-stale:1', 'renew:channel-stale:2']);
});

it('treats a second stale lease version as fatal rather than guessing again', async () => {
  const provisioner = newProvisioner();
  const channel = await provisioner.provision({ ...lineage, channelId: 'channel-stale-twice' });
  const stale = { status: 409, body: { error: 'stale_lease_version' } };
  fixture.renewQueue.push(stale, stale);

  const error = await provisioner.renew(channel).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(SessionChannelRenewalError);
  expect(error).toMatchObject({ kind: 'fatal', status: 409, code: 'stale_lease_version' });
  expect(fixture.lifecycle).toHaveLength(3);
});

it('adopt reconstructs the lease from disk through the idempotent provision read-back', async () => {
  // The host-restart shape: P1 provisioned and died; P2 starts with a fresh
  // ownership map over the same material root and recovers the CURRENT lease —
  // not a new one — by re-presenting the persisted lineage and CSR.
  const p1 = newProvisioner();
  const adoptLineage = { ...lineage, sessionId: 'session-adopt', channelId: 'channel-adopt' };
  const provisionedChannel = await p1.provision(adoptLineage);
  // The lease moved on after provisioning (renewals by the dead host).
  fixture.setLeaseVersion('channel-adopt', 3);

  const p2 = newProvisioner();
  const adopted = await p2.adopt(adoptLineage);

  expect(adopted.lineage).toEqual(adoptLineage);
  expect(adopted.leaseVersion).toBe(3);
  expect(adopted.materials.clientCertificatePath()).toBe(provisionedChannel.materials.clientCertificatePath());
  expect(fixture.lifecycle).toEqual(['provision:channel-adopt', 'provision:channel-adopt']);
});

it('adopt immediately renews an expired lease that is still inside its certificate horizon', async () => {
  const p1 = newProvisioner();
  const adoptLineage = { ...lineage, sessionId: 'session-adopt-expired', channelId: 'channel-adopt-expired' };
  await p1.provision(adoptLineage);
  fixture.options.provisionLeaseTtlSeconds = -1;

  const p2 = newProvisioner();
  const adopted = await p2.adopt(adoptLineage);

  expect(adopted.leaseVersion).toBe(2);
  expect(Date.parse(adopted.expiresAt)).toBeGreaterThan(Date.now());
  expect(fixture.lifecycle).toEqual([
    'provision:channel-adopt-expired',
    'provision:channel-adopt-expired',
    'renew:channel-adopt-expired:1',
  ]);
});

it('findAdoptableLineage recovers the persisted lineage by session id', async () => {
  const p1 = newProvisioner();
  const adoptLineage = { ...lineage, sessionId: 'session-lineage', channelId: 'channel-lineage' };
  await p1.provision(adoptLineage);

  const p2 = newProvisioner();
  expect(p2.findAdoptableLineage('session-lineage')).toEqual(adoptLineage);
  expect(p2.findAdoptableLineage('session-unknown')).toBeNull();
});

it('adopt seeds ownership deliberately, so the ownership gate passes for renew and revoke', async () => {
  // D4's constraint: never bypass #requireOwnedChannel — seed the map it
  // checks. Renewal and revocation of the adopted channel must flow through
  // the same gate as a self-provisioned one, and succeed.
  const p1 = newProvisioner();
  const adoptLineage = { ...lineage, sessionId: 'session-own', channelId: 'channel-own' };
  await p1.provision(adoptLineage);

  const p2 = newProvisioner();
  const adopted = await p2.adopt(adoptLineage);
  const renewed = await p2.renew(adopted);

  expect(renewed.leaseVersion).toBe(adopted.leaseVersion + 1);
  await p2.revoke(renewed, 'adopted-then-revoked');
  expect(fixture.lifecycle.at(-1)).toBe('revoke:channel-own');
});

it('adopt fails closed on a revoked channel and seeds no ownership', async () => {
  // The gateway answers 409 channel_conflict for a revoked channel — the
  // fail-closed path that keeps a successor from resurrecting a lease an
  // operator killed. Nothing may be seeded on the way out.
  const p1 = newProvisioner();
  const adoptLineage = { ...lineage, sessionId: 'session-revoked', channelId: 'channel-adopt-revoked' };
  const channel = await p1.provision(adoptLineage);
  await p1.revoke(channel, 'operator-revoked');

  const p2 = newProvisioner();
  await expect(p2.adopt(adoptLineage)).rejects.toMatchObject({ status: 409, code: 'channel_conflict' });
  // The ownership gate still refuses the channel: nothing was seeded.
  await expect(p2.revoke(channel, 'must-not-work')).rejects.toThrow(
    'NanoCo session material is not owned by this provisioner',
  );
});

it('adopt refuses a channel this provisioner already owns', async () => {
  const p1 = newProvisioner();
  const adoptLineage = { ...lineage, sessionId: 'session-double', channelId: 'channel-double' };
  await p1.provision(adoptLineage);

  await expect(p1.adopt(adoptLineage)).rejects.toThrow('already owned by this provisioner');
});

it('classifies a revoked lease as fatal and keeps the response body out of the failure', async () => {
  const provisioner = newProvisioner();
  const channel = await provisioner.provision({ ...lineage, channelId: 'channel-revoked' });
  fixture.renewQueue.push({
    status: 410,
    body: { error: 'channel_revoked', detail: '/secrets/session-key.pem' },
  });

  const error = await provisioner.renew(channel).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ kind: 'fatal', status: 410, code: 'channel_revoked' });
  expect(inspect(error)).not.toContain('/secrets/');
  // One attempt only: a revoked lease must not consume the caller's retry budget.
  expect(fixture.lifecycle).toEqual(['provision:channel-revoked', 'renew:channel-revoked:1']);
});

it('classifies an unavailable control plane as transient', async () => {
  const provisioner = newProvisioner();
  const channel = await provisioner.provision({ ...lineage, channelId: 'channel-unavailable' });
  fixture.renewQueue.push({ status: 500, body: { error: 'control_unavailable' } });

  const error = await provisioner.renew(channel).catch((caught: unknown) => caught);

  expect(error).toMatchObject({ kind: 'transient', status: 500, code: 'control_unavailable' });
});

it('carries a real control-plane failure through classification into a retry that survives', async () => {
  // The seam the other tests miss: everywhere else the sidecar's provisioner is
  // a mock throwing an already-classified error. Here a real 500 crosses real
  // mTLS, gets classified, and the renewal loop acts on it -- on real timers,
  // which is why the lease is deliberately short.
  fixture.options.provisionLeaseTtlSeconds = 10;
  fixture.renewQueue.push({ status: 500, body: { error: 'control_unavailable' } });
  const manager = new NanoCoSessionSidecarManager(
    { deploymentId: lineage.deploymentId, sidecarImage: 'nanoco-sidecar:test' },
    newProvisioner(),
    new NoopSidecarDriver(),
    () => 'f6f6f6f6-1111-2222-3333-444444444444',
  );

  const handle = await manager.prepare(sidecarContext);
  const unavailable = vi.fn();
  handle.onUnavailable(unavailable);
  try {
    // Renewal arms at half of ~10s, fails on the queued 500, backs off, retries.
    await new Promise((resolve) => setTimeout(resolve, 9_000));

    const renewals = fixture.lifecycle.filter((event) => event.startsWith('renew:'));
    expect(renewals.length).toBeGreaterThanOrEqual(2);
    expect(unavailable).not.toHaveBeenCalled();
  } finally {
    await handle.close('composed-path-complete');
  }
}, 30_000);

it('classifies a gateway that stopped listening as transient', async () => {
  const offline = await ControlFixture.start();
  try {
    const provisioner = newProvisioner(offline);
    const channel = await provisioner.provision({ ...lineage, channelId: 'channel-refused' });
    await offline.closeServer();

    const error = await provisioner.renew(channel).catch((caught: unknown) => caught);

    // A restarting Gateway surfaces as a reset pooled socket or a refused
    // reconnect depending on timing. Neither reaches a status code, which is
    // why classification cannot key on HTTP status alone.
    expect(error).toMatchObject({ kind: 'transient' });
    expect(['ECONNRESET', 'ECONNREFUSED']).toContain((error as SessionChannelRenewalError).code);
  } finally {
    await offline.close();
  }
}, 30_000);

class ControlFixture {
  readonly root: string;
  readonly serverCa: string;
  readonly deploymentCertificate: string;
  readonly deploymentPrivateKey: string;
  readonly proxyCa: string;
  readonly materialRoot: string;
  readonly lifecycle: string[];
  /** Replies the in-test Gateway serves for the next provision calls, in order. */
  readonly provisionQueue: RenewOutcome[];
  /** Replies the in-test Gateway serves for the next renew calls, in order. */
  readonly renewQueue: RenewOutcome[];
  /** Mutable knobs the request handler reads per call. */
  readonly options: { provisionLeaseTtlSeconds: number };
  /** The in-test Gateway's channel store — mutate to simulate lease movement. */
  readonly channels: Map<string, FixtureChannel>;
  readonly url: string;
  readonly #server: https.Server;

  private constructor(args: {
    root: string;
    serverCa: string;
    deploymentCertificate: string;
    deploymentPrivateKey: string;
    proxyCa: string;
    materialRoot: string;
    lifecycle: string[];
    provisionQueue: RenewOutcome[];
    renewQueue: RenewOutcome[];
    options: { provisionLeaseTtlSeconds: number };
    channels: Map<string, FixtureChannel>;
    url: string;
    server: https.Server;
  }) {
    this.root = args.root;
    this.serverCa = args.serverCa;
    this.deploymentCertificate = args.deploymentCertificate;
    this.deploymentPrivateKey = args.deploymentPrivateKey;
    this.proxyCa = args.proxyCa;
    this.materialRoot = args.materialRoot;
    this.lifecycle = args.lifecycle;
    this.provisionQueue = args.provisionQueue;
    this.renewQueue = args.renewQueue;
    this.options = args.options;
    this.channels = args.channels;
    this.url = args.url;
    this.#server = args.server;
  }

  reset(): void {
    this.lifecycle.length = 0;
    this.provisionQueue.length = 0;
    this.renewQueue.length = 0;
    this.options.provisionLeaseTtlSeconds = 300;
    this.channels.clear();
  }

  /** Move the stored lease forward, as renewals by a previous host would have. */
  setLeaseVersion(channelId: string, leaseVersion: number): void {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`fixture has no channel ${channelId}`);
    channel.leaseVersion = leaseVersion;
  }

  /** Drop the listener but keep the material, so renew hits ECONNREFUSED. */
  async closeServer(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  static async start(): Promise<ControlFixture> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-gateway-provisioner-'));
    const serverCa = createCa(root, 'server');
    const deploymentCa = createCa(root, 'deployment');
    const sessionCa = createCa(root, 'session');
    const server = createLeaf(root, 'server', serverCa, 'serverAuth', 'subjectAltName=DNS:localhost');
    const deployment = createLeaf(root, 'deployment', deploymentCa, 'clientAuth');
    const proxyCa = path.join(root, 'proxy-ca.pem');
    fs.copyFileSync(serverCa.certificate, proxyCa);
    const materialRoot = path.join(root, 'materials');
    fs.mkdirSync(materialRoot, { mode: 0o700 });

    const lifecycle: string[] = [];
    const provisionQueue: RenewOutcome[] = [];
    const renewQueue: RenewOutcome[] = [];
    const options = { provisionLeaseTtlSeconds: 300 };
    const channels = new Map<string, FixtureChannel>();
    const lineageOf = (body: Record<string, string>): SessionChannelLineage => ({
      deploymentId: body.deploymentId,
      agentId: body.agentId,
      sessionId: body.sessionId,
      containerInstanceId: body.containerInstanceId,
      channelId: body.channelId,
    });
    const httpsServer = https.createServer(
      {
        cert: fs.readFileSync(server.certificate),
        key: fs.readFileSync(server.privateKey),
        ca: fs.readFileSync(deploymentCa.certificate),
        requestCert: true,
        rejectUnauthorized: true,
      },
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
          if (request.method === 'POST' && request.url === '/v1/session-channels') {
            lifecycle.push(`provision:${body.channelId}`);
            const outcome = provisionQueue.shift();
            if (outcome) {
              jsonResponse(response, outcome.status, outcome.body);
              return;
            }
            const existing = channels.get(body.channelId);
            if (existing) {
              // The real Gateway's idempotent read-back (session_control.rs):
              // the identical five-field identity plus the identical CSR
              // against an Active channel returns the STORED lease at its
              // CURRENT version; anything else — different identity, different
              // CSR, revoked status — conflicts.
              const identityMatches = (Object.keys(existing.lineage) as Array<keyof SessionChannelLineage>).every(
                (key) => existing.lineage[key] === body[key],
              );
              if (!identityMatches || existing.csrPem !== body.csrPem || existing.status !== 'active') {
                jsonResponse(response, 409, { error: 'channel_conflict' });
                return;
              }
              jsonResponse(response, 201, {
                ...existing.lineage,
                certificateSha256: '00'.repeat(32),
                clientCertificatePem: existing.certificatePem,
                leaseExpiresAt: Math.floor(Date.now() / 1000) + options.provisionLeaseTtlSeconds,
                certificateNotAfter: Math.floor(Date.now() / 1000) + 3600,
                leaseVersion: existing.leaseVersion,
              });
              return;
            }
            const certificate = signSessionCsr(root, body.channelId, body.csrPem, sessionCa);
            channels.set(body.channelId, {
              lineage: lineageOf(body),
              csrPem: body.csrPem,
              certificatePem: certificate,
              leaseVersion: 1,
              status: 'active',
            });
            jsonResponse(response, 201, {
              ...lineageOf(body),
              certificateSha256: '00'.repeat(32),
              clientCertificatePem: certificate,
              leaseExpiresAt: Math.floor(Date.now() / 1000) + options.provisionLeaseTtlSeconds,
              certificateNotAfter: Math.floor(Date.now() / 1000) + 3600,
              leaseVersion: 1,
            });
            return;
          }
          const renewed = /^\/v1\/session-channels\/([A-Za-z0-9._:-]+)\/renew$/.exec(request.url ?? '');
          if (request.method === 'POST' && renewed) {
            const channelId = renewed[1];
            lifecycle.push(`renew:${channelId}:${body.expectedLeaseVersion}`);
            const outcome = renewQueue.shift();
            if (outcome) {
              jsonResponse(response, outcome.status, outcome.body);
              return;
            }
            const channel = channels.get(channelId);
            if (!channel) {
              jsonResponse(response, 404, { error: 'channel_not_found' });
              return;
            }
            channel.leaseVersion = body.expectedLeaseVersion + 1;
            jsonResponse(response, 200, {
              ...channel.lineage,
              certificateSha256: '00'.repeat(32),
              clientCertificatePem: channel.certificatePem,
              leaseExpiresAt: Math.floor(Date.now() / 1000) + 600,
              certificateNotAfter: Math.floor(Date.now() / 1000) + 3600,
              leaseVersion: channel.leaseVersion,
            });
            return;
          }
          const revoked = /^\/v1\/session-channels\/([A-Za-z0-9._:-]+)$/.exec(request.url ?? '');
          if (request.method === 'DELETE' && revoked) {
            lifecycle.push(`revoke:${revoked[1]}`);
            const channel = channels.get(revoked[1]);
            if (channel) channel.status = 'revoked';
            response.writeHead(204).end();
            return;
          }
          jsonResponse(response, 404, { error: 'not_found' });
        });
      },
    );
    await new Promise<void>((resolve, reject) => {
      httpsServer.once('error', reject);
      httpsServer.listen(0, '127.0.0.1', resolve);
    });
    const address = httpsServer.address();
    if (!address || typeof address === 'string') throw new Error('control fixture has no TCP address');
    const fixture = new ControlFixture({
      root,
      serverCa: serverCa.certificate,
      deploymentCertificate: deployment.certificate,
      deploymentPrivateKey: deployment.privateKey,
      proxyCa,
      materialRoot,
      lifecycle,
      provisionQueue,
      renewQueue,
      options,
      channels,
      url: `https://localhost:${address.port}`,
      server: httpsServer,
    });
    return fixture;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

interface CaMaterial {
  certificate: string;
  privateKey: string;
}

function createCa(root: string, name: string): CaMaterial {
  const privateKey = path.join(root, `${name}-ca-key.pem`);
  const certificate = path.join(root, `${name}-ca.pem`);
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    `/CN=${name} test CA`,
    '-keyout',
    privateKey,
    '-out',
    certificate,
    '-days',
    '1',
  ]);
  return { certificate, privateKey };
}

function createLeaf(
  root: string,
  name: string,
  ca: CaMaterial,
  extendedKeyUsage: 'clientAuth' | 'serverAuth',
  extraExtension?: string,
): CaMaterial {
  const privateKey = path.join(root, `${name}-key.pem`);
  const csr = path.join(root, `${name}.csr`);
  const certificate = path.join(root, `${name}.pem`);
  const extensions = path.join(root, `${name}.ext`);
  fs.writeFileSync(
    extensions,
    [`extendedKeyUsage=${extendedKeyUsage}`, 'keyUsage=digitalSignature', extraExtension].filter(Boolean).join('\n'),
  );
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`, '-keyout', privateKey, '-out', csr]);
  openssl([
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    ca.certificate,
    '-CAkey',
    ca.privateKey,
    '-CAcreateserial',
    '-out',
    certificate,
    '-days',
    '1',
    '-extfile',
    extensions,
  ]);
  return { certificate, privateKey };
}

function signSessionCsr(root: string, channelId: string, csrPem: string, ca: CaMaterial): string {
  const csr = path.join(root, `${channelId}.csr`);
  const certificate = path.join(root, `${channelId}.pem`);
  const extensions = path.join(root, `${channelId}.ext`);
  fs.writeFileSync(csr, csrPem, { mode: 0o600 });
  fs.writeFileSync(extensions, 'extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature\n');
  openssl([
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    ca.certificate,
    '-CAkey',
    ca.privateKey,
    '-CAcreateserial',
    '-out',
    certificate,
    '-days',
    '1',
    '-extfile',
    extensions,
  ]);
  return fs.readFileSync(certificate, 'utf8');
}

function jsonResponse(response: import('http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function openssl(args: string[]): void {
  execFileSync('openssl', args, { stdio: 'pipe', timeout: 15_000 });
}
