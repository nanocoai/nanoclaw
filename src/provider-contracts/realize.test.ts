import path from 'path';
import { describe, expect, it } from 'vitest';

import './index.js';
import { protectedProviderDocumentSourcePaths, providerDocumentSourcePath } from './realize.js';
import { PROVIDER_HOST_CONTRACT_SEAM_VERSION, getProviderHostContract, type ProviderHostContract } from './registry.js';

const ROOT = '/srv/nanoclaw';
const CANON = path.resolve(ROOT, 'container', 'CLAUDE.md');

function fakeContract(): ProviderHostContract {
  return {
    seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
    projectDocument: {
      fileName: 'AGENTS.md',
      containerPath: '/workspace/agent/AGENTS.md',
      mountClass: 'group-state',
    },
    stateVolumes: [],
    skillBackings: [],
    skillViews: [],
    files: [],
  };
}

describe('protectedProviderDocumentSourcePaths', () => {
  it('protects the canonical template for the installed Claude contract', () => {
    expect(protectedProviderDocumentSourcePaths(ROOT)).toEqual([CANON]);
  });

  it('protects the canon regardless of which contracts are registered', () => {
    // Protection is core-owned since every contract renders from the one
    // canonical template; no declaration switches it on or off.
    expect(getProviderHostContract('claude')).toBeDefined();
    expect(providerDocumentSourcePath(ROOT, fakeContract())).toBe(CANON);
    expect(protectedProviderDocumentSourcePaths(ROOT)).toEqual([CANON]);
  });
});
