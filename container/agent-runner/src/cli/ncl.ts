#!/usr/bin/env bun
/**
 * ncl — NanoClaw CLI client (container edition).
 *
 * Same interface as the host-side `bin/ncl`. Detects that it's inside a
 * container and uses the registered session mailbox instead of the Unix socket
 * transport.
 *
 * Writes a cli_request system message and polls the same mailbox for the response.
 */
import '../modules/index.js';
import { getAgentMailbox, readMailboxContext } from '../mailbox/index.js';
import type { AgentMailbox } from '../mailbox/types.js';

import { readStdinJsonArgs, StdinJsonInputError } from './stdin-json.js';

// ---------------------------------------------------------------------------
// Frame types (mirrors src/cli/frame.ts on the host)
// ---------------------------------------------------------------------------

type RequestFrame = {
  id: string;
  command: string;
  args: Record<string, unknown>;
};

type ResponseFrame =
  // `human` mirrors src/cli/frame.ts: an optional server-rendered string we
  // print verbatim instead of running our own (drift-prone) formatter.
  | { id: string; ok: true; data: unknown; human?: string }
  | { id: string; ok: false; error: { code: string; message: string } };

// ---------------------------------------------------------------------------
// Mailbox transport
// ---------------------------------------------------------------------------

function generateId(): string {
  return `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Write a cli_request through the registered mailbox.
 */
async function writeRequest(mailbox: AgentMailbox, req: RequestFrame): Promise<void> {
  await mailbox.run(() =>
    mailbox.operations.writeMessageOut({
      id: req.id,
      kind: 'system',
      content: JSON.stringify({
        action: 'cli_request',
        requestId: req.id,
        command: req.command,
        args: req.args,
      }),
    }),
  );
}

/**
 * Poll the mailbox for a cli_response matching our requestId.
 */
async function pollResponse(mailbox: AgentMailbox, requestId: string, timeoutMs: number): Promise<ResponseFrame | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await mailbox.run(() => {
      const row = mailbox.operations.findCliResponse(requestId);
      if (row) {
        mailbox.operations.markMessages([row.id], 'completed');
        return (JSON.parse(row.content) as { frame: ResponseFrame }).frame;
      }
      return null;
    });
    if (response) return response;

    await Bun.sleep(500);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Arg parsing (mirrors src/cli/parse-argv.ts on the host — keep flag handling
// in sync when adding flags there)
// ---------------------------------------------------------------------------

function parseArgv(argv: string[]): {
  command: string;
  args: Record<string, unknown>;
  json: boolean;
  stdinJson: boolean;
} {
  const positional: string[] = [];
  const args: Record<string, unknown> = {};
  let json = false;
  let stdinJson = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--stdin-json') {
      stdinJson = true;
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
      continue;
    }
    positional.push(a);
  }

  if (positional.length === 0) {
    process.stderr.write('ncl: missing command\n');
    printUsage();
    process.exit(2);
  }

  // Join all positionals with dashes. The dispatcher trims the last
  // segment as a target ID if the full name isn't a registered command.
  const command = positional.join('-');

  return { command, args, json, stdinJson };
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: ncl <command> [--key value ...] [--stdin-json] [--json]',
      '',
      '  --stdin-json  Read one bounded JSON object from stdin and merge it with argv flags.',
      '',
      'Run `ncl help` to list available commands.',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Formatting (mirrors src/cli/format.ts on the host)
// ---------------------------------------------------------------------------

// Mirrors localizeIsoTimestamps in src/cli/format.ts (self-contained — no
// imports from agent-runner). Human display shows local time (container TZ
// env = install timezone); --json keeps the ISO machine contract. Only whole
// ISO-instant strings convert — embedded occurrences may be machine payloads.
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

// "YYYY-MM-DD HH:mm" — round-trips through parseZonedToUtc (naive = local
// wall-clock), so a value copied from human output into --process-after
// means what it shows.
function localTime(iso: string): string {
  return new Date(iso).toLocaleString('sv-SE', {
    timeZone: process.env.TZ || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function localizeIsoTimestamps(value: unknown): unknown {
  if (typeof value === 'string') {
    return ISO_UTC_RE.test(value) ? localTime(value) : value;
  }
  if (Array.isArray(value)) return value.map(localizeIsoTimestamps);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, localizeIsoTimestamps(v)]),
    );
  }
  return value;
}

function formatHuman(resp: ResponseFrame): string {
  if (!resp.ok) {
    return `error (${resp.error.code}): ${resp.error.message}\n`;
  }

  const data = localizeIsoTimestamps(resp.data);
  if (!Array.isArray(data) || data.length === 0) {
    return JSON.stringify(data, null, 2) + '\n';
  }

  const isFlat = data.every(
    (r) =>
      typeof r === 'object' &&
      r !== null &&
      !Array.isArray(r) &&
      Object.values(r as Record<string, unknown>).every((v) => typeof v !== 'object' || v === null),
  );

  if (!isFlat) return JSON.stringify(data, null, 2) + '\n';

  const keys = Object.keys(data[0] as Record<string, unknown>);
  const widths = keys.map((k) =>
    Math.max(k.length, ...data.map((r) => String((r as Record<string, unknown>)[k] ?? '').length)),
  );

  const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const rows = data.map((r) =>
    keys
      .map((k, i) => String((r as Record<string, unknown>)[k] ?? '').padEnd(widths[i]))
      .join('  '),
  );

  return [header, sep, ...rows, ''].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printUsage();
    return;
  }

  const { command, args, json, stdinJson } = parseArgv(argv);
  let requestArgs = args;
  if (stdinJson) {
    if (process.stdin.isTTY) {
      // Reading a TTY would silently block until the user types Ctrl-D.
      process.stderr.write('ncl: --stdin-json requires piped stdin (e.g. `echo {...} | ncl ...`)\n');
      process.exitCode = 2;
      return;
    }
    try {
      requestArgs = await readStdinJsonArgs(process.stdin, args);
    } catch (err) {
      if (!(err instanceof StdinJsonInputError)) throw err;
      process.stderr.write(`ncl: ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
  }

  const context = await readMailboxContext();
  const mailbox = getAgentMailbox();
  await mailbox.start(context);
  try {
    const requestId = generateId();
    await writeRequest(mailbox, { id: requestId, command, args: requestArgs });
    const resp = await pollResponse(mailbox, requestId, 30_000);

    if (!resp) {
      process.stderr.write('ncl: command timed out after 30s\n');
      process.exitCode = 2;
      return;
    }

    if (json) {
      process.stdout.write(JSON.stringify(resp, null, 2) + '\n');
    } else if (resp.ok && resp.human !== undefined) {
      process.stdout.write(resp.human + '\n');
    } else {
      const output = formatHuman(resp);
      if (!resp.ok) {
        process.stderr.write(output);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(output);
    }
  } finally {
    await mailbox.stop();
  }
}

main().catch((err) => {
  process.stderr.write(`ncl: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
