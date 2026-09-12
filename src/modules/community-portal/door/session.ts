/**
 * One SSH connection to the door, from authentication to the terminal the
 * session is handed.
 *
 * Authentication: public key only, any username (the account and the
 * relayed stream decide where a connection lands, not the login name; the
 * name is logged). A key the host has not approved is admitted too — into
 * the waiting room, which becomes the landing in the same session once the
 * key is approved. Sessions: a PTY if asked, then `shell` (land) or `exec`
 * (`ls` lists; anything else is refused with usage). The terminal itself is
 * the container runtime's: the attach command runs inside the session's
 * container over the runtime's own exec stream, sized from the client's
 * `pty-req` and every `window-change`. No forwarding of any kind, no
 * subsystems. A revocation ends the session; so does stopping the door.
 * A terminal whose program ended under it — the container retired, the
 * stream torn down — is put back in order and told why before the channel
 * closes (terminal-reset.ts).
 */
import type { ClientInfo, Connection, ServerChannel, Session } from 'ssh2';

import type { SessionExecStream } from '../../../drivers/types.js';
import { fingerprintOf } from './keys.js';
import { runLanding, type AttachTarget, type LandingIo, type SandboxVerbs } from './landing.js';
import type { PendingKeyRequest, PendingKeyResult } from './report.js';
import type { DoorLog } from './server.js';
import { ssh2Loaded } from './ssh2.js';
import type { DoorSource, DoorStream } from './target-map.js';
import { TERMINAL_RESET, terminalEnded } from './terminal-reset.js';
import { runWaitingRoom } from './waiting-room.js';

export type AuthorizeStatus = 'approved' | 'unknown' | 'disabled';

export interface SessionAuthority {
  status(fingerprint: string): AuthorizeStatus;
  openRoom(
    request: { fingerprint: string; keyType: string; publicKey: string },
    source?: DoorSource,
  ): Promise<'ok' | 'limit'>;
  waitForApproval(fingerprint: string, waitMs: number): Promise<boolean>;
  /** Register a way to end this session; returns the unregister. */
  registerSession(fingerprint: string, end: () => void): () => void;
}

export interface SessionDeps {
  authority: SessionAuthority;
  lookupTarget(port: number): DoorStream | undefined;
  pending(request: PendingKeyRequest): Promise<PendingKeyResult>;
  /** The approval page, when the checkout has one. */
  approvalUrl(): string | undefined;
  sandboxes: SandboxVerbs;
  /** Live sessions across the door, for the cap. */
  sessions: { count(): number; track(): () => void };
  maxSessions?: number;
  /** How long a connection may take to authenticate (AUTH_DEADLINE_MS). */
  authDeadlineMs?: number;
  log: DoorLog;
  now?: () => Date;
}

export const MAX_SESSIONS = 8;

/** A connection that has not authenticated by then is ended: no idling on the handshake. */
export const AUTH_DEADLINE_MS = 20_000;

/** How long naming the end of a terminal may wait on the runtime's status. */
const ALIVE_PROBE_MS = 1_000;

interface Identity {
  username: string;
  fingerprint: string;
  keyType: string;
  /** `<type> <base64>` */
  publicKey: string;
}

interface TerminalSize {
  cols: number;
  rows: number;
  term: string;
}

export function handleConnection(client: Connection, info: ClientInfo, deps: SessionDeps): void {
  // The server loaded the library before it accepted this connection.
  const { utils } = ssh2Loaded();
  const from = `${info.ip}:${info.port}`;
  let identity: Identity | undefined;
  // The pre-auth deadline: a client that never gets to `ready` is dropped.
  const deadline = setTimeout(() => {
    deps.log('info', 'Remote terminal connection ended: not authenticated in time', { from });
    client.end();
  }, deps.authDeadlineMs ?? AUTH_DEADLINE_MS);
  client.once('close', () => clearTimeout(deadline));

  client.on('authentication', (ctx) => {
    if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
    const parsed = utils.parseKey(ctx.key.data);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!key || key instanceof Error) return ctx.reject(['publickey']);
    const fingerprint = fingerprintOf(ctx.key.data);
    if (deps.authority.status(fingerprint) === 'disabled') return ctx.reject(['publickey']);
    // Without a signature the client is only asking whether the key would
    // be acceptable; every key is, since the waiting room admits unknown ones.
    if (ctx.signature) {
      if (!ctx.blob || key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
        deps.log('warn', 'Remote terminal key signature rejected', { from, fingerprint });
        return ctx.reject(['publickey']);
      }
    }
    identity = {
      username: ctx.username,
      fingerprint,
      keyType: ctx.key.algo,
      publicKey: `${ctx.key.algo} ${ctx.key.data.toString('base64')}`,
    };
    ctx.accept();
  });

  client.on('ready', () => {
    clearTimeout(deadline);
    if (!identity) return;
    deps.log('info', 'Remote terminal login', {
      from,
      username: identity.username,
      fingerprint: identity.fingerprint,
      status: deps.authority.status(identity.fingerprint),
    });
  });

  client.on('session', (accept) => {
    const session = accept();
    handleSession(session);
  });
  client.on('tcpip', (_accept, reject) => reject());
  client.on('openssh.streamlocal', (_accept, reject) => reject());
  client.on('request', (_accept, reject) => reject?.());

  function handleSession(session: Session): void {
    let size: TerminalSize | undefined;
    let exec: SessionExecStream | undefined;
    let started = false;

    session.on('pty', (accept, _reject, ptyInfo) => {
      size = { cols: ptyInfo.cols, rows: ptyInfo.rows, term: ptyInfo.term };
      accept?.();
    });
    session.on('window-change', (accept, _reject, change) => {
      if (size) size = { ...size, cols: change.cols, rows: change.rows };
      exec?.resize(change.cols, change.rows).catch(() => {});
      accept?.();
    });
    session.on('signal', (accept, reject) => {
      // The runtime's exec has no signal channel; a hang-up ends it (see close).
      if (exec) accept?.();
      else reject?.();
    });
    session.on('env', (_accept, reject) => reject?.());
    session.on('x11', (_accept, reject) => reject?.());
    session.on('auth-agent', (_accept, reject) => reject?.());
    session.on('sftp', (_accept, reject) => reject());
    session.on('subsystem', (_accept, reject) => reject());
    session.on('shell', (accept, reject) => {
      if (started) return reject();
      started = true;
      void run(accept(), undefined);
    });
    session.on('exec', (accept, reject, request) => {
      if (started) return reject();
      started = true;
      void run(accept(), request.command);
    });

    async function run(channel: ServerChannel, command: string | undefined): Promise<void> {
      // Text the door writes itself needs the carriage returns a terminal
      // would add; the attach command's own output already has them.
      const text = (value: string): string => (size ? value.replace(/\r?\n/g, '\r\n') : value);
      const io: LandingIo = {
        write: (value) => void channel.write(text(value)),
        fail: (value) => void channel.stderr.write(text(value)),
      };
      let finished = false;
      let closed = false;
      let untrack: () => void = () => {};
      let unregister: () => void = () => {};
      const finish = (code: number): void => {
        if (finished) return;
        finished = true;
        untrack();
        unregister();
        if (!closed) {
          channel.exit(code);
          channel.end();
        }
      };
      channel.on('close', () => {
        closed = true;
        exec?.close();
        finish(0);
      });

      if (!identity) return finish(1);
      if (deps.sessions.count() >= (deps.maxSessions ?? MAX_SESSIONS)) {
        io.fail('Too many terminal sessions on this machine; try again later.\n');
        return finish(1);
      }
      untrack = deps.sessions.track();
      const { fingerprint } = identity;
      unregister = deps.authority.registerSession(fingerprint, () => {
        // The door hangs the terminal's program up itself here; put the
        // terminal back first so the message lands on a clean screen.
        if (size && exec) channel.write(TERMINAL_RESET);
        io.fail('\nAccess to this machine was revoked.\n');
        exec?.close();
        finish(1);
        client.end();
      });
      const stream = deps.lookupTarget(info.port);

      if (deps.authority.status(fingerprint) !== 'approved') {
        const approvalUrl = deps.approvalUrl();
        const approved = await runWaitingRoom({
          fingerprint,
          keyType: identity.keyType,
          publicKey: identity.publicKey,
          ...(stream?.source ? { source: stream.source } : {}),
          ...(approvalUrl ? { approvalUrl } : {}),
          io,
          closed: () => closed,
          openRoom: (request, source) => deps.authority.openRoom(request, source),
          pending: (request) => deps.pending(request),
          waitForApproval: (fp, ms) => deps.authority.waitForApproval(fp, ms),
          ...(deps.now ? { now: deps.now } : {}),
        });
        if (!approved) return finish(1);
      }

      const code = await runLanding({
        stream,
        ...(command !== undefined ? { command } : {}),
        sandboxes: deps.sandboxes,
        io,
        run: (target) => attach(channel, target, () => !closed && !finished),
      });
      finish(code);
    }

    /**
     * Pump the channel into the attach command's stream inside the container
     * and back. `open` says whether the client is still there to write to
     * once the stream ends.
     */
    async function attach(channel: ServerChannel, target: AttachTarget, open: () => boolean): Promise<number> {
      if (!target.execStream) {
        channel.stderr.write(text("This session's runtime cannot hand over a terminal.\n"));
        return 1;
      }
      // The landing may have waited on a cold sandbox; the client (or its
      // key) may be gone by now. Nothing is started for a connection that
      // already ended.
      if (!open()) return 1;
      let running: SessionExecStream;
      try {
        running = await target.execStream(
          target.command,
          size ? { tty: true, cols: size.cols, rows: size.rows } : { tty: false },
        );
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        deps.log('error', 'Remote terminal could not start the attach command', {
          container: target.containerName,
          err: error,
        });
        channel.stderr.write(text(`The terminal could not be started: ${error.message}\n`));
        return 1;
      }
      // The connection ended (close, revocation) while the exec was being
      // started: hang the exec up instead of leaving it running untracked.
      if (!open()) {
        running.close();
        return 1;
      }
      exec = running;
      running.stdout.on('data', (data: Buffer) => {
        if (!channel.write(data)) {
          running.stdout.pause();
          channel.once('drain', () => running.stdout.resume());
        }
      });
      running.stderr?.on('data', (data: Buffer) => void channel.stderr.write(data));
      // TODO: honour stdin's write() result and pause the channel when the
      // runtime falls behind; today the SSH window (and the link's 64 KiB
      // per-direction window on the relayed path) bounds what can queue here.
      channel.on('data', (data: Buffer) => void running.stdin.write(data));
      // Without a terminal the client's EOF is the command's EOF; a terminal
      // ends when its program does (detach), never on a half-close.
      if (!size) channel.on('eof', () => running.stdin.end());
      let code: number;
      // Why the terminal ended, when that is worth a line: a clean exit is a
      // detach and should look like one. A non-zero end with the runtime
      // gone is the container stopping under the client — say that, not the
      // code of a killed tmux client.
      let reason: string | undefined;
      try {
        code = await running.exited;
        if (code !== 0) {
          reason = target.alive && !(await stillAlive(target.alive)) ? 'container stopped' : `exit code ${code}`;
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        deps.log('warn', 'Remote terminal stream ended without an exit code', {
          container: target.containerName,
          err: error,
        });
        code = 1;
        reason = 'stream closed';
      }
      if (exec === running) exec = undefined;
      // A program restores its terminal on a clean exit; one ended under
      // the client leaves mouse reporting and the rest on. Put the terminal
      // back (and say why, when there is a why) before the channel ends —
      // unless the client left first, in which case there is nobody to
      // write to.
      if (size && open()) channel.write(reason === undefined ? TERMINAL_RESET : terminalEnded(reason));
      return code;

      function text(value: string): string {
        return size ? value.replace(/\r?\n/g, '\r\n') : value;
      }
    }
  }
}

/** The runtime's word on whether it still runs; unknown (late, failed) reads as alive. */
async function stillAlive(alive: () => Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), ALIVE_PROBE_MS);
  });
  try {
    return await Promise.race([alive().catch(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}
