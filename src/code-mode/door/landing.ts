/**
 * The landing program — the forced command an approved key runs.
 *
 * Reads its client port from `SSH_CONNECTION`, asks the host over the door
 * socket what the relayed stream is for, registers itself so a revocation
 * can end it, then attaches through the host's own sandbox verbs over the
 * ncl socket: `sandboxes attach` for an existing sandbox (cold ones wake),
 * `sandboxes new` for an account whose default sandbox does not exist yet.
 * The exec spec the host returns is run with the terminal handed over,
 * exactly as the ncl client does. Detach is tmux's Ctrl-b then d; there is
 * no shell on this path. `ssh <address> ls` lists the sandboxes instead.
 */
import { resolveAttachExec } from '../../cli/attach-exec.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { fetchTarget, postSession } from './door-client.js';
import { runForeground } from './foreground.js';
import { sendHostFrame } from './host-client.js';
import type { SessionRequest } from './host-socket.js';
import { decideLanding } from './landing-decision.js';
import { doorFiles, isMainModule } from './paths.js';
import { readDoorState } from './state.js';
import type { DoorStream } from './target-map.js';

export interface LandingIo {
  env: NodeJS.ProcessEnv;
  pid: number;
  stdinIsTty: boolean;
  write: (text: string) => void;
  fail: (text: string) => void;
  exec: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number> | number;
  fetchTarget: (socketPath: string, port: number) => Promise<DoorStream | undefined>;
  postSession: (socketPath: string, request: SessionRequest) => Promise<void>;
  sendFrame: (socketPath: string, command: string, args: Record<string, unknown>) => Promise<ResponseFrame>;
}

/** `SSH_CONNECTION` is `<client ip> <client port> <server ip> <server port>`. */
export function clientPortFromSshConnection(value: string | undefined): number | undefined {
  const fields = (value ?? '').trim().split(/\s+/);
  const port = Number(fields[1]);
  return fields.length >= 4 && Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function parsePreset(json: string | undefined): DoorStream | undefined {
  if (!json) return undefined;
  const stream = JSON.parse(json) as DoorStream;
  return typeof stream?.target?.account === 'string' ? stream : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runLanding(argv: string[], io: LandingIo): Promise<number> {
  const [doorDir, fingerprint, presetJson] = argv;
  if (!doorDir || !fingerprint) {
    io.fail('landing: usage: landing <doorDir> <fingerprint> [<stream json>]\n');
    return 2;
  }
  const state = await readDoorState(doorFiles(doorDir).state);
  if (!state?.enabled) {
    io.fail('Remote access is disabled on this machine.\n');
    return 1;
  }

  // The waiting room resolves the stream when the connection arrives and
  // hands it over, so a long approval wait cannot outlive the map's TTL.
  const port = clientPortFromSshConnection(io.env.SSH_CONNECTION);
  let stream = parsePreset(presetJson);
  if (!stream && port !== undefined) {
    try {
      stream = await io.fetchTarget(state.hostSocketPath, port);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      io.fail(`Could not resolve this connection's target: ${error.message}\n`);
      return 1;
    }
  }
  if (stream) {
    // Best effort: lets a revocation end this session. Never worth refusing over.
    await io.postSession(state.hostSocketPath, { pid: io.pid, fingerprint, ...(port ? { port } : {}) }).catch(() => {});
  }
  const original = io.env.SSH_ORIGINAL_COMMAND;
  let response: ResponseFrame;
  try {
    // Only an account target (or a listing) needs the host's sandbox list;
    // no stream and a named sandbox decide without contacting the host.
    let list: ResponseFrame | undefined;
    if (stream && (!stream.target.sandbox || original)) {
      list = await io.sendFrame(state.socketPath, 'sandboxes-list', {});
    }
    const existing =
      list?.ok && Array.isArray(list.data)
        ? list.data.map((row) => String((row as { sandbox?: unknown }).sandbox ?? ''))
        : [];
    const decision = decideLanding(stream, existing, original);
    if (decision.verb === 'refuse') {
      io.fail(`${decision.reason}\n`);
      return decision.code;
    }
    if (decision.verb === 'list') {
      if (!list?.ok) {
        io.fail(`${list ? list.error.message : 'The host did not answer.'}\n`);
        return 1;
      }
      io.write(`${list.human ?? JSON.stringify(list.data, null, 2)}\n`);
      return 0;
    }
    io.write(
      decision.verb === 'new'
        ? `Creating sandbox ${decision.name} — detach with Ctrl-b then d.\n`
        : `Attaching to sandbox ${decision.name} — detach with Ctrl-b then d.\n`,
    );
    response = await io.sendFrame(
      state.socketPath,
      `sandboxes-${decision.verb}`,
      decision.verb === 'attach' ? { id: decision.name } : { name: decision.name },
    );
    if (!response.ok && decision.verb === 'attach' && /^no sandbox /.test(response.error.message)) {
      io.fail(`sandbox ${decision.name} no longer exists\n`);
      return 1;
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    io.fail(`The host is not reachable: ${error.message}\n`);
    return 1;
  }
  const attach = resolveAttachExec(response, false, io.stdinIsTty);
  if (!attach) {
    io.fail(`${response.ok ? 'The host did not return a terminal to attach.' : response.error.message}\n`);
    return 1;
  }
  // The server hands its children a minimal PATH; the attach argv names the
  // container runtime by bare command, so the host's PATH is restored.
  return io.exec(attach.bin, attach.args, { ...io.env, PATH: state.path || io.env.PATH || '' });
}

if (isMainModule(import.meta.url)) {
  runLanding(process.argv.slice(2), {
    env: process.env,
    pid: process.pid,
    stdinIsTty: process.stdin.isTTY === true,
    write: (text) => process.stdout.write(text),
    fail: (text) => process.stderr.write(text),
    exec: (bin, args, env) => runForeground(bin, args, env),
    fetchTarget: (socketPath, port) => fetchTarget(socketPath, port),
    postSession: (socketPath, request) => postSession(socketPath, request),
    sendFrame: (socketPath, command, args) => sendHostFrame(socketPath, command, args),
  }).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`landing: ${message(error)}\n`);
      process.exit(1);
    },
  );
}
