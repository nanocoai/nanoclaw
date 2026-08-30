/**
 * Governance-minted agent ids — the spec-side adoption gate.
 *
 * The governance service mints an agent's permanent id (a bare
 * `crypto.randomUUID()`) BEFORE asking the host to materialize, and passes it
 * on the create spec as `agentId`. The host must adopt that id verbatim as the
 * agent group id — the returned group's `id` (governance's
 * `agent_group_id`) then equals the id governance already bound to an owner in
 * its `agents` table. See the governance repo's
 * docs/agent-identity-design.md ("Change lists").
 *
 * `adoptGovernanceAgentId` runs at the top of `createAgentFromSpec`, before
 * structural validation: it validates `agentId` and folds it into `id`, so
 * every downstream consumer (validation, stamping, the DB row, the session
 * dirs keyed by group id) sees exactly one id. Absent `agentId`, the spec is
 * untouched — `id` behaves as it always has, and specs without either still
 * fail validation's "requires string id" exactly as before.
 */

/** Group ids become DB keys, `data/v2-sessions/<id>` directory names, and CLI
 *  `--group` arguments — keep them to a single safe path segment. A bare UUID
 *  and the legacy `ag-<...>` shapes both pass. */
const AGENT_ID_MAX_LENGTH = 128;
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The two id fields this module reconciles (a structural subset of
 *  AgentCreateSpec — kept independent so this module has no imports). */
export interface GovernanceAgentIdCarrier {
  id?: string;
  agentId?: string;
}

/**
 * Validate a governance-minted `agentId` and adopt it as the spec's `id`
 * (mutating the spec). No-op when `agentId` is absent. Throws (CLI-shaped
 * `--spec…` messages, matching create-spec.ts) when `agentId` is present but
 * empty, unsafe as a path segment, over-long, or in conflict with an
 * explicitly different `id`.
 */
export function adoptGovernanceAgentId(spec: GovernanceAgentIdCarrier): void {
  const { agentId } = spec;
  if (agentId === undefined) return;
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    throw new Error('--spec.agentId must be a non-empty string');
  }
  if (agentId !== agentId.trim()) {
    throw new Error('--spec.agentId must not have leading or trailing whitespace');
  }
  if (agentId.length > AGENT_ID_MAX_LENGTH) {
    throw new Error(`--spec.agentId exceeds ${AGENT_ID_MAX_LENGTH} characters`);
  }
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(
      `--spec.agentId must be a safe single path segment (${AGENT_ID_PATTERN.source}): ${JSON.stringify(agentId)}`,
    );
  }
  if (spec.id !== undefined && spec.id !== agentId) {
    throw new Error('--spec.agentId conflicts with --spec.id — supply one of them, or the same value in both');
  }
  spec.id = agentId;
}
