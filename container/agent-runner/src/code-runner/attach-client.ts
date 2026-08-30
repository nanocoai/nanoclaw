/**
 * Attach client — the process the host execs into the container to reach
 * the code runner's PTY (sandbox-spec D20, D22).
 *
 *   docker exec -it <container> bun /app/src/code-runner/attach-client.ts
 *
 * Pure pipe: socket bytes → stdout raw; stdin → data frames, with Ctrl-]
 * intercepted locally as the detach key. Detaching never disturbs the
 * session — the PTY and the agent inside it keep running (D2/D14).
 * No PTY here: this end only needs raw stdin and a socket.
 */
import net from 'net';

import { DetachKeyScanner, encodeData, encodeDetach, encodePing, encodeResize, resolveHeartbeatMs } from './protocol.js';
import { ATTACH_SOCKET_PATH } from './attach-server.js';

// The keepalive cadence lives in protocol.ts now (the server's sweep deadline
// shares it); re-exported here so the client's public surface is unchanged.
export { DEFAULT_HEARTBEAT_MS, resolveHeartbeatMs } from './protocol.js';

// Exit codes — distinct on purpose, so the exec wrapper (and an operator's
// scripts) can tell a deliberate detach from everything that is not one:
//   0 — local detach (Ctrl-] or stdin EOF); the session keeps running.
//   1 — no attach socket here (not a code-mode container / never came up);
//       only ever BEFORE a successful attach.
//   2 — the session went away under us (stopped or restarted), whether we
//       saw a clean server EOF or a mid-attach socket error.
//   3 — the exec transport itself died under us (kubectl/ssh gone).
export const EXIT_DETACH = 0;
export const EXIT_NO_SOCKET = 1;
export const EXIT_SERVER_CLOSED = 2;
export const EXIT_TRANSPORT_ERROR = 3;

/**
 * Where a unix-socket error lands in the exit-code contract. Pure and pinned
 * by tests, because a real socket cannot drive the post-connect branch
 * deterministically (EOF and EPIPE race when the server dies).
 *
 *  - 'retry': never connected and the socket just is not there yet (D13 lazy
 *    spawn) — try again while the connect window is open.
 *  - EXIT_SERVER_CLOSED: the error hit AFTER a successful attach. That is the
 *    session dying under us — a kill mid-keystroke surfaces as EPIPE or
 *    ECONNRESET on the write instead of a clean EOF, but it is the same lost
 *    session; exiting EXIT_NO_SOCKET here would tell an operator's script the
 *    box "was never a code-mode container".
 *  - EXIT_NO_SOCKET: never connected and out of window, or a non-retryable
 *    connect failure — there is no attach socket to reach.
 */
export function classifyAttachSocketError(
  connected: boolean,
  code: string | undefined,
  withinConnectWindow: boolean,
): 'retry' | typeof EXIT_SERVER_CLOSED | typeof EXIT_NO_SOCKET {
  if (connected) return EXIT_SERVER_CLOSED;
  const retryable = code === 'ENOENT' || code === 'ECONNREFUSED';
  return retryable && withinConnectWindow ? 'retry' : EXIT_NO_SOCKET;
}

/*
 * Transport heartbeat (cadence: protocol.ts DEFAULT_HEARTBEAT_MS): each beat
 * does two jobs in two directions.
 *
 * OUTBOUND, a single NUL byte down stdout: VT terminals discard NUL, so the
 * operator never sees it — but the byte traverses container → kubelet →
 * apiserver → kubectl, resetting every idle timer on the way (the kubelet's
 * streamingConnectionIdleTimeout defaults to 4h and NOTHING else pings the
 * exec stream under a silently-watching attach). It also converts a dead
 * transport into a prompt, HANDLED EPIPE on the next beat, instead of an
 * uncaught crash whenever the next PTY byte happens to echo (measured: a
 * mailbox injection echo was the first write into a long-dead `kubectl
 * exec`, and it took the client down).
 *
 * INBOUND-to-server, a FRAME_PING down the socket: proves this client
 * PROCESS is alive so the server's sweep can drop wedged/orphaned holders
 * (attach-server.ts). Liveness custody: the NUL never enters the attach
 * socket, and FRAME_PING is machine chatter the server explicitly refuses
 * to count as attach evidence — neither can touch lastClientInputAt /
 * lastClientConnectAt / lastInjectionAt, the only attach-shaped evidence
 * decideLiveness counts (liveness.ts). An orphaned exec still loses its
 * lease at the idle TTL; the beat cannot recreate cycle 1's orphan-exec
 * immortality.
 */

const CONNECT_RETRY_MS = 300;
const CONNECT_WINDOW_MS = 15_000;

export function main(argv: string[] = process.argv): void {
  const socketPath = argv[2] || ATTACH_SOCKET_PATH;

  const stdin = process.stdin;
  const stdout = process.stdout;
  const isTty = stdin.isTTY === true;

  function restore(): void {
    if (isTty) stdin.setRawMode(false);
  }

  // The socket binds slightly after container start, so a lazily-spawned
  // session (D13) briefly has no socket to reach: retry the connect for a
  // bounded window before declaring this a non-code-mode container.
  const connectDeadline = Date.now() + CONNECT_WINDOW_MS;
  let waitingNoteShown = false;

  // stdin listeners live in main(), registered once: a retry must not
  // drop an 'end' or a keystroke that fires between attempts (a scripted pipe
  // drains during the connect-retry window — its bytes must reach the session,
  // not the void, or a piped attach "succeeds" having delivered nothing).
  let activeSocket: net.Socket | null = null;
  let stdinEnded = false;
  let localDetach = false;
  const pendingInput: Buffer[] = [];

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  function stopHeartbeat(): void {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  // The exec transport can die without the unix socket noticing: kubectl
  // killed, the ssh session carrying it dropped, the runtime shim's pipe
  // closed. Without these handlers the next stdout/stdin byte is an
  // UNCAUGHT EPIPE crash; with them a dead transport is what it is — a
  // lost connection, not a detach (0) and not a server close (2).
  function onTransportError(error: NodeJS.ErrnoException): void {
    stopHeartbeat();
    restore();
    // stdout may BE the dead pipe — the honest notice goes to stderr.
    process.stderr.write(`\r\n[connection lost (transport error: ${error.message})]\r\n`);
    process.exit(EXIT_TRANSPORT_ERROR);
  }
  stdout.on('error', onTransportError);
  stdin.on('error', onTransportError);
  // Some exec shims close the container-side fds outright instead of (or
  // before) surfacing an error — same dead transport, same exit. stdin's
  // close is only transport death when no clean EOF preceded it: a piped
  // stdin legitimately closes after 'end', and that path is a detach (0).
  function onTransportClose(what: string): void {
    stopHeartbeat();
    restore();
    process.stderr.write(`\r\n[connection lost (${what} closed)]\r\n`);
    process.exit(EXIT_TRANSPORT_ERROR);
  }
  stdout.on('close', () => onTransportClose('stdout'));
  stdin.on('close', () => {
    if (!stdinEnded) onTransportClose('stdin');
  });

  // Paste-aware: 0x1d inside a bracketed-paste region is data, not a detach
  // (protocol.ts DetachKeyScanner). One scanner for the whole stdin stream —
  // pre-connect buffered chunks replay through it in order, so markers split
  // across chunks (or across the connect boundary) still track.
  const detachScanner = new DetachKeyScanner();

  function forward(socket: net.Socket, chunk: Buffer): void {
    const { data, detach } = detachScanner.scan(chunk);
    if (data.length > 0) socket.write(encodeData(data));
    if (detach) {
      localDetach = true;
      socket.write(encodeDetach());
      socket.end();
    }
  }

  stdin.on('data', (chunk: Buffer) => {
    if (activeSocket) forward(activeSocket, chunk);
    else pendingInput.push(chunk); // replayed on connect, detach-key intact
  });

  stdin.on('end', () => {
    // Non-TTY pipe closed (e.g. scripted input) — detach cleanly, but only
    // after any buffered input has been forwarded (see 'connect').
    stdinEnded = true;
    if (activeSocket) {
      localDetach = true;
      activeSocket.write(encodeDetach());
      activeSocket.end();
    }
  });

  function connect(): void {
    const socket = net.createConnection(socketPath);

    socket.on('connect', () => {
      activeSocket = socket;
      stdout.write('[attached — Ctrl-] to detach]\r\n');
      // The two-direction beat while connected — see the heartbeat comment
      // above. The ping stops with a detach in flight: a write after end()
      // would misread our own detach as a lost session.
      heartbeat = setInterval(() => {
        stdout.write('\0');
        if (!localDetach && socket.writable) socket.write(encodePing());
      }, resolveHeartbeatMs());
      if (isTty) {
        stdin.setRawMode(true);
        socket.write(encodeResize(stdout.columns || 120, stdout.rows || 32));
        process.on('SIGWINCH', () => {
          socket.write(encodeResize(stdout.columns || 120, stdout.rows || 32));
        });
      }
      stdin.resume();
      // Input that arrived while the session was still coming up (D13 lazy
      // spawn) replays first, then a closed pipe's detach. A detach key inside
      // the buffer ends the socket — stop replaying into it.
      while (pendingInput.length > 0 && !localDetach) forward(socket, pendingInput.shift()!);
      if (stdinEnded && !localDetach) {
        localDetach = true;
        socket.write(encodeDetach());
        socket.end();
      }
    });

    socket.on('data', (chunk) => {
      stdout.write(chunk);
    });

    socket.on('close', (hadError) => {
      if (hadError) return; // the error handler owns the exit path
      stopHeartbeat();
      restore();
      if (localDetach || stdinEnded) {
        stdout.write('\r\n[detached — session keeps running]\r\n');
        process.exit(EXIT_DETACH);
      }
      // The SERVER closed on us: the session was stopped or restarted, which
      // is not a detach — do not report one.
      stdout.write('\r\n[connection closed by the session — it may have been stopped or restarted]\r\n');
      process.exit(EXIT_SERVER_CLOSED);
    });

    socket.on('error', (error: NodeJS.ErrnoException) => {
      const outcome = classifyAttachSocketError(
        socket === activeSocket,
        error.code,
        Date.now() < connectDeadline,
      );
      if (outcome === 'retry') {
        if (!waitingNoteShown) {
          waitingNoteShown = true;
          stdout.write('[waiting for the session to come up…]\r\n');
        }
        setTimeout(connect, CONNECT_RETRY_MS);
        return;
      }
      stopHeartbeat();
      restore();
      if (outcome === EXIT_SERVER_CLOSED) {
        console.error(`attach: connection to the session lost (${error.message}) — it may have been stopped or restarted`);
      } else if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
        console.error('attach: no code-runner socket here — is this a code-mode agent container?');
      } else {
        console.error(`attach: ${error.message}`);
      }
      process.exit(outcome);
    });
  }

  connect();
}

// Guarded so the module is importable (tests pin the exit-code contract and
// the heartbeat) without hijacking the importer's stdin.
if (import.meta.main) main();
