import { describe, expect, it } from 'bun:test';

import { shimCwd } from './cwd-shim.js';

describe('shimCwd', () => {
  it('wraps a cwd-declaring server in a cd-then-exec launch', () => {
    const shimmed = shimCwd({
      command: '/workspace/agent/plugins/sdr/run.js',
      args: ['--flag'],
      env: { A: 'b' },
      cwd: '/workspace/agent/plugin-data/sdr',
    });

    expect(shimmed).toEqual({
      command: '/bin/sh',
      args: [
        '-c',
        'cd "$0" && exec "$@"',
        '/workspace/agent/plugin-data/sdr',
        '/workspace/agent/plugins/sdr/run.js',
        '--flag',
      ],
      env: { A: 'b' },
    });
  });

  it('keeps hostile values positional instead of interpolating them', () => {
    // The script is a fixed constant; hostile strings only ever appear as
    // discrete argv entries after it.
    expect(
      shimCwd({
        command: 'server',
        args: ['$(rm -rf /)', '"; evil'],
        cwd: '/workspace/agent/plugins/p',
      }),
    ).toEqual({
      command: '/bin/sh',
      args: ['-c', 'cd "$0" && exec "$@"', '/workspace/agent/plugins/p', 'server', '$(rm -rf /)', '"; evil'],
    });
  });

  it('passes servers without cwd and http servers through untouched', () => {
    const stdio = { command: 'bun', args: ['run', 'x.ts'] };
    expect(shimCwd(stdio)).toBe(stdio);

    const http = { type: 'http' as const, url: 'https://mcp.example.com/mcp' };
    expect(shimCwd(http)).toBe(http);
  });
});
