/**
 * Term-audit runner — prints one PASS/FAIL/MANUAL matrix row per audited
 * behavior of the code-mode attach experience, measured against the REAL
 * production path (PtySession + AttachServer + attach-client subprocess).
 *
 *   cd container/agent-runner && bun src/code-runner/term-audit/run.ts
 *
 * The matrix is the deliverable: it scopes which fixes the milestone buys.
 * Rows measure observable behavior only, so the same runner reports honestly
 * before and after fixes. The two transport-death modes are separate rows on
 * purpose — closing the read end yields immediate EPIPE on the next beat,
 * while stop-draining buffers indefinitely (a 1-byte NUL beat will not fill
 * a 64KB pipe buffer in any realistic window; detection may NEVER fire
 * locally, which is itself the honest worst-case orphan datum).
 *
 * The kubectl leg (real exec latency, resize coalescing, POC bun version) is
 * explicitly out of local scope — see the notes the matrix prints.
 */
import { resolveHeartbeatMs } from '../attach-client.js';
import { encodeResize } from '../protocol.js';
import { SESSION_TERM_ENV } from '../term-env.js';
import { fmt, Matrix } from './matrix.js';
import {
  type AuditStack,
  type PipeClient,
  rawSocket,
  sleep,
  spawnPipeClient,
  spawnTtyClient,
  startStack,
  waitFor,
} from './harness.js';
import {
  CMD_BULK,
  CMD_SGR,
  CMD_SIZE,
  PROBE_BOOT,
  PROBE_BULK_DONE,
  PROBE_SGR_END,
  SGR_256,
  SGR_TRUECOLOR,
} from './probe.js';

const matrix = new Matrix('term-audit matrix — attach stack');

async function attachPipeClient(stack: AuditStack, env: Record<string, string> = {}): Promise<PipeClient> {
  const client = spawnPipeClient(stack.socketPath, env);
  await waitFor(() => client.output().includes('[attached'), 'the attach banner');
  return client;
}

// ---------------------------------------------------------------------------
// Env verdicts — what production forces into the session (term-env.ts).

function checkEnv(): void {
  matrix.row(
    'env-term',
    SESSION_TERM_ENV.TERM === 'xterm-256color' ? 'PASS' : 'FAIL',
    `TERM=${SESSION_TERM_ENV.TERM ?? 'unset'} (PTY name pins xterm-256color in pty-session.ts)`,
  );
  const colorterm = SESSION_TERM_ENV.COLORTERM;
  matrix.row(
    'env-colorterm',
    colorterm === 'truecolor' ? 'PASS' : 'FAIL',
    colorterm === 'truecolor'
      ? 'COLORTERM=truecolor — TUIs negotiate 24-bit color'
      : `COLORTERM=${colorterm ?? 'unset'} — TUIs downgrade truecolor to 256-color`,
  );
}

// ---------------------------------------------------------------------------
// Byte-path rows on one shared stack, sequential; each row fails alone.

async function checkBytePath(): Promise<void> {
  const stack = await startStack();
  const cleanup: Array<() => void> = [];
  try {
    const client = await attachPipeClient(stack);
    cleanup.push(() => client.kill());
    await waitFor(() => client.output().includes(PROBE_BOOT), 'the probe boot line');

    // Input latency: write→hex-echo round trip through the full real path
    // (client stdin → frame → socket → server → PTY → probe → PTY → server
    // → socket → client stdout). Local bound ~100ms.
    await matrix.attempt('input-latency', async () => {
      const keys = ['q', 'w', 'e', 'r', 't'];
      const timings: number[] = [];
      for (const key of keys) {
        const before = client.rx().length;
        const t0 = performance.now();
        client.write(key);
        await waitFor(() => client.rx().length > before, `echo of '${key}'`);
        timings.push(performance.now() - t0);
      }
      timings.sort((a, b) => a - b);
      const median = timings[Math.floor(timings.length / 2)];
      return [
        median <= 100 ? 'PASS' : 'FAIL',
        `median ${fmt(median)} over ${keys.length} keys (min ${fmt(timings[0])}, max ${fmt(timings[timings.length - 1])}; local bound 100ms)`,
      ];
    });

    // Truecolor / 256-color: the SGR patterns must arrive byte-exact through
    // the raw server→client path.
    await matrix.attempt('sgr-bytes', async () => {
      client.write(CMD_SGR);
      await waitFor(() => client.output().includes(PROBE_SGR_END), 'the SGR pattern');
      const ok = client.output().includes(SGR_TRUECOLOR) && client.output().includes(SGR_256);
      return ok
        ? ['PASS', 'truecolor + 256-color SGR sequences byte-exact through server→client']
        : ['FAIL', 'SGR sequences were altered in transit'];
    });

    // Key passthrough: arrows, ctrl chords, alt/ESC-prefix — byte-exact at
    // the probe. (0x1d is exercised separately: it is the detach key.)
    await matrix.attempt('key-passthrough', async () => {
      const keyBytes = Buffer.from([
        0x1b, 0x5b, 0x41, // up
        0x1b, 0x5b, 0x42, // down
        0x1b, 0x5b, 0x43, // right
        0x1b, 0x5b, 0x44, // left
        0x01, 0x05, 0x17, 0x03, // ctrl-a ctrl-e ctrl-w ctrl-c (raw mode: plain bytes)
        0x1b, 0x62, // alt-b (ESC-prefix)
      ]);
      const before = client.rx().length;
      client.write(keyBytes);
      await waitFor(() => client.rx().subarray(before).includes(keyBytes), 'the key bytes at the probe');
      return ['PASS', 'arrows, ctrl chords, alt/ESC-prefix byte-exact at the child'];
    });

    // Bracketed paste WITHOUT the detach byte: markers + payload intact.
    await matrix.attempt('bracketed-paste-intact', async () => {
      const paste = Buffer.from('\x1b[200~paste-payload-integrity\x1b[201~', 'latin1');
      const before = client.rx().length;
      client.write(paste);
      await waitFor(() => client.rx().subarray(before).includes(paste), 'the paste bytes at the probe');
      return ['PASS', 'ESC[200~…ESC[201~ and payload arrive intact at the child'];
    });

    // Multi-client: both see the stream; either may type.
    await matrix.attempt('multi-client', async () => {
      const second = await attachPipeClient(stack);
      cleanup.push(() => second.kill());
      const before = client.rx().length;
      second.write('z');
      await waitFor(() => client.rx().subarray(before).includes(Buffer.from('z')), "second client's keystroke");
      await waitFor(() => second.output().includes('[rx 7a]'), 'the echo reaching the second client');
      return ['PASS', 'two attachers: both see the stream, both can type'];
    });

    // Resize policy: two raw sockets fight; the kernel winsize (stty, queried
    // via the probe) shows whose write stuck — last resize wins (documented,
    // attach-server.ts). Child NOTIFICATION is a separate row below.
    await matrix.attempt('multi-client-resize', async () => {
      const sockA = await rawSocket(stack.socketPath);
      const sockB = await rawSocket(stack.socketPath);
      cleanup.push(() => sockA.destroy(), () => sockB.destroy());
      sockA.write(encodeResize(81, 21));
      await sleep(50);
      sockB.write(encodeResize(101, 31));
      await sleep(100);
      const before = client.output().length;
      client.write(CMD_SIZE);
      await waitFor(() => client.output().slice(before).includes('stty=['), 'the kernel winsize report');
      const ok = client.output().slice(before).includes('stty=[31 101]');
      return ok
        ? ['PASS', 'last-resize-wins observed at the kernel (documented policy, attach-server.ts)']
        : ['FAIL', `kernel winsize did not follow the last resize: ${client.output().slice(before).match(/stty=\[[^\]]*\]/)?.[0] ?? 'no stty report'}`];
    });

    // Detach key semantics: 0x1d detaches; by design it can NEVER reach the
    // TUI (tmux-style reserved key).
    await matrix.attempt('detach-key-reserved', async () => {
      const throwaway = await attachPipeClient(stack);
      throwaway.write(Buffer.from([0x61, 0x62, 0x1d]));
      const code = await throwaway.exited;
      return [
        code === 0 ? 'PASS' : 'FAIL',
        `Ctrl-] detaches (exit ${code}); by design the byte never reaches the TUI — documented limitation`,
      ];
    });
  } finally {
    for (const fn of cleanup) fn();
    stack.close();
  }
}

// ---------------------------------------------------------------------------
// Paste containing the detach byte 0x1d.

async function checkPasteDetachByte(): Promise<void> {
  const stack = await startStack();
  try {
    await matrix.attempt('paste-with-0x1d', async () => {
      const client = await attachPipeClient(stack);
      await waitFor(() => client.output().includes(PROBE_BOOT), 'the probe boot line');
      const full = Buffer.from('\x1b[200~ab\x1dcd\x1b[201~', 'latin1');
      // Split mid-marker to exercise chunk boundaries.
      client.write(full.subarray(0, 3));
      await sleep(30);
      client.write(full.subarray(3));

      const outcome = await Promise.race([
        client.exited.then((code) => ({ kind: 'exit' as const, code })),
        waitFor(() => client.rx().includes(full), 'the full paste at the probe', 2_500).then(
          () => ({ kind: 'intact' as const }),
          () => ({ kind: 'timeout' as const }),
        ),
      ]);
      if (outcome.kind === 'intact') {
        client.kill();
        return ['PASS', 'a paste containing 0x1d arrives intact — no mid-paste detach'];
      }
      if (outcome.kind === 'exit') {
        return [
          'FAIL',
          `client detached mid-paste (exit ${outcome.code}): splitAtDetachKey scans every chunk, so 0x1d inside pasted bytes detaches and the paste tail is lost`,
        ];
      }
      client.kill();
      return ['FAIL', 'paste bytes never fully arrived (no detach observed either)'];
    });
  } finally {
    stack.close();
  }
}

// ---------------------------------------------------------------------------
// Replay/scrollback.

async function checkReplay(): Promise<void> {
  const stack = await startStack();
  try {
    await matrix.attempt('replay-scrollback', async () => {
      const writer = await attachPipeClient(stack);
      writer.write(CMD_BULK);
      await waitFor(() => writer.output().includes(PROBE_BULK_DONE), 'the bulk emit', 20_000);
      writer.kill();

      const snapshot = stack.session.replay();
      const fresh = await attachPipeClient(stack);
      await waitFor(() => fresh.output().includes(PROBE_BULK_DONE), 'the replayed ring', 20_000);
      const tail = snapshot.subarray(Math.max(0, snapshot.length - 32 * 1024));
      const intact = fresh.bytes().includes(tail);
      fresh.kill();
      return intact
        ? ['PASS', `fresh attach replayed the ring intact (ring ${Math.round(snapshot.length / 1024)}KB, tail-32KB byte-compare)`]
        : ['FAIL', 'replayed bytes did not match the session ring'];
    });
  } finally {
    stack.close();
  }
  matrix.row(
    'replay-visual-mismatch',
    'MANUAL',
    'visual garbling when replaying at a mismatched terminal size needs eyes (or a VT-state parser) — not scriptable here',
  );
}

// ---------------------------------------------------------------------------
// Resize propagation, TTY mode: the full chain, client SIGWINCH → FRAME_RESIZE
// → session.resize → child notification. Kernel truth via the probe's stty.

async function checkTtyResize(): Promise<void> {
  const stack = await startStack();
  const tty = spawnTtyClient(stack.socketPath, { cols: 91, rows: 33 });
  try {
    // Leg 1 — connect-time resize: the client announces its geometry on
    // attach. Kernel truth (interrogated, not notified): the session pty
    // must be 91x33 now.
    await matrix.attempt('resize-connect', async () => {
      await waitFor(() => tty.output().includes('[attached'), 'the TTY attach banner');
      const before = tty.output().length;
      await sleep(200);
      tty.write(CMD_SIZE);
      await waitFor(() => tty.output().slice(before).includes('stty=['), 'the kernel winsize report', 10_000);
      const ok = tty.output().slice(before).includes('stty=[33 91]');
      return ok
        ? ['PASS', 'client connect-resize landed in the session pty (stty=[33 91])']
        : ['FAIL', `connect-time resize did not land: ${tty.output().slice(before).match(/stty=\[[^\]]*\]/)?.[0] ?? 'no stty report'}`];
    });

    // Leg 2 — live resize: operator terminal grows, client gets SIGWINCH,
    // FRAME_RESIZE must carry the NEW geometry into the session pty. The
    // probe reports nothing spontaneously (that is leg 3's subject), so
    // interrogate the kernel until the new size lands or the window closes.
    let liveLanded = false;
    let outputAtResize = 0;
    await matrix.attempt('resize-live', async () => {
      outputAtResize = tty.output().length;
      tty.resize(121, 41);
      let last = 'no stty report';
      for (let i = 0; i < 5; i++) {
        await sleep(300);
        const q = tty.output().length;
        tty.write(CMD_SIZE);
        await waitFor(() => tty.output().slice(q).includes('stty=['), 'the kernel winsize report', 10_000);
        last = tty.output().slice(q).match(/stty=\[[^\]]*\]/)?.[0] ?? last;
        if (last === 'stty=[41 121]') {
          liveLanded = true;
          return ['PASS', 'live resize landed in the session pty (stty=[41 121])'];
        }
      }
      return [
        'FAIL',
        `live resize never landed (kernel still ${last}) — the client's SIGWINCH frame carried nothing or a stale geometry`,
      ];
    });

    // Leg 3 — child notification: the probe must HEAR about the resize
    // (SIGWINCH → PROBE_WINCH), not merely have the kernel winsize changed.
    await matrix.attempt('resize-child-notify', () => {
      if (!liveLanded) return ['FAIL', 'not reached — the live-resize leg failed first'];
      const winched = tty.output().slice(outputAtResize).includes('PROBE_WINCH');
      return winched
        ? ['PASS', 'the child was notified (SIGWINCH → PROBE_WINCH with the new kernel winsize)']
        : [
            'FAIL',
            'kernel winsize changed but the child was never notified: Bun.Terminal children have no controlling terminal, so TIOCSWINSZ has no foreground process group to signal',
          ];
    });
  } finally {
    tty.write(Buffer.from([0x1d])); // detach cleanly
    await Promise.race([tty.exited, sleep(2_000)]);
    tty.kill();
    stack.close();
  }
}

// ---------------------------------------------------------------------------
// Disconnect detection — the ISSUES.md #1 tail. Three independent stacks.

const DISCONNECT_BOUND_MS = 15_000; // the UX bound the milestone buys (≤ ~3×5s beats)

async function checkDisconnectEpipe(): Promise<void> {
  const beat = resolveHeartbeatMs();
  const stack = await startStack();
  try {
    await matrix.attempt('disconnect-epipe-mode', async () => {
      const client = await attachPipeClient(stack);
      await waitFor(() => stack.countEvents.some((e) => e.count === 1), 'the connect stamp');
      const t0 = Date.now();
      client.killReadEnd(); // kubectl/ssh died; read end of the exec stream gone
      const watch = Math.max(2 * beat + 15_000, 30_000);
      try {
        await waitFor(() => stack.countEvents.some((e) => e.count === 0 && e.at >= t0), 'the disconnect stamp', watch);
      } catch {
        client.kill();
        return ['FAIL', `no disconnect detected within ${fmt(watch)} (beat ${fmt(beat)})`];
      }
      const at = stack.countEvents.find((e) => e.count === 0 && e.at >= t0)!.at;
      const ms = at - t0;
      const code = await Promise.race([client.exited, sleep(2_000).then(() => 'still running' as const)]);
      client.kill();
      return [
        ms <= DISCONNECT_BOUND_MS ? 'PASS' : 'FAIL',
        `read end closed → attach-state clients dropped in ${fmt(ms)} (client exit ${String(code)}; beat ${fmt(beat)}; bound ${fmt(DISCONNECT_BOUND_MS)})`,
      ];
    });
  } finally {
    stack.close();
  }
}

async function checkDisconnectBuffered(): Promise<void> {
  const beat = resolveHeartbeatMs();
  const stack = await startStack();
  try {
    await matrix.attempt('disconnect-buffered-mode', async () => {
      const client = await attachPipeClient(stack);
      await waitFor(() => stack.countEvents.some((e) => e.count === 1), 'the connect stamp');
      const t0 = Date.now();
      client.stopDraining(); // transport wedged: bytes buffer, no EOF, no error
      const watch = Math.min(3 * beat + 2_000, 45_000);
      try {
        await waitFor(() => stack.countEvents.some((e) => e.count === 0 && e.at >= t0), 'the disconnect stamp', watch);
      } catch {
        client.kill();
        return [
          'FAIL',
          `no detection within ${fmt(watch)} watch (beat ${fmt(beat)}): 1-byte NUL beats never fill the 64KB pipe buffer — in-container detection is impossible in this mode; the D14 idle lease (30min TTL) is the designed backstop`,
        ];
      }
      const at = stack.countEvents.find((e) => e.count === 0 && e.at >= t0)!.at;
      client.kill();
      return ['PASS', `detected in ${fmt(at - t0)} despite buffering`];
    });
  } finally {
    stack.close();
  }
}

async function checkOrphanSocketSweep(): Promise<void> {
  const beat = resolveHeartbeatMs();
  const stack = await startStack();
  try {
    await matrix.attempt('orphan-socket-sweep', async () => {
      const sock = await rawSocket(stack.socketPath); // a client-shaped socket that never speaks
      await waitFor(() => stack.countEvents.some((e) => e.count === 1), 'the connect stamp');
      const t0 = Date.now();
      const watch = Math.min(4 * beat + 4_000, 45_000);
      try {
        await waitFor(() => stack.countEvents.some((e) => e.count === 0 && e.at >= t0), 'the sweep', watch);
      } catch {
        sock.destroy();
        return [
          'FAIL',
          `a silent client-shaped socket survived ${fmt(watch)}: the server has no liveness of its own — it trusts socket close, so a wedged client holds attach-state.clients up indefinitely`,
        ];
      }
      const at = stack.countEvents.find((e) => e.count === 0 && e.at >= t0)!.at;
      sock.destroy();
      return ['PASS', `a silent socket was swept in ${fmt(at - t0)} (server-side keepalive deadline)`];
    });
  } finally {
    stack.close();
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`term-audit: auditing the real attach path (beat ${fmt(resolveHeartbeatMs())})…`);

  checkEnv();
  await checkBytePath();
  await checkPasteDetachByte();
  await checkReplay();
  await checkTtyResize();
  console.log('  … transport-death rows (watching, this takes a while)');
  await Promise.all([checkDisconnectEpipe(), checkDisconnectBuffered(), checkOrphanSocketSweep()]);

  matrix.note(
    'Ctrl-] (0x1d) is the reserved detach key and never reaches the TUI — tmux-style, by design.',
    'Multi-client resize is last-resize-wins (attach-server.ts); changing that policy is architecture — consult first.',
    'The buffered transport-death mode has no in-container signal at all; the D14 idle lease is the designed backstop.',
    'The harness TTY wrapper substitutes the operator-terminal kernel step for SIGWINCH delivery to the client (Bun.Terminal children have no controlling terminal — a term-audit finding that also affects the SESSION child).',
    'bun refreshes process.stdout.columns/rows lazily around SIGWINCH (stale inside an isolated handler, fresh in the real client under 1.3.14) — the audit reads kernel truth via stty instead of trusting process.stdout geometry.',
    'The kubectl leg (exec-stream latency, resize coalescing, POC bun 1.3.12 vs local 1.3.14) is out of local scope.',
  );

  matrix.print();
  process.exit(0); // the matrix is the deliverable; verdicts speak for themselves
}

main().catch((error) => {
  console.error('term-audit: harness failure:', error);
  process.exit(1);
});
