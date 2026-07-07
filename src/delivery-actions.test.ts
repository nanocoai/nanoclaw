/**
 * Delivery action registry.
 *
 * `registerDeliveryAction` is the hook modules use to handle system-kind
 * outbound messages; `getDeliveryAction` is the read side that makes those
 * registrations behavior-testable. Goes red if either half of the registry
 * is removed or the two stop sharing the same map.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

import { registerDeliveryAction, getDeliveryAction, type DeliveryActionHandler } from './delivery.js';

describe('delivery action registry', () => {
  it('getDeliveryAction returns the handler registerDeliveryAction registered', () => {
    const handler: DeliveryActionHandler = async () => {};
    registerDeliveryAction('test_registry_action', handler);
    expect(getDeliveryAction('test_registry_action')).toBe(handler);
  });

  it('getDeliveryAction returns undefined for unregistered actions', () => {
    expect(getDeliveryAction('test_never_registered_action')).toBeUndefined();
  });

  it('re-registering an action overwrites the previous handler', () => {
    const first: DeliveryActionHandler = async () => {};
    const second: DeliveryActionHandler = async () => {};
    registerDeliveryAction('test_overwrite_action', first);
    registerDeliveryAction('test_overwrite_action', second);
    expect(getDeliveryAction('test_overwrite_action')).toBe(second);
  });
});
