/**
 * Delivery action registry.
 *
 * `registerDeliveryAction` is the hook modules use to handle system-kind
 * outbound messages; `getDeliveryAction` is the read side that makes those
 * registrations behavior-testable. Goes red if either half of the registry
 * is removed or the two stop sharing the same map. Every registration now
 * carries a guard spec or an explicit unguarded(<reason>) declaration —
 * omission is a type error.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

import { registerDeliveryAction, getDeliveryAction, type DeliveryActionHandler } from './delivery.js';
import { defineGuardedAction, HOLD, unguarded } from './guard/index.js';

const testUnguarded = unguarded('test — registry mechanics only');

describe('delivery action registry', () => {
  it('getDeliveryAction returns the handler registerDeliveryAction registered', () => {
    const handler: DeliveryActionHandler = async () => {};
    registerDeliveryAction('test_registry_action', handler, testUnguarded);
    expect(getDeliveryAction('test_registry_action')).toBe(handler);
  });

  it('getDeliveryAction returns undefined for unregistered actions', () => {
    expect(getDeliveryAction('test_never_registered_action')).toBeUndefined();
  });

  it('re-registering an action overwrites the previous handler', () => {
    const first: DeliveryActionHandler = async () => {};
    const second: DeliveryActionHandler = async () => {};
    registerDeliveryAction('test_overwrite_action', first, testUnguarded);
    registerDeliveryAction('test_overwrite_action', second, testUnguarded);
    expect(getDeliveryAction('test_overwrite_action')).toBe(second);
  });

  it('refuses to replace a guard-wrapped action with an unguarded handler', () => {
    const guardAction = defineGuardedAction({
      action: 'test.guarded-overwrite',
      decide: () => HOLD('t'),
    });
    registerDeliveryAction('test_guarded_overwrite', async () => {}, {
      guardAction,
      requestHold: async () => {},
    });

    // Disarming the guard by re-registering unguarded must throw — otherwise
    // the action's catalog entry would still exist while the live path runs
    // unguarded.
    expect(() => registerDeliveryAction('test_guarded_overwrite', async () => {}, testUnguarded)).toThrow(
      /disarm the guard/,
    );

    // Re-registering WITH a spec stays allowed (a legitimate replacement
    // keeps the action guarded).
    registerDeliveryAction('test_guarded_overwrite', async () => {}, {
      guardAction,
      requestHold: async () => {},
    });
    expect(getDeliveryAction('test_guarded_overwrite')).toBeDefined();
  });
});
