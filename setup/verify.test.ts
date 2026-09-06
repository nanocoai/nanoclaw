import { describe, expect, it } from 'vitest';

import { determineVerifyStatus } from './verify.js';

const healthyBase = {
  service: 'running' as const,
  credentials: 'configured',
  registeredGroups: 1,
  healthStatus: 'healthy' as const,
  healthCheckoutMatches: true,
  healthProcessMatches: true,
};

describe('determineVerifyStatus', () => {
  it('accepts a healthy install with at least one wired agent group', () => {
    expect(determineVerifyStatus(healthyBase)).toBe('success');
  });

  it('accepts an explicit empty agent-group state', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        registeredGroups: 0,
      }),
    ).toBe('success');
  });

  // Deferred wire (Teams): configured but zero groups is pending operator
  // action (first DM), not a broken install — success, not failed.
  it('accepts zero groups when wiring is pending a first DM', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        registeredGroups: 0,
        wiringPending: true,
      }),
    ).toBe('success');
  });

  it('pending wiring never rescues a stopped service or missing credentials', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        registeredGroups: 0,
        wiringPending: true,
        service: 'stopped',
      }),
    ).toBe('failed');
    expect(
      determineVerifyStatus({
        ...healthyBase,
        registeredGroups: 0,
        wiringPending: true,
        credentials: 'missing',
      }),
    ).toBe('failed');
  });

  it('fails when the service is not running', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        service: 'stopped',
      }),
    ).toBe('failed');
  });

  it('fails when credentials are missing', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        credentials: 'missing',
      }),
    ).toBe('failed');
  });

  it('fails when structured health is unavailable or from another checkout', () => {
    expect(determineVerifyStatus({ ...healthyBase, healthStatus: 'unhealthy', healthCheckoutMatches: false })).toBe(
      'failed',
    );
    expect(determineVerifyStatus({ ...healthyBase, healthStatus: 'healthy', healthCheckoutMatches: false })).toBe(
      'failed',
    );
    expect(
      determineVerifyStatus({
        ...healthyBase,
        healthStatus: 'healthy',
        healthCheckoutMatches: true,
        healthProcessMatches: true,
      }),
    ).toBe('success');
    expect(
      determineVerifyStatus({
        ...healthyBase,
        healthStatus: 'healthy',
        healthCheckoutMatches: true,
        healthProcessMatches: false,
      }),
    ).toBe('failed');
    expect(determineVerifyStatus({ ...healthyBase, healthStatus: undefined as never })).toBe('failed');
  });
});
