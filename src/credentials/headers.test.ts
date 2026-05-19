import { describe, expect, it } from 'vitest';
import {
  NANOCLAW_HEADER_AGENT_GROUP,
  NANOCLAW_HEADER_RUNTIME_PROVIDER,
  NANOCLAW_HEADER_MODEL_PROVIDER,
  NANOCLAW_HEADER_MODEL,
  NANOCLAW_INTERNAL_HEADERS,
  stripNanoclawHeaders,
} from './headers.js';

describe('nanoclaw internal headers', () => {
  it('exposes stable constant names', () => {
    expect(NANOCLAW_HEADER_AGENT_GROUP).toBe('x-nanoclaw-agent-group');
    expect(NANOCLAW_HEADER_RUNTIME_PROVIDER).toBe('x-nanoclaw-runtime-provider');
    expect(NANOCLAW_HEADER_MODEL_PROVIDER).toBe('x-nanoclaw-model-provider');
    expect(NANOCLAW_HEADER_MODEL).toBe('x-nanoclaw-model');
  });

  it('NANOCLAW_INTERNAL_HEADERS lists every internal header', () => {
    expect(NANOCLAW_INTERNAL_HEADERS).toEqual([
      NANOCLAW_HEADER_AGENT_GROUP,
      NANOCLAW_HEADER_RUNTIME_PROVIDER,
      NANOCLAW_HEADER_MODEL_PROVIDER,
      NANOCLAW_HEADER_MODEL,
    ]);
  });

  it('stripNanoclawHeaders removes only internal headers, case-insensitively', () => {
    const incoming = {
      'X-Nanoclaw-Agent-Group': 'group-1',
      'x-nanoclaw-runtime-provider': 'codex',
      authorization: 'Bearer secret',
      'content-type': 'application/json',
    };

    const stripped = stripNanoclawHeaders(incoming);

    expect(stripped).toEqual({
      authorization: 'Bearer secret',
      'content-type': 'application/json',
    });
  });

  it('stripNanoclawHeaders is non-mutating', () => {
    const incoming = { 'x-nanoclaw-agent-group': 'g1', authorization: 'b' };
    const copy = { ...incoming };
    stripNanoclawHeaders(incoming);
    expect(incoming).toEqual(copy);
  });
});
