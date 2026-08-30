/**
 * Deterministic pins for the term-audit findings — the scripted half of the
 * matrix, so the merge train's gate re-checks the fixes without wall-clock
 * flake (run.ts remains the full measured audit).
 */
import { describe, it, expect } from 'bun:test';

import { SESSION_TERM_ENV } from '../term-env.js';
import { auditSessionEnv, rawSocket, sleep, spawnPipeClient, startStack, waitFor } from './harness.js';
import { CMD_SGR, PROBE_SGR_END, SGR_256, SGR_TRUECOLOR } from './probe.js';

// ---------------------------------------------------------------------------
// Env verdicts (matrix rows env-term / env-colorterm).

describe('session terminal env', () => {
  it('forces TERM=xterm-256color and COLORTERM=truecolor into the session', () => {
    // The PTY name pins xterm-256color (pty-session.ts); COLORTERM is what
    // lets TUIs negotiate 24-bit color — without it they downgrade even
    // though the byte path carries truecolor SGR intact (matrix: sgr-bytes).
    expect(SESSION_TERM_ENV.TERM).toBe('xterm-256color');
    expect(SESSION_TERM_ENV.COLORTERM).toBe('truecolor');
  });

  it('the harness env carries the production values, not the dev shell leak', () => {
    const env = auditSessionEnv();
    expect(env.TERM).toBe('xterm-256color');
    expect(env.COLORTERM).toBe('truecolor');
  });
});

// ---------------------------------------------------------------------------
// End-to-end pins over the REAL path: PtySession (Bun.Terminal) + AttachServer
// + the real attach-client subprocess. Generous timeouts, no wall-clock pins.

describe('term-audit end-to-end', () => {
  it(
    'the probe boots with the production env and bytes echo through the whole path',
    async () => {
      const stack = await startStack();
      try {
        const client = spawnPipeClient(stack.socketPath);
        await waitFor(() => client.output().includes('[attached'), 'the attach banner');
        await waitFor(() => client.output().includes('PROBE_BOOT'), 'the probe boot line');
        expect(client.output()).toContain('term=xterm-256color');
        expect(client.output()).toContain('colorterm=truecolor');
        const before = client.rx().length;
        client.write('hello');
        await waitFor(() => client.rx().subarray(before).includes(Buffer.from('hello')), 'the echo');
        client.kill();
      } finally {
        stack.close();
      }
    },
    20_000,
  );

  it(
    'truecolor and 256-color SGR arrive byte-exact at the operator',
    async () => {
      const stack = await startStack();
      try {
        const client = spawnPipeClient(stack.socketPath);
        await waitFor(() => client.output().includes('[attached'), 'the attach banner');
        client.write(CMD_SGR);
        await waitFor(() => client.output().includes(PROBE_SGR_END), 'the SGR pattern');
        expect(client.output()).toContain(SGR_TRUECOLOR);
        expect(client.output()).toContain(SGR_256);
        client.kill();
      } finally {
        stack.close();
      }
    },
    20_000,
  );

  it(
    'a paste containing 0x1d arrives intact and the client stays attached (matrix: paste-with-0x1d)',
    async () => {
      const stack = await startStack();
      try {
        const client = spawnPipeClient(stack.socketPath);
        await waitFor(() => client.output().includes('[attached'), 'the attach banner');
        const paste = Buffer.from('\x1b[200~ab\x1dcd\x1b[201~', 'latin1');
        client.write(paste.subarray(0, 4)); // split mid-marker
        await sleep(30);
        client.write(paste.subarray(4));
        await waitFor(() => client.rx().includes(paste), 'the full paste at the probe');
        // Still attached: a later keystroke still echoes.
        const before = client.rx().length;
        client.write('k');
        await waitFor(() => client.rx().subarray(before).includes(Buffer.from('k')), 'the post-paste echo');
        client.kill();
      } finally {
        stack.close();
      }
    },
    20_000,
  );

  it(
    'transport death (EPIPE mode) surfaces as a disconnect within a few beats (matrix: disconnect-epipe-mode)',
    async () => {
      const stack = await startStack();
      try {
        const client = spawnPipeClient(stack.socketPath, { NANOCLAW_ATTACH_HEARTBEAT_MS: '60' });
        await waitFor(() => stack.countEvents.some((e) => e.count === 1), 'the connect stamp');
        const t0 = Date.now();
        client.killReadEnd();
        await waitFor(() => stack.countEvents.some((e) => e.count === 0 && e.at >= t0), 'the disconnect stamp', 5_000);
        client.kill();
      } finally {
        stack.close();
      }
    },
    20_000,
  );

  it(
    'the sweep retires a silent socket; the pinging real client survives untouched (matrix: orphan-socket-sweep)',
    async () => {
      const stack = await startStack({ serverOptions: { keepaliveDeadlineMs: 400, sweepIntervalMs: 50 } });
      try {
        const client = spawnPipeClient(stack.socketPath, { NANOCLAW_ATTACH_HEARTBEAT_MS: '100' });
        await waitFor(() => client.output().includes('[attached'), 'the attach banner');
        const silent = await rawSocket(stack.socketPath);
        await waitFor(() => stack.server.clientCount === 2, 'both clients connected');
        await waitFor(() => stack.server.clientCount === 1, 'the sweep', 5_000);
        // Only pings have flowed — they must not have stamped human evidence.
        expect(stack.server.lastClientInputAt).toBe(0);
        // The survivor is the pinging client, still fully functional.
        const before = client.rx().length;
        client.write('s');
        await waitFor(() => client.rx().subarray(before).includes(Buffer.from('s')), "the survivor's echo");
        silent.destroy();
        client.kill();
      } finally {
        stack.close();
      }
    },
    20_000,
  );
});
