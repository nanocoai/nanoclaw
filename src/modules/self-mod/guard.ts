/**
 * Self-mod guard adapter — the module's catalog entries, composed at the
 * module edge (imported by ./index.ts).
 *
 * The decision is today's behavior verbatim: from the container
 * path, self-modification is held unconditionally for the agent group's
 * admin chain. (The equivalent host-side mutations — `ncl groups config
 * add-package` etc. — are separate catalog actions derived from the command
 * registry.)
 *
 * One capability gate on top: install_packages ends in an image rebuild
 * (./apply.ts calls buildAgentGroupImage), so on a session runtime that
 * declares `imageBuild: false` it is DENIED at request time — before any
 * card is minted — so an admin is never asked to approve something that
 * cannot happen. And because decide re-runs on every consult and a grant
 * satisfies a hold but NEVER a deny, an approval issued while the install
 * ran on Docker cannot execute after a switch to a driver without
 * imageBuild. add_mcp_server needs no rebuild and carries no gate.
 */
import { getSessionDriver } from '../../drivers/index.js';
import { DENY, HOLD, defineGuardedAction, type GuardInput } from '../../guard/index.js';

function selfModDecide(label: string) {
  return (input: GuardInput) => {
    if (input.actor.kind !== 'agent') {
      return DENY(`${label} is a container-originated action.`);
    }
    return HOLD(`${label} always requires admin approval from the container path`);
  };
}

const holdInstallPackages = selfModDecide('install_packages');

export const selfModInstallPackages = defineGuardedAction({
  action: 'self_mod.install_packages',
  grantActionName: 'install_packages',
  decide: (input) => {
    // The capability gate runs first: a deny for "this runtime cannot do it"
    // must win over a hold even for a request that would otherwise card an
    // admin. Gate on capabilities(), never on kind (drivers/index.ts).
    if (!getSessionDriver().capabilities().imageBuild) {
      return DENY(
        "install_packages needs an image rebuild and the session runtime does not declare the 'imageBuild' " +
          'capability — packages cannot be installed on this runtime (image changes are built and imported out of band)',
      );
    }
    return holdInstallPackages(input);
  },
});

export const selfModAddMcpServer = defineGuardedAction({
  action: 'self_mod.add_mcp_server',
  grantActionName: 'add_mcp_server',
  decide: selfModDecide('add_mcp_server'),
});
