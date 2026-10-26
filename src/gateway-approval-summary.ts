import type { GatewayApprovalRequest } from './gateway-providers/gateway-provider-registry.js';

/** Cuts a long value with a visible marker, so the approver knows text is missing. */
export function markedCut(value: string, max: number): string {
  if (value.length <= max) return value;
  // Room for the longest count; never split a surrogate pair.
  let keep = max - 40;
  const code = value.charCodeAt(keep - 1);
  if (code >= 0xd800 && code <= 0xdbff) keep -= 1;
  return `${value.slice(0, keep)} … (${value.length - keep} more characters not shown)`;
}

/** One normalization boundary for OneCLI's native summary and compatible gateways. */
export function normalizeGatewayApprovalSummary(
  request: { agent: string; method: string; host: string; path: string },
  summary?: { action?: string; details?: { label: string; value: string }[] },
): NonNullable<GatewayApprovalRequest['summary']> {
  const details = summary?.details;
  return {
    agent: markedCut(request.agent, 120),
    action: markedCut(
      summary?.action ||
        (['GET', 'HEAD'].includes(request.method)
          ? 'Read from an external service'
          : 'Send a request that may change external data'),
      600,
    ),
    resource: markedCut(`${request.method} ${request.host}${request.path.split(/[?#]/, 1)[0]}`, 600),
    reason: 'The gateway policy requires human approval for this request.',
    details: details?.slice(0, 6).map(({ label, value }) => ({
      label: markedCut(String(label), 80),
      value: markedCut(String(value), 600),
    })),
    ...(details && details.length > 6 ? { omittedDetails: details.length - 6 } : {}),
  };
}
