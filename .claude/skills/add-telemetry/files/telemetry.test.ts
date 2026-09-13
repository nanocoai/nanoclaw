/**
 * Telemetry regressions.
 *
 * Every case here guards a defect that has actually occurred, not a hypothetical
 * one. Most surface only by looking at real traces, which is why this suite
 * exists: without it, correctness depends on someone remembering to re-check
 * everything by hand on each change.
 *
 * The module initializes from `otel.json` on import, so the fixture and env var
 * are set up BEFORE the dynamic import. `endpoint: "memory:"` selects the
 * synchronous in-memory exporter (see the seam in telemetry.ts).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';

import { SpanKind } from '@opentelemetry/api';
import fs from 'fs';
import os from 'os';
import path from 'path';

let telemetry: typeof import('./telemetry.js');

/** Duration in ms from the hrtime pair a ReadableSpan exposes. */
function durationMs(span: { duration: [number, number] }): number {
  return span.duration[0] * 1000 + span.duration[1] / 1e6;
}

function byName(spans: Array<{ name: string }>, name: string) {
  return spans.filter((s) => s.name === name);
}

function one(spans: Array<{ name: string }>, name: string) {
  const found = byName(spans, name);
  expect(found.length).toBe(1);
  return found[0] as any;
}

/** The parent id field is renamed between SDK versions; accept both shapes. */
function parentIdOf(span: any): string | undefined {
  return span.parentSpanContext?.spanId ?? span.parentSpanId;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-otel-'));
  const cfg = path.join(dir, 'otel.json');
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      endpoint: 'memory:',
      projectName: 'suite',
      // One key that is new and one that overrides a default — see 'resource attributes'.
      resourceAttributes: { 'deployment.environment': 'suite-env', 'service.name': 'custom-svc' },
    }),
  );
  process.env.NANOCLAW_OTEL_CONFIG = cfg;
  telemetry = await import('./telemetry.js');
});

beforeEach(() => {
  telemetry.__testReset();
});

describe('tool pairing', () => {
  // DEFECT: `toolEnd` used `pop()` on a LIFO stack. With the SDK running tools in
  // parallel, closing A ended B's span and most spans carried another tool's
  // duration.
  it('matches each tool by tool_use_id even when closing out of LIFO order', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Alfa', tool_use_id: 'A' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Bravo', tool_use_id: 'B' });
    // close A FIRST — the order the stack got wrong
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Alfa', tool_use_id: 'A', duration_ms: 1111 });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Bravo', tool_use_id: 'B', duration_ms: 2222 });

    const spans = telemetry.__testSpans();
    expect(one(spans, 'tool.Alfa').attributes['nanoclaw.tool_duration_ms']).toBe(1111);
    expect(one(spans, 'tool.Bravo').attributes['nanoclaw.tool_duration_ms']).toBe(2222);
  });

  it('ignores an unknown tool_use_id instead of closing someone else\u2019s span', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Echo', tool_use_id: 'E' });
    telemetry.toolEnd({
      hook_event_name: 'PostToolUse',
      tool_name: 'Ghost',
      tool_use_id: 'DOES_NOT_EXIST',
      duration_ms: 9,
    });

    // the phantom must not have closed anything
    expect(byName(telemetry.__testSpans(), 'tool.Echo').length).toBe(0);

    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Echo', tool_use_id: 'E', duration_ms: 5555 });
    expect(one(telemetry.__testSpans(), 'tool.Echo').attributes['nanoclaw.tool_duration_ms']).toBe(5555);
  });

  // DEFECT: a tool failure was indistinguishable from success, and the exit code
  // stayed trapped inside the error string.
  it('marks failure with error status and extracts the exit code', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'X' });
    telemetry.toolEnd({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_use_id: 'X',
      error: 'Exit code 127\n/bin/bash: line 6: python3: command not found',
    });

    const span = one(telemetry.__testSpans(), 'tool.Bash');
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span.attributes['nanoclaw.tool_exit_code']).toBe(127);
  });

  it('does not stamp an exit code on success — absence already means success', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'X' });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'X', duration_ms: 10 });

    expect(one(telemetry.__testSpans(), 'tool.Bash').attributes['nanoclaw.tool_exit_code']).toBeUndefined();
  });

  it('records only the SIZE of tool output, never the content', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'R' });
    telemetry.toolEnd({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_use_id: 'R',
      tool_response: 'secret'.repeat(500),
    });

    const attrs = one(telemetry.__testSpans(), 'tool.Read').attributes;
    expect(attrs['nanoclaw.tool_response_chars']).toBe(3000);
    expect(JSON.stringify(attrs)).not.toContain('secret');
  });

  // Phoenix's Input panel on a TOOL span reads `input.value`, not
  // `tool.parameters`. Emitting only the latter left the panel blank for EVERY
  // tool, which is indistinguishable from "this tool took no arguments" — so the
  // args go out under both names.
  it('publishes tool args under input.value as well as tool.parameters', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({
      hook_event_name: 'PreToolUse',
      tool_name: 'ToolSearch',
      tool_use_id: 'TS',
      tool_input: { query: 'select:Read', max_results: 1 },
    });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'ToolSearch', tool_use_id: 'TS' });

    const attrs = one(telemetry.__testSpans(), 'tool.ToolSearch').attributes;
    expect(attrs['tool.parameters']).toBe('{"query":"select:Read","max_results":1}');
    expect(attrs['input.value']).toBe(attrs['tool.parameters']);
    expect(attrs['input.mime_type']).toBe('application/json');
  });

  // A tool that genuinely took no arguments must leave the panel empty rather
  // than showing `{}` — otherwise the blank case stops being readable again.
  it('omits input.value entirely when the tool took no arguments', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'NoArgs', tool_use_id: 'SA' });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'NoArgs', tool_use_id: 'SA' });

    const attrs = one(telemetry.__testSpans(), 'tool.NoArgs').attributes;
    expect(attrs['tool.parameters']).toBeUndefined();
    expect(attrs['input.value']).toBeUndefined();
    expect(attrs['input.mime_type']).toBeUndefined();
  });
});

describe('tool taxonomy', () => {
  // All of this was ALREADY in the trace — the server inside the span name, the
  // skill inside `tool.parameters` — and none of it was queryable: answering
  // "which skills did this agent use" meant a LIKE over names or parsing JSON out
  // of an attribute. These are the same facts, as attributes.
  it('splits an MCP call into server and tool, instead of one opaque name', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'mcp__nanoclaw__send_message', tool_use_id: 'M' });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'mcp__nanoclaw__send_message', tool_use_id: 'M' });

    const attrs = one(telemetry.__testSpans(), 'tool.mcp__nanoclaw__send_message').attributes;
    expect(attrs['nanoclaw.tool_kind']).toBe('mcp');
    expect(attrs['nanoclaw.mcp_server']).toBe('nanoclaw');
    expect(attrs['nanoclaw.mcp_tool']).toBe('send_message');
  });

  it('names the skill, and keeps the span name a stable category', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({
      hook_event_name: 'PreToolUse',
      tool_name: 'Skill',
      tool_use_id: 'S',
      tool_input: { skill: 'adversarial-review', args: 'review the diff' },
    });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_use_id: 'S' });

    // `tool.Skill:<skill>` would read better in the waterfall at the cost of
    // GROUP BY name: every skill would become its own span name, fragmenting the
    // aggregation Phoenix builds from it. The name stays the category.
    const attrs = one(telemetry.__testSpans(), 'tool.Skill').attributes;
    expect(attrs['nanoclaw.tool_kind']).toBe('skill');
    expect(attrs['nanoclaw.skill']).toBe('adversarial-review');
  });

  // The field name comes from the CLI, not from a typed SDK surface. If it is
  // renamed, the class must still land — the alternative is a `[object Object]`
  // or a crash inside a hook.
  it('still classifies a skill whose input does not name it', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({
      hook_event_name: 'PreToolUse',
      tool_name: 'Skill',
      tool_use_id: 'S',
      tool_input: { another: 1 },
    });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_use_id: 'S' });

    const attrs = one(telemetry.__testSpans(), 'tool.Skill').attributes;
    expect(attrs['nanoclaw.tool_kind']).toBe('skill');
    expect(attrs['nanoclaw.skill']).toBeUndefined();
  });

  // An absent attribute cannot be grouped, and "neither MCP nor skill" is a real
  // bucket — the biggest one.
  it('gives every other tool a class, so nothing groups as null', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'B' });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'B' });

    const attrs = one(telemetry.__testSpans(), 'tool.Bash').attributes;
    expect(attrs['nanoclaw.tool_kind']).toBe('builtin');
    expect(attrs['nanoclaw.mcp_server']).toBeUndefined();
    expect(attrs['nanoclaw.skill']).toBeUndefined();
  });
});

describe('turn tool rollup', () => {
  const step = () => ({
    type: 'assistant',
    session_id: 's',
    message: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: {} },
  });
  const result = () => ({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 });

  const callTool = (name: string, id: string, input?: object) => {
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: name, tool_use_id: id, tool_input: input });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: name, tool_use_id: id });
  };

  // The per-span attributes answer "what did this call cost". This answers "did
  // this turn touch skill X" while scanning a list of turns, with no join against
  // the children.
  it('collects the turn’s skills and MCP servers, deduplicated and sorted', () => {
    telemetry.turnStart({ prompt: 'x' });
    callTool('Skill', 's1', { skill: 'adversarial-review' });
    callTool('Skill', 's2', { skill: 'adversarial-review' });
    callTool('Skill', 's3', { skill: 'deep-research' });
    callTool('mcp__weather__forecast', 'm1');
    callTool('mcp__nanoclaw__send_message', 'm2');
    callTool('Bash', 'b1');
    telemetry.observe(result());

    const attrs = one(telemetry.__testSpans(), 'agent.turn').attributes;
    expect(attrs['nanoclaw.skills_used']).toBe('adversarial-review,deep-research');
    expect(attrs['nanoclaw.mcp_servers_used']).toBe('nanoclaw,weather');
    expect(attrs['nanoclaw.tool_calls']).toBe(6);
  });

  // Zero is always written: its absence could not distinguish "used no tool" from
  // "turn predates the instrument". With `tool_calls` present and `skills_used`
  // absent, the turn genuinely used no skill.
  it('counts tool calls, zero included, and claims no skill when there was none', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(result());

    const attrs = one(telemetry.__testSpans(), 'agent.turn').attributes;
    expect(attrs['nanoclaw.tool_calls']).toBe(0);
    expect(attrs['nanoclaw.skills_used']).toBeUndefined();
    expect(attrs['nanoclaw.mcp_servers_used']).toBeUndefined();
  });

  it('does not carry one exchange’s tools into the next', () => {
    telemetry.turnStart({ prompt: 'x' });
    callTool('Skill', 's1', { skill: 'adversarial-review' });
    telemetry.observe(result());

    // second exchange: pushed into the live query, no new turnStart
    telemetry.observe(step());
    callTool('Bash', 'b1');
    telemetry.observe(result());

    const turns = byName(telemetry.__testSpans(), 'agent.turn') as any[];
    expect(turns.length).toBe(2);
    expect(turns[0].attributes['nanoclaw.skills_used']).toBe('adversarial-review');
    expect(turns[1].attributes['nanoclaw.skills_used']).toBeUndefined();
    expect(turns[1].attributes['nanoclaw.tool_calls']).toBe(1);
  });

  // Background work runs after `turnEnd`, with the counters already applied.
  // Counted there, it would be credited to the NEXT turn — a skill nobody invoked
  // in it. Its own span keeps the attributes, so nothing is lost.
  it('a tool that runs after the turn closed joins no rollup', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(result());
    callTool('mcp__weather__forecast', 'm1');

    telemetry.observe(step());
    telemetry.observe(result());

    const turns = byName(telemetry.__testSpans(), 'agent.turn') as any[];
    expect(turns[1].attributes['nanoclaw.mcp_servers_used']).toBeUndefined();
    expect(turns[1].attributes['nanoclaw.tool_calls']).toBe(0);
    // the span itself still says which server it went through
    const tool = one(telemetry.__testSpans(), 'tool.mcp__weather__forecast');
    expect(tool.attributes['nanoclaw.mcp_server']).toBe('weather');
  });
});

describe('model call unit', () => {
  // DEFECT: the SDK slices ONE API response into several messages (one per
  // block), and we emitted a span per message — each recording the WHOLE call's
  // `usage`. Summing the children then overstated the turn's tokens,
  // and Phoenix's native rollup inherited the inflated number.
  const msg = (content: unknown[], usage: object) => ({
    type: 'assistant',
    session_id: 's',
    message: { model: 'claude-sonnet-5', content, usage },
  });
  const usageA = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 103_274 };
  const usageB = { input_tokens: 11, output_tokens: 6, cache_read_input_tokens: 104_953 };

  it('merges one call\u2019s messages into a single span, with usage once', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(msg([{ type: 'thinking', thinking: 'I think' }], usageA));
    telemetry.observe(msg([{ type: 'text', text: 'I say' }], usageA));
    telemetry.observe(msg([{ type: 'tool_use', name: 'Bash' }], usageA));
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: usageA });

    const calls = byName(telemetry.__testSpans(), 'llm.call') as any[];
    expect(calls.length).toBe(1);
    // the prompt must be the call's, not 3×
    expect(calls[0].attributes['llm.token_count.prompt']).toBe(10 + 103_274);
    expect(calls[0].attributes['nanoclaw.block_kinds']).toBe('thinking,text,tool_use');
    expect(calls[0].attributes['nanoclaw.thinking']).toBe('I think');
    expect(calls[0].attributes['output.value']).toBe('I say');
  });

  it('parallel tool calls become ONE decision with N tools', () => {
    telemetry.turnStart({ prompt: 'x' });
    for (const t of ['WebSearch', 'Read', 'Bash', 'Grep']) {
      telemetry.observe(msg([{ type: 'tool_use', name: t }], usageA));
    }
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: usageA });

    const call = one(telemetry.__testSpans(), 'llm.call');
    expect(call.attributes['nanoclaw.tool_names']).toBe('WebSearch,Read,Bash,Grep');
    expect(call.attributes['nanoclaw.tool_call_count']).toBe(4);
    // `nanoclaw.tool_calls` is the TURN's integer count; the call never writes
    // that key, so one attribute name keeps one type across span kinds.
    expect(call.attributes['nanoclaw.tool_calls']).toBeUndefined();
  });

  // Generic OTel backends separate outbound calls (CLIENT) from in-process work
  // (INTERNAL) in their views; a model call is the former, a tool the latter.
  it('the model call is a CLIENT span and a tool stays INTERNAL', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(msg([{ type: 'tool_use', name: 'Bash' }], usageA));
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'T' });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'T' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: usageA });

    const spans = telemetry.__testSpans();
    expect(one(spans, 'llm.call').kind).toBe(SpanKind.CLIENT);
    expect(one(spans, 'tool.Bash').kind).toBe(SpanKind.INTERNAL);
    expect(one(spans, 'agent.turn').kind).toBe(SpanKind.INTERNAL);
  });

  it('a different usage closes the previous call and opens another', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(msg([{ type: 'tool_use', name: 'Bash' }], usageA));
    telemetry.observe(msg([{ type: 'text', text: 'answer' }], usageB));
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: usageB });

    const calls = byName(telemetry.__testSpans(), 'llm.call') as any[];
    expect(calls.length).toBe(2);
    expect(calls.map((c) => c.attributes['llm.token_count.prompt'])).toEqual([10 + 103_274, 11 + 104_953]);
  });

  // Merging on absent data would group unrelated messages — worse than not
  // grouping at all.
  it('with no usage, each message is its own call', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(msg([{ type: 'text', text: 'a' }], {}));
    telemetry.observe(msg([{ type: 'text', text: 'b' }], {}));
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: usageA });

    expect(byName(telemetry.__testSpans(), 'llm.call').length).toBe(2);
  });

  // The sum of the children never exceeds the turn total.
  it('the children no longer sum beyond the turn total', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(msg([{ type: 'thinking' }], usageA));
    telemetry.observe(msg([{ type: 'tool_use', name: 'Bash' }], usageA));
    telemetry.observe(msg([{ type: 'text', text: 'end' }], usageB));
    telemetry.observe({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      usage: { input_tokens: 21, output_tokens: 11, cache_read_input_tokens: 208_227 },
    });

    // Checked on the INPUT side, the one that is trustworthy: this same sum
    // reproduces the turn's own total exactly.
    // The output side cannot be checked this way — see `setCallTokenAttrs`.
    const spans = telemetry.__testSpans() as any[];
    const childSum = spans
      .filter((s) => s.name === 'llm.call')
      .reduce((acc, s) => acc + (s.attributes['llm.token_count.prompt'] as number), 0);
    const turnPromptTokens = one(spans, 'agent.turn').attributes['nanoclaw.turn_tokens_prompt'] as number;
    expect(childSum).toBe(turnPromptTokens); // ratio 1.0
  });
});

describe('token counting', () => {
  // DEFECT: only `input_tokens`/`output_tokens` were counted. Since Anthropic
  // reports cache in separate fields, Phoenix showed a small fraction of real
  // consumption.
  it('adds cache tokens into the prompt, or the total is meaningless', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      total_cost_usd: 0.5,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 200_000,
        cache_creation_input_tokens: 5_000,
      },
      modelUsage: { 'claude-haiku-4-5': { costUSD: 0.01 }, 'claude-opus-5': { costUSD: 0.49 } },
    });

    const attrs = one(telemetry.__testSpans(), 'agent.turn').attributes;
    expect(attrs['nanoclaw.turn_tokens_prompt']).toBe(205_100);
    expect(attrs['nanoclaw.turn_tokens_completion']).toBe(50);
    expect(attrs['nanoclaw.turn_tokens_total']).toBe(205_150);
    expect(attrs['nanoclaw.turn_tokens_cache_read']).toBe(200_000);
    expect(attrs['nanoclaw.turn_tokens_cache_write']).toBe(5_000);
    // the model that answers for the cost, not the first in the list
    expect(attrs['nanoclaw.model']).toBe('claude-opus-5');
  });

  // DEFECT: the turn carried `llm.token_count.*` / `gen_ai.usage.*`. Phoenix
  // ignored them outright (kind AGENT is not priced, so `tokenCountTotal` read
  // 0), but Langfuse billed the turn ON TOP of what it billed the same turn's
  // children. The vendor namespace bought nothing and double counted in a second
  // backend.
  it('the turn keeps its tokens out of any cost engine’s reach', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200_000 },
    });

    const attrs = one(telemetry.__testSpans(), 'agent.turn').attributes;
    const leaked = Object.keys(attrs).filter((k) => k.startsWith('llm.token_count.') || k.startsWith('gen_ai.usage.'));
    expect(leaked).toEqual([]);
    // still queryable, just not billable
    expect(attrs['nanoclaw.turn_tokens_completion']).toBe(50);
  });

  // DEFECT: `usage.output_tokens` on an assistant message is a partial streaming
  // value — a handful of tokens on a span whose own output runs to thousands of
  // characters. Published as `llm.token_count.completion` it made Phoenix price a
  // fraction of the real output spend.
  it('the call publishes no output token count, only the partial value', () => {
    const partialUsage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 103_274 };
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe({
      type: 'assistant',
      session_id: 's',
      message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'I say' }], usage: partialUsage },
    });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: partialUsage });

    const attrs = one(telemetry.__testSpans(), 'llm.call').attributes;
    expect(attrs['llm.token_count.completion']).toBeUndefined();
    expect(attrs['gen_ai.usage.output_tokens']).toBeUndefined();
    // nor a `total` built on top of it
    expect(attrs['llm.token_count.total']).toBeUndefined();
    // kept for diagnosis, under a name no cost engine reads
    expect(attrs['nanoclaw.output_tokens_partial']).toBe(5);
    // the input side stays in the vendor namespace — it is the trustworthy one
    expect(attrs['llm.token_count.prompt']).toBe(10 + 103_274);
  });
});

describe('time boundary across contexts', () => {
  // DEFECT: `lastBoundary` was a single global number, but the main thread and
  // subagent workers emit INTERLEAVED messages — one side stole the other's
  // boundary and the durations swapped owners.
  it('does not let a worker step shorten the main thread step', async () => {
    const step = (extra: object) => ({
      type: 'assistant',
      session_id: 's',
      message: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'p' }], usage: {} },
      ...extra,
    });

    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'AG' });
    await sleep(40);
    await telemetry.subagentHook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'worker' });
    await sleep(40);
    telemetry.observe(step({ parent_tool_use_id: 'AG', subagent_type: 'worker' })); // worker
    await sleep(60);
    telemetry.observe(step({})); // main thread

    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 9 } });
    const steps = byName(telemetry.__testSpans(), 'llm.call');
    expect(steps.length).toBe(2);
    const worker = steps.find((s: any) => s.attributes['nanoclaw.agent_type'] === 'worker') as any;
    const main = steps.find((s: any) => !s.attributes['nanoclaw.agent_type']) as any;

    // The main thread has been working since turnStart (~140ms). With a single
    // global boundary it would inherit the worker step's instant instead.
    expect(durationMs(main)).toBeGreaterThan(100);
    // And the worker must not span the whole turn.
    expect(durationMs(worker)).toBeLessThan(durationMs(main));
  });

  // DEFECT: a reported duration longer than the elapsed time started the child
  // before its parent; Phoenix draws a negative offset and the tree disappears.
  it('does not let a backdated span start before its turn', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 180_000, post_tokens: 42_000, duration_ms: 600_000 },
    });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: {} });

    const spans = telemetry.__testSpans();
    const turn = one(spans, 'agent.turn');
    const compact = one(spans, 'agent.compact');
    const startOf = (s: any) => s.startTime[0] * 1e9 + s.startTime[1];
    expect(startOf(compact)).toBeGreaterThanOrEqual(startOf(turn));
    expect(compact.attributes['nanoclaw.compact_tokens_saved']).toBe(138000);
  });
});

describe('turn origin', () => {
  // DEFECT: `from` was mapped to `user.id`. But `formatter.ts` builds `from` from
  // the routing DESTINATION, so on an agent-to-agent message it carries the
  // sending agent's name — which would become a person in Phoenix and inflate
  // cost-per-user with work nobody asked for.
  it('does not treat a sending agent as a user', () => {
    telemetry.turnStart({
      prompt: '<message id="9" from="sender-agent" sender="Unknown" time="t">hi</message>',
    });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: {} });

    const attrs = one(telemetry.__testSpans(), 'agent.turn').attributes;
    expect(attrs['nanoclaw.source']).toBe('sender-agent');
    expect(attrs['user.id']).toBeUndefined();
    expect(attrs['nanoclaw.trigger']).toBe('message');
  });

  it('records a user when there is a real human sender', () => {
    telemetry.turnStart({
      continuation: 'previous-session',
      prompt:
        '<message id="1" from="telegram-mg-1" sender="Jane Doe" time="t">a</message>\n' +
        '<message id="2" from="telegram-mg-2" sender="Another" time="t">b</message>',
    });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: {} });

    const attrs = one(telemetry.__testSpans(), 'agent.turn').attributes;
    expect(attrs['user.id']).toBe('Jane Doe');
    expect(attrs['nanoclaw.source']).toBe('telegram-mg-1');
    expect(attrs['nanoclaw.source_count']).toBe(2);
    expect(attrs['nanoclaw.resumed']).toBe(true);
  });

  it('classifies a scheduled run as task, and a fresh session as not resumed', () => {
    telemetry.turnStart({ prompt: '<task time="t">Instructions: weekly report</task>' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: {} });

    const attrs = one(telemetry.__testSpans(), 'agent.turn').attributes;
    expect(attrs['nanoclaw.trigger']).toBe('task');
    expect(attrs['nanoclaw.resumed']).toBe(false);
    expect(attrs['user.id']).toBeUndefined();
  });
});

describe('reasoning', () => {
  const think = (total: number, delta: number) => ({
    type: 'system' as const,
    subtype: 'thinking_tokens' as const,
    estimated_tokens: total,
    estimated_tokens_delta: delta,
  });
  const thinkingStep = () => ({
    type: 'assistant',
    session_id: 's',
    message: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'thinking' }], usage: {} },
  });

  it('attributes the estimate to the current block and resets on the next', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(think(400, 400));
    telemetry.observe(think(900, 500));
    telemetry.observe(thinkingStep());
    telemetry.observe(think(250, 250));
    telemetry.observe(thinkingStep());
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: {} });

    const spans = telemetry.__testSpans();
    const callSpans = byName(spans, 'llm.call') as any[];
    // Numbers on BOTH span kinds: a `String()` on the llm.call path would give the
    // same attribute name two types, and a typed store coerces the column.
    expect(callSpans.map((s) => s.attributes['nanoclaw.thinking_tokens_est'])).toEqual([900, 250]);
    // the turn sums the increments rather than repeating the last total
    expect(one(spans, 'agent.turn').attributes['nanoclaw.thinking_tokens_est']).toBe(1150);
  });

  it('captures reasoning text when it arrives populated', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe({
      type: 'assistant',
      session_id: 's',
      message: {
        model: 'm',
        stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: 'I need to check the file first' }],
        usage: {},
      },
    });

    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 9 } });
    expect(one(telemetry.__testSpans(), 'llm.call').attributes['nanoclaw.thinking']).toBe(
      'I need to check the file first',
    );
  });
});

describe('parenting', () => {
  // Background work outlives the turn's `result`. Before the context stitching, a
  // single session scattered into dozens of one-span traces in Phoenix.
  it('stitches post-turn spans into the originating trace, and flags them', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: {} });

    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Latecomer', tool_use_id: 'T' });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Latecomer', tool_use_id: 'T', duration_ms: 5 });

    const spans = telemetry.__testSpans();
    const turn = one(spans, 'agent.turn');
    const lateTool = one(spans, 'tool.Latecomer');
    expect(lateTool.spanContext().traceId).toBe(turn.spanContext().traceId);
    expect(parentIdOf(lateTool)).toBe(turn.spanContext().spanId);
    expect(lateTool.attributes['nanoclaw.detached_from_turn']).toBe(true);
  });

  it('hangs worker tools under the subagent span', async () => {
    telemetry.turnStart({ prompt: 'x' });
    await telemetry.subagentHook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'worker' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_use_id: 'G', agent_id: 'a1' });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 'G', agent_id: 'a1' });
    await telemetry.subagentHook({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'worker' });

    const spans = telemetry.__testSpans();
    expect(parentIdOf(one(spans, 'tool.Grep'))).toBe(one(spans, 'subagent.worker').spanContext().spanId);
  });

  it('does not let an unknown agent_id end another subagent', async () => {
    telemetry.turnStart({ prompt: 'x' });
    await telemetry.subagentHook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'worker' });
    await telemetry.subagentHook({ hook_event_name: 'SubagentStop', agent_id: 'GHOST' });

    expect(byName(telemetry.__testSpans(), 'subagent.worker').length).toBe(0);
  });
});

describe('continuation exchanges', () => {
  const mainStep = () => ({
    type: 'assistant',
    session_id: 's',
    message: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'answer' }], usage: {} },
  });
  const result = (usd: number) => ({
    type: 'result',
    subtype: 'success',
    result: 'ok',
    total_cost_usd: usd,
    num_turns: 2,
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  const startMs = (s: any) => s.startTime[0] * 1e3 + s.startTime[1] / 1e6;

  // Background traffic after a turn ends — a task settling, a worker's tool echo —
  // must not arm the continuation anchor, or the next exchange would open at
  // that stale instant and absorb the silence in between.
  it('a task settling after the turn does not anchor the next exchange', async () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(result(0.1));
    telemetry.observe({ type: 'system', subtype: 'task_notification', status: 'completed', task_id: 't1' });
    await sleep(40);

    const before = Date.now();
    telemetry.observe(mainStep());
    telemetry.observe(result(0.2));

    const cont = (byName(telemetry.__testSpans(), 'agent.turn') as any[]).find(
      (t) => t.attributes['nanoclaw.continuation'],
    );
    expect(cont.attributes['nanoclaw.continuation_anchor']).toBe('assistant');
    expect(startMs(cont)).toBeGreaterThanOrEqual(before);
  });

  it("a worker's messages do not anchor the next exchange", async () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(result(0.1));
    telemetry.observe({ type: 'system', subtype: 'thinking_tokens', parent_tool_use_id: 'AG', estimated_tokens: 5 });
    telemetry.observe({ type: 'user', parent_tool_use_id: 'AG', message: { role: 'user', content: [] } });
    await sleep(40);

    const before = Date.now();
    telemetry.observe(mainStep());
    telemetry.observe(result(0.2));

    const cont = (byName(telemetry.__testSpans(), 'agent.turn') as any[]).find(
      (t) => t.attributes['nanoclaw.continuation'],
    );
    expect(cont.attributes['nanoclaw.continuation_anchor']).toBe('assistant');
    expect(startMs(cont)).toBeGreaterThanOrEqual(before);
  });

  it('a main-thread thinking signal anchors the next exchange', async () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(result(0.1));
    const armed = Date.now();
    telemetry.observe({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 5 });
    await sleep(40);
    telemetry.observe(mainStep());
    telemetry.observe(result(0.2));

    const cont = (byName(telemetry.__testSpans(), 'agent.turn') as any[]).find(
      (t) => t.attributes['nanoclaw.continuation'],
    );
    expect(cont.attributes['nanoclaw.continuation_anchor']).toBe('signal');
    expect(startMs(cont)).toBeLessThanOrEqual(armed + 1);
    expect(durationMs(cont)).toBeGreaterThanOrEqual(35);
  });

  it('a signal older than the cap is discarded, and says so', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(result(0.1));
    telemetry.__testArmSignal(Date.now() - 6 * 60_000);

    const before = Date.now();
    telemetry.observe(mainStep());
    telemetry.observe(result(0.2));

    const cont = (byName(telemetry.__testSpans(), 'agent.turn') as any[]).find(
      (t) => t.attributes['nanoclaw.continuation'],
    );
    expect(cont.attributes['nanoclaw.continuation_anchor']).toBe('stale_signal');
    expect(startMs(cont)).toBeGreaterThanOrEqual(before);
    expect(cont.attributes['nanoclaw.inbound_clock_skew']).toBeUndefined();
  });

  // DEFECT: `agent.turn` is born in query(), but the poll-loop pushes later
  // messages into the live call — so most exchanges in a fluid conversation never
  // became turns and their cost was discarded.
  it('opens one turn per exchange, and loses no cost', () => {
    telemetry.turnStart({ prompt: '<message id="1" from="tg" sender="Zed" time="t">first prompt</message>' });
    telemetry.observe(mainStep());
    telemetry.observe(result(0.11));

    // second exchange: prompt pushed into the live query, with no new turnStart
    telemetry.observe(mainStep());
    telemetry.observe(result(0.22));

    // third
    telemetry.observe(mainStep());
    telemetry.observe(result(0.33));

    const turns = byName(telemetry.__testSpans(), 'agent.turn') as any[];
    expect(turns.length).toBe(3);
    // `total_cost_usd` climbs because it is the session RUNNING total; each
    // exchange costs the difference. The sum of the differences must equal the
    // last running total — that identity is what "no cost is lost" means.
    const deltas = turns.map((t) => t.attributes['nanoclaw.cost_usd'] as number);
    expect(deltas).toEqual([0.11, 0.11, 0.11]);
    expect(Math.round(deltas.reduce((a, b) => a + b, 0) * 1e6) / 1e6).toBe(0.33);
    expect(turns.map((t) => t.attributes['nanoclaw.session_cost_usd'])).toEqual([0.11, 0.22, 0.33]);
    // only the first came from query(); the rest are continuations
    expect(turns.map((t) => t.attributes['nanoclaw.continuation'] ?? false)).toEqual([false, true, true]);
    // and only the first has an origin, since a pushed prompt never reaches telemetry
    expect(turns[0].attributes['user.id']).toBe('Zed');
    expect(turns[1].attributes['user.id']).toBeUndefined();
  });

  it('a worker step opens no exchange — it is background of the previous turn', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'AG' });
    telemetry.observe(result(0.1));

    // the worker keeps working after the result
    telemetry.observe({
      type: 'assistant',
      session_id: 's',
      parent_tool_use_id: 'AG',
      subagent_type: 'worker',
      message: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'from the worker' }], usage: {} },
    });
    // A second result is required so a spurious turn, had one been opened, would
    // actually CLOSE and reach the exporter. Without it the test passes even with
    // the guard removed (verified by mutation).
    telemetry.observe(result(0.2));

    expect(byName(telemetry.__testSpans(), 'agent.turn').length).toBe(1);
  });

  // A continuation span is born at the first signal, so its duration is a FLOOR:
  // the time between the prompt being pushed and that signal is excluded, and such
  // a turn can close reporting near-zero. Backdating is impossible — `startTime`
  // is fixed at creation — so the authoritative duration comes from the SDK.
  it('records the SDK-measured duration, not just the span-inferred one', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(mainStep());
    telemetry.observe({ ...result(0.4), duration_ms: 7300, duration_api_ms: 6100 });

    const turn = one(telemetry.__testSpans(), 'agent.turn');
    expect(turn.attributes['nanoclaw.turn_duration_ms']).toBe(7300);
    expect(turn.attributes['nanoclaw.duration_api_ms']).toBe(6100);
    // and it exceeds the span duration, which started only at the first signal
    expect(durationMs(turn)).toBeLessThan(7300);
  });

  it('a continuation exchange starts when the model starts thinking, not at first text', async () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(result(0.1));

    telemetry.observe({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50, estimated_tokens_delta: 50 });
    await sleep(60);
    telemetry.observe(mainStep());
    telemetry.observe(result(0.2));

    const cont = (byName(telemetry.__testSpans(), 'agent.turn') as any[]).find(
      (t) => t.attributes['nanoclaw.continuation'],
    );
    // without this anchor the turn would start at the assistant message and last ~0
    expect(durationMs(cont)).toBeGreaterThan(40);
  });
});

describe('failure taxonomy and GenAI conventions', () => {
  function toolFailureKind(failureText: string, extra: object = {}) {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'X' });
    telemetry.toolEnd({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_use_id: 'X',
      error: failureText,
      ...extra,
    });
    return one(telemetry.__testSpans(), 'tool.Bash').attributes['nanoclaw.failure_kind'];
  }

  // Knowing THAT something failed prioritizes nothing; knowing most failures are
  // tool_not_found points at a missing image dependency.
  it('classifies failures instead of leaving the cause trapped in a string', () => {
    expect(toolFailureKind('Exit code 127\n/bin/bash: python3: command not found')).toBe('tool_not_found');
    telemetry.__testReset();
    expect(toolFailureKind('Command timed out after 30s')).toBe('timeout');
    telemetry.__testReset();
    expect(toolFailureKind('EACCES: permission denied')).toBe('permission');
    telemetry.__testReset();
    expect(toolFailureKind('API error: 529 overloaded')).toBe('api_error');
    telemetry.__testReset();
    expect(toolFailureKind('prompt is too long for the context window')).toBe('context_overflow');
    telemetry.__testReset();
    expect(toolFailureKind('something unexpected', { is_interrupt: true })).toBe('interrupted');
  });

  it('uses the honest "other" class instead of forcing an existing label', () => {
    expect(toolFailureKind('something no pattern covers')).toBe('other');
  });

  // Two families that otherwise land in `other`: a tool result larger than the
  // harness accepts and a process killed from outside (exit 137).
  it('separates an oversized tool result and an external kill from "other"', () => {
    expect(toolFailureKind('File content (96356 tokens) exceeds maximum allowed tokens (25000).')).toBe(
      'output_too_large',
    );
    telemetry.__testReset();
    expect(toolFailureKind('Exit code 1\nClaude Code process exited with code 137. stderr: …')).toBe('killed');
    telemetry.__testReset();
    expect(toolFailureKind('Exit code 137')).toBe('killed');
  });

  it('emits OTel GenAI names alongside the OpenInference ones', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'T' });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'T' });
    telemetry.observe({
      type: 'assistant',
      session_id: 's',
      message: {
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    });
    telemetry.observe({
      type: 'result',
      subtype: 'success',
      result: 'hi',
      usage: { input_tokens: 3, output_tokens: 2 },
    });

    const spans = telemetry.__testSpans();
    const turn = one(spans, 'agent.turn');
    expect(turn.attributes['gen_ai.operation.name']).toBe('invoke_agent');
    // The turn's tokens are NOT under `gen_ai.usage.*` — a turn is not a
    // generation, and vendors that price per span billed it twice. See the
    // dedicated case in `token counting`.
    expect(turn.attributes['nanoclaw.turn_tokens_prompt']).toBe(3);

    const call = one(spans, 'llm.call');
    expect(call.attributes['gen_ai.operation.name']).toBe('chat');
    expect(call.attributes['gen_ai.request.model']).toBe('claude-sonnet-5');
    expect(call.attributes['gen_ai.system']).toBe('anthropic');
    // the OpenInference names stay, or Phoenix loses what it indexes
    expect(call.attributes['llm.model_name']).toBe('claude-sonnet-5');

    const tool = one(spans, 'tool.Bash');
    expect(tool.attributes['gen_ai.operation.name']).toBe('execute_tool');
    expect(tool.attributes['gen_ai.tool.name']).toBe('Bash');
    expect(tool.attributes['tool.name']).toBe('Bash');
  });
});

describe('origin and trace from inbound.db', () => {
  const REMOTE_TRACE_ID = 'a'.repeat(32);
  const REMOTE_SPAN_ID = 'b'.repeat(16);

  /** Seeds a claimed message, as the poll-loop would before query(). */
  function seedInbound(
    id: string,
    kind: string,
    content: object,
    status: 'processing' | 'completed',
    stampedAt = new Date(),
  ) {
    const { inbound, outbound } = db;
    inbound
      .prepare('INSERT OR REPLACE INTO messages_in (id, kind, timestamp, content) VALUES (?,?,?,?)')
      .run(id, kind, stampedAt.toISOString(), JSON.stringify(content));
    outbound
      .prepare('INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?,?,?)')
      .run(id, status, stampedAt.toISOString());
  }

  let db: { inbound: any; outbound: any };
  beforeEach(async () => {
    const conn = await import('./mailbox/sqlite/connection.js');
    db = conn.initTestSessionDb() as any;
  });

  // Without this, caller and delegate land in separate traces, and noticing that
  // the delegate cost far more than the turn that triggered it means comparing
  // tables by hand.
  it('hangs the turn in the trace of the agent that sent the message', () => {
    seedInbound(
      'm1',
      'chat',
      { text: 'do X', traceparent: `00-${REMOTE_TRACE_ID}-${REMOTE_SPAN_ID}-01` },
      'processing',
    );

    telemetry.turnStart({ prompt: '<message id="m1" from="some-group" sender="Unknown" time="t">do X</message>' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    const turn = one(telemetry.__testSpans(), 'agent.turn');
    expect(turn.spanContext().traceId).toBe(REMOTE_TRACE_ID);
    expect(parentIdOf(turn)).toBe(REMOTE_SPAN_ID);
    expect(turn.attributes['nanoclaw.trace_linked']).toBe(true);
  });

  it('a malformed traceparent breaks nothing — the turn becomes a root', () => {
    seedInbound('m2', 'chat', { text: 'hi', traceparent: 'garbage-not-w3c' }, 'processing');

    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    const turn = one(telemetry.__testSpans(), 'agent.turn');
    expect(turn.attributes['nanoclaw.trace_linked']).toBeUndefined();
    expect(turn.spanContext().traceId).not.toBe(REMOTE_TRACE_ID);
  });

  // The MCP server runs in ANOTHER process (StdioServerTransport) and cannot see
  // the runner's span — the context crosses through session_state, the same
  // channel `in_reply_to` already uses.
  it('publishes the traceparent to session_state for the MCP process to read', async () => {
    const st = await import('./telemetry-state.js');
    expect(st.getTurnTraceparent()).toBeNull(); // no open turn

    telemetry.turnStart({ prompt: 'x' });
    expect(st.getTurnTraceparent()).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);

    // turn closed: a late send must not attach itself to it
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });
    expect(st.getTurnTraceparent()).toBeNull();
  });

  // A continuation's question never arrives on the SDK stream; it comes from here.
  it('recovers question, trigger and user from a continuation exchange', () => {
    telemetry.turnStart({ prompt: 'first prompt' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    seedInbound('m3', 'chat-sdk', { text: 'Which fabrics for curtains?', senderName: 'Jane Doe' }, 'completed');

    telemetry.observe({
      type: 'assistant',
      session_id: 's',
      message: { model: 'm', content: [{ type: 'text', text: 'it depends' }], usage: { input_tokens: 7 } },
    });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'it depends', usage: { input_tokens: 7 } });

    const cont = (byName(telemetry.__testSpans(), 'agent.turn') as any[]).find(
      (t) => t.attributes['nanoclaw.continuation'],
    );
    expect(cont.attributes['input.value']).toBe('Which fabrics for curtains?');
    expect(cont.attributes['nanoclaw.trigger']).toBe('message');
    expect(cont.attributes['user.id']).toBe('Jane Doe');
    expect(cont.attributes['nanoclaw.origin_lookup']).toBe('hit');
  });

  it('a message from another agent is no user, but still classifies the trigger', () => {
    telemetry.turnStart({ prompt: 'first prompt' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    seedInbound('m4', 'task', { prompt: 'weekly report' }, 'completed');

    telemetry.observe({
      type: 'assistant',
      session_id: 's',
      message: { model: 'm', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 7 } },
    });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 7 } });

    const cont = (byName(telemetry.__testSpans(), 'agent.turn') as any[]).find(
      (t) => t.attributes['nanoclaw.continuation'],
    );
    expect(cont.attributes['nanoclaw.trigger']).toBe('task');
    expect(cont.attributes['user.id']).toBeUndefined();
  });

  /** The continuation exchange every test below drives, after `seedInbound`. */
  function continuationExchange() {
    telemetry.observe({
      type: 'assistant',
      session_id: 's',
      message: { model: 'm', content: [{ type: 'text', text: 'replying' }], usage: { input_tokens: 7 } },
    });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'replying', usage: { input_tokens: 7 } });
  }

  const continuationTurn = () =>
    (byName(telemetry.__testSpans(), 'agent.turn') as any[]).find((t) => t.attributes['nanoclaw.continuation']);

  // DEFECT: `pendingSignalAt` was armed ONLY by `thinking_tokens`, so a
  // continuation without extended thinking had no early signal and its span was
  // born at the first assistant message — excluding the model latency of the
  // whole exchange — and most continuations think nothing. Any main-thread
  // signal that precedes the reply arms it now.
  it('starts a continuation at the first SDK signal, with no thinking involved', async () => {
    telemetry.turnStart({ prompt: 'first prompt' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    seedInbound('c1', 'chat-sdk', { text: 'what now?', senderName: 'Jane Doe' }, 'completed');
    // The SDK stirs — NOT a `thinking_tokens` message, which is the whole point.
    telemetry.observe({ type: 'system', subtype: 'status', session_id: 's' });
    await sleep(40);
    continuationExchange();

    // Born at the assistant message this span would be near-instant.
    expect(durationMs(continuationTurn())).toBeGreaterThan(30);
  });

  // DEFECT: a continuation reported no queue latency at all, while every turn
  // opened by `query()` did. Since continuations are the bulk of traffic, the
  // user-perceived latency of most turns was invisible.
  //
  // It is measured from the turn's own start, not from a claim instant: the
  // poll loop marks the row `completed` on the same tick as `query.push()`, so a
  // continuation never sees a `processing` row and a claim-based reading yields
  // nothing.
  //
  // The second half is the REGRESSION GUARD that matters: this must not cost the
  // origin lookup the batch it needs, which a second `readClaimedMessages` would,
  // since that function consumes `attributedIds`.
  it('stamps queue latency on a continuation without costing it its origin', async () => {
    telemetry.turnStart({ prompt: 'first prompt' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    // ENQUEUED 3s ago and CLAIMED now — the shape `seedInbound` cannot express, and
    // the only one where the wait is a real number. The claim is what the lookup
    // window filters on, so a message merely dated in the past falls outside it.
    db.inbound
      .prepare('INSERT INTO messages_in (id, kind, timestamp, content) VALUES (?,?,?,?)')
      .run(
        'c3',
        'chat-sdk',
        new Date(Date.now() - 3_000).toISOString(),
        JSON.stringify({ text: 'how long did I wait?', senderName: 'Jane Doe' }),
      );
    db.outbound
      .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?,?,?)')
      .run('c3', 'completed', new Date().toISOString());
    telemetry.observe({ type: 'system', subtype: 'status', session_id: 's' });
    continuationExchange();

    const a = continuationTurn().attributes;
    expect(a['nanoclaw.inbound_wait_ms']).toBeGreaterThanOrEqual(2_900);
    expect(a['nanoclaw.origin_lookup']).toBe('hit');
    expect(a['input.value']).toBe('how long did I wait?');
    expect(a['user.id']).toBe('Jane Doe');
  });

  // The poll loop claims and pushes a message that arrives WHILE a turn runs, so
  // its `status_changed` lands inside that turn. A window opening at the turn's
  // END misses every such message, leaving continuations with no origin that
  // did have a message in inbound.db. The window opens at the previous
  // turn's START; `attributedIds` keeps the previous batch from being reused.
  it('attributes a message claimed during the previous turn to the next exchange', async () => {
    telemetry.turnStart({ prompt: 'first prompt' });
    // Arrives mid-turn: claimed now, while the first turn is still open.
    seedInbound('m6', 'chat-sdk', { text: 'arrived mid-turn', senderName: 'Jane Doe' }, 'completed');
    await sleep(5);
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    telemetry.observe({
      type: 'assistant',
      session_id: 's',
      message: { model: 'm', content: [{ type: 'text', text: 'replying' }], usage: { input_tokens: 7 } },
    });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'replying', usage: { input_tokens: 7 } });

    const cont = (byName(telemetry.__testSpans(), 'agent.turn') as any[]).find(
      (t) => t.attributes['nanoclaw.continuation'],
    );
    expect(cont.attributes['nanoclaw.origin_lookup']).toBe('hit');
    expect(cont.attributes['input.value']).toBe('arrived mid-turn');
  });

  /** A continuation exchange with nothing in inbound.db to explain it. */
  function continuationWithoutMessage(resultText: string) {
    telemetry.observe({
      type: 'assistant',
      session_id: 's',
      message: { model: 'm', content: [{ type: 'text', text: resultText }], usage: { input_tokens: 7 } },
    });
    telemetry.observe({ type: 'result', subtype: 'success', result: resultText, usage: { input_tokens: 7 } });
  }
  const continuationTurns = () =>
    (byName(telemetry.__testSpans(), 'agent.turn') as any[]).filter((t) => t.attributes['nanoclaw.continuation']);

  // A miss is still a trigger. Many misses follow
  // a `delivery.dropped`: the runner's wrap-nudge pushed its own prompt, and the
  // exchange is the model answering the RUNNER. Without the label these turns
  // had no trigger at all, and the cost of nudging was not a GROUP BY.
  it('labels a continuation with no message as nudge when the runner nudged', () => {
    telemetry.turnStart({ prompt: 'first prompt' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'no tag', usage: { input_tokens: 1 } });
    telemetry.dropped(7);
    continuationWithoutMessage('<internal>ok, nothing to send</internal>');

    const [cont] = continuationTurns();
    expect(cont.attributes['nanoclaw.origin_lookup']).toBe('miss');
    expect(cont.attributes['nanoclaw.trigger']).toBe('nudge');
  });

  // The other half: the SDK resumed on its own — a Monitor event, a background
  // task settling. Honest bucket, not a guess at which.
  it('labels it background when nothing nudged', () => {
    telemetry.turnStart({ prompt: 'first prompt' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });
    continuationWithoutMessage('woke up on my own');

    const [cont] = continuationTurns();
    expect(cont.attributes['nanoclaw.trigger']).toBe('background');
  });

  // The flag is consumed by the exchange it explains. Left set, every later
  // silent exchange would read as a nudge too.
  it('the nudge flag does not leak into the exchange after it', () => {
    telemetry.turnStart({ prompt: 'first prompt' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'no tag', usage: { input_tokens: 1 } });
    telemetry.dropped(7);
    continuationWithoutMessage('first continuation');
    continuationWithoutMessage('second continuation');

    const [a, b] = continuationTurns();
    expect(a.attributes['nanoclaw.trigger']).toBe('nudge');
    expect(b.attributes['nanoclaw.trigger']).toBe('background');
  });

  // The initial batch is marked `completed` on the `result` event, AFTER turnEnd —
  // without being consumed in turnStart it would fall into the next continuation
  // window.
  it('does not recycle a message that already belonged to the previous turn', () => {
    seedInbound('m5', 'chat-sdk', { text: 'original question', senderName: 'Jane Doe' }, 'processing');
    telemetry.turnStart({ prompt: 'x' });
    // simulates the markCompleted that runs just after the result
    seedInbound('m5', 'chat-sdk', { text: 'original question', senderName: 'Jane Doe' }, 'completed');
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    telemetry.observe({
      type: 'assistant',
      session_id: 's',
      message: { model: 'm', content: [{ type: 'text', text: 'next' }], usage: { input_tokens: 7 } },
    });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'next', usage: { input_tokens: 7 } });

    const cont = (byName(telemetry.__testSpans(), 'agent.turn') as any[]).find(
      (t) => t.attributes['nanoclaw.continuation'],
    );
    expect(cont.attributes['input.value']).toBeUndefined();
    expect(cont.attributes['nanoclaw.origin_lookup']).toBe('miss');
  });
});

describe('reasoning-text opt-in', () => {
  // Changes INFERENCE configuration, not just what is reported. A group without
  // the opt-in must send exactly today's request — hence an object to spread
  // rather than `thinking: undefined`.
  it('adds no thinking key without an explicit opt-in', () => {
    const opt = telemetry.thinkingOption();
    expect('thinking' in opt).toBe(false);
    expect({ effort: 'medium', ...opt }).toEqual({ effort: 'medium' });
  });
});

describe('turn cost', () => {
  // DEFECT, two generations. First: `nanoclaw.cost_usd` recorded
  // `result.total_cost_usd`, a RUNNING total, so summing turns summed counters and
  // the "most expensive" turn was merely the last of a long process. Second: the
  // cursor was persisted across containers on the belief that the total belonged
  // to the SESSION. It belongs to the PROCESS — it drops on a fresh container's
  // first turn and never inside a live one — so a restart subtracted a dead
  // process's total from a live turn or labelled an exact number a ceiling.
  const assistant = {
    type: 'assistant',
    session_id: 's1',
    message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }], usage: {} },
  };
  const result = (total: number) => ({
    type: 'result',
    subtype: 'success',
    result: 'ok',
    usage: {},
    total_cost_usd: total,
  });
  const turnAttrs = () => (byName(telemetry.__testSpans(), 'agent.turn') as any[]).map((t) => t.attributes);

  // 0.51 − 0.39 is 0.12000000000000005 in float, so this case also proves the
  // rounding.
  it('charges a continuation the difference, not the process running total', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(assistant);
    telemetry.observe(result(0.39));
    // Two continuation exchanges in the SAME process.
    telemetry.observe(assistant);
    telemetry.observe(result(0.51));
    telemetry.observe(assistant);
    telemetry.observe(result(0.52));

    const [first, second, third] = turnAttrs();
    expect(first['nanoclaw.cost_usd']).toBe(0.39);
    expect(second['nanoclaw.cost_usd']).toBe(0.12);
    expect(second['nanoclaw.session_cost_usd']).toBe(0.51);
    expect(third['nanoclaw.cost_usd']).toBe(0.01);
    // No basis attribute any more: every turn is exact.
    expect(second['nanoclaw.cost_basis']).toBeUndefined();
  });

  // A new `query()` is a new `claude` process and its total starts from zero,
  // whatever the previous process had accumulated. The first turn pays `total`
  // in full — that IS the turn's cost, not a ceiling.
  it('a new query() pays its total in full, subtracting nothing from the dead process', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(assistant);
    telemetry.observe(result(10.5));
    telemetry.turnStart({ prompt: 'y' });
    telemetry.observe(assistant);
    telemetry.observe(result(0.3));

    const [, second] = turnAttrs();
    expect(second['nanoclaw.cost_usd']).toBe(0.3);
    expect(second['nanoclaw.cost_cursor_reset']).toBeUndefined();
  });

  // The total dropping WITHOUT a new query() should not happen. If it does, a
  // negative cost would vanish in a sum and poison the average — the turn pays
  // `total` and says why.
  it('a total that drops mid-process is flagged, never negative', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(assistant);
    telemetry.observe(result(10.5));
    telemetry.observe(assistant);
    telemetry.observe(result(3.0));

    const [, second] = turnAttrs();
    expect(second['nanoclaw.cost_usd']).toBe(3.0);
    expect(second['nanoclaw.cost_cursor_reset']).toBe(true);
  });
});

/**
 * Turn API time — the same defect as `turn cost`, in a second field, found later.
 *
 * `result.duration_api_ms` is a RUNNING total of the process. Written raw it
 * described nothing: it EXCEEDED the turn's own `turn_duration_ms`, which cannot
 * happen for one turn since API time is a COMPONENT of the turn's wall clock,
 * and it climbed monotonically across the exchanges of a `query()` while
 * `turn_duration_ms`, a genuine per-exchange value, did not.
 */
describe('turn API time', () => {
  const assistant = {
    type: 'assistant',
    session_id: 's1',
    message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }], usage: {} },
  };
  const result = (apiMs: number) => ({
    type: 'result',
    subtype: 'success',
    result: 'ok',
    usage: {},
    duration_api_ms: apiMs,
  });
  const turnAttrs = () => (byName(telemetry.__testSpans(), 'agent.turn') as any[]).map((t) => t.attributes);

  it('charges a continuation the difference, not the process running total', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(assistant);
    telemetry.observe(result(4_485));
    telemetry.observe(assistant);
    telemetry.observe(result(10_158));
    telemetry.observe(assistant);
    telemetry.observe(result(12_380));

    const [first, second, third] = turnAttrs();
    expect(first['nanoclaw.duration_api_ms']).toBe(4_485);
    expect(second['nanoclaw.duration_api_ms']).toBe(5_673);
    expect(third['nanoclaw.duration_api_ms']).toBe(2_222);
    // The raw running total stays available, under the name that says so.
    expect(third['nanoclaw.session_duration_api_ms']).toBe(12_380);
  });

  // The invariant the raw value broke: API time is part of the turn's wall clock,
  // so it can never exceed it.
  it('never reports more API time than the turn itself lasted', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(assistant);
    telemetry.observe({ ...result(4_485), duration_ms: 4_509 });
    telemetry.observe(assistant);
    telemetry.observe({ ...result(10_158), duration_ms: 5_695 });

    for (const a of turnAttrs()) {
      expect(a['nanoclaw.duration_api_ms']).toBeLessThanOrEqual(a['nanoclaw.turn_duration_ms']);
    }
  });

  it('a new query() pays its total in full, subtracting nothing from the dead process', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(assistant);
    telemetry.observe(result(224_875));
    telemetry.turnStart({ prompt: 'y' });
    telemetry.observe(assistant);
    telemetry.observe(result(300));

    const [, second] = turnAttrs();
    expect(second['nanoclaw.duration_api_ms']).toBe(300);
    expect(second['nanoclaw.api_cursor_reset']).toBeUndefined();
  });

  // A drop mid-process should not happen; if it does, a negative duration would
  // vanish in a sum instead of being noticed.
  it('a total that drops mid-process is flagged, never negative', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(assistant);
    telemetry.observe(result(10_500));
    telemetry.observe(assistant);
    telemetry.observe(result(3_000));

    const [, second] = turnAttrs();
    expect(second['nanoclaw.duration_api_ms']).toBe(3_000);
    expect(second['nanoclaw.api_cursor_reset']).toBe(true);
  });
});

/**
 * The delivery leg. Before it existed most deliveries had no span at all, so the
 * turn closed with status OK while the user received nothing.
 */
describe('delivery', () => {
  const sendDelivery = (over: Partial<Parameters<typeof telemetry.delivery>[0]> = {}) =>
    telemetry.delivery({
      destinationType: 'channel',
      channelType: 'telegram',
      bodyChars: 42,
      threadResolved: true,
      ...over,
    });

  // The poll loop passes the moment it started the outbound write, so the span's
  // duration is the delivery latency instead of an instant.
  it('covers the outbound write when the caller reports when it started', async () => {
    telemetry.turnStart({ prompt: 'x' });
    // The turn needs elapsed time of its own, or the clamp correctly collapses the
    // backdating: a child may not start before its parent.
    await sleep(60);
    sendDelivery({ startedAt: Date.now() - 50 });

    const send = one(telemetry.__testSpans(), 'delivery.send');
    expect(durationMs(send)).toBeGreaterThanOrEqual(45);
    expect(send.status.code).not.toBe(2);
  });

  it('is still emitted as an instant when no start is reported', () => {
    telemetry.turnStart({ prompt: 'x' });
    sendDelivery();
    const send = one(telemetry.__testSpans(), 'delivery.send');
    // One `now` for both ends: an instant, exactly.
    expect(durationMs(send)).toBe(0);
  });

  // DEFECT: these point spans shipped with no `openinference.span.kind`, so
  // Phoenix filed every one of them under UNKNOWN and they dropped out of every
  // kind-filtered view — while their neighbours `agent.compact` and `task.*`
  // declared CHAIN. Covers every `pointSpan` caller that had none.
  it('every point span declares its kind, so none lands under UNKNOWN', () => {
    telemetry.turnStart({ prompt: 'x' });
    sendDelivery();
    telemetry.dropped(120);
    telemetry.runnerError('poll', new Error('failed'));
    telemetry.providerBlocked({ message: 'rate limit', retryable: false });

    for (const spanName of ['delivery.send', 'delivery.dropped', 'runner.error', 'provider.blocked']) {
      expect(one(telemetry.__testSpans(), spanName).attributes['openinference.span.kind']).toBe('CHAIN');
    }
  });

  it('emits one span per write, with the destination identified', () => {
    telemetry.turnStart({ prompt: 'x' });
    sendDelivery();

    const span = one(telemetry.__testSpans(), 'delivery.send');
    expect(span.attributes['nanoclaw.destination_type']).toBe('channel');
    expect(span.attributes['nanoclaw.channel_type']).toBe('telegram');
    expect(span.attributes['nanoclaw.body_chars']).toBe(42);
    expect(span.attributes['nanoclaw.thread_resolved']).toBe(true);
  });

  // A write that threw must not count as delivered — it is exactly the "answer
  // never arrived" case this instrumentation exists to find.
  it('a failed write becomes an error span and does not count as delivered', () => {
    telemetry.turnStart({ prompt: 'x' });
    sendDelivery({ error: 'disk I/O error' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 });

    const span = one(telemetry.__testSpans(), 'delivery.send');
    expect(span.status.code).toBe(2); // ERROR
    expect(one(telemetry.__testSpans(), 'agent.turn').attributes['nanoclaw.delivered_count']).toBe(0);
  });

  // Zero is the value worth searching for, so it is always written — its absence
  // could not distinguish "did not deliver" from "turn predates the instrument".
  it('counts the turn deliveries, zero included', () => {
    telemetry.turnStart({ prompt: 'x' });
    sendDelivery();
    sendDelivery({ channelType: 'discord' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 });
    expect(one(telemetry.__testSpans(), 'agent.turn').attributes['nanoclaw.delivered_count']).toBe(2);

    telemetry.__testReset();
    telemetry.turnStart({ prompt: 'y' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 });
    expect(one(telemetry.__testSpans(), 'agent.turn').attributes['nanoclaw.delivered_count']).toBe(0);
  });

  // DEFECT: `delivered_count` counted only the poll-loop leg, so turns that
  // answered via `send_message` — which writes from inside the MCP server and
  // never passes through `sendToDestination` — reported zero. A healthy turn
  // looked like a lost delivery.
  it('counts delivery via the MCP tools, which bypass the poll-loop', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ tool_use_id: 't1', tool_name: 'mcp__nanoclaw__send_message' });
    telemetry.toolEnd({ tool_use_id: 't1', hook_event_name: 'PostToolUse' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 });

    expect(one(telemetry.__testSpans(), 'agent.turn').attributes['nanoclaw.delivered_count']).toBe(1);
  });

  // A failed tool delivered nothing.
  it('a failed send_message does not count as delivered', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ tool_use_id: 't1', tool_name: 'mcp__nanoclaw__send_message' });
    telemetry.toolEnd({ tool_use_id: 't1', hook_event_name: 'PostToolUseFailure', error: 'boom' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 });

    expect(one(telemetry.__testSpans(), 'agent.turn').attributes['nanoclaw.delivered_count']).toBe(0);
  });

  // Delivery happens AFTER turnEnd. Without the detached context the span would
  // become a one-span root trace and the answer would vanish from the trace that
  // produced it.
  it('post-turn delivery stays in the turn trace, flagged as detached', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 });
    sendDelivery();

    const parentTurn = one(telemetry.__testSpans(), 'agent.turn');
    const send = one(telemetry.__testSpans(), 'delivery.send');
    expect(parentIdOf(send)).toBe(parentTurn.spanContext().spanId);
    expect(send.attributes['nanoclaw.detached_from_turn']).toBe(true);
  });

  // Status OK on purpose: the real frequency is unknown, since the warning only
  // ever existed in the container log, so marking ERROR could inflate the rate
  // without evidence. Queryable now, promotable later.
  it('text delivered to nobody is a neutral span, not an error', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.dropped(310);

    const span = one(telemetry.__testSpans(), 'delivery.dropped');
    expect(span.attributes['nanoclaw.dropped']).toBe(true);
    expect(span.attributes['nanoclaw.text_chars']).toBe(310);
    expect(span.status.code).not.toBe(2);
  });
});

/**
 * The `catch` blocks the runner swallowed. The asymmetry that exposed them: tool
 * spans carried many errors while turns carried almost none — runner
 * infrastructure failures had nowhere to appear, and container logs die with
 * `--rm`.
 */
describe('runner errors', () => {
  // The class comes from text: a runner error has no exit code (that is a
  // tool-error shape, extracted in `toolEnd`), so the classifier works on the
  // message — which is what the poll-loop `catch` blocks hold.
  it('a fatal failure becomes a classified error span', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.runnerError('query', new Error('API Error: 529 overloaded'), { fatal: true });

    const span = one(telemetry.__testSpans(), 'runner.error');
    expect(span.attributes['nanoclaw.stage']).toBe('query');
    expect(span.attributes['nanoclaw.failure_kind']).toBe('api_error');
    expect(span.status.code).toBe(2);
  });

  // A best-effort helper fails for a benign reason and returns null. Visible, but
  // without polluting the error dashboard — hence the graded severity.
  it('a helper failure stays visible without counting as an error', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.runnerError('outbound-verify', new Error('no such table'));

    const span = one(telemetry.__testSpans(), 'runner.error');
    expect(span.attributes['nanoclaw.stage']).toBe('outbound-verify');
    expect(span.status.code).not.toBe(2);
    // With no status, the message survives only as an attribute.
    expect(span.attributes['nanoclaw.error_message']).toContain('no such table');
  });
});

// `turn_duration_ms` covers `query()` → `result`. Everything before it — the host
// sweep, container spawn, poll interval — was invisible, so a fast turn answered
// minutes after the question was indistinguishable from one answered at once.
// These cases lock down the other half of perceived latency.
//
// There is deliberately no no-op case: the computation lives INSIDE `turnStart`,
// after `if (!rt) return`, so without `otel.json` it is unreachable by
// construction and a test would only restate the function's first line.
describe('queue latency', () => {
  let db: { inbound: any; outbound: any };
  let nowMs: number;

  beforeEach(async () => {
    const conn = await import('./mailbox/sqlite/connection.js');
    db = conn.initTestSessionDb() as any;
    nowMs = Date.now();
  });

  /**
   * Seeds a claimed message with all three instants controlled, each in ms BEFORE
   * `nowMs`. The resulting wait is exact rather than approximate: both sides of
   * the subtraction derive from the same `nowMs`, so it does not depend on when
   * `turnStart` actually runs.
   */
  function seedWaitRow(
    id: string,
    opts: { enqueuedAgoMs: number; dueAgoMs?: number; claimedAgoMs: number; kind?: string },
  ) {
    const isoAgo = (agoMs: number) => new Date(nowMs - agoMs).toISOString();
    db.inbound
      .prepare('INSERT OR REPLACE INTO messages_in (id, kind, timestamp, process_after, content) VALUES (?,?,?,?,?)')
      .run(
        id,
        opts.kind ?? 'chat',
        isoAgo(opts.enqueuedAgoMs),
        opts.dueAgoMs === undefined ? null : isoAgo(opts.dueAgoMs),
        JSON.stringify({ text: 'hi' }),
      );
    db.outbound
      .prepare("INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?,'processing',?)")
      .run(id, isoAgo(opts.claimedAgoMs));
  }

  function runTurn() {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });
    return one(telemetry.__testSpans(), 'agent.turn');
  }

  it('measures the wait between due time and claim', () => {
    seedWaitRow('m1', { enqueuedAgoMs: 5000, claimedAgoMs: 0 });

    const t = runTurn();
    expect(t.attributes['nanoclaw.inbound_wait_ms']).toBe(5000);
    // Same clock on both sides: small and non-negative.
    expect(t.attributes['nanoclaw.runner_lag_ms']).toBeLessThan(1000);
    expect(t.attributes['nanoclaw.inbound_clock_skew']).toBeUndefined();
  });

  // The case that separates a number from garbage. `insertTaskRow` writes
  // `timestamp` when a task is ARMED and `process_after` when it comes DUE; using
  // the former invents waits of days on a recurring task.
  it('counts from the due time, not from when the task was armed', () => {
    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
    seedWaitRow('m1', { enqueuedAgoMs: THREE_DAYS, dueAgoMs: 2000, claimedAgoMs: 0, kind: 'task' });

    const t = runTurn();
    expect(t.attributes['nanoclaw.inbound_wait_ms']).toBe(2000);
    expect(t.attributes['nanoclaw.inbound_wait_ms']).not.toBe(THREE_DAYS);
  });

  // The read is `ORDER BY timestamp`, which is NOT due order: the task armed
  // first comes due last. Here the longest wait is on the SECOND row, so taking
  // the first would return 1000.
  it('reports the batch\u2019s longest wait, not the first row\u2019s', () => {
    seedWaitRow('old-but-recent', { enqueuedAgoMs: 100000, dueAgoMs: 1000, claimedAgoMs: 0 });
    seedWaitRow('new-but-old', { enqueuedAgoMs: 5000, claimedAgoMs: 0 });

    expect(runTurn().attributes['nanoclaw.inbound_wait_ms']).toBe(5000);
  });

  // `dueAtMs` is on the HOST clock and `claimedAtMs` on the CONTAINER clock. A
  // negative wait is impossible and means the clocks drifted, not latency.
  it('clamps a negative wait and flags clock skew', () => {
    seedWaitRow('m1', { enqueuedAgoMs: 0, claimedAgoMs: 5000 });

    const t = runTurn();
    expect(t.attributes['nanoclaw.inbound_wait_ms']).toBe(0);
    expect(t.attributes['nanoclaw.inbound_clock_skew']).toBe(true);
  });

  // Sub-second negatives are ordinary noise; flagging them would make the signal
  // ignorable exactly when it matters.
  it('a millisecond negative raises no clock alarm', () => {
    seedWaitRow('m1', { enqueuedAgoMs: 0, claimedAgoMs: 50 });

    const t = runTurn();
    expect(t.attributes['nanoclaw.inbound_wait_ms']).toBe(0);
    expect(t.attributes['nanoclaw.inbound_clock_skew']).toBeUndefined();
  });

  // ABSENT, not zero — the deliberate opposite of `delivered_count`. With no
  // claimed message there is no wait to measure, and `0` would assert there was
  // none.
  it('invents no zero wait when no message was claimed', () => {
    const t = runTurn();
    expect(t.attributes['nanoclaw.inbound_wait_ms']).toBeUndefined();
    expect(t.attributes['nanoclaw.runner_lag_ms']).toBeUndefined();
    // Container age does not depend on a message: always present.
    expect(t.attributes['nanoclaw.runner_uptime_ms']).toBeGreaterThanOrEqual(0);
  });

  // A continuation exchange opens its turn from `assistantStep`, NOT `turnStart`,
  // so it gets no wait attributes: a message pushed with `query.push()` waits on
  // the model, not the host queue. But container age depends on no message at all,
  // and continuations are the bulk of the traffic — stamping it only in
  // `turnStart` left it missing from nearly every turn.
  it('a continuation turn also carries the container age', () => {
    const assistantMsg = {
      type: 'assistant',
      session_id: 's',
      message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1 } },
    };
    telemetry.observe(assistantMsg);
    telemetry.observe({ type: 'result', subtype: 'success', result: 'hi', usage: { input_tokens: 1 } });

    const t = one(telemetry.__testSpans(), 'agent.turn');
    expect(t.attributes['nanoclaw.continuation']).toBe(true);
    expect(t.attributes['nanoclaw.runner_uptime_ms']).toBeGreaterThanOrEqual(0);
    // The wait stays absent: deliberate scope, not an oversight.
    expect(t.attributes['nanoclaw.inbound_wait_ms']).toBeUndefined();
  });

  // Same placement rule for the turn's GenAI identity: a backend that reads OTel
  // GenAI classifies a turn by `gen_ai.operation.name`, so a continuation without
  // it was a different kind of span to it than a `turnStart` turn.
  it('a continuation turn carries the same GenAI identity as a query() turn', () => {
    telemetry.turnStart({ prompt: 'first prompt' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });
    const assistantMsg = {
      type: 'assistant',
      session_id: 's',
      message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1 } },
    };
    telemetry.observe(assistantMsg);
    telemetry.observe({ type: 'result', subtype: 'success', result: 'hi', usage: { input_tokens: 1 } });

    const turns = byName(telemetry.__testSpans(), 'agent.turn') as any[];
    expect(turns.length).toBe(2);
    const [firstTurn, continuationTurn] = turns;
    expect(continuationTurn.attributes['nanoclaw.continuation']).toBe(true);
    expect(continuationTurn.attributes['gen_ai.operation.name']).toBe('invoke_agent');
    expect(typeof continuationTurn.attributes['gen_ai.agent.name']).toBe('string');
    expect(continuationTurn.attributes['gen_ai.agent.name']).toBe(firstTurn.attributes['gen_ai.agent.name']);
  });
});

// A quota block sends the system into a retry loop that grows the context until
// it overflows, so the `context_overflow` burst that follows is the SYMPTOM. The
// cause had no class of its own and nowhere to appear.
describe('quota block', () => {
  function classify(failureText: string) {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'X' });
    telemetry.toolEnd({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_use_id: 'X',
      error: failureText,
    });
    return one(telemetry.__testSpans(), 'tool.Bash').attributes['nanoclaw.failure_kind'];
  }

  // The provider's own wording, verbatim — it otherwise lands in `other`.
  it('recognizes the session limit that filled the "other" bucket', () => {
    expect(classify("You've hit your session limit · resets 11:40am (UTC)")).toBe('rate_limit');
  });

  it('separates out of credits from a window limit', () => {
    expect(classify('Out of credits [weekly] (resets 2030-01-01T00:00:00.000Z)')).toBe('quota');
    telemetry.__testReset();
    expect(classify('Rate limit [5h] (resets 2030-01-01T00:00:00.000Z)')).toBe('rate_limit');
  });

  // Rule order is the easy thing to get wrong: `permission` matches `forbidden`,
  // and a billing block arrives as "403 billing_error". Placed after `permission`
  // it would send someone investigating access instead of the invoice.
  it('a billing 403 is quota, not permission', () => {
    expect(classify('403 Forbidden: billing_error')).toBe('quota');
  });

  it('429 is now a block, not a server failure', () => {
    expect(classify('429 Too Many Requests')).toBe('rate_limit');
  });

  // The new boundary: `api_error` is the SERVER failing. Without this, moving
  // `rate.?limit` out could have taken the 5xx cases with it.
  it('a server failure stays in api_error', () => {
    expect(classify('API error: 529 overloaded')).toBe('api_error');
    telemetry.__testReset();
    expect(classify('503 Service Unavailable')).toBe('api_error');
  });

  it('becomes a span carrying the provider\u2019s structured classification', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.providerBlocked({
      message: 'Out of credits [weekly] (resets 2030-01-01T00:00:00.000Z)',
      retryable: false,
      classification: 'quota',
    });

    const span = one(telemetry.__testSpans(), 'provider.blocked');
    expect(span.attributes['nanoclaw.classification']).toBe('quota');
    expect(span.attributes['nanoclaw.retryable']).toBe(false);
    expect(span.attributes['nanoclaw.failure_kind']).toBe('quota');
    expect(span.attributes['nanoclaw.resets_at']).toBe('2030-01-01T00:00:00.000Z');
    expect(span.status.code).toBe(2);
  });

  // The poll-loop's `case 'error'` also fires for every API retry. A span per
  // attempt would be noise, and the `apiRetries` counter already covers it.
  it('an API retry does not become a block span', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.providerBlocked({ message: 'API retry', retryable: true });

    expect(byName(telemetry.__testSpans(), 'provider.blocked').length).toBe(0);
  });

  // A local time with NO date cannot be reconstructed without guessing the day.
  // An absent attribute beats a wrong one.
  it('invents no date from a local time', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.providerBlocked({
      message: "You've hit your session limit · resets 11:40am (UTC)",
      retryable: false,
    });

    const span = one(telemetry.__testSpans(), 'provider.blocked');
    expect(span.attributes['nanoclaw.resets_at']).toBeUndefined();
    // The class, unlike the timestamp, does come from the text.
    expect(span.attributes['nanoclaw.failure_kind']).toBe('rate_limit');
  });
});

// Three places where the span told a small lie: an error where nothing failed, a
// counter that vanished on an interrupted turn, and a missing dependency that did
// not say "command not found".
describe('turn span fidelity', () => {
  function toolFailureKind(failureText: string, extra: object = {}) {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'X' });
    telemetry.toolEnd({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_use_id: 'X',
      error: failureText,
      ...extra,
    });
    return one(telemetry.__testSpans(), 'tool.Bash');
  }

  // Spans carried status ERROR purely for asking a human for authorization. That
  // is the approval flow working — counting it as an error inflates the failure
  // rate exactly when the system is correct.
  it('a pending approval is its own class and does NOT count as an error', () => {
    const span = toolFailureKind(
      'Exit code 1\nerror (approval-pending): Approval request sent to admin. You will be notified of the result.',
    );
    expect(span.attributes['nanoclaw.failure_kind']).toBe('approval_pending');
    expect(span.status.code).not.toBe(2);
  });

  // The other half of the same change: only approval escapes the error status.
  it('a real tool failure is still an error', () => {
    const span = toolFailureKind('Exit code 127\n/bin/bash: python3: command not found');
    expect(span.attributes['nanoclaw.failure_kind']).toBe('tool_not_found');
    expect(span.status.code).toBe(2);
  });

  it('a politely failing binary is a missing dependency, not "other"', () => {
    expect(
      toolFailureKind('pdftoppm is not installed. Install poppler-utils to enable PDF rendering.').attributes[
        'nanoclaw.failure_kind'
      ],
    ).toBe('tool_not_found');
    telemetry.__testReset();
    expect(toolFailureKind("ModuleNotFoundError: No module named 'pandas'").attributes['nanoclaw.failure_kind']).toBe(
      'tool_not_found',
    );
  });

  // The `other` long tail must not move — an over-broad regex would be worse than
  // the gap it fixes.
  it('an error in the agent\u2019s own code stays in "other"', () => {
    expect(
      toolFailureKind('Exit code 1\nTraceback (most recent call last):\nKeyError: 0').attributes[
        'nanoclaw.failure_kind'
      ],
    ).toBe('other');
  });

  // Two paths close a turn WITHOUT a `result` message and both lost the counters:
  // container shutdown, and replacing a pending turn.
  //
  // Shutdown is deliberately not tested here: `shutdownTelemetry()` calls
  // `provider.shutdown()`, which tears down the in-memory exporter for the whole
  // process — after it `__testSpans()` returns zero and every later test in the
  // file would be blind. That path is locked by a placement assertion in
  // `telemetry-integration.test.ts`.
  it('a turn replaced without a result preserves the counters', () => {
    telemetry.turnStart({ prompt: 'first' });
    telemetry.delivery({ destinationType: 'channel', channelType: 'telegram', bodyChars: 10, threadResolved: true });
    // A new turn with the previous one still open — the pending one is force-closed.
    telemetry.turnStart({ prompt: 'second' });

    const abortedSpan = (byName(telemetry.__testSpans(), 'agent.turn') as any[]).find(
      (t) => t.status.message === 'turn replaced without a result',
    );
    expect(abortedSpan).toBeDefined();
    expect(abortedSpan.attributes['nanoclaw.delivered_count']).toBe(1);
  });
});

// A narrow `Record<string, string>` on the span helper forced callers to wrap
// numbers in `String()`, and the collector stored them as TEXT. The span still
// appeared, but the attribute stopped sorting numerically — with mixed digit
// counts the maximum sinks below every value starting with a higher digit.
//
// `toBe` is strict, which is the whole point here: it fails on '123' where 123 is
// expected. A loose comparison would let the defect back in silently.
describe('numeric attributes stay numeric', () => {
  it('compaction emits numbers, not stringified numbers', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 180_000, post_tokens: 42_000 },
    });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: {} });

    const compact = one(telemetry.__testSpans(), 'agent.compact');
    expect(compact.attributes['nanoclaw.compact_pre_tokens']).toBe(180_000);
    expect(compact.attributes['nanoclaw.compact_post_tokens']).toBe(42_000);
    expect(compact.attributes['nanoclaw.compact_tokens_saved']).toBe(138_000);
    // The trigger really is text — the wide type does not force everything numeric.
    expect(compact.attributes['nanoclaw.compact_trigger']).toBe('auto');
  });

  it('task settlement emits numbers and covers the task’s own window', async () => {
    telemetry.turnStart({ prompt: 'x' });
    // Elapsed turn time, so the backdating is not clamped to the turn start.
    await sleep(60);
    telemetry.observe({
      type: 'system',
      subtype: 'task_notification',
      status: 'completed',
      task_id: 't1',
      usage: { total_tokens: 4321, tool_uses: 118, duration_ms: 40 },
    });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: {} });

    const task = one(telemetry.__testSpans(), 'task.completed');
    expect(task.attributes['nanoclaw.task_tool_uses']).toBe(118);
    expect(task.attributes['llm.token_count.total']).toBe(4321);
    // The SDK's `usage.duration_ms` backdates the span, as `agent.compact` does.
    expect(durationMs(task)).toBeGreaterThanOrEqual(35);
  });

  // One helper carries both backdating and error status; a second, narrower
  // helper would bring back a second attribute type.
  it('the unified helper keeps both backdating and error status', async () => {
    telemetry.turnStart({ prompt: 'x' });
    // The turn needs elapsed time of its own, or the clamp correctly collapses the
    // backdating: a child may not start before its parent.
    await sleep(60);
    telemetry.observe({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 10, post_tokens: 5, duration_ms: 40 },
    });
    telemetry.runnerError('query', new Error('boom'), { fatal: true });

    const spans = telemetry.__testSpans();
    // durationMs still backdates: the span is not an instant.
    expect(durationMs(one(spans, 'agent.compact'))).toBeGreaterThan(0);
    // errMessage still marks the span failed.
    expect(one(spans, 'runner.error').status.code).toBe(2);
  });
});

// Per-turn state was cleared in two hand-maintained lists — `openTurn` and
// `__testReset` — and they had already drifted: `pendingSignalAt` was in the
// first and missing from the second. A single `resetTurnState()` is what keeps
// them from diverging again.
describe('per-turn state resets from one place', () => {
  it('does not leak the continuation anchor across resets', async () => {
    // Seeds `pendingSignalAt` with no turn open, then abandons it.
    telemetry.observe({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 5 });
    await sleep(30);
    telemetry.__testReset();
    const after = Date.now();

    // A fresh continuation must anchor on NOW. With the leak it would anchor on
    // the abandoned signal and absorb the gap above.
    telemetry.observe({
      type: 'assistant',
      session_id: 's',
      message: { model: 'm', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1 } },
    });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    const turn = one(telemetry.__testSpans(), 'agent.turn');
    expect(turn.attributes['nanoclaw.continuation']).toBe(true);
    expect(turn.startTime[0] * 1e3 + turn.startTime[1] / 1e6).toBeGreaterThanOrEqual(after);
  });

  it('a new turn opens with the counters already zeroed', () => {
    telemetry.turnStart({ prompt: 'first' });
    telemetry.delivery({ destinationType: 'channel', channelType: 'telegram', bodyChars: 4, threadResolved: true });
    telemetry.toolStart({
      hook_event_name: 'PreToolUse',
      tool_name: 'Skill',
      tool_use_id: 'S',
      tool_input: { skill: 'debug' },
    });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_use_id: 'S' });
    telemetry.turnStart({ prompt: 'second' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    const secondTurn = (byName(telemetry.__testSpans(), 'agent.turn') as any[]).find(
      (t) => t.attributes['input.value'] === 'second',
    );
    expect(secondTurn).toBeDefined();
    expect(secondTurn.attributes['nanoclaw.delivered_count']).toBe(0);
    expect(secondTurn.attributes['nanoclaw.tool_calls']).toBe(0);
    expect(secondTurn.attributes['nanoclaw.skills_used']).toBeUndefined();
  });
});

// `llm.call` durations are inferred from a per-context boundary. Overwriting
// that boundary with the call's last message time would move it BACKWARD past
// any tool that ran since — and `assistantStep` flushes before reading it, so
// the next call would start before the tool had finished, charging tool time as
// model time.
describe('tool time is not charged to the model', () => {
  const step = (extra: object = {}) => ({
    type: 'assistant',
    session_id: 's',
    message: { model: 'm', content: [{ type: 'text', text: 'p' }], usage: {}, ...extra },
  });
  const endOf = (s: any) => s.startTime[0] * 1e3 + s.startTime[1] / 1e6 + durationMs(s);
  const startOf = (s: any) => s.startTime[0] * 1e3 + s.startTime[1] / 1e6;

  it('the next call starts no earlier than the tool it waited on', async () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(step({ usage: { input_tokens: 1 } }));
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'T' });
    await sleep(60);
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'T' });
    await sleep(40);
    telemetry.observe(step({ usage: { input_tokens: 2 } }));
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 2 } });

    const spans = telemetry.__testSpans();
    const tool = one(spans, 'tool.Bash');
    const calls = (byName(spans, 'llm.call') as any[]).sort((a, b) => startOf(a) - startOf(b));
    expect(calls.length).toBe(2);
    // The second call must not reach back across the tool — which is what
    // excludes the tool's own time from the call.
    expect(startOf(calls[1])).toBeGreaterThanOrEqual(endOf(tool) - 1);
  });

  // The guard must not freeze the boundary: with no tool in between, the second
  // call still has to start where the first one ended.
  it('two calls with no tool between still advance the boundary', async () => {
    telemetry.turnStart({ prompt: 'x' });
    // The gap before the FIRST message matters: it makes the turn start and the
    // first call's end distinct instants, so picking the older boundary is
    // detectable instead of collapsing onto the same millisecond.
    await sleep(50);
    telemetry.observe(step({ usage: { input_tokens: 1 } }));
    await sleep(50);
    telemetry.observe(step({ usage: { input_tokens: 2 } }));
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 2 } });

    const calls = (byName(telemetry.__testSpans(), 'llm.call') as any[]).sort((a, b) => startOf(a) - startOf(b));
    expect(calls.length).toBe(2);
    // Second call covers the gap — roughly the 50ms, not zero and not the whole turn.
    expect(durationMs(calls[1])).toBeGreaterThan(30);
    // And it starts where the FIRST one ended, not back at the turn start. This is
    // the half that fails if the guard picks the older boundary instead of the
    // newer one: the two calls would then overlap from the turn start onward.
    expect(startOf(calls[1])).toBeGreaterThanOrEqual(endOf(calls[0]) - 1);
  });

  // A worker's tool keys its boundary by `agent_id`, which the main thread never
  // reads. That separation is what keeps a subagent from shortening the main step.
  it('a worker tool does not move the main thread boundary', async () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe(step({ usage: { input_tokens: 1 } }));
    await sleep(60);
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'W', agent_id: 'a1' });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'W', agent_id: 'a1' });
    telemetry.observe(step({ usage: { input_tokens: 2 } }));
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 2 } });

    const calls = (byName(telemetry.__testSpans(), 'llm.call') as any[]).sort((a, b) => startOf(a) - startOf(b));
    // The main thread kept working across the worker's tool: ~60ms, not ~0.
    expect(durationMs(calls[1])).toBeGreaterThan(30);
  });
});

// Agent-to-agent traces were splitting because only ONE of
// the two delivery legs stamped the trace context: the MCP `send_message` tool
// did, the poll-loop's `<message to="...">` path did not. A reply sent as a block
// opened a ROOT turn on the other side instead of hanging in the caller's trace.
describe('trace context for the delivery leg', () => {
  const W3C = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

  it('carries the open turn in W3C form', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    const field = telemetry.traceparentField();
    expect(field.traceparent).toMatch(W3C);
    // Same trace as the turn it came from, or the link points somewhere else.
    const turn = one(telemetry.__testSpans(), 'agent.turn');
    expect(field.traceparent).toContain(turn.spanContext().traceId);
  });

  // The final result is delivered after `turnEnd` has already run. If the stamp
  // died with the turn, the most common agent-to-agent reply would stay unlinked
  // and the whole change would buy nothing.
  it('survives turnEnd, and only the next turn replaces it', () => {
    telemetry.turnStart({ prompt: 'first' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });
    const afterEnd = telemetry.traceparentField().traceparent;
    expect(afterEnd).toMatch(W3C);

    telemetry.turnStart({ prompt: 'second' });
    expect(telemetry.traceparentField().traceparent).toMatch(W3C);
    expect(telemetry.traceparentField().traceparent).not.toBe(afterEnd);
  });

  // An object to spread, never `{ traceparent: undefined }`. The undefined form
  // looks the same after JSON.stringify but changes the object's shape for any
  // consumer testing `'traceparent' in content`.
  it('adds no key at all when there is no turn', () => {
    const field = telemetry.traceparentField();
    expect(field).toEqual({});
    expect('traceparent' in field).toBe(false);
  });

  // Round trip: the value we emit has to be one the receiving side accepts.
  it('produces a parent the receiving side can adopt', () => {
    telemetry.turnStart({ prompt: 'sender' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });
    const tp = telemetry.traceparentField().traceparent!;
    const sender = one(telemetry.__testSpans(), 'agent.turn');
    const traceId = sender.spanContext().traceId;
    telemetry.__testReset();

    // Same path a real recipient takes: the traceparent arrives in the claimed
    // message content and `turnStart` adopts it.
    const { inbound, outbound } = db;
    inbound
      .prepare('INSERT OR REPLACE INTO messages_in (id, kind, timestamp, content) VALUES (?,?,?,?)')
      .run('a2a', 'chat', new Date().toISOString(), JSON.stringify({ text: 'hi', traceparent: tp }));
    outbound
      .prepare("INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?,'processing',?)")
      .run('a2a', new Date().toISOString());

    telemetry.turnStart({ prompt: 'receiver' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });
    const receiver = one(telemetry.__testSpans(), 'agent.turn');
    expect(receiver.spanContext().traceId).toBe(traceId);
    expect(receiver.attributes['nanoclaw.trace_linked']).toBe(true);
  });

  let db: { inbound: any; outbound: any };
  beforeEach(async () => {
    const conn = await import('./mailbox/sqlite/connection.js');
    db = conn.initTestSessionDb() as any;
  });
});

// With every group in ONE Phoenix project, the span attribute is the only
// per-agent filter — the resource copy exists but Phoenix's span API does not
// expose it. The stamp runs in a SpanProcessor.onStart, the single funnel over
// every startSpan call site.
describe('group attributes on every span', () => {
  it('stamps nanoclaw.group_name on every span kind', async () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe({
      type: 'assistant',
      session_id: 's',
      message: { model: 'm', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1 } },
    });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'B' });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'B' });
    await telemetry.subagentHook({ hook_event_name: 'SubagentStart', agent_id: 'g1', agent_type: 'worker' });
    await telemetry.subagentHook({ hook_event_name: 'SubagentStop', agent_id: 'g1' });
    telemetry.runnerError('test', new Error('x'));
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    const spans = telemetry.__testSpans() as any[];
    // agent.turn, llm.call, tool.Bash, subagent.worker, runner.error at least
    expect(spans.length).toBeGreaterThanOrEqual(5);
    for (const s of spans) {
      // In the suite `loadConfig()` finds no container.json, so groupName is ''
      // and the stamp falls back to 'nanoclaw' — always present, never empty.
      expect(s.attributes['nanoclaw.group_name']).toBe('nanoclaw');
      // Effort is written even when unset, as the literal 'default': absent
      // could not tell "SDK default" from "span predates the instrument", and
      // "unset" is the majority bucket. Same suite fallback as group_name.
      expect(s.attributes['nanoclaw.effort']).toBe('default');
    }
  });
});

// A native crash (a SIGTRAP) exports nothing that is still open:
// the turn and subagent span ids referenced by already-exported children never
// arrive, and the trace collapses into orphans. Segmentation ends long-lived
// spans early so the parent ids get out; children anchor to the FIRST segment.
describe('checkpoint segmentation', () => {
  const FUTURE = 200_000; // past SEGMENT_AFTER_MS
  const SOON = 30_000; // below it

  it('does not segment spans younger than the threshold', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.checkpointOpenSpans(Date.now() + SOON);
    expect(byName(telemetry.__testSpans(), 'agent.turn').length).toBe(0);
  });

  it('segments a long turn and anchors later children to segment 1', () => {
    telemetry.turnStart({ prompt: 'long' });
    const anchorTp = telemetry.traceparentField().traceparent as string;
    telemetry.checkpointOpenSpans(Date.now() + FUTURE);

    const seg1 = one(telemetry.__testSpans(), 'agent.turn');
    expect(seg1.attributes['nanoclaw.segment']).toBe(1);
    expect(seg1.attributes['nanoclaw.segment_continues']).toBe(true);
    // Not an error: the turn is alive, this is a checkpoint.
    expect(seg1.status.code).not.toBe(2);
    // The published traceparent is the anchor's — it must not move.
    expect(anchorTp).toContain(seg1.spanContext().spanId);
    expect(telemetry.traceparentField().traceparent).toBe(anchorTp);

    // A child opened AFTER the checkpoint parents to the exported segment 1,
    // not to the still-open segment 2 — that is the crash-safety property.
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Late', tool_use_id: 'T' });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Late', tool_use_id: 'T' });
    expect(parentIdOf(one(telemetry.__testSpans(), 'tool.Late'))).toBe(seg1.spanContext().spanId);

    // The FINAL segment carries the real result and counters, and no
    // segment_continues — that absence is what marks the true end of the turn.
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });
    const turns = byName(telemetry.__testSpans(), 'agent.turn') as any[];
    expect(turns.length).toBe(2);
    const finalSegment = turns.find((t) => t.attributes['nanoclaw.segment_continues'] === undefined);
    expect(finalSegment).toBeDefined();
    expect(finalSegment.attributes['nanoclaw.segment']).toBe(2);
    expect(finalSegment.attributes['nanoclaw.delivered_count']).toBe(0);
    expect(finalSegment.attributes['nanoclaw.tool_calls']).toBe(1);
  });

  // The GenAI identity is stamped in `openTurn`, before the seed copy, so a
  // reopened segment of a CONTINUATION turn carries it too — the path with no
  // `turnStart` and no explicit attribute object of its own.
  it('a reopened segment of a continuation turn keeps the GenAI identity', () => {
    telemetry.observe({
      type: 'assistant',
      session_id: 's',
      message: { model: 'm', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1 } },
    });
    telemetry.checkpointOpenSpans(Date.now() + FUTURE);
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    const turns = byName(telemetry.__testSpans(), 'agent.turn') as any[];
    expect(turns.length).toBe(2);
    for (const t of turns) {
      expect(t.attributes['nanoclaw.continuation']).toBe(true);
      expect(t.attributes['gen_ai.operation.name']).toBe('invoke_agent');
      expect(typeof t.attributes['gen_ai.agent.name']).toBe('string');
    }
  });

  // Two properties in one exercise, because one rotation cannot show both.
  //
  // SAME TRACE: `turnEnd` writes cost, tokens and `output.value` onto the LAST
  // segment while the work stays anchored to segment 1. Rotating into a new ROOT
  // therefore did not just add a span — it put what the turn cost in a different
  // TRACE from the spans that spent it, in every backend, since trace_id is the
  // join key.
  //
  // FLAT, NOT A STAIRCASE: segment 3 hangs off segment 1 exactly like segment 2
  // does, so depth stays 1 however long the turn runs. That needs a THIRD
  // segment to observe — with only two, hanging off segment 1 and hanging off
  // the previous segment are the same picture.
  it('hangs every later segment off segment 1, in the same trace', () => {
    telemetry.turnStart({ prompt: 'long' });
    telemetry.checkpointOpenSpans(Date.now() + FUTURE);
    const seg1 = one(telemetry.__testSpans(), 'agent.turn');
    telemetry.checkpointOpenSpans(Date.now() + FUTURE * 2);

    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });
    const turns = byName(telemetry.__testSpans(), 'agent.turn') as any[];
    expect(turns.length).toBe(3);
    for (const seg of turns.filter((t) => t.attributes['nanoclaw.segment'] !== 1)) {
      expect(parentIdOf(seg)).toBe(seg1.spanContext().spanId);
      expect(seg.spanContext().traceId).toBe(seg1.spanContext().traceId);
    }
  });

  it('segments a long tool and closes the final segment with the result', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Lengthy', tool_use_id: 'L' });
    telemetry.checkpointOpenSpans(Date.now() + FUTURE);

    const seg1 = one(telemetry.__testSpans(), 'tool.Lengthy');
    expect(seg1.attributes['nanoclaw.segment']).toBe(1);
    expect(seg1.attributes['nanoclaw.segment_continues']).toBe(true);

    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Lengthy', tool_use_id: 'L', duration_ms: 9 });
    const all = byName(telemetry.__testSpans(), 'tool.Lengthy') as any[];
    expect(all.length).toBe(2);
    const finalSegment = all.find((t) => t.attributes['nanoclaw.segment_continues'] === undefined);
    expect(finalSegment.attributes['nanoclaw.segment']).toBe(2);
    expect(finalSegment.attributes['nanoclaw.tool_duration_ms']).toBe(9);
    // Siblings: both segments hang under the same parent (the turn's anchor).
    expect(parentIdOf(finalSegment)).toBe(parentIdOf(seg1));
  });

  it('keeps worker tools anchored to subagent segment 1 across a checkpoint', async () => {
    telemetry.turnStart({ prompt: 'x' });
    await telemetry.subagentHook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'worker' });
    telemetry.checkpointOpenSpans(Date.now() + FUTURE);

    const seg1 = one(telemetry.__testSpans(), 'subagent.worker');
    expect(seg1.attributes['nanoclaw.segment_continues']).toBe(true);
    // The subagent's first span is born WITHOUT a segment number (only reopened
    // ones carry it from creation), so the checkpoint is the only thing that
    // stamps it here — unlike the turn and tool paths.
    expect(seg1.attributes['nanoclaw.segment']).toBe(1);

    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_use_id: 'G', agent_id: 'a1' });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 'G', agent_id: 'a1' });
    expect(parentIdOf(one(telemetry.__testSpans(), 'tool.Grep'))).toBe(seg1.spanContext().spanId);

    await telemetry.subagentHook({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'worker' });
    const all = byName(telemetry.__testSpans(), 'subagent.worker') as any[];
    expect(all.length).toBe(2);
    const finalSegment = all.find((t) => t.attributes['nanoclaw.segment_continues'] === undefined);
    expect(finalSegment.attributes['nanoclaw.segment']).toBe(2);
  });

  // `turnStart` never knows session/prompt ids — they arrive with the first tool
  // hook. A rotated segment is rebuilt from the seed alone, so unless the hook
  // wrote them THERE too, every segment past the first is anonymous and drops out
  // of any dashboard that filters by attribute. No tool runs after the checkpoint
  // here: that absence is the whole point, since a later tool would re-stamp the
  // new segment and hide the defect.
  it('carries ids learned mid-turn into the rotated segment', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({
      hook_event_name: 'PreToolUse',
      tool_name: 'Early',
      tool_use_id: 'C',
      session_id: 'S1',
      prompt_id: 'P1',
    });
    telemetry.toolEnd({
      hook_event_name: 'PostToolUse',
      tool_name: 'Early',
      tool_use_id: 'C',
      session_id: 'S1',
      prompt_id: 'P1',
    });

    telemetry.checkpointOpenSpans(Date.now() + FUTURE);
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    const turns = byName(telemetry.__testSpans(), 'agent.turn') as any[];
    expect(turns.length).toBe(2);
    const seg2 = turns.find((t) => t.attributes['nanoclaw.segment'] === 2);
    expect(seg2).toBeDefined();
    expect(seg2.attributes['session.id']).toBe('S1');
    expect(seg2.attributes['prompt.id']).toBe('P1');
  });

  // The seed is mutated in place, so the guard against a leak is that `openTurn`
  // replaces it wholesale. A turn that never learns ids must not inherit the
  // previous turn's.
  it('does not leak ids into the next turn', () => {
    telemetry.turnStart({ prompt: 'first' });
    telemetry.toolStart({
      hook_event_name: 'PreToolUse',
      tool_name: 'One',
      tool_use_id: 'U',
      session_id: 'S1',
      prompt_id: 'P1',
    });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'One', tool_use_id: 'U' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    telemetry.turnStart({ prompt: 'second' });
    telemetry.checkpointOpenSpans(Date.now() + FUTURE);
    // Closes segment 2 — an open span never reaches the exporter.
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    const seg2 = (byName(telemetry.__testSpans(), 'agent.turn') as any[]).find(
      (t) => t.attributes['nanoclaw.segment'] === 2,
    );
    expect(seg2).toBeDefined();
    expect(seg2.attributes['session.id']).toBeUndefined();
    expect(seg2.attributes['prompt.id']).toBeUndefined();
  });
});

// The SIGTERM path and the new JS-crash handlers share this close: every open
// span must land with ERROR status and the turn must keep its counters. Tested
// directly (not through shutdownTelemetry) because `rt.close()` would poison
// every later case in the suite.
describe('crash close', () => {
  it('closes turn, tools and subagents with error status and counters', async () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.delivery({ destinationType: 'channel', channelType: 'telegram', bodyChars: 4, threadResolved: true });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Middle', tool_use_id: 'M' });
    await telemetry.subagentHook({ hook_event_name: 'SubagentStart', agent_id: 'c1', agent_type: 'worker' });

    telemetry.closeOpenSpans();

    const spans = telemetry.__testSpans() as any[];
    for (const name of ['agent.turn', 'tool.Middle', 'subagent.worker']) {
      const s = one(spans, name);
      expect(s.status.code).toBe(2);
      expect(s.status.message).toBe('container shut down');
    }
    expect(one(spans, 'agent.turn').attributes['nanoclaw.delivered_count']).toBe(1);
  });
});

// Turns carry whole transcripts. Without the per-attribute cap a single span
// reaches megabytes, and the exporter starts silently dropping attributes — the
// failure mode is a span that looks fine minus the fields you needed.
describe('attribute size cap', () => {
  it('truncates an oversized attribute and says so', () => {
    const huge = 'a'.repeat(20_000);
    telemetry.turnStart({ prompt: huge });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    const v = one(telemetry.__testSpans(), 'agent.turn').attributes['input.value'] as string;
    expect(v.length).toBeLessThan(huge.length);
    // The cap is 12_000 plus the marker; asserting the marker keeps the test
    // honest about WHICH end was cut, not just that something shrank.
    expect(v.endsWith('…[truncated]')).toBe(true);
    expect(v.slice(0, -'…[truncated]'.length).length).toBe(12_000);
  });
});

// The SDK declares `tool_use_id` required. When it is missing anyway the span
// can never be paired at the end, so it is closed immediately and flagged —
// otherwise it stays open forever and the container leaks one span per call.
describe('unpaired tool span', () => {
  it('closes and flags a tool span that arrives without tool_use_id', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Orphan' });

    // Presence in __testSpans() is the leak assertion: only FINISHED spans land
    // there, so a span left open would simply be absent.
    const span = one(telemetry.__testSpans(), 'tool.Orphan');
    expect(span.attributes['nanoclaw.tool_unpaired']).toBe(true);
  });
});

// The turn span is where a human looks first, and most of its fields come from
// the `result` message or from counters accumulated during the turn. Each was
// individually unasserted; one exhaustive case covers the whole surface.
describe('the turn carries its fields', () => {
  it('writes every result field and counter onto the turn span', () => {
    telemetry.turnStart({ prompt: 'question' });
    // Counters are fed by system events, not by the result.
    telemetry.observe({ type: 'system', subtype: 'api_retry', error_status: 429 });
    telemetry.observe({ type: 'system', subtype: 'memory_recall' });
    telemetry.delivery({ destinationType: 'channel', channelType: 'telegram', bodyChars: 9, threadResolved: true });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'B' });
    telemetry.toolEnd({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'B' });

    telemetry.observe({
      type: 'result',
      subtype: 'success',
      result: 'final answer',
      num_turns: 4,
      duration_ms: 8888,
      duration_api_ms: 7777,
      total_cost_usd: 0.25,
      permission_denials: [{ tool_name: 'Write' }, { tool_name: 'Edit' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: { 'claude-opus-5': { costUSD: 0.2 }, 'claude-haiku-4-5': { costUSD: 0.05 } },
    });

    const a = one(telemetry.__testSpans(), 'agent.turn').attributes;
    expect(a['output.value']).toBe('final answer');
    expect(a['output.mime_type']).toBe('text/plain');
    expect(a['nanoclaw.num_turns']).toBe(4);
    expect(a['nanoclaw.result_subtype']).toBe('success');
    expect(a['nanoclaw.turn_duration_ms']).toBe(8888);
    expect(a['nanoclaw.duration_api_ms']).toBe(7777);
    expect(a['nanoclaw.permission_denials']).toBe(2);
    // The costliest model answers for the turn — under `nanoclaw.`, so no cost
    // engine reads it and bills the turn on top of its own children.
    expect(a['nanoclaw.model']).toBe('claude-opus-5');
    expect(a['llm.model_name']).toBeUndefined();
    expect(a['nanoclaw.api_retries']).toBe(1);
    expect(a['nanoclaw.last_retry_status']).toBe(429);
    expect(a['nanoclaw.memory_recalls']).toBe(1);
    expect(a['nanoclaw.delivered_count']).toBe(1);
    expect(a['nanoclaw.tool_calls']).toBe(1);
  });

  // The agent wrote only scratchpad. The poll loop blanks `<internal>` before
  // deciding whether to nudge, so no delivery and no `delivery.dropped` — the
  // typical "turn closed OK, user got nothing, nothing explains it".
  it('marks a turn whose whole output was scratchpad', () => {
    telemetry.turnStart({ prompt: 'p' });
    telemetry.observe({
      type: 'result',
      subtype: 'success',
      result: '<internal>nothing to do</internal>\n<INTERNAL>uppercase tags too</INTERNAL>',
    });
    expect(one(telemetry.__testSpans(), 'agent.turn').attributes['nanoclaw.output_internal_only']).toBe(true);

    telemetry.__testReset();
    telemetry.turnStart({ prompt: 'p' });
    telemetry.observe({ type: 'result', subtype: 'success', result: '<internal>draft</internal> visible text' });
    expect(one(telemetry.__testSpans(), 'agent.turn').attributes['nanoclaw.output_internal_only']).toBeUndefined();
  });
});

// Background work runs after the turn's `result`, with no turn open. Its spans
// must stitch into the originating trace AND say so — the flag is what separates
// legitimate background from a parenting bug.
describe('detached model call', () => {
  it('flags a worker step that arrives after its turn already closed', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1 } });

    // `parent_tool_use_id` is what keeps this from opening a continuation turn:
    // a MAIN-thread message with no turn open would anchor a new one instead of
    // going detached. The id names an `Agent` call whose span already closed, so
    // there is no tool to hang under either — the detached path exactly.
    telemetry.observe({
      type: 'assistant',
      session_id: 's',
      parent_tool_use_id: 'tool_already_closed',
      message: { model: 'm', content: [{ type: 'text', text: 'late' }], usage: { input_tokens: 2 } },
    });
    // Opening the next turn flushes the in-flight call, which is what finishes
    // the span so the exporter hands it over.
    telemetry.turnStart({ prompt: 'next' });

    const call = one(telemetry.__testSpans(), 'llm.call');
    expect(call.attributes['nanoclaw.detached_from_turn']).toBe(true);
  });
});

// `resourceAttributes` in otel.json is the collector-neutral way to route or
// label spans. It sits between the two defaults (which it may override) and the
// `nanoclaw.*` identity keys (which it may not) — the fixture at the top of this
// file sets one new key and overrides `service.name` to prove both edges.
describe('resource attributes', () => {
  it('merges operator keys into every span’s resource, below the group identity', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: {} });

    const res = one(telemetry.__testSpans(), 'agent.turn').resource.attributes;
    expect(res['deployment.environment']).toBe('suite-env');
    expect(res['service.name']).toBe('custom-svc');
    // `projectName` is shorthand for this key and still reaches the resource.
    expect(res['openinference.project.name']).toBe('suite');
    // The group's identity keys are written last and cannot be overridden.
    expect(typeof res['nanoclaw.group_name']).toBe('string');
    expect(typeof res['nanoclaw.agent_group_id']).toBe('string');
  });
});

// The whole drain — flush AND exporter close — sits under one deadline, so a
// stalled collector cannot hold the container past the host's stop grace.
describe('withDeadline', () => {
  it('resolves to the value when the promise settles first', async () => {
    expect(await telemetry.withDeadline(Promise.resolve(7), 1000)).toBe(7);
  });

  it('resolves to undefined once the deadline passes', async () => {
    expect(await telemetry.withDeadline(new Promise<number>(() => {}), 20)).toBeUndefined();
  });

  it('resolves to undefined on rejection instead of throwing', async () => {
    expect(await telemetry.withDeadline(Promise.reject(new Error('boom')), 1000)).toBeUndefined();
  });
});

// Instrumentation must never fail the runner: a throw inside a hook would fail
// the tool call, and one inside `observe` would surface as a query error to the
// user. Every entry point swallows and logs instead.
describe('entry points never throw', () => {
  const trap = {
    get type() {
      throw new Error('boom');
    },
  };

  it('a malformed SDK message is dropped, not raised', () => {
    telemetry.turnStart({ prompt: 'x' });
    expect(() => telemetry.observe(trap)).not.toThrow();
    expect(() => telemetry.observe(Object.create(null))).not.toThrow();
    expect(() =>
      telemetry.observe({ type: 'assistant', message: { content: 'not-an-array', usage: null } }),
    ).not.toThrow();
    telemetry.observe({ type: 'result', subtype: 'success', result: 'ok', usage: {} });
    expect(byName(telemetry.__testSpans(), 'agent.turn').length).toBe(1);
  });

  it('a non-string tool error is coerced, and the span still closes', () => {
    telemetry.turnStart({ prompt: 'x' });
    telemetry.toolStart({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'X' });
    expect(() =>
      telemetry.toolEnd({
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_use_id: 'X',
        error: { code: 1 },
      }),
    ).not.toThrow();
    const tool = one(telemetry.__testSpans(), 'tool.Bash');
    expect(tool.attributes['nanoclaw.failure_kind']).toBe('other');
    expect(tool.status.code).toBe(2);
  });

  it('a throwing hook input is swallowed and the hook still continues', async () => {
    telemetry.turnStart({ prompt: 'x' });
    const badHook = {
      get tool_use_id() {
        throw new Error('boom');
      },
    };
    expect(() => telemetry.toolStart(badHook)).not.toThrow();
    expect(() => telemetry.toolEnd(badHook)).not.toThrow();
    expect(await telemetry.subagentHook(badHook)).toEqual({ continue: true });
    expect(() => telemetry.checkpointOpenSpans(Number.NaN)).not.toThrow();
  });
});
