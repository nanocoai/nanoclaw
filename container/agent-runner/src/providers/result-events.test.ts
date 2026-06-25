import { afterEach, describe, expect, it } from 'bun:test';

import {
  __resetProviderResultEventPolicyForTest,
  baseCompactBoundaryEvent,
  baseResultMessageEvents,
  mapCompactBoundaryMessage,
  mapResultMessage,
  registerProviderResultEventPolicy,
} from './result-events.js';

// Base-owned test for the result/compaction event-mapping seam. There is NO default policy,
// so this proves the upstream defaults (error/success result mapping + the delivered "Context
// compacted" result) AND the override path. A downstream policy (non-null error fallback +
// suppressed `compacted` event) is overlay-owned and tested separately.

afterEach(() => __resetProviderResultEventPolicyForTest());

describe('result-events seam — upstream defaults (no policy)', () => {
  it('success result → single result event carrying its text, no isError', () => {
    __resetProviderResultEventPolicyForTest();
    expect(mapResultMessage({ result: 'all done' })).toEqual([{ type: 'result', text: 'all done', isError: false }]);
  });

  it('missing result (no error) → result event with null text', () => {
    __resetProviderResultEventPolicyForTest();
    expect(mapResultMessage({})).toEqual([{ type: 'result', text: null, isError: false }]);
  });

  it('error result → joins errors[] into text with isError:true', () => {
    __resetProviderResultEventPolicyForTest();
    expect(mapResultMessage({ is_error: true, errors: ['line one', 'line two'] })).toEqual([
      { type: 'result', text: 'line one\nline two', isError: true },
    ]);
  });

  it('error result with NO detail → upstream leaves text NULL (the drop the overlay later fixes)', () => {
    __resetProviderResultEventPolicyForTest();
    expect(baseResultMessageEvents({ is_error: true })).toEqual([{ type: 'result', text: null, isError: true }]);
  });

  it('compact_boundary → delivered as a result line (upstream behaviour)', () => {
    __resetProviderResultEventPolicyForTest();
    expect(mapCompactBoundaryMessage({ compact_metadata: { pre_tokens: 12345 } })).toEqual({
      type: 'result',
      text: 'Context compacted (12,345 tokens compacted).',
    });
    expect(baseCompactBoundaryEvent({})).toEqual({ type: 'result', text: 'Context compacted.' });
  });
});

describe('result-events seam — a registered policy overrides', () => {
  it('mapResult override replaces the default mapping', () => {
    __resetProviderResultEventPolicyForTest();
    registerProviderResultEventPolicy({
      mapResult: () => [{ type: 'result', text: 'OVERRIDDEN', isError: true }],
    });
    expect(mapResultMessage({ result: 'ignored' })).toEqual([{ type: 'result', text: 'OVERRIDDEN', isError: true }]);
  });

  it('mapCompactBoundary override can emit a `compacted` event instead of a result', () => {
    __resetProviderResultEventPolicyForTest();
    registerProviderResultEventPolicy({
      mapCompactBoundary: (m) => ({ type: 'compacted', text: baseCompactBoundaryEvent(m).text as string }),
    });
    expect(mapCompactBoundaryMessage({ compact_metadata: { pre_tokens: 100 } })).toEqual({
      type: 'compacted',
      text: 'Context compacted (100 tokens compacted).',
    });
  });

  it('a partial policy (only mapResult) leaves the other mapping on its base default', () => {
    __resetProviderResultEventPolicyForTest();
    registerProviderResultEventPolicy({ mapResult: () => [{ type: 'result', text: 'X' }] });
    // compact mapping untouched → still the base result line.
    expect(mapCompactBoundaryMessage({})).toEqual({ type: 'result', text: 'Context compacted.' });
  });
});
