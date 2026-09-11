/**
 * The landing — what an approved connection does once it is in.
 *
 * The relayed stream behind the connection's source port says where it is
 * for; the host's own sandbox verbs do the rest: `sandboxes attach` for an
 * existing sandbox (cold ones wake), `sandboxes new` for an account whose
 * default sandbox does not exist yet, and the terminal is handed to the
 * attach program the host composes. `ls` lists the sandboxes instead. There
 * is no shell on this path; detach is tmux's Ctrl-b then d.
 */
import { decideLanding } from './landing-decision.js';
import type { DoorStream } from './target-map.js';

/** The exec spec the host composes for an attach (see cli/attach-exec.ts). */
export interface AttachExec {
  bin: string;
  argsTty: string[];
  argsPlain: string[];
}

export interface SandboxListing {
  names: string[];
  /** The host's rendered table. */
  human: string;
}

/** The host's sandbox verbs as the door calls them; errors carry the verb's own message. */
export interface SandboxVerbs {
  list(): Promise<SandboxListing>;
  attach(name: string): Promise<AttachExec>;
  create(name: string): Promise<AttachExec>;
}

export interface LandingIo {
  write(text: string): void;
  fail(text: string): void;
}

export interface LandingDeps {
  stream: DoorStream | undefined;
  /** The exec command, when the client sent one instead of asking for a shell. */
  command?: string;
  sandboxes: SandboxVerbs;
  io: LandingIo;
  /** Hand the terminal to the attach program; resolves with its exit code. */
  spawn(exec: AttachExec): Promise<number>;
}

export async function runLanding(deps: LandingDeps): Promise<number> {
  const { stream, command, sandboxes, io } = deps;
  // Only an account target (or a listing) needs the sandbox list; no stream
  // and a named sandbox decide without it.
  let listing: SandboxListing | undefined;
  if (stream && (!stream.target.sandbox || command)) {
    try {
      listing = await sandboxes.list();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      io.fail(`The host could not list sandboxes: ${error.message}\n`);
      return 1;
    }
  }
  const decision = decideLanding(stream, listing?.names ?? [], command);
  if (decision.verb === 'refuse') {
    io.fail(`${decision.reason}\n`);
    return decision.code;
  }
  if (decision.verb === 'list') {
    io.write(`${listing?.human ?? ''}\n`);
    return 0;
  }
  io.write(
    decision.verb === 'new'
      ? `Creating sandbox ${decision.name} — detach with Ctrl-b then d.\n`
      : `Attaching to sandbox ${decision.name} — detach with Ctrl-b then d.\n`,
  );
  let exec;
  try {
    exec = decision.verb === 'attach' ? await sandboxes.attach(decision.name) : await sandboxes.create(decision.name);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const text = error.message;
    io.fail(
      `${decision.verb === 'attach' && /^no sandbox /.test(text) ? `sandbox ${decision.name} no longer exists` : text}\n`,
    );
    return 1;
  }
  return deps.spawn(exec);
}
