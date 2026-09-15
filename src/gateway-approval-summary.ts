import type { GatewayApprovalRequest } from './gateway-providers/gateway-provider-registry.js';

/** One normalization boundary for OneCLI's native summary and compatible gateways. */
export function normalizeGatewayApprovalSummary(
  request: { agent: string; method: string; host: string; path: string },
  summary?: { action?: string; details?: { label: string; value: string }[] },
): NonNullable<GatewayApprovalRequest['summary']> {
  return {
    agent: request.agent.slice(0, 120),
    action: (
      summary?.action ||
      (['GET', 'HEAD'].includes(request.method)
        ? 'Read from an external service'
        : 'Send a request that may change external data')
    ).slice(0, 600),
    resource: `${request.method} ${request.host}${request.path.split(/[?#]/, 1)[0]}`.slice(0, 600),
    reason: 'The gateway policy requires human approval for this request.',
    details: summary?.details?.slice(0, 6).map(({ label, value }) => ({
      label: String(label).slice(0, 80),
      value: String(value).slice(0, 600),
    })),
  };
}
