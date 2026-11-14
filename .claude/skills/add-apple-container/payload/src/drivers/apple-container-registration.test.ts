/**
 * Registration guard for the Apple Container driver: imports only the real
 * selection module (which evaluates the `installed.ts` barrel) and asserts the
 * registry resolves kind 'container' to this driver. Red when the barrel line
 * is deleted, when the registration module stops registering, or when the
 * barrel cannot evaluate.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { createSessionDriver, listSessionDriverKinds } from './index.js';

describe('Apple Container driver registration', () => {
  it('is registered under kind "container" through the installed barrel', () => {
    expect(listSessionDriverKinds()).toContain('container');
  });

  it('selecting "container" builds the Apple driver', () => {
    const driver = createSessionDriver('container');
    expect(driver.kind).toBe('container');
    expect(driver.capabilities().auxiliaryContainers).toBe(false);
  });
});
