/**
 * Registration guard for the FXMacroData remote MCP server.
 *
 * The skill registers a bare Streamable HTTP URL with no headers, so the
 * keyless tier works out of the box and an optional API key only ever comes
 * from the credential gateway. Per-group registration is runtime DB state and
 * is verified by the install skill's smoke test; this test runs the exact
 * registration the skill uses through core's own CLI parser and the
 * container.json materializer, so a core change that would reject or reshape
 * it fails here instead of on the user's restart.
 */
import { describe, expect, it } from 'vitest';

import { parseMcpServerConfig, sanitizeStoredMcpServers, validateMcpServerName } from './container-config.js';

const NAME = 'fxmacrodata';
const MCP_URL = 'https://mcp.fxmacrodata.com';

describe('the FXMacroData MCP registration is accepted by core', () => {
  it('uses a valid server name', () => {
    expect(() => validateMcpServerName(NAME)).not.toThrow();
  });

  it('parses as a keyless Streamable HTTP server with no headers', () => {
    const server = parseMcpServerConfig({ url: MCP_URL });
    expect(server).toEqual({ type: 'http', url: MCP_URL });
    expect(server).not.toHaveProperty('headers');
  });

  it('reaches container.json unchanged', () => {
    const stored = { [NAME]: parseMcpServerConfig({ url: MCP_URL }) };
    expect(sanitizeStoredMcpServers(JSON.parse(JSON.stringify(stored)), 'test-group')).toEqual({
      [NAME]: { type: 'http', url: MCP_URL },
    });
  });

  it('rejects a key in the URL, so the key has to go through the gateway', () => {
    expect(() => parseMcpServerConfig({ url: `${MCP_URL}/?api_key=test-key` })).toThrow(/looks like a credential/);
  });
});
