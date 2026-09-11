/**
 * One SSH connection to the door, from authentication to the program the
 * terminal is handed to.
 *
 * Authentication: public key only, any username (the account and the
 * relayed stream decide where a connection lands, not the login name). A
 * key the host has not approved is admitted too — into the waiting room,
 * which becomes the landing in the same session once the key is approved.
 * Sessions: a PTY if asked, then `shell` (land) or `exec` (`ls` lists;
 * anything else is refused with usage). No forwarding of any kind, no
 * subsystems. A revocation ends the session; so does stopping the door.
 */
import ssh2, { type ClientInfo, type Connection, type ServerChannel, type Session } from 'ssh2';

import { fingerprintOf } from './keys.js';
import { runLanding, type AttachExec, type LandingIo, type SandboxVerbs } from './landing.js';
import { spawnPlain, spawnPty, type SpawnSpec, type TerminalProgram, type TerminalSize } from './pty.js';
import type { PendingKeyRequest, PendingKeyResult } from './report.js';
import type { DoorLog } from './server.js';
import type { DoorSource, DoorStream } from './target-map.js';
import { runWaitingRoom } from './waiting-room.js';

const { utils } = ssh2;

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
  approvalUrl(): string;
  sandboxes: SandboxVerbs;
  /** Live sessions across the door, for the cap. */
  sessions: { count(): number; track(): () => void };
  maxSessions?: number;
  log: DoorLog;
  env?: NodeJS.ProcessEnv;
  spawnPty?: typeof spawnPty;
  spawnPlain?: typeof spawnPlain;
  now?: () => Date;
}

export const MAX_SESSIONS = 8;

interface Identity {
  username: string;
  fingerprint: string;
  keyType: string;
  /** `<type> <base64>` */
  publicKey: string;
}

export function handleConnection(client: Connection, info: ClientInfo, deps: SessionDeps): void {
  const from = `${info.ip}:${info.port}`;
  let identity: Identity | undefined;

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
    let program: TerminalProgram | undefined;
    let started = false;

    session.on('pty', (accept, _reject, ptyInfo) => {
      size = { cols: ptyInfo.cols, rows: ptyInfo.rows, term: ptyInfo.term };
      accept?.();
    });
    session.on('window-change', (accept, _reject, change) => {
      if (size) size = { ...size, cols: change.cols, rows: change.rows };
      program?.resize(change.cols, change.rows);
      accept?.();
    });
    session.on('signal', (accept, _reject, signal) => {
      program?.kill(`SIG${signal.name}` as NodeJS.Signals);
      accept?.();
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
    session.on('exec', (accept, reject, exec) => {
      if (started) return reject();
      started = true;
      void run(accept(), exec.command);
    });

    async function run(channel: ServerChannel, command: string | undefined): Promise<void> {
      // Text the door writes itself needs the carriage returns a terminal
      // would add; a program's own output already has them.
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
        program?.kill('SIGHUP');
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
        io.fail('\nAccess to this machine was revoked.\n');
        program?.kill('SIGHUP');
        finish(1);
        client.end();
      });
      const stream = deps.lookupTarget(info.port);

      if (deps.authority.status(fingerprint) !== 'approved') {
        const approved = await runWaitingRoom({
          fingerprint,
          keyType: identity.keyType,
          publicKey: identity.publicKey,
          ...(stream?.source ? { source: stream.source } : {}),
          approvalUrl: deps.approvalUrl(),
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
        spawn: (exec) => runProgram(channel, exec),
      });
      finish(code);
    }

    async function runProgram(channel: ServerChannel, exec: AttachExec): Promise<number> {
      const spec: SpawnSpec = {
        bin: exec.bin,
        args: size ? exec.argsTty : exec.argsPlain,
        env: deps.env ?? process.env,
      };
      try {
        program = size ? await (deps.spawnPty ?? spawnPty)(spec, size) : (deps.spawnPlain ?? spawnPlain)(spec);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        deps.log('error', 'Remote terminal could not start the attach program', { err: error });
        channel.stderr.write(`The terminal could not be started: ${error.message}\r\n`);
        return 1;
      }
      const running = program;
      return new Promise<number>((resolve) => {
        running.onData((data) => {
          if (!channel.write(data)) {
            running.pause();
            channel.once('drain', () => running.resume());
          }
        });
        running.onStderr((data) => void channel.stderr.write(data));
        channel.on('data', (data: Buffer) => running.write(data));
        channel.on('eof', () => running.end());
        running.onExit((code) => {
          if (program === running) program = undefined;
          resolve(code);
        });
      });
    }
  }
}
