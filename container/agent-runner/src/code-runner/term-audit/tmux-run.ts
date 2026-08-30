/**
 * Term-audit runner, tmux leg — the SAME 18 matrix rows as run.ts, measured
 * against the tmux terminal mode (TmuxSession + a real `tmux attach` client),
 * printed identically so the parity comparison is row-name to row-name.
 *
 *   cd container/agent-runner && bun src/code-runner/term-audit/tmux-run.ts
 *
 * Oracles differ where the physics differ, deliberately:
 *  - Input-direction rows read the probe's PROBE_LOG side-channel, not the
 *    client stream: what a tmux client shows is a RENDERING (the redraw may
 *    split any text with cursor motion), so "bytes reached the child" must be
 *    proven off-screen. Output-direction rows (SGR fidelity, replay) still
 *    read the operator-visible stream — the screen IS their subject.
 *  - The client is always TTY-shaped: tmux refuses to attach without one, so
 *    there is no pipes-mode leg. The wrapper substitutes the operator
 *    terminal's kernel SIGWINCH step exactly as run.ts's TTY wrapper does.
 *  - Detach semantics invert by design: the prefix chord (C-b d) detaches and
 *    the prefix never reaches the TUI; 0x1d is an ordinary byte again.
 */
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { resolveHeartbeatMs } from '../attach-client.js';
import { TmuxEvidence } from '../tmux-evidence.js';
import { TmuxSession } from '../tmux-session.js';
import { auditSessionEnv, rxBytes, sleep, waitFor } from './harness.js';
import { fmt, Matrix } from './matrix.js';
import {
  CMD_BULK,
  CMD_PASTE_ON,
  CMD_SGR,
  CMD_SIZE,
  PROBE_BOOT,
  PROBE_BULK_DONE,
  PROBE_PASTE_ON,
  PROBE_SGR_END,
  PROBE_WINCH,
  SGR_256,
  SGR_TRUECOLOR,
} from './probe.js';

const PROBE_PATH = path.join(import.meta.dir, 'probe.ts');
const matrix = new Matrix('term-audit matrix — tmux terminal mode');

interface TmuxStack {
  session: TmuxSession;
  evidence: TmuxEvidence;
  socketPath: string;
  log(): string;
  rx(): Buffer;
  /** Literal text through the pane's stdin server-side (no client needed). */
  type(text: string): Promise<void>;
  tmux(args: string[]): Promise<{ exitCode: number; stdout: string }>;
  close(): void;
}

async function startTmuxStack(): Promise<TmuxStack> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-term-audit-tmux-'));
  const socketPath = path.join(dir, 'tmux.sock');
  const logPath = path.join(dir, 'probe.log');
  const session = new TmuxSession({
    command: process.execPath,
    args: [PROBE_PATH],
    cwd: dir,
    env: auditSessionEnv({ PROBE_LOG: logPath }),
    socketPath,
    confPath: path.join(dir, 'tmux.conf'),
    pollMs: 200,
  });
  await session.start();
  const evidence = new TmuxEvidence({ socketPath, pollMs: 200 });
  evidence.start();

  const log = () => {
    try {
      return fs.readFileSync(logPath, 'utf8');
    } catch {
      return '';
    }
  };
  const tmux = async (args: string[]) => {
    const proc = Bun.spawn(['tmux', '-S', socketPath, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { exitCode, stdout };
  };
  await waitFor(() => log().includes(PROBE_BOOT), 'the probe boot line in the log');
  return {
    session,
    evidence,
    socketPath,
    log,
    rx: () => rxBytes(log()),
    type: async (text) => {
      await tmux(['send-keys', '-t', 'agent', '-l', text]);
    },
    tmux,
    close() {
      evidence.stop();
      session.dispose();
    },
  };
}

interface TmuxTtyClient {
  write(data: Buffer | string): void;
  resize(cols: number, rows: number): void;
  output(): string;
  exited: Promise<number>;
  kill(): void;
}

/** A real `tmux attach` under a harness-owned Bun.Terminal — the operator's
 * terminal, with the same kernel-SIGWINCH substitution run.ts documents. */
function spawnTmuxClient(socketPath: string, opts: { cols?: number; rows?: number } = {}): TmuxTtyClient {
  const out: Buffer[] = [];
  const terminal = new Bun.Terminal({
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 40,
    name: 'xterm-256color',
    data(_t, chunk) {
      out.push(Buffer.from(chunk));
    },
  });
  // Mirrors the production attach argv (cli/attach-resolve.ts): the exec
  // transport forwards neither TERM nor the locale, so the client restores
  // the color floor and forces UTF-8 itself.
  const proc = Bun.spawn(['env', 'TERM=xterm-256color', 'tmux', '-u', '-S', socketPath, 'attach-session', '-t', 'agent'], {
    terminal,
    env: { ...process.env, TERM: 'xterm-256color' },
    onExit() {
      if (!terminal.closed) terminal.close();
    },
  });
  return {
    write: (data) => void terminal.write(data),
    resize: (cols, rows) => {
      terminal.resize(cols, rows);
      try {
        proc.kill('SIGWINCH');
      } catch {
        // client already exited
      }
    },
    output: () => Buffer.concat(out).toString('latin1'),
    exited: proc.exited,
    kill: () => proc.kill(),
  };
}

/** Client bookkeeping: rows attach and drop clients in sequence, and the
 * evidence poll observes with a lag — every transition waits for the count
 * to SETTLE at the expected value or the next row reasons over a stale one
 * (the first audit run failed four rows on exactly that race). */
let liveClients = 0;

async function attachClient(stack: TmuxStack, opts: { cols?: number; rows?: number } = {}): Promise<TmuxTtyClient> {
  await waitFor(() => stack.evidence.clientCount === liveClients, 'client counts to settle before attach');
  const client = spawnTmuxClient(stack.socketPath, opts);
  liveClients++;
  await waitFor(() => stack.evidence.clientCount === liveClients, 'the tmux client to register');
  // Let the initial redraw land before rows start reasoning about output.
  await sleep(300);
  return client;
}

/** Kill (or confirm an already-exited) client and wait for tmux to drop it. */
async function dropClient(stack: TmuxStack, client: TmuxTtyClient): Promise<void> {
  client.kill();
  liveClients--;
  await waitFor(() => stack.evidence.clientCount === liveClients, 'the client to drop', 10_000);
}

// ---------------------------------------------------------------------------

async function checkEnv(stack: TmuxStack): Promise<void> {
  const boot = stack.log().match(/PROBE_BOOT term=(\S+) colorterm=(\S+)/);
  const locale = stack.log().match(/PROBE_BOOT .*lang=(\S+)/);
  matrix.row(
    'env-locale',
    locale?.[1]?.toLowerCase().includes('utf-8') ? 'PASS' : 'FAIL',
    `pane LANG=${locale?.[1] ?? 'unset'} — tmux decides UTF-8 from the locale, and a raw PTY never needed one`,
  );
  matrix.row(
    'env-term',
    boot?.[1] === 'xterm-256color' ? 'PASS' : 'FAIL',
    `pane TERM=${boot?.[1] ?? 'unreadable'} (tmux default-terminal, tmux-session.ts conf)`,
  );
  matrix.row(
    'env-colorterm',
    boot?.[2] === 'truecolor' ? 'PASS' : 'FAIL',
    boot?.[2] === 'truecolor'
      ? 'COLORTERM=truecolor inherited through the tmux server env'
      : `COLORTERM=${boot?.[2] ?? 'unset'} in the pane`,
  );
}

async function checkBytePath(stack: TmuxStack): Promise<void> {
  const client = await attachClient(stack);
  try {
    // The row the first live POC attach earned: a raw PTY passes bytes
    // through, but tmux parses and re-renders them, so a missing locale
    // silently downgrades BOTH server and client to non-UTF-8 and every
    // filled block / box-drawing glyph lands as wrong-width junk. Assert the
    // negotiated mode, not the intent.
    await matrix.attempt('utf8-mode', async () => {
      const clients = await stack.tmux(['list-clients', '-F', '#{client_utf8} #{client_termname}']);
      const rows = clients.stdout.trim().split('\n').filter(Boolean);
      const allUtf8 = rows.length > 0 && rows.every((r) => r.startsWith('1 '));
      const all256 = rows.every((r) => r.includes('256color'));
      return [
        allUtf8 && all256 ? 'PASS' : 'FAIL',
        `client(s): ${rows.join(' | ') || 'none'} — utf8 must be 1 (else filled shapes garble) and termname 256color (else no truecolor to the operator)`,
      ];
    });

    // Copy must reach the OPERATOR's clipboard, not a container-private
    // buffer: tmux's default set-clipboard=external leaves mouse selection
    // stranded in the pod (measured on the POC — "highlighting to copy"
    // silently did nothing). The proof is the OSC 52 escape appearing in the
    // client's own byte stream, since that is what rides the exec transport
    // and ssh home.
    await matrix.attempt('copy-to-operator-clipboard', async () => {
      const before = client.output().length;
      await stack.tmux(['copy-mode', '-t', 'agent']);
      await stack.tmux(['send-keys', '-X', '-t', 'agent', 'begin-selection']);
      for (let i = 0; i < 5; i++) await stack.tmux(['send-keys', '-X', '-t', 'agent', 'cursor-right']);
      await stack.tmux(['send-keys', '-X', '-t', 'agent', 'copy-selection-and-cancel']);
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !client.output().slice(before).includes('\x1b]52;')) await sleep(50);
      const seen = client.output().slice(before).includes('\x1b]52;');
      const setting = (await stack.tmux(['show', '-gv', 'set-clipboard'])).stdout.trim();
      return seen
        ? ['PASS', `tmux emitted OSC 52 to the client (set-clipboard=${setting}) — selection lands in the operator's clipboard`]
        : [
            'FAIL',
            `no OSC 52 in the client stream (set-clipboard=${setting}) — copy stays in the pod's tmux buffer`,
          ];
    });

    await matrix.attempt('input-latency', async () => {
      const keys = ['q', 'w', 'e', 'r', 't'];
      const timings: number[] = [];
      for (const key of keys) {
        const before = stack.rx().length;
        const t0 = performance.now();
        client.write(key);
        await waitFor(() => stack.rx().length > before, `echo of '${key}'`);
        timings.push(performance.now() - t0);
      }
      timings.sort((a, b) => a - b);
      const median = timings[Math.floor(timings.length / 2)];
      return [
        median <= 100 ? 'PASS' : 'FAIL',
        `median ${fmt(median)} over ${keys.length} keys (min ${fmt(timings[0])}, max ${fmt(timings[timings.length - 1])}; local bound 100ms)`,
      ];
    });

    await matrix.attempt('sgr-bytes', async () => {
      const before = client.output().length;
      client.write(CMD_SGR);
      await waitFor(() => stack.log().includes(PROBE_SGR_END), 'the SGR pattern at the probe');
      await sleep(300); // let the render reach the client
      const seen = client.output().slice(before);
      if (seen.includes(SGR_TRUECOLOR) && seen.includes(SGR_256)) {
        return ['PASS', 'truecolor + 256-color SGR byte-exact at the operator terminal'];
      }
      // tmux re-encodes SGR from its own screen model; the row's subject is
      // color FIDELITY at the operator, so exact params anywhere count —
      // and a miss on the exact sequence with params intact is re-encoding,
      // not loss.
      const truecolorParams = seen.includes('38;2;10;20;30') && seen.includes('48;2;200;100;50');
      const c256Params = seen.includes('38;5;196') && seen.includes('48;5;24');
      return truecolorParams && c256Params
        ? ['PASS', 'SGR re-encoded by tmux with 24-bit and 256-color parameters intact (RGB terminal-override active)']
        : ['FAIL', `color parameters lost in tmux transit (truecolor=${truecolorParams} 256=${c256Params})`];
    });

    await matrix.attempt('key-passthrough', async () => {
      const keyBytes = Buffer.from([
        0x1b, 0x5b, 0x41, // up
        0x1b, 0x5b, 0x42, // down
        0x1b, 0x5b, 0x43, // right
        0x1b, 0x5b, 0x44, // left
        0x01, 0x05, 0x17, 0x03, // ctrl-a ctrl-e ctrl-w ctrl-c (no 0x02 — that is tmux's prefix, reserved by design)
        0x1b, 0x62, // alt-b (ESC-prefix)
      ]);
      const before = stack.rx().length;
      client.write(keyBytes);
      await waitFor(() => stack.rx().subarray(before).includes(keyBytes), 'the key bytes at the probe');
      return ['PASS', 'arrows, ctrl chords, alt/ESC-prefix byte-exact at the child (0x02 is the reserved prefix instead of 0x1d)'];
    });

    await matrix.attempt('bracketed-paste-intact', async () => {
      // Production-faithful: the TUI (claude) enables bracketed paste, so the
      // pane requests it and tmux re-wraps operator pastes with the markers.
      const before = stack.rx().length;
      client.write(CMD_PASTE_ON);
      await waitFor(() => stack.log().includes(PROBE_PASTE_ON), 'the pane to enable bracketed paste');
      await sleep(200);
      const paste = Buffer.from('\x1b[200~paste-payload-integrity\x1b[201~', 'latin1');
      client.write(paste);
      await waitFor(
        () => stack.rx().subarray(before).toString('latin1').includes('paste-payload-integrity'),
        'the paste payload at the probe',
      );
      const got = stack.rx().subarray(before).toString('latin1');
      const markers = got.includes('\x1b[200~') && got.includes('\x1b[201~');
      return markers
        ? ['PASS', 'markers + payload intact at the child (pane in paste mode; tmux re-wraps)']
        : ['FAIL', 'payload arrived but the paste markers were stripped despite the pane requesting 2004'];
    });

    await matrix.attempt('multi-client', async () => {
      const second = await attachClient(stack);
      try {
        const beforeRx = stack.rx().length;
        const beforeOut = client.output().length;
        second.write('z');
        await waitFor(() => stack.rx().subarray(beforeRx).includes(Buffer.from('z')), "second client's keystroke");
        await waitFor(() => client.output().length > beforeOut, "the first client's view to advance");
        return ['PASS', 'two attachers: both see the stream, both can type (tmux native)'];
      } finally {
        await dropClient(stack, second);
      }
    });

    await matrix.attempt('multi-client-resize', async () => {
      // tmux's documented policy is window-size latest: the most recently
      // active client's geometry wins — same "last wins" family as the
      // attach server's last-resize-wins. The status line takes one row, so
      // a client at RxC gives the pane (R-1)xC.
      const second = await attachClient(stack, { cols: 81, rows: 21 });
      let dropped = false;
      try {
        const q1 = stack.log().length;
        await stack.type(CMD_SIZE);
        await waitFor(() => stack.log().slice(q1).includes('stty=['), 'the kernel winsize report');
        const afterSecond = stack.log().slice(q1).match(/stty=\[[^\]]*\]/)?.[0];
        await dropClient(stack, second);
        dropped = true;
        client.resize(101, 31);
        await sleep(400);
        const q2 = stack.log().length;
        await stack.type(CMD_SIZE);
        await waitFor(() => stack.log().slice(q2).includes('stty=['), 'the kernel winsize report');
        const afterResize = stack.log().slice(q2).match(/stty=\[[^\]]*\]/)?.[0];
        return afterSecond === 'stty=[21 81]' && afterResize === 'stty=[31 101]'
          ? ['PASS', `latest-active client wins (${afterSecond} → ${afterResize}; window-size latest; pane = the client's FULL geometry — no status bar steals a row)`]
          : ['FAIL', `geometry did not follow the latest client (${afterSecond ?? '?'} → ${afterResize ?? '?'})`];
      } finally {
        if (!dropped) await dropClient(stack, second);
      }
    });

    await matrix.attempt('detach-key-reserved', async () => {
      const throwaway = await attachClient(stack);
      // 0x1d is an ordinary byte now — prove it passes through first.
      const before = stack.rx().length;
      throwaway.write(Buffer.from([0x1d]));
      await waitFor(() => stack.rx().subarray(before).includes(Buffer.from([0x1d])), '0x1d at the probe');
      // The reserved chord is the prefix: C-b d detaches; C-b never reaches the TUI.
      throwaway.write(Buffer.from([0x02, 0x64]));
      const code = await Promise.race([throwaway.exited, sleep(5_000).then(() => -1)]);
      liveClients--;
      if (code === -1) throwaway.kill();
      await waitFor(() => stack.evidence.clientCount === liveClients, 'the detached client to drop', 10_000);
      return [
        code === 0 ? 'PASS' : 'FAIL',
        `C-b d detaches (exit ${code}); 0x1d passes through to the TUI — the reserved key moved to tmux's prefix, by design`,
      ];
    });
  } finally {
    await dropClient(stack, client);
  }
}

async function checkPasteDetachByte(stack: TmuxStack): Promise<void> {
  await matrix.attempt('paste-with-0x1d', async () => {
    const client = await attachClient(stack);
    try {
      const before = stack.rx().length;
      const full = Buffer.from('\x1b[200~ab\x1dcd\x1b[201~', 'latin1');
      client.write(full.subarray(0, 3));
      await sleep(30);
      client.write(full.subarray(3));
      await waitFor(
        () => stack.rx().subarray(before).toString('latin1').includes('ab\x1dcd'),
        'the full paste (0x1d included) at the probe',
      );
      return ['PASS', 'a paste containing 0x1d arrives intact — no reserved byte inside the stream anymore'];
    } finally {
      await dropClient(stack, client);
    }
  });
}

async function checkReplay(stack: TmuxStack): Promise<void> {
  await matrix.attempt('replay-scrollback', async () => {
    const writer = await attachClient(stack);
    writer.write(CMD_BULK);
    await waitFor(() => stack.log().includes(PROBE_BULK_DONE), 'the bulk emit', 20_000);
    await dropClient(stack, writer);

    const fresh = await attachClient(stack);
    try {
      await waitFor(() => fresh.output().includes(PROBE_BULK_DONE), 'the redrawn screen tail', 10_000);
      // Depth: the pane's history (capture-pane over the whole scrollback)
      // must still hold the START of the bulk emit — tmux's history-limit is
      // the ring buffer's successor.
      const captured = await stack.tmux(['capture-pane', '-p', '-t', 'agent', '-S', '-']);
      const depth = captured.stdout.includes('bulk-000000');
      return depth
        ? ['PASS', 'fresh attach redraws the live screen; full bulk history present in tmux scrollback (capture-pane from line 0)']
        : ['FAIL', 'the scrollback lost the head of the bulk emit (history-limit too small for the ring the attach stack kept)'];
    } finally {
      await dropClient(stack, fresh);
    }
  });
  matrix.row(
    'replay-visual-mismatch',
    'MANUAL',
    'tmux redraws every attach from its own screen model at the client geometry — the mismatch class the ring replay had should be structurally gone; confirm by eye once live',
  );
}

async function checkTtyResize(stack: TmuxStack): Promise<void> {
  const tty = await attachClient(stack, { cols: 91, rows: 33 });
  try {
    await matrix.attempt('resize-connect', async () => {
      await sleep(300);
      const q = stack.log().length;
      await stack.type(CMD_SIZE);
      await waitFor(() => stack.log().slice(q).includes('stty=['), 'the kernel winsize report', 10_000);
      const got = stack.log().slice(q).match(/stty=\[[^\]]*\]/)?.[0];
      // status off: the pane is the client's full geometry, no row lost.
      return got === 'stty=[33 91]'
        ? ['PASS', 'client geometry landed in the pane pty on attach (stty=[33 91] — the full 91x33, no status bar)']
        : ['FAIL', `connect-time size did not land: ${got ?? 'no stty report'}`];
    });

    let liveLanded = false;
    let logAtResize = 0;
    await matrix.attempt('resize-live', async () => {
      logAtResize = stack.log().length;
      tty.resize(121, 41);
      let last = 'no stty report';
      for (let i = 0; i < 5; i++) {
        await sleep(300);
        const q = stack.log().length;
        await stack.type(CMD_SIZE);
        await waitFor(() => stack.log().slice(q).includes('stty=['), 'the kernel winsize report', 10_000);
        last = stack.log().slice(q).match(/stty=\[[^\]]*\]/)?.[0] ?? last;
        if (last === 'stty=[41 121]') {
          liveLanded = true;
          return ['PASS', 'live resize landed in the pane pty (stty=[41 121] — the full client geometry)'];
        }
      }
      return ['FAIL', `live resize never landed (kernel still ${last})`];
    });

    await matrix.attempt('resize-child-notify', () => {
      if (!liveLanded) return ['FAIL', 'not reached — the live-resize leg failed first'];
      const winched = stack.log().slice(logAtResize).includes(PROBE_WINCH);
      return winched
        ? ['PASS', 'the child was notified natively (pane pty is a real controlling terminal — SIGWINCH → PROBE_WINCH)']
        : ['FAIL', 'pane winsize changed but the child never heard SIGWINCH'];
    });
  } finally {
    tty.write(Buffer.from([0x02, 0x64])); // C-b d — detach cleanly
    await Promise.race([tty.exited, sleep(2_000)]);
    await dropClient(stack, tty); // kill is a no-op on an exited client
  }
}

const DISCONNECT_BOUND_MS = 15_000;

async function checkDisconnect(stack: TmuxStack): Promise<void> {
  await matrix.attempt('disconnect-epipe-mode', async () => {
    const client = await attachClient(stack);
    const t0 = Date.now();
    client.kill(); // the exec transport died; the in-pod tmux client dies with its tty
    liveClients--;
    await waitFor(() => stack.evidence.clientCount === liveClients, 'the disconnect', 30_000);
    const ms = Date.now() - t0;
    return [
      ms <= DISCONNECT_BOUND_MS ? 'PASS' : 'FAIL',
      `client death → tmux dropped it in ${fmt(ms)} (server-native; evidence poll 200ms; bound ${fmt(DISCONNECT_BOUND_MS)})`,
    ];
  });

  matrix.row(
    'disconnect-buffered-mode',
    'MANUAL',
    'a wedged-but-open exec stream blocks the in-pod tmux client on its tty writes; tmux buffers per-client server-side and the D14 idle lease stays the designed backstop — not reproducible under the auto-draining Bun.Terminal wrapper; physics differ from the NUL-beat pipe, verify on the kubectl leg',
  );

  await matrix.attempt('orphan-socket-sweep', async () => {
    const sock = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(stack.socketPath);
      s.on('data', () => {});
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    try {
      await sleep(2_000);
      return stack.evidence.clientCount === 0
        ? ['PASS', 'a silent client-shaped socket never becomes a tmux client — no sweep needed, the protocol handshake is the gate']
        : ['FAIL', 'a silent socket registered as a client'];
    } finally {
      sock.destroy();
    }
  });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`term-audit (tmux): auditing the tmux terminal mode (attach beat ${fmt(resolveHeartbeatMs())} for reference)…`);
  const stack = await startTmuxStack();
  try {
    await checkEnv(stack);
    await checkBytePath(stack);
    await checkPasteDetachByte(stack);
    await checkReplay(stack);
    await checkTtyResize(stack);
    await checkDisconnect(stack);
  } finally {
    stack.close();
  }

  matrix.note(
    'The reserved key moved: C-b (the tmux prefix) never reaches the TUI, C-b d detaches; 0x1d passes through — the attach stack had it inverted.',
    "Multi-client geometry is tmux's window-size latest (latest active client wins) — the same last-wins family as the attach server's policy.",
    'The buffered transport-death mode has different physics under tmux (blocked client tty vs an undrained pipe); the D14 idle lease remains the designed backstop either way — verify on the kubectl leg.',
    'The harness TTY wrapper substitutes the operator-terminal kernel step for SIGWINCH delivery to the tmux CLIENT; everything from the client inward is real.',
    'The kubectl leg (exec-stream latency, resize coalescing, POC bun/tmux versions) is out of local scope, exactly as in run.ts.',
  );
  matrix.print();
  process.exit(0);
}

main().catch((error) => {
  console.error('term-audit (tmux): harness failure:', error);
  process.exit(1);
});
