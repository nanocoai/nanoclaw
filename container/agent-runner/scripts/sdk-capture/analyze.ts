/**
 * Analyze SDK capture recordings: for each scenario JSONL, compute the
 * containment relation between the turn's result text and the streamed
 * assistant text, and account for <message> block boundaries.
 *
 * Usage: cd container/agent-runner && bun scripts/sdk-capture/analyze.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const RECORDINGS_DIR = path.join(import.meta.dir, 'recordings');
const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

function completeBlocks(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(MESSAGE_RE.source, 'g');
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return out;
}

interface TurnAccount {
  turn: number;
  segments: string[]; // one per assistant message (text blocks joined with '')
  textBlockCounts: number[]; // raw text-block count per assistant message
  resultText: string | null;
  isError: boolean;
  subtype: string | undefined;
}

function analyzeFile(file: string): void {
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  const meta = lines.find((l) => l._harness === 'meta') as { scenario: string; gist: string } | undefined;
  const end = lines.find((l) => l._harness === 'end') as { error: string | null } | undefined;

  const turns: TurnAccount[] = [];
  let cur: TurnAccount = { turn: 1, segments: [], textBlockCounts: [], resultText: null, isError: false, subtype: undefined };
  for (const msg of lines) {
    if (msg.type === 'assistant') {
      const content = (msg as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content;
      if (Array.isArray(content)) {
        const texts = content.filter((b) => b.type === 'text' && b.text).map((b) => b.text!);
        if (texts.length > 0) {
          cur.segments.push(texts.join(''));
          cur.textBlockCounts.push(texts.length);
        }
      }
    } else if (msg.type === 'result') {
      const m = msg as { result?: string; is_error?: boolean; errors?: string[]; subtype?: string };
      cur.resultText = m.result ?? (m.errors && m.errors.length > 0 ? m.errors.join('\n') : null);
      cur.isError = m.is_error === true;
      cur.subtype = m.subtype;
      turns.push(cur);
      cur = { turn: turns.length + 1, segments: [], textBlockCounts: [], resultText: null, isError: false, subtype: undefined };
    }
  }
  if (cur.segments.length > 0) turns.push(cur); // aborted turn with no result

  console.log(`\n=== ${meta?.scenario ?? path.basename(file)} — ${meta?.gist ?? ''}${end?.error ? `  [RUN ERROR: ${end.error}]` : ''}`);
  for (const t of turns) {
    const last = t.segments[t.segments.length - 1] ?? null;
    const concat = t.segments.join('');
    const r = t.resultText;
    let containment: string;
    if (r === null) containment = 'NO RESULT (turn had no result event)';
    else if (t.segments.length === 0) containment = r === '' ? 'empty result, zero segments' : 'RESULT WITH ZERO STREAMED SEGMENTS';
    else if (r === last) containment = 'result === LAST segment (exact)';
    else if (r === concat) containment = 'result === CONCAT of all segments';
    else if (last !== null && r.endsWith(last)) containment = 'result ends-with last segment (superset!)';
    else if (concat.includes(r)) containment = 'result is substring of concat';
    else containment = 'DIVERGENT (result text not derivable from segments)';

    const resultBlocks = r ? completeBlocks(r) : [];
    const segBlockSets = t.segments.map((s) => new Set(completeBlocks(s)));
    const unstreamedComplete = resultBlocks.filter((b) => !segBlockSets.some((set) => set.has(b)));
    const splitSegs = t.segments
      .map((s, i) => {
        const opens = (s.match(/<message\s+to=/g) ?? []).length;
        const closes = (s.match(/<\/message>/g) ?? []).length;
        return opens !== closes ? `seg${i}(open=${opens},close=${closes})` : null;
      })
      .filter(Boolean);

    console.log(
      `  turn ${t.turn}: segments=${t.segments.length} (textBlocks/msg: ${t.textBlockCounts.join(',') || '-'}) ` +
        `resultLen=${r?.length ?? 'null'} subtype=${t.subtype ?? '-'} isError=${t.isError}`,
    );
    console.log(`    containment: ${containment}`);
    console.log(
      `    blocks: result=${resultBlocks.length}, complete-in-result-but-never-complete-in-a-segment=${unstreamedComplete.length}` +
        (splitSegs.length ? `, UNBALANCED segments: ${splitSegs.join(' ')}` : ''),
    );
    if (unstreamedComplete.length > 0) {
      for (const b of unstreamedComplete) console.log(`    !! unstreamed complete block: ${b.slice(0, 120)}`);
    }
    for (const [i, s] of t.segments.entries()) {
      console.log(`    seg${i}: ${JSON.stringify(s.slice(0, 110))}${s.length > 110 ? '…' : ''}`);
    }
    if (r !== null && r !== last) console.log(`    result: ${JSON.stringify(r.slice(0, 110))}${r.length > 110 ? '…' : ''}`);
  }
}

for (const f of fs.readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith('.jsonl')).sort()) {
  analyzeFile(path.join(RECORDINGS_DIR, f));
}
