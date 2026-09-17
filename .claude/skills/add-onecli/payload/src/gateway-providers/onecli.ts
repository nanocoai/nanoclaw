import { normalizeGatewayApprovalSummary } from '../gateway-approval-summary.js';
/** OneCLI typed configuration and supervised native approval adapter. */
import { OneCLI, ApprovalClient, type ContainerConfig, type ApprovalRequest } from '@onecli-sh/sdk';

import { DATA_DIR } from '../config.js';
import { combinedCaBundle, stageOnecliFile } from './onecli-files.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import {
  registerGatewayProvider,
  type GatewayApprovalRequest,
  type GatewayContribution,
  type GatewaySessionInput,
  type GatewaySessionLease,
} from './gateway-provider-registry.js';

const env = readEnvFile([
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'ONECLI_GATEWAY_CONTAINER',
  'ANTHROPIC_BASE_URL',
  'ONECLI_CONSOLE_URL',
]);
const onecliUrl = process.env.ONECLI_URL || env.ONECLI_URL;
const onecliApiKey = process.env.ONECLI_API_KEY || env.ONECLI_API_KEY;
const gatewayContainer = process.env.ONECLI_GATEWAY_CONTAINER || env.ONECLI_GATEWAY_CONTAINER || 'onecli';
const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL;
const onecli = new OneCLI({ url: onecliUrl, apiKey: onecliApiKey });
const healthUrl = new URL('/v1/health', onecliUrl || 'https://api.onecli.sh').toString();
const liveLeases = new Set<{ unavailable?: string; notify?: (reason: string) => void }>();
let healthTimer: NodeJS.Timeout | null = null;
let probing = false;

type OneCLIContribution = Omit<GatewayContribution, 'networkAccess'>;
type GatewayMount = NonNullable<GatewayContribution['mounts']>[number];

/** Stage immutable per-content files; SDK temporary basenames are shared across agents. */
export function contributionFromConfig(
  config: ContainerConfig,
  groupScope: string,
  dataDir = DATA_DIR,
): OneCLIContribution {
  const env = { ...config.env };
  const mounts: GatewayMount[] = [];
  const mount = (kind: 'ca' | 'combined' | 'stub', content: string, containerPath: string) => {
    mounts.push({
      class: 'allowlisted-extra',
      hostPath: stageOnecliFile(dataDir, kind, content),
      containerPath,
      mode: 'ro',
      groupScope,
    });
  };
  mount('ca', config.caCertificate, config.caCertificateContainerPath);
  const combined = combinedCaBundle(config.caCertificate);
  if (combined) {
    const target = '/tmp/onecli-combined-ca.pem';
    mount('combined', combined, target);
    env.SSL_CERT_FILE = target;
    env.DENO_CERT = target;
  }
  for (const stub of config.credentialStubs ?? []) mount('stub', stub.content, stub.containerPath);
  return { env, mounts };
}

export function withProviderEnv(contribution: OneCLIContribution, baseUrl = anthropicBaseUrl): OneCLIContribution {
  if (!baseUrl) return contribution;
  return {
    ...contribution,
    env: { ...contribution.env, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: 'gateway-managed' },
  };
}

function stopHealthMonitor(): void {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}

async function probeHealth(): Promise<void> {
  if (probing || liveLeases.size === 0) return;
  probing = true;
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`status ${response.status}`);
  } catch (err) {
    const reason = 'OneCLI gateway unavailable';
    log.error(reason, { err });
    stopHealthMonitor();
    for (const lease of liveLeases) {
      lease.unavailable = reason;
      lease.notify?.(reason);
    }
  } finally {
    probing = false;
  }
}

function monitorLease(signal: AbortSignal): Pick<GatewaySessionLease, 'onUnavailable'> {
  const lease: { unavailable?: string; notify?: (reason: string) => void } = {};
  liveLeases.add(lease);
  if (!healthTimer) {
    healthTimer = setInterval(() => void probeHealth(), 5_000);
    healthTimer.unref();
  }
  const close = () => {
    liveLeases.delete(lease);
    if (liveLeases.size === 0) stopHealthMonitor();
  };
  if (signal.aborted) close();
  else signal.addEventListener('abort', close, { once: true });
  return {
    onUnavailable(report) {
      lease.notify = report;
      if (lease.unavailable) report(lease.unavailable);
    },
  };
}

async function ensureSession(input: GatewaySessionInput, signal: AbortSignal): Promise<GatewaySessionLease> {
  // The OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  await onecli.ensureAgent({ name: input.groupName, identifier: input.key.agentGroupId });
  const config = await onecli.getContainerConfig({ agent: input.key.agentGroupId });
  log.info('OneCLI gateway applied', { agentGroupId: input.key.agentGroupId, sessionId: input.key.sessionId });
  return {
    ...monitorLease(signal),
    contribution: {
      ...withProviderEnv(contributionFromConfig(config, input.key.agentGroupId)),
      networkAccess: {
        endpoint: 'host.docker.internal',
        target: { kind: 'runtime', identity: gatewayContainer },
      },
    },
  };
}

async function subscribeApprovals(
  decide: (request: GatewayApprovalRequest) => Promise<'approve' | 'deny'>,
  signal: AbortSignal,
): Promise<void> {
  const subscribedAt = Date.now();
  const client = new ApprovalClient(
    onecliUrl || 'https://api.onecli.sh',
    onecliApiKey || '',
    process.env.ONECLI_GATEWAY_URL || null,
    process.env.ONECLI_PROJECT_ID || null,
  );
  let stopped = false;
  const stop = () => {
    if (!stopped) {
      stopped = true;
      client.stop();
    }
  };
  if (signal.aborted) return;
  signal.addEventListener('abort', stop, { once: true });
  try {
    // Unlike configureManualApproval, start exposes gateway-URL discovery failures.
    await client.start(async (request: ApprovalRequest) => {
      if (signal.aborted || Date.parse(request.createdAt) < subscribedAt) return 'deny';
      try {
        return await decide(toGatewayApprovalRequest(request));
      } catch (err) {
        log.error('OneCLI approval translation failed closed', { requestId: request.id, err });
        return 'deny';
      }
    });
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
  }
}

function toGatewayApprovalRequest(request: ApprovalRequest): GatewayApprovalRequest {
  return {
    id: request.id,
    trigger: 'policy',
    destination: { host: request.host, method: request.method },
    agentGroupId: request.agent.externalId ?? '',
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    summary: normalizeGatewayApprovalSummary(
      { agent: request.agent.name, method: request.method, host: request.host, path: request.path },
      (request as ApprovalRequest & { summary?: ApprovalSummary }).summary,
    ),
    title: 'Credentials Request',
    question: buildQuestion(request, request.agent.name),
    audit: { method: request.method, host: request.host, path: request.path },
  };
}

interface ApprovalSummary {
  action?: string;
  details?: { label: string; value: string }[];
}

function safeApprovalText(value: string): string {
  return value.replace(/[<>&`*_~[\]()]/g, '_').replace(/[\0\r]/g, '');
}

function buildQuestion(request: ApprovalRequest, agentName: string): string {
  const lines = [`*Agent:* \`${safeApprovalText(agentName)}\``];
  const summary = (request as ApprovalRequest & { summary?: ApprovalSummary }).summary;
  if (summary?.details?.length) {
    if (summary.action) lines.push(`*Action:* \`${safeApprovalText(summary.action)}\``);
    let budget = 2_200;
    for (const { label, value } of summary.details) {
      if (budget <= 0) break;
      const raw = safeApprovalText(typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value)));
      const shown = raw.slice(0, Math.min(900, budget));
      const safeLabel = safeApprovalText(String(label));
      lines.push(shown.includes('\n') ? `*${safeLabel}:*\n\`\`\`\n${shown}\n\`\`\`` : `*${safeLabel}:* \`${shown}\``);
      budget -= shown.length + String(label).length + 8;
    }
  } else {
    lines.push(`\`${safeApprovalText(`${request.method} ${request.host}${request.path.split(/[?#]/, 1)[0]}`)}\``);
  }
  return lines.join('\n').slice(0, 2_600);
}

registerGatewayProvider({
  kind: 'onecli',
  connections: {
    async connect() {
      const consoleUrl = process.env.ONECLI_CONSOLE_URL || env.ONECLI_CONSOLE_URL;
      return consoleUrl
        ? {
            status: 'action_required' as const,
            action: 'operator_console' as const,
            connect_url: consoleUrl,
            message:
              'Connect the account in OneCLI and grant access to the agent, then retry the original request. A native connect_url returned by the gateway can be used directly.',
          }
        : {
            status: 'unsupported' as const,
            message:
              'Use the native connect_url returned by OneCLI, or ask the operator to set ONECLI_CONSOLE_URL for a console handoff. Do not guess a dashboard URL from an API URL.',
          };
    },
  },
  agentSkills: ['onecli-gateway'],
  sessions: { ensure: ensureSession },
  approvals: { legacyActions: ['onecli_credential'], subscribe: subscribeApprovals },
});
