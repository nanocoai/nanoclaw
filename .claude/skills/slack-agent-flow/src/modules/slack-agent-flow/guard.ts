/**
 * Slack-agent-flow guard adapter — the module's catalog entries for the
 * agent-facing room actions, composed at the module edge (imported
 * by ./index.ts), mirroring agent-to-agent/guard.ts.
 *
 * rooms.create / rooms.add_agent — same trust split as agents.create:
 * `global` cli_scope acts directly (room wiring is the intended primitive for
 * trusted owner agent groups); anything else — the default `group` scope, and
 * unknown/missing config, fail-closed — holds for the requesting group's
 * admin chain. Both actions write central-DB state (messaging groups,
 * wirings, a2a destinations) and open Slack conversations with the operator,
 * so a confined container must never reach the handler unheld.
 */
import { getContainerConfig } from '../../db/container-configs.js';
import { ALLOW, DENY, HOLD, defineGuardedAction, type GuardedAction } from '../../guard/index.js';
import type { GuardDecision, GuardInput } from '../../guard/index.js';

/** The agents.create trust split, reused verbatim for the room actions. */
async function decideByCliScope(input: GuardInput, action: string): Promise<GuardDecision> {
  if (input.actor.kind !== 'agent') return DENY(`${action} is a container-originated action.`);
  const cliScope = (await getContainerConfig(input.actor.agentGroupId))?.cli_scope ?? 'group';
  if (cliScope === 'global') {
    // Trusted owner agent group — an approval tap on every room change would
    // be needless friction.
    return ALLOW('trusted global-scope agent group');
  }
  // The realistic prompt-injection victim (default `group` scope) — and any
  // unknown config value, fail-closed — requires an admin before any
  // central-DB write or MPIM open.
  return HOLD(`agent-initiated ${action} requires admin approval`);
}

export const roomsCreate: GuardedAction = defineGuardedAction({
  action: 'rooms.create',
  grantActionName: 'create_room',
  // Bind a create_room grant to the room name that was approved.
  grantCoversRequest: (grant, input) => {
    try {
      return (JSON.parse(grant.payload) as { name?: string }).name === input.payload.name;
    } catch {
      return false;
    }
  },
  decide: (input) => decideByCliScope(input, 'create_room'),
});

export const roomsAddAgent: GuardedAction = defineGuardedAction({
  action: 'rooms.add_agent',
  grantActionName: 'add_to_room',
  // Bind an add_to_room grant to the exact (room, agent) pair approved.
  grantCoversRequest: (grant, input) => {
    try {
      const p = JSON.parse(grant.payload) as { room?: string; agent?: string };
      return p.room === input.payload.room && p.agent === input.payload.agent;
    } catch {
      return false;
    }
  },
  decide: (input) => decideByCliScope(input, 'add_to_room'),
});
