/**
 * extractInputValue / extractViewState dig input and select values out of a
 * raw Slack block_actions payload (`state.values`, with nested view-state
 * fallback) — home-tab buttons submit no form, so sibling input values only
 * travel via action state.
 */
import { describe, expect, it } from 'vitest';

import { extractInputValue, extractViewState } from './home-events-forward.js';

function rawWith(values: unknown): unknown {
  return { view: { state: { values } } };
}

function rawWithTopLevel(values: unknown): { state: { values: unknown } } {
  return { state: { values } };
}

describe('extractInputValue', () => {
  it('returns the first plain_text_input value from view state', () => {
    const raw = rawWith({
      'home-mem-editor': { 'home:mem:input': { type: 'plain_text_input', value: '# edited memory\n' } },
    });
    expect(extractInputValue(raw)).toBe('# edited memory\n');
  });

  it('reads canonical top-level action state and prefers it over nested view state', () => {
    const raw = {
      ...rawWithTopLevel({
        credentials: { 'home:credential:token:htmlit': { type: 'plain_text_input', value: 'hub_current' } },
      }),
      view: {
        state: {
          values: {
            credentials: { 'home:credential:token:htmlit': { type: 'plain_text_input', value: 'hub_stale' } },
          },
        },
      },
    };
    expect(extractInputValue(raw)).toBe('hub_current');
  });

  it('ignores non-input state and malformed payloads', () => {
    expect(extractInputValue(rawWith({ b: { a: { type: 'static_select', value: 'x' } } }))).toBeUndefined();
    expect(extractInputValue(rawWith({ b: { a: { type: 'plain_text_input', value: 42 } } }))).toBeUndefined();
    expect(extractInputValue({})).toBeUndefined();
    expect(extractInputValue(undefined)).toBeUndefined();
    expect(extractInputValue(rawWith(null))).toBeUndefined();
  });

  it('drops oversized values instead of forwarding them', () => {
    const raw = rawWith({ b: { a: { type: 'plain_text_input', value: 'x'.repeat(70 * 1024) } } });
    expect(extractInputValue(raw)).toBeUndefined();
  });
});

describe('extractViewState', () => {
  it('collects inputs and selects keyed by action_id', () => {
    const raw = {
      view: {
        state: {
          values: {
            b1: { 'home:prov:user': { type: 'static_select', selected_option: { value: 'amit@nanoco.ai' } } },
            b2: { 'home:prov:template': { type: 'static_select', selected_option: { value: 'sdr' } } },
            b3: { 'home-mem-editor-input': { type: 'plain_text_input', value: 'text' } },
          },
        },
      },
    };
    expect(extractViewState(raw)).toEqual({
      'home:prov:user': 'amit@nanoco.ai',
      'home:prov:template': 'sdr',
      'home-mem-editor-input': 'text',
    });
  });

  it('collects canonical top-level action state', () => {
    const raw = rawWithTopLevel({
      credentials: { 'home:credential:token:htmlit': { type: 'plain_text_input', value: 'hub_current' } },
    });
    expect(extractViewState(raw)).toEqual({ 'home:credential:token:htmlit': 'hub_current' });
  });

  it('returns undefined for empty/malformed state and drops oversized maps', () => {
    expect(extractViewState({})).toBeUndefined();
    expect(extractViewState({ view: { state: { values: {} } } })).toBeUndefined();
    const big = {
      view: { state: { values: { b: { a: { type: 'plain_text_input', value: 'x'.repeat(70 * 1024) } } } } },
    };
    expect(extractViewState(big)).toBeUndefined();
  });
});
