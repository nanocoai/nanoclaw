import { describe, expect, it } from 'bun:test';
import { mcpInitFailureDiagnostics } from './claude.js';

describe('MCP server init diagnostics', () => {
  it('reports failed, unauthenticated, and pending servers by name', () => {
    expect(
      mcpInitFailureDiagnostics([
        { name: 'healthy', status: 'connected' },
        { name: 'missing-runtime', status: 'failed' },
        { name: 'remote-tools', status: 'needs-auth' },
        { name: 'slow-start', status: 'pending' },
        { name: 'intentionally-off', status: 'disabled' },
      ]),
    ).toEqual([
      'ERROR: MCP server "missing-runtime" is unavailable (status: failed); its tools will not be available',
      'ERROR: MCP server "remote-tools" is unavailable (status: needs-auth); its tools will not be available',
      'ERROR: MCP server "slow-start" is unavailable (status: pending); its tools will not be available',
    ]);
  });

  it('keeps untrusted server names on one bounded log line', () => {
    const longName = `bad\nserver${'x'.repeat(300)}`;
    const [diagnostic] = mcpInitFailureDiagnostics([{ name: longName, status: 'failed' }]);

    expect(diagnostic).not.toContain('\n');
    expect(diagnostic).toContain('bad server');
    expect(diagnostic!.length).toBeLessThan(300);
  });
});
