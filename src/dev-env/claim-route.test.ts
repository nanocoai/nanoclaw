/**
 * Structural guards for the D19 per-claim route — the unit-level seal the
 * manifest lints cannot see, because this object only ever exists at runtime.
 *
 * The T6 seal is the load-bearing set: a route is SELECTORS ONLY (a
 * pod-selector egress rule can never admit the parent apiserver — it is not a
 * pod), one port (8443, the child apiserver's real post-DNAT port), and the
 * forge-proof managed-by-absent term. These asserts must survive any future
 * widening of the ClaimRoute type: they scan the built object, not the
 * declaration.
 */
import { describe, expect, it } from 'vitest';

import { CLAIM_ROUTE_PORT, buildClaimRoute, claimRouteName, type ClaimRouteSpec } from './claim-route.js';
import { DEV_ENV_LABELS } from './types.js';

function spec(overrides: Partial<ClaimRouteSpec> = {}): ClaimRouteSpec {
  return {
    installScope: 'suite',
    instanceId: 'ins-1234',
    claimantNamespace: 'agents',
    claimantPodSelector: { 'nanoclaw-install': 'suite', 'nanoclaw-group': 'g1', 'nanoclaw-role': 'agent' },
    childNamespace: 'nanoclaw-dev-abcd1234',
    ...overrides,
  };
}

/** Every key anywhere in the object — the deep scan the seal rides on. */
function allKeys(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, found);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      found.add(k);
      allKeys(v, found);
    }
  }
  return found;
}

describe('buildClaimRoute — the T6 seal', () => {
  it('carries NO ipBlock (or cidr/except) anywhere, ever', () => {
    // The whole reason this stream is pod-selector routes: a CIDR that
    // admitted the child's address space could silently include the parent
    // apiserver; a selector structurally cannot.
    const keys = allKeys(buildClaimRoute(spec()));
    expect(keys.has('ipBlock')).toBe(false);
    expect(keys.has('cidr')).toBe(false);
    expect(keys.has('except')).toBe(false);
  });

  it('admits by selectors only: every to-term is exactly namespaceSelector + podSelector', () => {
    const route = buildClaimRoute(spec());
    for (const rule of route.spec.egress) {
      for (const to of rule.to) {
        expect(Object.keys(to).sort()).toEqual(['namespaceSelector', 'podSelector']);
      }
    }
    // And the namespace term names the child by its immutable metadata label.
    expect(route.spec.egress[0].to[0].namespaceSelector.matchLabels).toEqual({
      'kubernetes.io/metadata.name': 'nanoclaw-dev-abcd1234',
    });
  });

  it('opens TCP 8443 only — one rule, one term, one port, egress only', () => {
    const route = buildClaimRoute(spec());
    expect(route.spec.policyTypes).toEqual(['Egress']);
    expect(route.spec.egress).toHaveLength(1);
    expect(route.spec.egress[0].to).toHaveLength(1);
    expect(route.spec.egress[0].ports).toEqual([{ protocol: 'TCP', port: 8443 }]);
    expect(CLAIM_ROUTE_PORT).toBe(8443);
  });

  it('requires the syncer-stamped managed-by label ABSENT — the term a tenant pod cannot fake', () => {
    // `app=vcluster` alone is forgeable inside the child (plain labels sync
    // verbatim); the pair is what the rendered bundle already relies on.
    const route = buildClaimRoute(spec());
    expect(route.spec.egress[0].to[0].podSelector.matchExpressions).toEqual([
      { key: 'app', operator: 'In', values: ['vcluster'] },
      { key: 'vcluster.loft.sh/managed-by', operator: 'DoesNotExist' },
    ]);
  });

  it('lands in the CLAIMANT namespace under the shared name rule, wearing install + instance labels', () => {
    const route = buildClaimRoute(spec());
    expect(route.metadata.namespace).toBe('agents');
    expect(route.metadata.name).toBe(claimRouteName('ins-1234'));
    expect(route.metadata.name).toBe('dev-env-route-ins-1234');
    // Attribution: what joins a route back to its claim, and what the orphan
    // sweep keys on.
    expect(route.metadata.labels).toEqual({
      [DEV_ENV_LABELS.install]: 'suite',
      [DEV_ENV_LABELS.instance]: 'ins-1234',
    });
  });

  it('selects the claimant pods by the given labels, verbatim', () => {
    const route = buildClaimRoute(spec());
    expect(route.spec.podSelector).toEqual({
      matchLabels: { 'nanoclaw-install': 'suite', 'nanoclaw-group': 'g1', 'nanoclaw-role': 'agent' },
    });
  });

  it('refuses an EMPTY claimant selector — that is every pod in the namespace', async () => {
    expect(() => buildClaimRoute(spec({ claimantPodSelector: {} }))).toThrow(/selector is empty/);
  });

  it('refuses inputs that fail the closed charsets, never mangles them', () => {
    expect(() => buildClaimRoute(spec({ claimantNamespace: '' }))).toThrow(/claimant namespace/);
    expect(() => buildClaimRoute(spec({ claimantNamespace: 'Agents!' }))).toThrow(/claimant namespace/);
    expect(() => buildClaimRoute(spec({ childNamespace: 'no spaces' }))).toThrow(/child namespace/);
    expect(() => buildClaimRoute(spec({ claimantPodSelector: { 'bad key!': 'v' } }))).toThrow(/selector key/);
    expect(() => buildClaimRoute(spec({ claimantPodSelector: { ok: 'no spaces' } }))).toThrow(/selector value/);
    expect(() => buildClaimRoute(spec({ instanceId: 'INS 1' }))).toThrow(/instance id/);
    // Refusals wear the seam taxonomy — a claim above this sees a shape it knows.
    try {
      buildClaimRoute(spec({ claimantPodSelector: {} }));
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toMatchObject({ kind: 'instantiation-failed', retryable: false });
    }
  });
});
