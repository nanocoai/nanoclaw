/**
 * Guard conformance — checked with the real registries.
 *
 * The old registry walk is gone: an unmapped consult or an undeclared
 * unguarded registration is now unconstructible — guard() takes the defined
 * GuardedAction value (a dropped module-edge import or typo'd name is a
 * compile error), and the keyed registries require a guard spec or an
 * explicit unguarded(<reason>) declaration. What's left to verify is the
 * cross-registry pairing the compiler can't see: every holding action has a
 * registered approve continuation. (At runtime a missing continuation is
 * handled loudly at click time — the requester is told no handler is
 * installed; this test keeps the tree from shipping that state.)
 */
import { describe, expect, it } from 'vitest';

// Production barrels — side-effect imports populate the real registries.
import '../cli/commands/index.js';
import '../modules/index.js';
import '../cli/delivery-action.js';
import '../cli/dispatch.js'; // registers the cli_command approval handler

import { commandGuard, listCommands } from '../cli/registry.js';
import { getApprovalHandler } from '../modules/approvals/primitive.js';
import { defineGuardedAction, listGuardedActions } from './guard-actions.js';
import { HOLD } from './types.js';

describe('guard conformance', () => {
  it('every holding action pairs with a registered approval handler', () => {
    const holding = listGuardedActions().filter((spec) => spec.grantActionName);
    expect(holding.length).toBeGreaterThan(0);

    const dangling = holding.filter((spec) => !getApprovalHandler(spec.grantActionName as string));
    expect(dangling.map((s) => s.action)).toEqual([]);
  });

  it('every mutating ncl command derives a guard that holds via cli_command', () => {
    const mutating = listCommands().filter((cmd) => cmd.access === 'approval');
    expect(mutating.length).toBeGreaterThan(0);

    const wrong = mutating.filter((cmd) => commandGuard(cmd.name).grantActionName !== 'cli_command');
    expect(wrong.map((c) => c.name)).toEqual([]);
  });

  it('the domain catalog entries are defined once the module barrels load', () => {
    const actions = new Set(listGuardedActions().map((s) => s.action));
    for (const expected of [
      'agents.create',
      'a2a.send',
      'self_mod.install_packages',
      'self_mod.add_mcp_server',
      'senders.admit',
      'channels.register',
    ]) {
      expect(actions.has(expected), `catalog is missing "${expected}"`).toBe(true);
    }
  });

  it('defining the same action twice throws — names are the catalog key', () => {
    defineGuardedAction({ action: 'test.dup-define', decide: () => HOLD('x') });
    expect(() => defineGuardedAction({ action: 'test.dup-define', decide: () => HOLD('x') })).toThrow(
      /already defined/,
    );
  });
});
