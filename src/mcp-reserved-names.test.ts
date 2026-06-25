import { describe, expect, it } from 'vitest';

import { isReservedMcpServerName, RESERVED_MCP_SERVER_NAMES } from './mcp-reserved-names.js';

describe('isReservedMcpServerName (host write-path guard)', () => {
  it('reserves the built-in nanoclaw server name', () => {
    expect(isReservedMcpServerName('nanoclaw')).toBe(true);
  });

  it('does not reserve ordinary server names', () => {
    expect(isReservedMcpServerName('board')).toBe(false);
    expect(isReservedMcpServerName('sqlite')).toBe(false);
  });

  it('stays in sync with the container-side reserved set (mirror invariant)', () => {
    // If this drifts from container/agent-runner/src/mcp-server-config.ts RESERVED_MCP_SERVER_NAMES,
    // a name reserved at boot would be accepted at write time (or vice-versa) — keep them equal.
    expect([...RESERVED_MCP_SERVER_NAMES].sort()).toEqual(['nanoclaw']);
  });
});
