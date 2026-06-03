/**
 * Network policy provider — extension point for per-agent egress policy.
 *
 * Core ships with no provider registered; behavior is unchanged from before
 * this hook existed. A skill (e.g. `/agent-network`) registers an
 * implementation that decides container outbound posture (Docker network,
 * proxy env, ACLs).
 *
 * Inter-agent messaging is NOT regulated here — that's already handled by
 * row presence in `agent_destinations` (no row → no communication, enforced
 * inside `routeAgentMessage`). The skill's LAN-side configuration consists
 * of inserting and deleting those rows, not running through this hook.
 *
 * Two optional hooks, each invoked at a different point in the host:
 *
 *   - `ensure`             — once at host startup, after migrations.
 *   - `applyContainerArgs` — every container spawn, just after OneCLI
 *                            credentials are wired and before mounts/image.
 *                            The provider mutates `args` in place to add
 *                            `--network`, env vars, etc.
 */
import type { AgentGroup } from '../../types.js';

export interface ContainerArgsContext {
  agentGroup: AgentGroup;
}

export interface NetworkPolicyProvider {
  /** One-time setup at host startup (e.g. ensure Docker network + proxy container). */
  ensure?(): Promise<void>;

  /** Per-spawn hook: mutate Docker args based on the agent's network policy. */
  applyContainerArgs?(args: string[], ctx: ContainerArgsContext): Promise<void>;
}
