import { getProviderModelEndpoint, providerModelAllowedHosts } from '../provider-contracts/index.js';
import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { CONTAINER_RUNTIME_BIN } from '../container-runtime.js';
import { readEnvFile } from '../env.js';
import { getInstallSlug } from '../install-slug.js';
import { log } from '../log.js';

import { IronProxyApprovalBridge, type IronApprovalIdentity } from './iron-proxy-approval.js';
import {
  registerGatewayProvider,
  type GatewayContribution,
  type GatewayProviderDefinition,
  type GatewaySessionInput,
  type GatewaySessionLease,
} from './gateway-provider-registry.js';

const SETTINGS = [
  'NANOCLAW_SESSION_MATERIAL_ROOT',
  'NANOCLAW_IRON_PROXY_IMAGE',
  'NANOCLAW_IRON_PROXY_CA_CERT',
  'NANOCLAW_IRON_PROXY_CA_KEY',
  'NANOCLAW_IRON_PROXY_SECRET_FILE',
  'NANOCLAW_IRON_PROXY_CONFIG_FILE',
  'NANOCLAW_IRON_PROXY_IDENTITY_KEY',
  'NANOCLAW_IRON_PROXY_CONTAINER',
  'NANOCLAW_IRON_CONTROL_URL',
  'NANOCLAW_IRON_PROXY_PORT',
  'NANOCLAW_IRON_PROXY_APPROVAL_SOCKET',
  'NANOCLAW_IRON_PROXY_AUTH_ENV',
  'NANOCLAW_IRON_PROXY_APPROVAL_PORT',
  'NANOCLAW_IRON_PROXY_MODEL_HOST',
  'NANOCLAW_IRON_PROXY_ALLOWED_HOSTS',
  'NANOCLAW_IRON_PROXY_APPROVAL_TIMEOUT_MS',
  'NANOCLAW_IRON_PROXY_MAX_PENDING',
  'ANTHROPIC_BASE_URL',
] as const;

const PLACEHOLDER = 'gateway-managed';
const CODEX_PLACEHOLDER = 'nc-codex-token-v1';
const PROXY_HOST = 'iron-proxy';
const CA_CERT_PATH = '/etc/iron-proxy/ca.crt';
const CA_KEY_PATH = '/etc/iron-proxy/ca.key';
const SECRET_PATH = '/run/secrets/upstream';
const IDENTITY_KEY_PATH = '/run/secrets/workload-identity-key';
const APPROVAL_DIR = '/run/nanoclaw-gateway';
const APPROVAL_SOCKET = `${APPROVAL_DIR}/approval.sock`;
const AGENT_CA_PATH = '/run/nanoclaw-iron-proxy-ca.crt';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export interface IronProxySettings {
  materialRoot: string;
  image: string;
  caCert: string;
  caKey: string;
  secretFile: string;
  configFile: string;
  identityKey: string;
  containerName: string;
  port: number;
  managed?: boolean;
  projectRoot?: string;
  approvalDir: string;
  approvalSocket: string;
  agentCaCert: string;
  allowedHostsFile: string;
  authEnv: string;
  modelHost: string;
  anthropicBaseUrl?: string;
  approvalTimeoutMs: number;
  maxPending: number;
  approvalPort?: number;
}

function valueIn(env: NodeJS.ProcessEnv, file: Record<string, string>, key: (typeof SETTINGS)[number]): string {
  return env[key]?.trim() || file[key]?.trim() || '';
}

function isInside(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return path.isAbsolute(file) && relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function defaultApprovalSocket(projectRoot: string): string {
  return path.join(os.tmpdir(), `nanoclaw-iron-socket-${getInstallSlug(projectRoot)}`, 'approval.sock');
}

/** Hosts are matched case-insensitively; the install script validates their grammar when the operator supplies them. */
function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase();
}

export function readIronProxySettings(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot = process.cwd(),
): IronProxySettings {
  const file = readEnvFile([...SETTINGS]);
  const value = (key: (typeof SETTINGS)[number]): string => valueIn(env, file, key);
  const materialRoot = value('NANOCLAW_SESSION_MATERIAL_ROOT') || path.join(projectRoot, 'data', 'session-materials');
  const gatewayRoot = path.join(materialRoot, 'iron-proxy');
  const approvalSocket = value('NANOCLAW_IRON_PROXY_APPROVAL_SOCKET') || defaultApprovalSocket(projectRoot);
  const port = Number(value('NANOCLAW_IRON_PROXY_PORT') || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 18080)
    throw new Error('Iron approval-front port must be 1–65535 and differ from its internal backend port 18080');
  // Operator-supplied values are taken as given. The install script pins the
  // image digest and validates host grammar at the point the operator types it;
  // a wrong path here fails loudly at first use, which is where it should.
  return {
    materialRoot,
    image: value('NANOCLAW_IRON_PROXY_IMAGE'),
    caCert: value('NANOCLAW_IRON_PROXY_CA_CERT') || path.join(gatewayRoot, 'shared', 'ca.crt'),
    caKey: value('NANOCLAW_IRON_PROXY_CA_KEY') || path.join(gatewayRoot, 'shared', 'ca.key'),
    secretFile: value('NANOCLAW_IRON_PROXY_SECRET_FILE') || path.join(gatewayRoot, 'shared', 'upstream-secret'),
    configFile: value('NANOCLAW_IRON_PROXY_CONFIG_FILE') || path.join(gatewayRoot, 'shared', 'config.yaml'),
    identityKey: value('NANOCLAW_IRON_PROXY_IDENTITY_KEY') || path.join(gatewayRoot, 'shared', 'workload-identity.key'),
    containerName: value('NANOCLAW_IRON_PROXY_CONTAINER') || `nanoclaw-iron-proxy-${getInstallSlug(projectRoot)}`,
    port,
    managed: !!value('NANOCLAW_IRON_CONTROL_URL'),
    projectRoot,
    approvalDir: isInside(approvalSocket, materialRoot)
      ? path.dirname(approvalSocket)
      : path.join(gatewayRoot, 'approval'),
    approvalSocket,
    agentCaCert: path.join(projectRoot, 'data', 'gateway-trust', 'iron-proxy', 'ca.crt'),
    allowedHostsFile:
      value('NANOCLAW_IRON_PROXY_ALLOWED_HOSTS') || path.join(gatewayRoot, 'shared', 'allowed-hosts.json'),
    authEnv: value('NANOCLAW_IRON_PROXY_AUTH_ENV') || 'ANTHROPIC_API_KEY',
    modelHost: normalizeHost(
      value('NANOCLAW_IRON_PROXY_MODEL_HOST') || new URL(getProviderModelEndpoint('claude', 'api')).hostname,
    ),
    ...(value('ANTHROPIC_BASE_URL') ? { anthropicBaseUrl: value('ANTHROPIC_BASE_URL') } : {}),
    approvalTimeoutMs: Number(value('NANOCLAW_IRON_PROXY_APPROVAL_TIMEOUT_MS')) || 120_000,
    maxPending: Number(value('NANOCLAW_IRON_PROXY_MAX_PENDING')) || 32,
    ...(value('NANOCLAW_IRON_PROXY_APPROVAL_PORT')
      ? { approvalPort: Number(value('NANOCLAW_IRON_PROXY_APPROVAL_PORT')) }
      : {}),
  };
}

function ensureApprovalSocketAlias(settings: IronProxySettings): void {
  const alias = path.dirname(settings.approvalSocket);
  if (alias === settings.approvalDir) return;
  fs.mkdirSync(settings.approvalDir, { recursive: true, mode: 0o700 });
  try {
    if (fs.realpathSync(alias) !== fs.realpathSync(settings.approvalDir)) {
      throw new Error('Iron Proxy approval socket alias points outside its material directory');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    fs.symlinkSync(settings.approvalDir, alias, 'dir');
  }
}

function readAllowedHosts(settings: IronProxySettings): string[] {
  if (!fs.existsSync(settings.allowedHostsFile)) return [];
  const hosts = JSON.parse(fs.readFileSync(settings.allowedHostsFile, 'utf8')) as string[];
  return [...new Set(hosts.map(normalizeHost))].sort();
}

/** The front owns approvals. Stock Iron only injects credentials on loopback. */
export function ironProxyConfig(settings: IronProxySettings): string {
  return stringifyYaml(
    {
      dns: { enabled: false },
      proxy: {
        tunnel_listen: '127.0.0.1:18080',
        upstream_response_header_timeout: '5m',
        // Enforced by upstream Iron at the actual resolved-address dial, including
        // managed mode. A DNS alias cannot reach the approval-free backend.
        upstream_deny_cidrs: ['127.0.0.0/8', '::1/128', '169.254.0.0/16', 'fe80::/10', '0.0.0.0/32', '::/128'],
      },
      tls: { mode: 'mitm', ca_cert: CA_CERT_PATH, ca_key: CA_KEY_PATH },
      transforms: settings.managed
        ? []
        : [
            {
              name: 'secrets',
              config: {
                secrets: [
                  {
                    source: { type: 'file', path: SECRET_PATH, ttl: '1s', failure_ttl: '1s' },
                    replace: {
                      proxy_value: PLACEHOLDER,
                      match_headers: ['Authorization', 'X-Api-Key'],
                      require: false,
                    },
                    rules: [{ host: settings.modelHost, methods: METHODS }],
                  },
                ],
              },
            },
          ],
      log: { level: 'info' },
    },
    { lineWidth: 0 },
  );
}

/** Host-owned front configuration cannot be replaced by Iron Control sync. */
export function ironFrontConfig(settings: IronProxySettings): string {
  return (
    JSON.stringify(
      {
        listen: `:${settings.port}`,
        backend: 'http://127.0.0.1:18080',
        ca_cert: CA_CERT_PATH,
        ca_key: CA_KEY_PATH,
        identity_key: IDENTITY_KEY_PATH,
        allowed_hosts: [
          ...new Set([settings.modelHost, ...providerModelAllowedHosts(), ...readAllowedHosts(settings)]),
        ].sort(),
        approval_target: settings.approvalPort
          ? `host.docker.internal:${settings.approvalPort}`
          : `unix://${APPROVAL_SOCKET}`,
        ...(settings.approvalPort
          ? { approval_cert: '/run/secrets/approval-client.crt', approval_key: '/run/secrets/approval-client.key' }
          : {}),
        summary_command: '/usr/local/bin/gateway-approval-summary',
        timeout_ms: settings.approvalTimeoutMs,
      },
      null,
      2,
    ) + '\n'
  );
}

/**
 * The one place this adapter asks the runtime whether the central proxy is up.
 * Asynchronous on purpose: it is polled while the host is serving, and a
 * synchronous `docker inspect` there stalls delivery and the sweep along with it.
 *
 * `execFile` is dereferenced here rather than promisified at module scope: an
 * installed provider is imported by the gateway barrel into every test's module
 * graph, and touching a `child_process` export at import time breaks any core
 * test that stubs that module.
 */
function centralContainerRunning(containerName: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      CONTAINER_RUNTIME_BIN,
      ['inspect', '-f', '{{.State.Running}}', containerName],
      { encoding: 'utf8', timeout: 5_000 },
      (err, stdout) => resolve(!err && stdout.trim() === 'true'),
    );
  });
}

/** Material the proxy cannot serve a session without. */
function missingMaterial(files: readonly string[]): string | undefined {
  return files.find((file) => !fs.existsSync(file));
}

async function assertReady(settings: IronProxySettings): Promise<void> {
  const missing = missingMaterial([
    settings.caCert,
    settings.caKey,
    settings.secretFile,
    settings.configFile,
    settings.identityKey,
    settings.agentCaCert,
  ]);
  if (missing) throw new Error(`Iron Proxy prerequisite is missing: ${missing}`);
  if (!(await centralContainerRunning(settings.containerName))) {
    throw new Error(`Iron Proxy central container is unavailable: ${settings.containerName}`);
  }
}

export function signedWorkloadToken(identity: string, key: Buffer): string {
  if (key.length < 32) throw new Error('Iron Proxy identity key must contain at least 32 bytes');
  const unsigned = `iw1.${Buffer.from(identity).toString('base64url')}`;
  return `${unsigned}.${createHmac('sha256', key).update(unsigned).digest('base64url')}`;
}

/** Synthetic login data only; real tokens and account headers stay inside Iron. */
export function codexPlaceholder(mode: 'api' | 'chatgpt'): string {
  if (mode === 'api') return JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: CODEX_PLACEHOLDER });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'none' })}.${encode({
    sub: CODEX_PLACEHOLDER,
    'https://api.openai.com/auth': { chatgpt_account_id: CODEX_PLACEHOLDER, chatgpt_plan_type: 'plus' },
  })}.cGxhY2Vob2xkZXI`;
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: token, access_token: CODEX_PLACEHOLDER, refresh_token: '', account_id: CODEX_PLACEHOLDER },
    last_refresh: new Date().toISOString(),
  });
}

function codexAuthMount(
  settings: IronProxySettings,
  input: GatewaySessionInput,
): NonNullable<GatewayContribution['mounts']> {
  if (!settings.managed || !settings.projectRoot) return [];
  const metadata = path.join(settings.projectRoot, 'data/session-materials/iron-control/codex.json');
  if (!fs.existsSync(metadata)) return [];
  const { mode } = JSON.parse(fs.readFileSync(metadata, 'utf8'));
  if (mode !== 'api' && mode !== 'chatgpt') throw new Error('Invalid Iron Codex authentication mode');
  const group = input.key.agentGroupId;
  if (!/^[a-zA-Z0-9_-]+$/.test(group)) throw new Error('Invalid agent group ID');
  const directory = path.join(settings.projectRoot, 'data/v2-sessions', group, '.iron-codex');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'auth.json');
  fs.writeFileSync(file, codexPlaceholder(mode), { mode: 0o644 });
  return [
    {
      class: 'group-state',
      hostPath: file,
      containerPath: '/home/node/.codex/auth.json',
      mode: 'ro',
      groupScope: group,
    },
  ];
}

export function ironProxyContribution(settings: IronProxySettings, input: GatewaySessionInput): GatewayContribution {
  const token = signedWorkloadToken(input.runtimeIdentity, fs.readFileSync(settings.identityKey));
  const proxy = `http://workload:${encodeURIComponent(token)}@${PROXY_HOST}:${settings.port}`;
  return {
    env: {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
      NODE_EXTRA_CA_CERTS: AGENT_CA_PATH,
      SSL_CERT_FILE: AGENT_CA_PATH,
      CURL_CA_BUNDLE: AGENT_CA_PATH,
      GIT_SSL_CAINFO: AGENT_CA_PATH,
      [settings.authEnv]: PLACEHOLDER,
      ...(settings.anthropicBaseUrl ? { ANTHROPIC_BASE_URL: settings.anthropicBaseUrl } : {}),
    },
    mounts: [
      ...codexAuthMount(settings, input),
      {
        class: 'gateway-trust',
        hostPath: settings.agentCaCert,
        containerPath: AGENT_CA_PATH,
        mode: 'ro',
        groupScope: input.key.agentGroupId,
      },
    ],
    networkAccess: { endpoint: PROXY_HOST, target: { kind: 'runtime', identity: settings.containerName } },
  };
}

interface LiveLease extends IronApprovalIdentity {
  unavailable?: string;
  notify?: (reason: string) => void;
}

export function defineIronProxyProvider(initialSettings?: IronProxySettings): GatewayProviderDefinition {
  let settings = initialSettings;
  const leases = new Map<string, LiveLease>();
  let monitor: NodeJS.Timeout | null = null;
  let bridge: IronProxyApprovalBridge | null = null;

  const currentSettings = (): IronProxySettings => (settings ??= readIronProxySettings());
  const currentBridge = (): IronProxyApprovalBridge => {
    if (bridge) return bridge;
    const configured = currentSettings();
    ensureApprovalSocketAlias(configured);
    bridge = new IronProxyApprovalBridge(
      {
        socketPath: configured.approvalSocket,
        timeoutMs: configured.approvalTimeoutMs,
        maxPending: configured.maxPending,
        ...(configured.approvalPort
          ? {
              tls: {
                address: `127.0.0.1:${configured.approvalPort}`,
                ca: configured.caCert,
                cert: path.join(path.dirname(configured.configFile), 'approval-server.crt'),
                key: path.join(path.dirname(configured.configFile), 'approval-server.key'),
              },
            }
          : {}),
      },
      (runtimeIdentity) => leases.get(runtimeIdentity),
    );
    return bridge;
  };

  // One probe at a time: a `docker inspect` that runs long must not stack up
  // behind the interval, and the leases only need the first failure anyway.
  let probing = false;

  const probeAvailability = async (): Promise<void> => {
    if (probing || !monitor) return;
    probing = true;
    try {
      const configured = currentSettings();
      const missing = missingMaterial([
        configured.caCert,
        configured.caKey,
        configured.secretFile,
        configured.identityKey,
      ]);
      const reason = !currentBridge().running
        ? 'Iron Proxy approval bridge unavailable'
        : missing
          ? `Iron Proxy material unavailable: ${missing}`
          : !(await centralContainerRunning(configured.containerName))
            ? 'Iron Proxy central container unavailable'
            : '';
      if (!reason || !monitor) return;
      clearInterval(monitor);
      monitor = null;
      for (const lease of leases.values()) {
        lease.unavailable = reason;
        lease.notify?.(reason);
      }
    } catch (err) {
      log.error('Iron Proxy availability probe failed', { err });
    } finally {
      probing = false;
    }
  };

  const startMonitor = (): void => {
    if (monitor) return;
    monitor = setInterval(() => void probeAvailability(), 2_000);
    monitor.unref();
  };

  const ensure = async (input: GatewaySessionInput, signal: AbortSignal): Promise<GatewaySessionLease> => {
    const configured = currentSettings();
    await currentBridge().ready();
    await assertReady(configured);
    const lease: LiveLease = {
      runtimeIdentity: input.runtimeIdentity,
      sessionId: input.key.sessionId,
      agentGroupId: input.key.agentGroupId,
      groupName: input.groupName,
    };
    leases.set(input.runtimeIdentity, lease);
    startMonitor();
    const close = () => {
      if (leases.get(input.runtimeIdentity) !== lease) return;
      leases.delete(input.runtimeIdentity);
      currentBridge().cancelIdentity(input.runtimeIdentity);
      if (leases.size === 0 && monitor) {
        clearInterval(monitor);
        monitor = null;
      }
    };
    if (signal.aborted) close();
    else signal.addEventListener('abort', close, { once: true });
    return {
      contribution: ironProxyContribution(configured, input),
      onUnavailable(report) {
        lease.notify = report;
        if (lease.unavailable) report(lease.unavailable);
      },
    };
  };

  return {
    kind: 'iron-proxy',
    connections: {
      async connect({ host }) {
        const configured = currentSettings();
        if (!configured.projectRoot)
          return { status: 'unsupported' as const, message: 'Iron Control project location is unavailable.' };
        const env = fs.existsSync(path.join(configured.projectRoot, '.env'))
          ? fs.readFileSync(path.join(configured.projectRoot, '.env'), 'utf8')
          : '';
        const consoleUrl = env.match(/^NANOCLAW_IRON_CONTROL_URL=(.+)$/m)?.[1]?.trim();
        if (!configured.managed || !consoleUrl)
          return { status: 'unsupported' as const, message: 'Install Iron Control to manage account credentials.' };
        return {
          status: 'action_required' as const,
          action: 'operator_console' as const,
          connect_url: new URL('/console/secrets', consoleUrl).toString(),
          message: `In Iron Control, configure a credential for ${host}, grant it to this install’s principal, and permit the destination. Console login is required. Approval of an API call does not connect an account. Retry the original call only after configuration; verify success before reporting connected.`,
        };
      },
    },
    agentSkills: ['iron-proxy-gateway'],
    // The proxy is install-owned, not a per-session resource. Session abort
    // drops only its signed capability and approval state.
    sessions: { ensure },
    approvals: { subscribe: (decide, signal) => currentBridge().subscribe(decide, signal) },
  };
}

registerGatewayProvider(defineIronProxyProvider());
