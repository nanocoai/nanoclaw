/**
 * Bureaucracy-automation guard test — mirrors self-mod/guard.test.ts's shape
 * for the simpler, ungated action (no imageBuild capability check applies
 * here: this action never rebuilds anything).
 */
import { describe, expect, it } from 'vitest';

import { bureaucracySubmit } from './guard.js';

describe('bureaucracySubmit guard', () => {
  it('holds for a container-originated request', async () => {
    const decision = await bureaucracySubmit.decide({ actor: { kind: 'agent', agentGroupId: 'g1' }, payload: {} });
    expect(decision.effect).toBe('hold');
  });

  it('denies a non-agent actor', async () => {
    const decision = await bureaucracySubmit.decide({ actor: { kind: 'human', userId: 'u1' }, payload: {} });
    expect(decision.effect).toBe('deny');
  });
});
