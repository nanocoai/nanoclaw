import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  __resetProviderToolPolicyForTest,
  policyAllowsTool,
  policyExtraDenied,
  policyHidesMcpServer,
  policySettingSources,
  registerProviderToolPolicy,
} from './tool-policy.js';

// Reset BOTH before and after each case: an install-overlay's tool-policy registrant
// self-registers at module load (via the providers barrel), so when this base suite runs in the
// same bun process as the installed barrel, the shared registry would be pre-populated and the
// "inert" assertions would see a stale policy. beforeEach guarantees the un-registered baseline
// regardless of order — caught by the install-then-test gate (passes by default, where no
// registrant loads; failed once the overlay barrel wired the registrant).
beforeEach(() => __resetProviderToolPolicyForTest());
afterEach(() => __resetProviderToolPolicyForTest());

describe('provider tool-policy (monotonic composition)', () => {
  it('is inert with no policy — every accessor returns the provider default', () => {
    expect(policyExtraDenied()).toEqual([]);
    expect(policyAllowsTool('Bash')).toBe(true);
    expect(policyHidesMcpServer('sqlite')).toBe(false);
    expect(policySettingSources(['project', 'user', 'local'])).toEqual(['project', 'user', 'local']);
  });

  it('a single policy tightens each surface', () => {
    registerProviderToolPolicy({
      extraDenied: ['Bash', 'Read'],
      allowTool: (t) => t !== 'WebSearch',
      hideMcpServer: (n) => n === 'sqlite',
      settingSources: [],
    });
    expect(policyExtraDenied()).toEqual(['Bash', 'Read']);
    expect(policyAllowsTool('WebSearch')).toBe(false);
    expect(policyAllowsTool('Read')).toBe(true); // allowlist filter independent of denylist
    expect(policyHidesMcpServer('sqlite')).toBe(true);
    expect(policySettingSources(['project', 'user', 'local'])).toEqual([]);
  });

  it('a SECOND policy can only tighten — it can NEVER weaken the first (the Codex BLOCKER)', () => {
    registerProviderToolPolicy({
      extraDenied: ['Bash'],
      allowTool: (t) => t !== 'WebSearch',
      hideMcpServer: (n) => n === 'sqlite',
      settingSources: ['project'],
    });
    // An empty/loose later registrant must NOT undo any of the strict one.
    registerProviderToolPolicy({});
    expect(policyExtraDenied()).toContain('Bash'); // union — still denied
    expect(policyAllowsTool('WebSearch')).toBe(false); // AND — still dropped
    expect(policyHidesMcpServer('sqlite')).toBe(true); // OR — still hidden
    expect(policySettingSources(['project', 'user', 'local'])).toEqual(['project']); // ∩ — not widened
  });

  it('two tightening policies compose: union / AND / OR / intersection', () => {
    registerProviderToolPolicy({
      extraDenied: ['Bash'],
      allowTool: (t) => t !== 'WebSearch',
      hideMcpServer: (n) => n === 'sqlite',
      settingSources: ['project', 'user'],
    });
    registerProviderToolPolicy({
      extraDenied: ['Edit'],
      allowTool: (t) => t !== 'WebFetch',
      hideMcpServer: (n) => n === 'other',
      settingSources: ['project', 'local'],
    });
    expect(policyExtraDenied().sort()).toEqual(['Bash', 'Edit']);
    expect(policyAllowsTool('WebSearch')).toBe(false);
    expect(policyAllowsTool('WebFetch')).toBe(false);
    expect(policyAllowsTool('Read')).toBe(true);
    expect(policyHidesMcpServer('sqlite')).toBe(true);
    expect(policyHidesMcpServer('other')).toBe(true);
    expect(policyHidesMcpServer('keep')).toBe(false);
    expect(policySettingSources(['project', 'user', 'local'])).toEqual(['project']); // ∩
  });
});
