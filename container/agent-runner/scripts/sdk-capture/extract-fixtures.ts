/**
 * Convert probative capture recordings into the deterministic fixture file
 * replayed by src/providers/claude.recorded.test.ts.
 *
 * Message TEXT is kept verbatim; non-text noise (usage, ids, tool inputs) is
 * trimmed to the shape the provider actually reads, so the fixtures stay
 * small and free of machine-local leakage. Deterministic: re-running over the
 * same recordings produces the same JSON.
 *
 * Usage: cd container/agent-runner && bun scripts/sdk-capture/extract-fixtures.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const RECORDINGS_DIR = path.join(import.meta.dir, 'recordings');
const OUT_FILE = path.join(import.meta.dir, '..', '..', 'src', 'providers', '__fixtures__', 'sdk-midturn-recordings.json');

// s04c is excluded: its message text embeds local /tmp directory listings.
// s01/s11 (trivial unwrapped), s04a/s05/s07 (shapes duplicated by s08/s02)
// are omitted to keep the fixture minimal.
const PICK = [
  's02-single-block',
  's03-block-then-tool',
  's04b-tool-inside-block',
  's06-only-final',
  's08-long-block',
  's09-repeat-in-summary',
  's10-summarize-no-repeat',
  's12-abort-midstream',
  's13-internal-draft',
  's14-two-turns-stream',
  's16-three-way-split',
];

type Raw = Record<string, unknown> & {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: Array<{ type?: string; text?: string; name?: string }> };
  result?: string;
  is_error?: boolean;
  errors?: string[];
  rate_limit_info?: unknown;
  _harness?: string;
};

function trim(msg: Raw): unknown | null {
  if (msg._harness) return null;
  switch (msg.type) {
    case 'system':
      return msg.subtype === 'init'
        ? { type: 'system', subtype: 'init', session_id: msg.session_id }
        : { type: 'system', subtype: msg.subtype };
    case 'assistant': {
      const content = (msg.message?.content ?? []).map((b) =>
        b.type === 'text' ? { type: 'text', text: b.text ?? '' } : { type: b.type, name: b.name },
      );
      return { type: 'assistant', message: { content } };
    }
    case 'user':
      // Tool results — the provider yields only 'activity' for these; keep a
      // stub to preserve the stream cadence.
      return { type: 'user' };
    case 'result': {
      const out: Record<string, unknown> = { type: 'result', subtype: msg.subtype };
      if (msg.result !== undefined) out.result = msg.result;
      if (msg.is_error !== undefined) out.is_error = msg.is_error;
      if (msg.errors !== undefined) out.errors = msg.errors;
      return out;
    }
    case 'rate_limit_event':
      return { type: 'rate_limit_event', rate_limit_info: msg.rate_limit_info };
    default:
      return { type: msg.type };
  }
}

const fixtures: Record<string, { gist: string; capturedAt: string; messages: unknown[] }> = {};
for (const id of PICK) {
  const file = path.join(RECORDINGS_DIR, `${id}.jsonl`);
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Raw);
  const meta = lines.find((l) => l._harness === 'meta') as unknown as { gist: string; startedAt: string };
  fixtures[id] = {
    gist: meta.gist,
    capturedAt: meta.startedAt,
    messages: lines.map(trim).filter((m) => m !== null),
  };
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(fixtures, null, 2) + '\n');
console.error(`Wrote ${OUT_FILE} (${Object.keys(fixtures).length} scenarios)`);
