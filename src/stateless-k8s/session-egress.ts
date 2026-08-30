import fs from 'node:fs';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

import type { ContainerSpec, MountSpec, RuntimeVolumeSource } from '../drivers/types.js';
import { registerSessionEgressAdopter, registerSessionEgressFactory, type SessionEgressHandle } from '../session-egress.js';

const REQUEST_TIMEOUT_MS = 10_000;
const IDENTITY_DIR = '/run/nanoco/identity';

interface ConfiguredEgress {
  NANOCO_DEPLOYMENT_ID: string;
  NANOCO_SIDECAR_IMAGE: string;
  NANOCO_GATEWAY_CONTROL_URL: string;
  NANOCO_GATEWAY_CONTROL_SERVER_NAME: string;
  NANOCO_GATEWAY_ADDRESS: string;
  NANOCO_GATEWAY_SERVER_NAME: string;
  NANOCO_GATEWAY_CA: string;
  NANOCO_DEPLOYMENT_CERT: string;
  NANOCO_DEPLOYMENT_KEY: string;
}

interface ClaimResponse { claim: string; expiresAt: number }

export interface StatelessRelayIdentity {
  claim: string;
  requestCapability: string;
  deploymentId: string;
  agentId: string;
  sessionId: string;
  containerInstanceId: string;
  channelId: string;
  claimUrl: string;
  claimServerName: string;
  gatewayAddress: string;
  gatewayServerName: string;
  sidecarImage: string;
}

let installedConfig: ConfiguredEgress | undefined;

const identityVolume: RuntimeVolumeSource = { kind: 'emptyDir', name: 'session-identity', medium: 'Memory', sizeLimit: '4Mi' };
const gatewayCa: RuntimeVolumeSource = { kind: 'secret', name: 'session-gateway-ca', secretName: 'nanoclaw-session-public', key: 'gateway-server-ca.pem' };
const proxyCa: RuntimeVolumeSource = { kind: 'secret', name: 'session-proxy-ca', secretName: 'nanoclaw-session-public', key: 'proxy-ca.pem' };

function mount(
  source: RuntimeVolumeSource,
  containerPath: string,
  mode: 'ro' | 'rw',
  groupScope: string,
  subPath?: string,
  mountClass: MountSpec['class'] = 'identity-material',
): MountSpec {
  return {
    class: mountClass,
    hostPath: `/nanoclaw-runtime/${source.name}${subPath ? `/${subPath}` : ''}`,
    containerPath,
    mode,
    groupScope,
    source,
    ...(subPath ? { subPath } : {}),
  };
}

export function statelessEgressContainers(args: {
  deploymentId: string;
  groupId: string;
  sessionId: string;
  containerInstanceId: string;
  channelId: string;
  claim: string;
  claimUrl: string;
  claimServerName: string;
  gatewayAddress: string;
  gatewayServerName: string;
  sidecarImage: string;
  materializerImage: string;
  sourceRoot?: string;
}): { containers: ContainerSpec[]; agentMount: MountSpec } {
  const labels = {
    'nanoclaw-group': args.groupId,
    'nanoco-channel': args.channelId,
    'nanoco-container-instance': args.containerInstanceId,
  };
  const identityManager: ContainerSpec = {
    role: 'identity-manager',
    image: args.materializerImage,
    command: ['node', `${args.sourceRoot ?? '/opt/nanoclaw'}/dist/stateless-k8s/identity-manager.js`],
    env: {
      NANOCO_IDENTITY_CLAIM_URL: args.claimUrl,
      NANOCO_IDENTITY_SERVER_NAME: args.claimServerName,
      NANOCO_IDENTITY_GATEWAY_CA: '/run/nanoco/gateway-ca.pem',
      NANOCO_IDENTITY_DIR: IDENTITY_DIR,
      NANOCO_IDENTITY_DEPLOYMENT_ID: args.deploymentId,
      NANOCO_IDENTITY_AGENT_ID: args.groupId,
      NANOCO_IDENTITY_SESSION_ID: args.sessionId,
      NANOCO_IDENTITY_CONTAINER_INSTANCE_ID: args.containerInstanceId,
      NANOCO_IDENTITY_CHANNEL_ID: args.channelId,
    },
    sensitiveEnv: { NANOCO_IDENTITY_CLAIM: args.claim },
    mounts: [
      mount(identityVolume, IDENTITY_DIR, 'rw', args.groupId),
      mount(gatewayCa, '/run/nanoco/gateway-ca.pem', 'ro', args.groupId, 'gateway-server-ca.pem', 'allowlisted-extra'),
    ],
    labels,
  };
  const egress: ContainerSpec = {
    role: 'egress-sidecar',
    image: args.sidecarImage,
    env: {
      NANOCO_SIDECAR_LISTEN_ADDR: '0.0.0.0:15001',
      NANOCO_SIDECAR_GATEWAY_ADDR: args.gatewayAddress,
      NANOCO_SIDECAR_GATEWAY_SERVER_NAME: args.gatewayServerName,
      NANOCO_SIDECAR_GATEWAY_CA: '/run/nanoco/gateway-ca.pem',
      NANOCO_SIDECAR_CLIENT_CERT: `${IDENTITY_DIR}/session-cert.pem`,
      NANOCO_SIDECAR_CLIENT_KEY: `${IDENTITY_DIR}/session-key.pem`,
    },
    mounts: [
      mount(identityVolume, IDENTITY_DIR, 'ro', args.groupId),
      mount(gatewayCa, '/run/nanoco/gateway-ca.pem', 'ro', args.groupId, 'gateway-server-ca.pem', 'allowlisted-extra'),
    ],
    labels,
  };
  return {
    containers: [identityManager, egress],
    agentMount: mount(proxyCa, '/run/nanoco/proxy-ca.pem', 'ro', args.groupId, 'proxy-ca.pem', 'allowlisted-extra'),
  };
}

export function registerStatelessSessionEgress(config: ConfiguredEgress): { configured: boolean; reapOrphans(): void } {
  installedConfig = config;
  const claimUrl = process.env.NANOCO_GATEWAY_CLAIM_URL?.trim() ?? '';
  if (!claimUrl) throw new Error('stateless session egress requires claim URL');
  registerSessionEgressFactory(async (context) => {
    const materializerImage = process.env.NANOCO_MATERIALIZER_IMAGE?.trim() ?? '';
    if (!/^\S+@sha256:[0-9a-f]{64}$/.test(materializerImage)) {
      throw new Error('stateless session egress requires an immutable materializer image');
    }
    const token = randomUUID();
    const containerInstanceId = `container-${token}`;
    const channelId = `channel-${token}`;
    const response = await requestClaim(config, {
      deploymentId: config.NANOCO_DEPLOYMENT_ID,
      agentId: context.agentGroup.id,
      sessionId: context.session.id,
      containerInstanceId,
      channelId,
      ...(context.requestCapability ? { requestCapability: context.requestCapability } : {}),
    });
    const realized = statelessEgressContainers({
      deploymentId: config.NANOCO_DEPLOYMENT_ID,
      groupId: context.agentGroup.id,
      sessionId: context.session.id,
      containerInstanceId,
      channelId,
      claim: response.claim,
      claimUrl,
      claimServerName: config.NANOCO_GATEWAY_CONTROL_SERVER_NAME,
      gatewayAddress: config.NANOCO_GATEWAY_ADDRESS,
      gatewayServerName: config.NANOCO_GATEWAY_SERVER_NAME,
      sidecarImage: config.NANOCO_SIDECAR_IMAGE,
      materializerImage,
      sourceRoot: process.env.NANOCO_HOST_SOURCE_ROOT?.trim() || '/opt/nanoclaw',
    });
    return handle(realized.containers, realized.agentMount, containerInstanceId, channelId);
  });
  registerSessionEgressAdopter(async () => handle([], undefined, '', ''));
  return { configured: true, reapOrphans(): void {} };
}

/** Mint a second renewable Gateway identity for a trusted outboard companion
 * of the session. The claim and request capability are returned to the caller
 * for Secret projection; neither is logged or written to the Host tree. */
export async function prepareStatelessRelay(input: {
  agentId: string;
  sessionId: string;
  requestCapability: string;
}): Promise<StatelessRelayIdentity> {
  const config = installedConfig;
  if (!config) throw new Error('stateless session egress is not configured');
  if (!/^[a-f0-9]{64}$/.test(input.requestCapability)) {
    throw new Error('stateless relay requires a valid request capability');
  }
  const token = randomUUID();
  const containerInstanceId = `workspace-${token}`;
  const channelId = `workspace-${token}`;
  const response = await requestClaim(config, {
    deploymentId: config.NANOCO_DEPLOYMENT_ID,
    agentId: input.agentId,
    sessionId: input.sessionId,
    containerInstanceId,
    channelId,
    requestCapability: input.requestCapability,
  });
  return {
    claim: response.claim,
    requestCapability: input.requestCapability,
    deploymentId: config.NANOCO_DEPLOYMENT_ID,
    agentId: input.agentId,
    sessionId: input.sessionId,
    containerInstanceId,
    channelId,
    claimUrl: process.env.NANOCO_GATEWAY_CLAIM_URL?.trim() ?? '',
    claimServerName: config.NANOCO_GATEWAY_CONTROL_SERVER_NAME,
    gatewayAddress: config.NANOCO_GATEWAY_ADDRESS,
    gatewayServerName: config.NANOCO_GATEWAY_SERVER_NAME,
    sidecarImage: config.NANOCO_SIDECAR_IMAGE,
  };
}

function handle(containers: ContainerSpec[], agentMount: MountSpec | undefined, incarnation: string, channel: string): SessionEgressHandle {
  return {
    agentEnvironment: {
      HTTP_PROXY: 'http://127.0.0.1:15001',
      HTTPS_PROXY: 'http://127.0.0.1:15001',
      NODE_EXTRA_CA_CERTS: '/run/nanoco/proxy-ca.pem',
      SSL_CERT_FILE: '/run/nanoco/proxy-ca.pem',
      CURL_CA_BUNDLE: '/run/nanoco/proxy-ca.pem',
      REQUESTS_CA_BUNDLE: '/run/nanoco/proxy-ca.pem',
      GIT_SSL_CAINFO: '/run/nanoco/proxy-ca.pem',
    },
    agentNetworkArgs: [],
    containers,
    agentMounts: agentMount ? [agentMount] : [],
    agentLabels: channel ? { 'nanoco-channel': channel, 'nanoco-container-instance': incarnation } : {},
    onUnavailable(): void {},
    async close(): Promise<void> {},
    async detach(): Promise<void> {},
  };
}

async function requestClaim(config: ConfiguredEgress, body: Record<string, unknown>): Promise<ClaimResponse> {
  const target = new URL('/v1/session-channel-claims', config.NANOCO_GATEWAY_CONTROL_URL);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = https.request(target, {
      method: 'POST',
      servername: config.NANOCO_GATEWAY_CONTROL_SERVER_NAME,
      ca: fs.readFileSync(config.NANOCO_GATEWAY_CA),
      cert: fs.readFileSync(config.NANOCO_DEPLOYMENT_CERT),
      key: fs.readFileSync(config.NANOCO_DEPLOYMENT_KEY),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: REQUEST_TIMEOUT_MS,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 201) return reject(new Error(`Gateway claim request failed (${response.statusCode ?? 0})`));
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ClaimResponse;
          if (!/^[0-9a-f]+$/.test(value.claim) || !Number.isSafeInteger(value.expiresAt)) throw new Error('invalid claim response');
          resolve(value);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Gateway claim request timed out')));
    request.on('error', reject);
    request.end(payload);
  });
}
