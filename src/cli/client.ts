/**
 * `ncl` binary entry point.
 *
 * Parses argv, builds a request frame, sends it via the picked transport,
 * formats the response, exits non-zero on error.
 *
 * Usage:
 *   ncl <resource> <verb> [target] [--key value ...] [--stdin-json] [--json]
 *
 * Examples:
 *   ncl groups list
 *   ncl groups get abc123
 *   ncl groups create --name foo --folder bar
 *   ncl groups update abc123 --name baz
 *   ncl help
 *   ncl groups help
 */
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';

import { resolveAttachExec } from './attach-exec.js';
import { formatResponse } from './format.js';
import type { RequestFrame } from './frame.js';
import { parseArgv } from './parse-argv.js';
import { SocketTransport } from './socket-client.js';
import { resolveApproverBindingStdin } from '../nanoco/approver-binding-stdin.js';
import { resolveCreateSpecStdin } from './stdin.js';
import { readStdinJsonArgs, StdinJsonInputError } from './stdin-json.js';
import type { Transport } from './transport.js';
import { formatTransportError } from './transport-errors.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  const { command, args, json, stdinJson } = parseArgv(argv);
  await resolveApproverBindingStdin(command, args);
  await resolveCreateSpecStdin(command, args);
  if (command.length === 0) {
    process.stderr.write('ncl: missing command\n');
    printUsage();
    process.exit(2);
  }

  let requestArgs = args;
  if (stdinJson) {
    if (process.stdin.isTTY) {
      // Reading a TTY would silently block until the user types Ctrl-D.
      process.stderr.write('ncl: --stdin-json requires piped stdin (e.g. `echo {...} | ncl ...`)\n');
      process.exit(2);
    }
    try {
      requestArgs = await readStdinJsonArgs(process.stdin, args);
    } catch (err) {
      if (!(err instanceof StdinJsonInputError)) throw err;
      process.stderr.write(`ncl: ${err.message}\n`);
      process.exit(2);
    }
  }
  // Stdin is only a client-side encoding for args. The daemon receives the
  // same stable request frame it would receive if every value came from argv.
  const req: RequestFrame = { id: randomUUID(), command, args: requestArgs };
  const transport: Transport = pickTransport();

  let res;
  try {
    res = await transport.sendFrame(req);
  } catch (e) {
    process.stderr.write(formatTransportError(e));
    process.exit(2);
  }

  // Attach responses hand the terminal over instead of printing: the server
  // decided which container and which entry (policy); this client owns the
  // TTY, so the interactive exec has to happen here (`ncl groups attach`).
  const attach = resolveAttachExec(res, json, process.stdin.isTTY === true);
  if (attach) {
    const result = spawnSync(attach.bin, attach.args, { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  }

  const output =
    !json && res.ok && res.human !== undefined
      ? res.human + '\n' // server-rendered view — print verbatim
      : formatResponse(res, json ? 'json' : 'human');
  // Exit only after stdout drains: process.exit() discards buffered pipe
  // writes, silently truncating any response past the 64KB pipe buffer
  // (bit `ncl sessions list --json` at scale).
  process.stdout.write(output, () => process.exit(res.ok ? 0 : 1));
}

function pickTransport(): Transport {
  return new SocketTransport();
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: ncl <resource> <verb> [target] [--key value ...] [--stdin-json] [--json]',
      '',
      '  --stdin-json  Read one bounded JSON object from stdin and merge it with argv flags.',
      '',
      'Run `ncl help` to list available resources and commands.',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`ncl: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
