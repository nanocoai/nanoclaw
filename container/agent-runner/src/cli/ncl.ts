#!/usr/bin/env bun
/**
 * ncl — NanoClaw CLI client (container edition).
 *
 * Same interface as the host-side `bin/ncl`. Detects that it's inside a
 * container (the session DBs exist at /workspace/) and uses a DB transport
 * instead of the Unix socket transport.
 *
 * Writes a cli_request system message to outbound.db, polls inbound.db
 * for the response. Self-contained — no imports from agent-runner.
 */
import { Database } from 'bun:sqlite';

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
// Paths
// ---------------------------------------------------------------------------

const INBOUND_DB = '/workspace/inbound.db';
const OUTBOUND_DB = '/workspace/outbound.db';

// ---------------------------------------------------------------------------
// DB transport
// ---------------------------------------------------------------------------

function generateId(): string {
  return `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Write a cli_request to outbound.db.
 *
 * Uses BEGIN IMMEDIATE to acquire a write lock before reading max(seq),
 * preventing seq collisions with concurrent agent-runner writes.
 */
function writeRequest(req: RequestFrame): void {
  const db = new Database(OUTBOUND_DB);
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA busy_timeout = 5000');

  const inDb = new Database(INBOUND_DB, { readonly: true });
  inDb.exec('PRAGMA busy_timeout = 5000');

  try {
    db.exec('BEGIN IMMEDIATE');
    const maxOut = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
    const maxIn = (inDb.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
    const max = Math.max(maxOut, maxIn);
    const nextSeq = max % 2 === 0 ? max + 1 : max + 2;

    db.prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, content)
       VALUES ($id, $seq, $timestamp, 'system', $content)`,
    ).run({
      $id: req.id,
      $seq: nextSeq,
      $timestamp: new Date().toISOString(),
      $content: JSON.stringify({
        action: 'cli_request',
        requestId: req.id,
        command: req.command,
        args: req.args,
      }),
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    inDb.close();
    db.close();
  }
}

/**
 * Poll inbound.db for a cli_response matching our requestId.
 * Opens a fresh connection each poll (mmap_size=0) for cross-mount visibility.
 */
function pollResponse(requestId: string, timeoutMs: number): ResponseFrame | null {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const inDb = new Database(INBOUND_DB, { readonly: true });
    inDb.exec('PRAGMA busy_timeout = 5000');
    inDb.exec('PRAGMA mmap_size = 0');

    try {
      const row = inDb
        .prepare("SELECT id, content FROM messages_in WHERE status = 'pending' AND content LIKE ?")
        .get(`%"requestId":"${requestId}"%`) as { id: string; content: string } | null;

      if (row) {
        // Mark as completed via processing_ack so agent-runner skips it
        const outDb = new Database(OUTBOUND_DB);
        outDb.exec('PRAGMA journal_mode = DELETE');
        outDb.exec('PRAGMA busy_timeout = 5000');
        outDb
          .prepare(
            "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'completed', ?)",
          )
          .run(row.id, new Date().toISOString());
        outDb.close();

        const parsed = JSON.parse(row.content);
        return parsed.frame as ResponseFrame;
      }
    } finally {
      inDb.close();
    }

    Bun.sleepSync(500);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Arg parsing (mirrors host-side client.ts)
// ---------------------------------------------------------------------------

function parseArgv(argv: string[]): {
  command: string;
  args: Record<string, unknown>;
  json: boolean;
} {
  const positional: string[] = [];
  const args: Record<string, unknown> = {};
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      json = true;
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

  return { command, args, json };
}

function printUsage(): void {
  process.stdout.write(
    ['Usage: ncl <command> [--key value ...] [--json]', '', 'Run `ncl help` to list available commands.', ''].join('\n'),
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

const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  printUsage();
  process.exit(0);
}

const { command, args, json } = parseArgv(argv);
const requestId = generateId();
const req: RequestFrame = { id: requestId, command, args };

writeRequest(req);

const resp = pollResponse(requestId, 30_000);

if (!resp) {
  process.stderr.write('ncl: command timed out after 30s\n');
  process.exit(2);
}

if (json) {
  process.stdout.write(JSON.stringify(resp, null, 2) + '\n');
} else if (resp.ok && resp.human !== undefined) {
  // Server-rendered view — print verbatim.
  process.stdout.write(resp.human + '\n');
} else {
  const output = formatHuman(resp);
  if (!resp.ok) {
    process.stderr.write(output);
    process.exit(1);
  }
  process.stdout.write(output);
}
