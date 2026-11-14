/**
 * Repo self-edit guard adapter — the module's catalog entry.
 *
 * From the container path a self-edit is always held for the agent group's
 * admin chain, exactly like install_packages and add_mcp_server. One gate
 * sits in front of the hold: only agent groups the operator listed in
 * REPO_SELF_EDIT_AGENT_GROUPS may propose at all. Every other group is
 * denied before a card is minted, so an admin is never asked to approve a
 * source edit from an agent that was not meant to have the capability.
 *
 * decide re-runs on the approved replay and a grant never satisfies a deny,
 * so removing a group from the list also stops an approval already in flight.
 */
import { envValue } from '../../env.js';
import { DENY, HOLD, defineGuardedAction } from '../../guard/index.js';

export const ALLOWLIST_ENV = 'REPO_SELF_EDIT_AGENT_GROUPS';

function allowedAgentGroups(): Set<string> {
  const raw = process.env[ALLOWLIST_ENV] ?? envValue(ALLOWLIST_ENV) ?? '';
  return new Set(
    raw
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export const repoSelfEditApply = defineGuardedAction({
  action: 'repo_self_edit.apply',
  grantActionName: 'repo_self_edit',
  decide: (input) => {
    if (input.actor.kind !== 'agent') {
      return DENY('repo_self_edit is a container-originated action.');
    }
    if (!allowedAgentGroups().has(input.actor.agentGroupId)) {
      return DENY(`agent group ${input.actor.agentGroupId} is not listed in ${ALLOWLIST_ENV}`);
    }
    return HOLD('repo_self_edit always requires admin approval from the container path');
  },
});
