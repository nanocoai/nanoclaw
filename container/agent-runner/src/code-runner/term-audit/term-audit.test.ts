/** Terminal behavior through the production tmux server and client. */
import { describe, expect, test } from 'bun:test';
import { SESSION_TERM_ENV } from '../term-env.js';
import {
  auditSessionEnv,
  sleep,
  spawnTmuxClient,
  startTmuxStack,
  waitFor,
  type TmuxStack,
  type TmuxTtyClient,
} from './harness.js';
import { CMD_PASTE_ON, CMD_SGR, CMD_SIZE, PROBE_PASTE_ON, PROBE_SGR_END, PROBE_WINCH } from './probe.js';

test('the terminal audit uses the session environment', () => {
  expect(SESSION_TERM_ENV.TERM).toBe('xterm-256color');
  expect(SESSION_TERM_ENV.COLORTERM).toBe('truecolor');
  expect(auditSessionEnv()).toMatchObject(SESSION_TERM_ENV);
});

async function withTerminal(fn: (stack: TmuxStack, client: TmuxTtyClient) => Promise<void>): Promise<void> {
  const stack = await startTmuxStack();
  const client = spawnTmuxClient(stack.socketPath, { cols: 100, rows: 40 });
  try {
    await waitFor(() => stack.evidence.clientCount === 1, 'the tmux client');
    await fn(stack, client);
  } finally {
    client.kill();
    stack.close();
  }
}

describe.if(Bun.which('tmux') !== null)('tmux terminal integration', () => {
  test('round-trips input and preserves truecolor output', async () => {
    await withTerminal(async (stack, client) => {
      expect(stack.log()).toContain('term=xterm-256color');
      expect(stack.log()).toContain('colorterm=truecolor');
      client.write('hello');
      await waitFor(() => stack.rx().includes(Buffer.from('hello')), 'typed input at the probe');
      client.write(CMD_SGR);
      await waitFor(() => client.output().includes(PROBE_SGR_END), 'the color pattern');
      // tmux may combine SGR sequences while preserving every color value.
      for (const color of ['38;2;10;20;30', '48;2;200;100;50', '38;5;196', '48;5;24']) {
        expect(client.output()).toContain(color);
      }
    });
  }, 20_000);

  test('a paste containing Ctrl-] reaches the process without detaching', async () => {
    await withTerminal(async (stack, client) => {
      await stack.type(CMD_PASTE_ON);
      await waitFor(() => stack.log().includes(PROBE_PASTE_ON), 'bracketed paste support');
      await sleep(100);
      const paste = Buffer.from('\x1b[200~ab\x1dcd\x1b[201~', 'latin1');
      client.write(paste);
      await waitFor(() => stack.rx().includes(paste), 'the complete paste');
      expect(stack.evidence.clientCount).toBe(1);
    });
  }, 20_000);

  test('detach keeps the session and another client alive, and reattach sees the existing screen', async () => {
    await withTerminal(async (stack, first) => {
      const second = spawnTmuxClient(stack.socketPath);
      const screenMarker = Buffer.from('retained-screen').toString('hex');
      let third: TmuxTtyClient | undefined;
      try {
        await waitFor(() => stack.evidence.clientCount === 2, 'two clients');
        first.write('retained-screen');
        await waitFor(() => second.output().includes(screenMarker), 'output on the second client');
        first.write(Buffer.from([0x02, 0x64]));
        expect(await first.exited).toBe(0);
        await waitFor(() => stack.evidence.clientCount === 1, 'one remaining client');
        expect(stack.session.running).toBe(true);
        third = spawnTmuxClient(stack.socketPath);
        await waitFor(() => third!.output().includes(screenMarker), 'redraw on reattach');
        second.write('still-live');
        await waitFor(() => stack.rx().includes(Buffer.from('still-live')), 'input from the remaining client');
      } finally {
        second.kill();
        third?.kill();
      }
    });
  }, 20_000);

  test('resize updates the process terminal and delivers SIGWINCH', async () => {
    await withTerminal(async (stack, client) => {
      const before = stack.log().length;
      client.resize(121, 41);
      await waitFor(() => stack.log().slice(before).includes(PROBE_WINCH), 'the child resize signal');
      await stack.type(CMD_SIZE);
      await waitFor(() => stack.log().slice(before).includes('stty=[41 121]'), 'the child terminal geometry');
    });
  }, 20_000);

  test('client death clears human presence and leaves the session running', async () => {
    await withTerminal(async (stack, client) => {
      client.kill();
      await client.exited;
      await waitFor(() => stack.evidence.clientCount === 0, 'presence to clear');
      expect(stack.evidence.attachedClientActivityAt).toBeUndefined();
      expect(stack.session.running).toBe(true);
    });
  }, 20_000);
});
