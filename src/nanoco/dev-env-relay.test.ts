import { afterEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionChannelMaterials, type ProvisionedSessionChannel, type SessionChannelLineage } from './session-sidecar.js';
import { ParentGovernedDevEnvRelay } from './dev-env-relay.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-dev-relay-'));
  roots.push(root);
  const files = {
    gatewayCa: path.join(root, 'gateway-ca.pem'),
    cert: path.join(root, 'session-cert.pem'),
    key: path.join(root, 'session-key.pem'),
    proxyCa: path.join(root, 'proxy-ca.pem'),
  };
  fs.writeFileSync(files.gatewayCa, 'GATEWAY-CA');
  fs.writeFileSync(files.cert, 'SESSION-CERT');
  fs.writeFileSync(files.key, 'SESSION-PRIVATE-KEY');
  fs.writeFileSync(files.proxyCa, 'PROXY-CA');
  let lineage: SessionChannelLineage | null = null;
  let revoked = 0;
  let released = 0;
  const channel = (value: SessionChannelLineage): ProvisionedSessionChannel => ({
    lineage: value,
    gatewayAddress: 'gateway-session.parent.svc.cluster.local:9443',
    gatewayServerName: 'gateway.internal',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    certificateNotAfter: new Date(Date.now() + 86_400_000).toISOString(),
    leaseVersion: 1,
    materials: new SessionChannelMaterials({
      gatewayCaPath: files.gatewayCa,
      clientCertificatePath: files.cert,
      clientPrivateKeyPath: files.key,
      proxyCaPath: files.proxyCa,
    }),
  });
  const provisioner = {
    provision: async (value: SessionChannelLineage) => {
      lineage = value;
      return channel(value);
    },
    renew: async (value: ProvisionedSessionChannel) => value,
    revoke: async () => { revoked += 1; },
    release: async () => { released += 1; },
    findAdoptableLineage: () => null,
  };
  return { root, files, provisioner, get lineage() { return lineage; }, get revoked() { return revoked; }, get released() { return released; } };
}

const context = {
  envId: 'env-11111111-1111-1111-1111-111111111111',
  instanceId: 'ins-22222222-2222-2222-2222-222222222222',
  ownerRef: '33333333-3333-3333-3333-333333333333',
  stampId: 'governed-child-kata',
  namespace: 'nanoclaw-dev-a1b2c3d4',
};

function gatewayStream(): string {
  const namespaces = ['system', 'nanoclaw'].map((name) => JSON.stringify({
    apiVersion: 'v1', kind: 'Namespace', metadata: { name },
  }));
  const gateway = JSON.stringify({
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: {
      name: 'gateway', namespace: 'system', annotations: { 'nanoco.dev/parent-governed-egress': 'required' },
    },
    spec: { template: { spec: { containers: [{ name: 'gateway', env: [], volumeMounts: [] }], volumes: [] } } },
  });
  const host = JSON.stringify({
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'nanoclaw-host', namespace: 'nanoclaw' },
    spec: { template: { spec: { containers: [{
      // The Deployment is nanoclaw-host; its real generated container name is
      // deliberately shorter. Keep this fixture aligned with manifests.ts so
      // the relay test cannot bless a shape the stamp never emits.
      name: 'host',
      image: `docker.io/library/nanoclaw-child-host@sha256:${'c'.repeat(64)}`,
      env: [
        { name: 'NANOCLAW_MAILBOX_S3_PREFIX', value: `install/nanoclaw/children/${context.namespace}` },
        { name: 'NANOCLAW_WORKSPACE_S3_BUCKET', value: 'nanoco-workspaces-example' },
        { name: 'NANOCLAW_WORKSPACE_S3_ENDPOINT', value: 'https://s3.eu-west-1.amazonaws.com' },
        { name: 'NANOCLAW_WORKSPACE_S3_PREFIX', value: `install/restic/children/${context.namespace}` },
        { name: 'NANOCLAW_WORKSPACE_S3_REGION', value: 'eu-west-1' },
      ],
      volumeMounts: [],
    }], volumes: [] } } },
  });
  return [...namespaces, gateway, host].join('\n---\n');
}

describe('parent-governed dev environment relay', () => {
  test('keeps the session key parent-side and gives the child only an endpoint and public CA', async () => {
    const fx = fixture();
    const applied: string[] = [];
    const relay = new ParentGovernedDevEnvRelay({
      deploymentId: 'deployment-1',
      sidecarImage: 'nanoco-sidecar@sha256:' + 'a'.repeat(64),
      gatewayAddress: 'gateway-session.parent.svc.cluster.local:9443',
      gatewayServerName: 'gateway.internal',
      proxyCaPath: fx.files.proxyCa,
      parentSystemNamespace: 'nanoco-k8s-kata-system',
      parentHostServiceAccount: 'nanoclaw-host',
      provisioner: fx.provisioner,
    });
    let childRenders = 0;
    const deleted: string[] = [];
    await relay.ensure(context, {
      apply: (docs) => applied.push(docs),
      serviceIp: (namespace) => namespace.endsWith('-workspace') ? '10.43.91.8' : '10.43.91.7',
      deleteNamespace: (namespace) => deleted.push(namespace),
      renderChild: () => { childRenders += 1; return true; },
    });
    expect(childRenders).toBe(1);

    expect(fx.lineage).toMatchObject({
      agentId: context.ownerRef,
      sessionId: `devenv-${context.envId}`,
      containerInstanceId: `devenv-${context.instanceId}`,
      channelId: `channel-${context.instanceId}`,
    });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain('SESSION-PRIVATE-KEY');
    expect(applied[0]).toContain('parent-egress-relay-egress');
    expect(applied[0]).toContain('nanoco-k8s-kata-system');
    const outer = applied[0].split('\n---\n').map((document) => JSON.parse(document));
    const egress = outer.find((document) => document.kind === 'NetworkPolicy');
    expect(egress.spec.egress).toContainEqual({
      to: [{
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
        podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
      }],
      ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }],
    });
    expect(egress.spec.egress).toContainEqual({
      to: [{
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'nanoco-k8s-kata-system' } },
        podSelector: { matchLabels: { 'app.kubernetes.io/name': 'gateway' } },
      }],
      ports: [{ protocol: 'TCP', port: 9443 }],
    });

    const child = relay.renderChild(context.namespace, gatewayStream());
    expect(child).toContain('http://10.43.91.7:15001');
    expect(child).toContain('PROXY-CA');
    expect(child).toContain('NANOCLAW_MAILBOX_S3_TRANSPORT');
    expect(child).toContain('NANOCLAW_STORAGE_CAPABILITY');
    expect(child).toContain(`install/nanoclaw/children/devenv-${context.envId}`);
    expect(child).toContain('http://10.43.91.8:8787');
    expect(child).toContain('NANOCO_MATERIALIZER_IMAGE');
    expect(child).not.toContain('NANOCLAW_WORKSPACE_S3_BUCKET');
    expect(applied[1]).toContain('pod-security.kubernetes.io/enforce');
    expect(applied[1]).toContain('nanoclaw-workspace-custodian');
    expect(applied[1]).toContain(`install/restic/children/devenv-${context.envId}`);
    expect(applied[1]).toContain(`docker.io/library/nanoclaw-child-host@sha256:${'c'.repeat(64)}`);
    expect(child).not.toContain('SESSION-PRIVATE-KEY');
    expect(child).not.toContain('SESSION-CERT');
    expect(child).not.toContain('GATEWAY-CA');

    await relay.ensure(context, {
      apply: (docs) => applied.push(docs),
      serviceIp: (namespace) => namespace.endsWith('-workspace') ? '10.43.91.8' : '10.43.91.7',
      deleteNamespace: (namespace) => deleted.push(namespace),
      renderChild: () => true,
    });

    const rendered = child.split('\n---\n').map((document) => JSON.parse(document));
    const namespaceEnd = Math.max(
      rendered.findIndex((document) => document.kind === 'Namespace' && document.metadata.name === 'system'),
      rendered.findIndex((document) => document.kind === 'Namespace' && document.metadata.name === 'nanoclaw'),
    );
    const trustIndexes = rendered
      .map((document, index) => document.kind === 'ConfigMap' && document.metadata.name === 'parent-egress-trust' ? index : -1)
      .filter((index) => index >= 0);
    const firstWorkload = rendered.findIndex((document) => document.kind === 'Deployment');
    expect(trustIndexes).toHaveLength(2);
    expect(Math.min(...trustIndexes)).toBeGreaterThan(namespaceEnd);
    expect(Math.max(...trustIndexes)).toBeLessThan(firstWorkload);

    await relay.release(context.namespace);
    expect(fx.revoked).toBe(1);
    expect(fx.released).toBe(1);
    expect(deleted).toEqual([`${context.namespace}-workspace`]);
  });

  // ---------------------------------------------------------------------------
  // A release must not depend on this process having served the claim.
  //
  // Relay state is process memory. The host restarts — a deploy, a crash, an
  // OOM — and the map is empty, but the instance and its companion namespace
  // are still out there on the cluster. `release` used to open with
  // `if (!state) return;`, so a release after a restart tore down NOTHING and
  // left `<instance>-workspace` running the workspace-controller for good.
  //
  // It was invisible in the worst way: the env itself released cleanly and
  // dropped off `ncl envs list`, so the only trace was a namespace nobody was
  // looking for. Observed on omri-test after the host rolled mid-claim —
  // `nanoclaw-dev-e69a9856-workspace` outlived its instance by design of the bug.
  //
  // The companion namespace is derivable from the instance namespace alone, so
  // it is reachable with or without the memory. Only the channel grant, which
  // names a channel THIS process opened, legitimately needs the state.
  // ---------------------------------------------------------------------------
  test('releases the companion namespace even when the process never held relay state', async () => {
    const fx = fixture();
    const relay = new ParentGovernedDevEnvRelay({
      deploymentId: 'deployment-1',
      sidecarImage: `nanoco-sidecar@sha256:${'a'.repeat(64)}`,
      gatewayAddress: 'gateway-session.parent.svc.cluster.local:9443',
      // The three flat edge fields became one nested option; this test kept the
      // old shape, which only surfaced when the composed tree is typechecked.
      edge: {
        domain: 'omri-test.dev.nanoco.sh',
        actor: 'tailnet-development@nanoco.local',
        proxyImage: `nanoco-host-runtime@sha256:${'b'.repeat(64)}`,
      },
      gatewayServerName: 'gateway.internal',
      proxyCaPath: fx.files.proxyCa,
      parentSystemNamespace: 'nanoco-k8s-kata-system',
      parentHostServiceAccount: 'nanoclaw-host',
      provisioner: fx.provisioner,
    });
    const deleted: string[] = [];

    // No `ensure` first — this relay is as blank as one in a freshly restarted host.
    await relay.release('nanoclaw-dev-a1b2c3d4', {
      apply: () => undefined,
      serviceIp: () => null,
      deleteNamespace: (namespace) => deleted.push(namespace),
    });

    expect(deleted).toEqual(['nanoclaw-dev-a1b2c3d4-workspace']);
    // Nothing to revoke: this process opened no channel for that instance.
    expect(fx.revoked).toBe(0);
    expect(fx.released).toBe(0);
  });

  test('materializes the automatic private edge only after child public CAs exist', async () => {
    const fx = fixture();
    const applied: string[] = [];
    const relay = new ParentGovernedDevEnvRelay({
      deploymentId: 'deployment-1',
      sidecarImage: 'nanoco-sidecar@sha256:' + 'a'.repeat(64),
      gatewayAddress: 'gateway-session.parent.svc.cluster.local:9443',
      gatewayServerName: 'gateway.internal',
      proxyCaPath: fx.files.proxyCa,
      parentSystemNamespace: 'system',
      parentHostServiceAccount: 'nanoclaw-host',
      provisioner: fx.provisioner,
      edge: {
        domain: 'omri-test.dev.nanoco.sh',
        actor: 'tailnet-development@nanoco.local',
        proxyImage: 'nanoco-host-runtime@sha256:' + 'b'.repeat(64),
      },
    });
    await relay.ensure(context, {
      apply: (docs) => applied.push(docs),
      serviceIp: () => '10.43.91.7',
      secretData: (_namespace, _secret, key) =>
        key.endsWith('ca.pem') ? '-----BEGIN CERTIFICATE-----\nPUBLIC-CA\n-----END CERTIFICATE-----\n' : null,
    });
    expect(applied).toHaveLength(2);
    expect(applied[1]).toContain('governed-child-edge');
    expect(applied[1]).toContain('kata-qemu-runtime-rs');
    expect(applied[1]).toContain('slack-${namespace}.${domain}');
    expect(applied[1]).toContain('governance-${namespace}.${domain}');
    expect(applied[1]).toContain('X-Forwarded-Email: ${target.actor}');
    expect(applied[1]).toContain("import http from 'node:http'");
    expect(applied[1]).toContain("import https from 'node:https'");
    expect(applied[1]).toContain('agent: false');
    expect(applied[1]).toContain("server.on('upgrade'");
    expect(applied[1]).not.toContain('hostHeader');
    expect(applied[1]).not.toContain('BACKLOT_SLACK_PUBLIC_ORIGIN');
    expect(applied[1]).toContain('nanoco.dev/edge-config-sha256');
    expect(applied[1]).toContain("import tls from 'node:tls'");
    expect(applied[1]).toContain('rejectUnauthorized: true');
    expect(applied[1]).not.toContain('PRIVATE KEY');
    const edgeDocs = applied[1].split('\n---\n').map((document) => JSON.parse(document));
    const edgeScript = edgeDocs.find((document) => document.kind === 'ConfigMap').data['proxy.mjs'];
    const syntax = spawnSync('node', ['--check', '--input-type=module'], {
      input: edgeScript,
      encoding: 'utf8',
    });
    expect({ status: syntax.status, stderr: syntax.stderr }).toEqual({ status: 0, stderr: '' });
    await relay.release(context.namespace);
  });

  test('leaves unrelated stamps untouched', async () => {
    const fx = fixture();
    const relay = new ParentGovernedDevEnvRelay({
      deploymentId: 'deployment-1', sidecarImage: 'sidecar', gatewayAddress: 'gateway:9443',
      gatewayServerName: 'gateway.internal',
      proxyCaPath: fx.files.proxyCa, parentSystemNamespace: 'system', parentHostServiceAccount: 'nanoclaw-host', provisioner: fx.provisioner,
    });
    const source = gatewayStream();
    await relay.ensure(
      { ...context, stampId: 'other' },
      { apply: () => { throw new Error('not called'); }, serviceIp: () => null },
    );
    expect(relay.renderChild(context.namespace, source)).toBe(source);
    expect(fx.lineage).toBeNull();
  });
});
