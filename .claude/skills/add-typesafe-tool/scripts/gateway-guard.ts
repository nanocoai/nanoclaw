/**
 * Pre-flight for /add-typesafe-tool: which credential gateway this copy runs,
 * and whether the skill supports it.
 *
 * Reads the stamp the way the host does (`NANOCLAW_GATEWAY_PROVIDER` in the
 * environment, then in `.env` via `configuredGatewayKind`) and never probes
 * for an installed gateway: an unstamped copy has not finished setup, and the
 * skill must not guess.
 *
 * OneCLI only, for now. On Iron Proxy every judgment is a POST to
 * api.typesafe.ai, and core auto-approves only the agent provider's model
 * domains and GET/HEAD on `NANOCLAW_GATEWAY_READ_ONLY_HOSTS`, so each call
 * would raise a human approval card. Iron support waits on a per-host
 * auto-approval rule in core.
 */
import { configuredGatewayKind } from '../../../../setup/gateways/selection.js';

export const SUPPORTED_GATEWAY = 'onecli';

export function selectedGateway(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  return env.NANOCLAW_GATEWAY_PROVIDER?.trim().toLowerCase() || configuredGatewayKind(root);
}

/** The reason the install must stop, or undefined when the selected gateway is supported. */
export function gatewayRefusal(kind: string): string | undefined {
  if (!kind) {
    return (
      'No credential gateway is stamped for this copy (NANOCLAW_GATEWAY_PROVIDER is unset in the environment and .env). ' +
      'Finish /setup or run /add-onecli first, then retry; this skill does not probe for an installed gateway.'
    );
  }
  if (kind === SUPPORTED_GATEWAY) return undefined;
  const why =
    kind === 'iron-proxy'
      ? ' On Iron Proxy every judgment (a POST to api.typesafe.ai) would raise a human approval card, because core auto-approves ' +
        'only the model domains and GET/HEAD read-only hosts; Iron support waits on a per-host auto-approval rule in core.'
      : '';
  return `/add-typesafe-tool supports the OneCLI gateway only; this copy runs "${kind}".${why}`;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const kind = selectedGateway();
  const refusal = gatewayRefusal(kind);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  console.log(kind);
}
