/**
 * Self-mod guard adapter — the module's catalog entries, composed at the
 * module edge (imported by ./index.ts).
 *
 * The decision is today's behavior verbatim: from the container
 * path, self-modification is held unconditionally for the agent group's
 * admin chain. (The equivalent host-side mutations — `ncl groups config
 * add-package` etc. — are separate catalog actions derived from the command
 * registry.)
 */
import { DENY, HOLD, defineGuardedAction, type GuardInput } from '../../guard/index.js';

function selfModDecide(label: string) {
  return (input: GuardInput) => {
    if (input.actor.kind !== 'agent') {
      return DENY(`${label} is a container-originated action.`);
    }
    return HOLD(`${label} always requires admin approval from the container path`);
  };
}

export const selfModInstallPackages = defineGuardedAction({
  action: 'self_mod.install_packages',
  grantActionName: 'install_packages',
  decide: selfModDecide('install_packages'),
});

export const selfModAddMcpServer = defineGuardedAction({
  action: 'self_mod.add_mcp_server',
  grantActionName: 'add_mcp_server',
  decide: selfModDecide('add_mcp_server'),
});
