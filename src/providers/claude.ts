/**
 * Claude provider container config.
 *
 * Routes the credential decision through the credential resolver so installs
 * can override behaviour via `setCredentialResolverHook`. Default (no hook
 * registered) preserves today's behaviour exactly:
 *   - read ANTHROPIC_BASE_URL from .env
 *   - if set, write ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN=placeholder
 *   - if absent, no env contribution (SDK uses its built-in defaults)
 *
 * The real auth token never enters the container regardless of mode — OneCLI
 * proxy rewrites the Authorization header on the wire.
 *
 * Container-runner calls `getClaudeContribution` directly for the `claude`
 * provider — we do not self-register via `registerProviderContainerConfig`
 * because the registry interface is sync and the resolver is async.
 */
import { readEnvFile } from '../env.js';
import { applyCredentialDecisions, resolveCredential, type CredentialDecision } from '../credentials/index.js';
import type { ProviderContainerContext, ProviderContainerContribution } from './provider-container-registry.js';

/**
 * @param ctx - Per-session container context.
 * @param preResolved - Optional already-resolved credential decision. Pass this
 *   when the caller (typically `buildContributionForSpawn`) has already invoked
 *   `resolveCredential` for the session — avoids firing the resolver hook twice
 *   per spawn, which matters for any future stateful hook (rate-limited,
 *   one-shot provisioner, side-effecting).
 */
export async function getClaudeContribution(
  ctx: ProviderContainerContext,
  preResolved?: CredentialDecision,
): Promise<ProviderContainerContribution> {
  const decision =
    preResolved ??
    (await resolveCredential({
      agentGroupId: ctx.agentGroupId,
      runtimeProvider: 'claude',
      modelProvider: 'anthropic',
      authMode: 'auto',
    }));

  const effective: CredentialDecision = decision.kind === 'fallback' ? defaultDecisionFromEnv() : decision;

  const result = applyCredentialDecisions([effective], ctx.sessionDir, ctx.hostEnv);

  if (result.refusal) {
    if (result.refusal.kind === 'forbidden') {
      throw new Error(
        `Claude provider forbidden for agent group ${ctx.agentGroupId}: ${result.refusal.reason ?? 'no reason given'}`,
      );
    }
    throw new Error(`Claude provider requires account connect (${result.refusal.provider}): ${result.refusal.message}`);
  }

  return result.contribution;
}

function defaultDecisionFromEnv(): CredentialDecision {
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL']);
  if (!dotenv.ANTHROPIC_BASE_URL) return { kind: 'fallback' };
  return {
    kind: 'gateway_secret',
    providerId: 'anthropic',
    baseUrl: dotenv.ANTHROPIC_BASE_URL,
    placeholderToken: 'placeholder',
    refreshPolicy: 'gateway',
  };
}
