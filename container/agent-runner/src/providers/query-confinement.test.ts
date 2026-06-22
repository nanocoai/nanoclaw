import { afterEach, describe, expect, it } from 'bun:test';

import { ClaudeProvider } from './claude.js';
import {
  __resetQueryConfinementForTest,
  applyQueryConfinement,
  isQueryConfinementRegistered,
  registerQueryConfinement,
  type QueryConfinement,
  type QueryConfinementSurface,
} from './query-confinement.js';

// Base-owned test for the per-turn query-confinement seam. Pristine core ships NO
// registrant, so this proves the INERT + fail-CLOSED contract and the base provider
// wiring (the honest supportsConfinedExternal capability + query() refusing a flagged
// turn when nothing taught it how to confine). The TaskFlow registrant that reproduces
// RC5-ext C4c confinement is overlay-owned and tested separately.

const NORMAL_SURFACE: QueryConfinementSurface = {
  allowedTools: ['Bash', 'Read', 'mcp__nanoclaw__*', 'mcp__board__*'],
  visibleMcpServerNames: ['nanoclaw', 'board'],
  additionalDirectories: ['/workspace/board-a'],
};

// A minimal confinement used only to exercise the registered path (the real overlay
// registrant is not present in pristine core).
const DUMMY_CONFINEMENT: QueryConfinement = {
  confine: () => ({ allowedTools: ['mcp__nanoclaw__*'], visibleMcpServerNames: ['nanoclaw'], additionalDirectories: [] }),
};

afterEach(() => __resetQueryConfinementForTest());

describe('query-confinement seam — inert + fail-closed on pristine core', () => {
  it('isQueryConfinementRegistered() is false with no registrant', () => {
    __resetQueryConfinementForTest();
    expect(isQueryConfinementRegistered()).toBe(false);
  });

  it('applyQueryConfinement THROWS with no registrant — refuses to run unconfined', () => {
    __resetQueryConfinementForTest();
    expect(() => applyQueryConfinement(NORMAL_SURFACE)).toThrow(/no QueryConfinement is registered/);
  });

  it('composes registrants monotonically (each receives the prior output)', () => {
    __resetQueryConfinementForTest();
    registerQueryConfinement(DUMMY_CONFINEMENT);
    const confined = applyQueryConfinement(NORMAL_SURFACE);
    expect(confined.allowedTools).toEqual(['mcp__nanoclaw__*']);
    expect(confined.visibleMcpServerNames).toEqual(['nanoclaw']);
    expect(confined.additionalDirectories).toEqual([]);
  });
});

describe('ClaudeProvider — honest supportsConfinedExternal capability', () => {
  it('reports false with no registrant (a caller fails closed and skips the turn)', () => {
    __resetQueryConfinementForTest();
    expect(new ClaudeProvider({}).supportsConfinedExternal).toBe(false);
  });

  it('reports true once a confinement is registered', () => {
    __resetQueryConfinementForTest();
    registerQueryConfinement(DUMMY_CONFINEMENT);
    expect(new ClaudeProvider({}).supportsConfinedExternal).toBe(true);
  });
});

describe('ClaudeProvider.query — fail-closed on a confined turn with no registrant', () => {
  it('throws BEFORE the SDK is invoked rather than run an external turn unconfined', () => {
    __resetQueryConfinementForTest();
    const provider = new ClaudeProvider({});
    expect(() =>
      provider.query({ prompt: 'external participant message', cwd: '/tmp/neutral', confinedExternal: true }),
    ).toThrow(/no QueryConfinement is registered/);
  });
});
