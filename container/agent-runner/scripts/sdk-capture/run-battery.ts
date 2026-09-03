/**
 * Live SDK capture battery.
 *
 * Drives the REAL @anthropic-ai/claude-agent-sdk (the agent-runner's pinned
 * dependency — run this from container/agent-runner so bun resolves that
 * copy) through scenarios designed to elicit the mid-turn-delivery edge
 * cases, and records EVERY raw SDK message verbatim as one JSONL transcript
 * per scenario under scripts/sdk-capture/recordings/.
 *
 * Auth comes from the local environment (Claude Code keychain / ANTHROPIC_API_KEY)
 * — nothing is hardcoded. Network goes through the local DoH CONNECT proxy
 * (see doh-proxy.ts) because the capture machine's system resolver is broken.
 *
 * Usage:  cd container/agent-runner && bun scripts/sdk-capture/run-battery.ts [ids...]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import { startDohProxy } from './doh-proxy.js';

const RECORDINGS_DIR = path.join(import.meta.dir, 'recordings');

// Mirrors container/agent-runner/src/destinations.ts buildDestinationsSection
// (chat mode, two destinations) so the model actually uses the <message>
// convention the agent-runner teaches.
const INSTRUCTIONS = `# You are TestBot

Your name is **TestBot**. Use it when the channel asks who you are.

## Sending messages

You can send messages to the following destinations:

- \`discord-main\` (discord)
- \`ops-log\` (slack)

Wrap each delivered message in a \`<message to="name">…</message>\` block; include several blocks in one response to address several destinations. \`<internal>…</internal>\` marks thinking you don't want sent.

When replying to an incoming message, default to addressing the destination it came \`from\` (every inbound \`<message>\` tag carries a \`from="name"\` attribute). Pick a different destination when the request asks for it (e.g., "tell Laura that…").

For a short turn, do not narrate. For longer work, send one acknowledgment and then updates only at meaningful milestones, especially before slow operations. Never narrate micro-steps; finish with the outcome, not a play-by-play.`;

interface Scenario {
  id: string;
  gist: string;
  prompt: string;
  /** Abort the SDK query as soon as the first tool_use block is observed. */
  abortOnFirstToolUse?: boolean;
  /** Push this follow-up prompt after the first result (streaming input). */
  followUp?: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: 's01-plain',
    gist: 'plain reply, no blocks',
    prompt: '<message from="discord-main">Reply with the single word: ok. Do not use any message block.</message>',
  },
  {
    id: 's02-single-block',
    gist: 'single block then end',
    prompt: '<message from="discord-main">Send me a one-line greeting.</message>',
  },
  {
    id: 's03-block-then-tool',
    gist: 'block, THEN a tool call after it (SAF shape)',
    prompt:
      '<message from="discord-main">First send me a complete one-line message block saying the deploy is done. After closing that block, run the Bash command `echo status-updated` and then end your turn with no further text.</message>',
  },
  {
    id: 's04a-tool-inside-block',
    gist: 'tool call BETWEEN open and close of a block (half-message)',
    prompt:
      '<message from="discord-main">Compose a two-sentence status message to me, but split your work: write the opening <message to="discord-main"> tag and the first sentence, then run Bash `echo checkpoint` before writing anything else, then write the second sentence and the closing tag.</message>',
  },
  {
    id: 's04b-tool-inside-block',
    gist: 'half-message, phrasing 2 (explicit interleave)',
    prompt:
      '<message from="discord-main">I am testing your streaming. Emit EXACTLY this sequence: (1) the text `<message to="discord-main">part one` and nothing else, (2) a Bash call `echo mid`, (3) the text `part two</message>` and nothing else. Do not merge steps 1 and 3 into one text output.</message>',
  },
  {
    id: 's04c-tool-inside-block',
    gist: 'half-message, phrasing 3 (start now, finish after checking)',
    prompt:
      '<message from="discord-main">Start telling me the current directory contents in a message block — open the block and write "Checking now…", then (before closing the block) actually run `ls /tmp | head -2`, then finish the same message block with what you found.</message>',
  },
  {
    id: 's05-two-blocks',
    gist: 'two blocks to different destinations in one turn',
    prompt:
      '<message from="discord-main">Send me a one-line hello, and separately send ops-log a one-line note that says "capture test". Two message blocks, one turn.</message>',
  },
  {
    id: 's06-only-final',
    gist: 'tool first, block only in the very last text',
    prompt:
      '<message from="discord-main">Without writing any text first, run Bash `echo hi`. Then your ONLY text output should be a single one-line message block to me with the command output.</message>',
  },
  {
    id: 's07-unclosed',
    gist: 'never-completed block (no closing tag)',
    prompt:
      '<message from="discord-main">Protocol test: output the opening tag <message to="discord-main"> followed by the words "this stays open" and END YOUR TURN THERE. Deliberately do not emit the closing tag. Do not add anything else.</message>',
  },
  {
    id: 's08-long-block',
    gist: 'long multi-paragraph block (chunking)',
    prompt:
      '<message from="discord-main">Send me one message block containing a ~200-word four-paragraph update about a fictional deploy of a service called "orion" (rollout, metrics, one incident, next steps).</message>',
  },
  {
    id: 's09-repeat-in-summary',
    gist: 'instructed to repeat block verbatim in final text',
    prompt:
      '<message from="discord-main">Send me a one-line message block saying "backup finished". Then run Bash `echo logged`. Then, as your final text, repeat the exact same message block verbatim once more.</message>',
  },
  {
    id: 's10-summarize-no-repeat',
    gist: 'summary WITHOUT repeating the block',
    prompt:
      '<message from="discord-main">Send me a one-line message block saying "backup finished". Then run Bash `echo logged`. Then finish with one short unwrapped sentence (no message block) noting what you did.</message>',
  },
  {
    id: 's11-unwrapped-only',
    gist: 'unwrapped prose only',
    prompt:
      '<message from="discord-main">In two unwrapped sentences (no message block — this is a protocol test), explain why the sky is blue.</message>',
  },
  {
    id: 's12-abort-midstream',
    gist: 'abort during the tool call',
    prompt:
      '<message from="discord-main">Send me a complete one-line message block saying "starting the slow job", then run Bash `sleep 8 && echo slow-done`, then send a second message block saying it finished.</message>',
    abortOnFirstToolUse: true,
  },
  {
    id: 's13-internal-draft',
    gist: 'internal-wrapped draft plus a real block',
    prompt:
      '<message from="discord-main">First, inside an <internal>…</internal> span, draft (but do not send) a too-blunt version of a message block telling me my report is late. Then, outside the internal span, send me the polite real message block.</message>',
  },
  {
    id: 's14-two-turns-stream',
    gist: 'streaming input: follow-up push after first result',
    prompt: '<message from="discord-main">Send me a one-line message block saying "turn one".</message>',
    followUp: '<message from="discord-main">Now send me a one-line message block saying "turn two".</message>',
  },
  {
    id: 's15-midtoken-split',
    gist: 'open tag literally split mid-token across assistant messages',
    prompt:
      '<message from="discord-main">Streaming protocol test — emit EXACTLY this sequence, no commentary: (1) the text `<mess` and NOTHING else (stop your text there), (2) a Bash call `echo tick`, (3) the text `age to="discord-main">reassembled greeting</message>` and nothing else. The tag is intentionally split mid-token; do not repair it in either step.</message>',
  },
  {
    id: 's16-three-way-split',
    gist: 'block spread across three assistant messages with two tool calls between',
    prompt:
      '<message from="discord-main">Streaming protocol test — emit EXACTLY this sequence, no commentary: (1) the text `<message to="discord-main">alpha ` and nothing else, (2) a Bash call `echo one`, (3) the text `beta ` and nothing else, (4) a Bash call `echo two`, (5) the text `gamma</message>` and nothing else. Do not merge the text steps.</message>',
  },
];

/** Push-based input stream (mirrors the provider's MessageStream). */
class Stream {
  q: unknown[] = [];
  private waiting: (() => void) | null = null;
  private done = false;
  push(text: string): void {
    this.q.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
    this.waiting?.();
  }
  end(): void {
    this.done = true;
    this.waiting?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    while (true) {
      while (this.q.length > 0) yield this.q.shift()!;
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function runScenario(s: Scenario, proxyPort: number, cwd: string): Promise<string> {
  const outPath = path.join(RECORDINGS_DIR, `${s.id}.jsonl`);
  const lines: string[] = [
    JSON.stringify({
      _harness: 'meta',
      scenario: s.id,
      gist: s.gist,
      prompt: s.prompt,
      followUp: s.followUp ?? null,
      startedAt: new Date().toISOString(),
    }),
  ];

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error('scenario timeout')), 240_000);

  const stream = new Stream();
  stream.push(s.prompt);

  let resultCount = 0;
  const wantResults = s.followUp ? 2 : 1;
  let error: string | null = null;

  try {
    const q = sdkQuery({
      prompt: stream as AsyncIterable<never>,
      options: {
        cwd,
        abortController: abort,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: INSTRUCTIONS },
        allowedTools: ['Bash'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        maxTurns: 8,
        env: {
          ...process.env,
          HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
          HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
          NO_PROXY: '127.0.0.1,localhost',
        },
      },
    });

    for await (const message of q) {
      lines.push(JSON.stringify(message));
      const m = message as { type?: string; message?: { content?: Array<{ type?: string }> } };
      if (
        s.abortOnFirstToolUse &&
        m.type === 'assistant' &&
        Array.isArray(m.message?.content) &&
        m.message.content.some((b) => b.type === 'tool_use')
      ) {
        lines.push(JSON.stringify({ _harness: 'abort', reason: 'first tool_use observed', at: new Date().toISOString() }));
        abort.abort(new Error('harness abort on first tool_use'));
      }
      if (m.type === 'result') {
        resultCount++;
        if (resultCount === 1 && s.followUp) stream.push(s.followUp);
        if (resultCount >= wantResults) stream.end();
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    lines.push(JSON.stringify({ _harness: 'error', error, at: new Date().toISOString() }));
  } finally {
    clearTimeout(timeout);
  }

  lines.push(JSON.stringify({ _harness: 'end', endedAt: new Date().toISOString(), results: resultCount, error }));
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  return `${s.id}: ${resultCount} result(s)${error ? ` ERROR: ${error.slice(0, 120)}` : ''}`;
}

async function main(): Promise<void> {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const only = new Set(process.argv.slice(2));
  const picked = only.size > 0 ? SCENARIOS.filter((s) => only.has(s.id)) : SCENARIOS;

  const { port, close } = await startDohProxy();
  console.error(`[battery] DoH CONNECT proxy on 127.0.0.1:${port}`);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-capture-'));
  console.error(`[battery] scenario cwd: ${cwd}`);

  try {
    for (const s of picked) {
      console.error(`[battery] running ${s.id} — ${s.gist}`);
      const line = await runScenario(s, port, cwd);
      console.error(`[battery]   ${line}`);
    }
  } finally {
    close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

await main();
