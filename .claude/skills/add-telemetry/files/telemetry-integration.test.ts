/**
 * Guards telemetry's INTEGRATION POINTS with the core.
 *
 * `telemetry.test.ts` covers internal logic by calling the functions directly, so
 * it does NOT protect the wiring: deleting `telemetry.observe(message)` from
 * `claude.ts` leaves that whole suite green. This one goes red.
 *
 * Two kinds of test, chosen by what can be invoked:
 *
 * - `mcp-tools/core.ts` exposes an invocable handler, so the test is BEHAVIOURAL:
 *   call the real handler and check the written message carries the `traceparent`.
 * - The points in `providers/claude.ts` live in module-private hooks and in a
 *   method that depends on the Agent SDK, which cannot be instrumented under Bun
 *   (the provider imports `query` with a static ESM binding). Those tests are
 *   STRUCTURAL, via the TypeScript compiler API, and verify POSITION — the call
 *   inside the right function — not merely that the symbol appears in the file.
 */
import { describe, it, expect, beforeEach } from 'bun:test';

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

import { initTestSessionDb, getOutboundDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { setTurnTraceparent } from './telemetry-state.js';

const CLAUDE_TS = path.join(import.meta.dir, 'providers', 'claude.ts');
const POLL_LOOP_TS = path.join(import.meta.dir, 'poll-loop.ts');
const TELEMETRY_TS = path.join(import.meta.dir, 'telemetry.ts');

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

/** Body of the function/method/variable with this name, at any depth. */
function findScope(src: ts.SourceFile, name: string): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    const isNamed =
      (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
      (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) ||
      (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
    if (isNamed) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(src, visit);
  return found;
}

/**
 * Is `telemetry.<method>` called inside an `if` whose condition mentions
 * `conditionText`? The nearest enclosing `if` is the one that counts.
 */
function callWithinIf(scope: ts.Node, method: string, conditionText: string): boolean {
  let hit = false;
  const visit = (node: ts.Node, ifs: ts.IfStatement[]): void => {
    if (hit) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'telemetry' &&
      node.expression.name.text === method
    ) {
      const nearest = ifs[ifs.length - 1];
      if (nearest && nearest.expression.getText().includes(conditionText)) hit = true;
      return;
    }
    const next = ts.isIfStatement(node) ? [...ifs, node] : ifs;
    ts.forEachChild(node, (child) => visit(child, next));
  };
  visit(scope, []);
  return hit;
}

/** Is `telemetry.<method>` called at some point WITHIN this scope? */
function callsWithin(scope: ts.Node, method: string): boolean {
  let hit = false;
  const visit = (node: ts.Node): void => {
    if (hit) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'telemetry' &&
      node.expression.name.text === method
    ) {
      hit = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return hit;
}

/** Does the identifier appear within this scope (for hooks passed by reference)? */
function mentionsWithin(scope: ts.Node, text: string): boolean {
  let hit = false;
  const visit = (node: ts.Node): void => {
    if (hit) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'telemetry'
    ) {
      if (node.name.text === text) {
        hit = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return hit;
}

describe('integration with providers/claude.ts', () => {
  it('imports telemetry from the right module', () => {
    const src = parse(CLAUDE_TS);
    const hasImport = src.statements.some(
      (s) =>
        ts.isImportDeclaration(s) &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        s.moduleSpecifier.text === '../telemetry.js',
    );
    expect(hasImport).toBe(true);
  });

  // Without this the tool span never opens and the tree loses its entire tool
  // layer.
  it('opens the tool span in the PreToolUse hook', () => {
    const scope = findScope(parse(CLAUDE_TS), 'preToolUseHook');
    expect(scope).toBeDefined();
    expect(callsWithin(scope!, 'toolStart')).toBe(true);
  });

  // Without this, tool spans stay open until shutdown and come out as errors.
  it('closes the tool span in the PostToolUse hook', () => {
    const scope = findScope(parse(CLAUDE_TS), 'postToolUseHook');
    expect(scope).toBeDefined();
    expect(callsWithin(scope!, 'toolEnd')).toBe(true);
  });

  // `turnStart` and `observe` live in the same method; position matters, because
  // `observe` outside the message loop would see no events at all.
  it('opens the turn and observes the message stream inside query()', () => {
    const scope = findScope(parse(CLAUDE_TS), 'query');
    expect(scope).toBeDefined();
    expect(callsWithin(scope!, 'turnStart')).toBe(true);
    expect(callsWithin(scope!, 'observe')).toBe(true);
    // the thinking option is spread into the sdkQuery options, in the same method
    expect(callsWithin(scope!, 'thinkingOption')).toBe(true);
  });

  // Passed by reference rather than called — hence the mention check.
  it('registers the subagent lifecycle hook', () => {
    const scope = findScope(parse(CLAUDE_TS), 'query');
    expect(mentionsWithin(scope!, 'subagentHook')).toBe(true);
  });
});

describe('integration with mcp-tools/core.ts', () => {
  beforeEach(() => {
    initTestSessionDb();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('test-destination', 'Destination', 'channel', 'discord', 'chan-1', NULL)`,
      )
      .run();
  });

  // BEHAVIOURAL: the handler is invocable, so no structure needed here. Deleting
  // the injection in core.ts turns this red.
  it('stamps the turn traceparent on the sent message', async () => {
    const { sendMessage } = await import('./mcp-tools/core.js');
    const tp = `00-${'c'.repeat(32)}-${'d'.repeat(16)}-01`;
    setTurnTraceparent(tp);

    await sendMessage.handler({ to: 'test-destination', text: 'hello' } as never);

    const row = getOutboundDb().prepare('SELECT content FROM messages_out ORDER BY seq DESC LIMIT 1').get() as {
      content: string;
    };
    const content = JSON.parse(row.content) as { text: string; traceparent?: string };
    expect(content.text).toBe('hello');
    expect(content.traceparent).toBe(tp);
  });

  // With no open turn the message must go out exactly as it always did — the
  // recipient opens a root turn.
  it('adds no key when there is no turn in progress', async () => {
    const { sendMessage } = await import('./mcp-tools/core.js');
    setTurnTraceparent(null);

    await sendMessage.handler({ to: 'test-destination', text: 'no trace' } as never);

    const row = getOutboundDb().prepare('SELECT content FROM messages_out ORDER BY seq DESC LIMIT 1').get() as {
      content: string;
    };
    expect('traceparent' in JSON.parse(row.content)).toBe(false);
  });
});

/**
 * Integration with the poll-loop: the half of the container that does NOT go
 * through the SDK.
 *
 * These assertions are what detects reach-in lost in an upstream merge.
 * `poll-loop.ts` changes far more than `providers/claude.ts`, so a conflict
 * eating one of these calls is a real risk — and the symptom would be silent: the
 * turn still closes OK, just with no delivery span.
 */
describe('integration with poll-loop.ts', () => {
  it('imports telemetry from the right module', () => {
    const src = parse(POLL_LOOP_TS);
    const found = src.statements.some(
      (st) =>
        ts.isImportDeclaration(st) &&
        ts.isStringLiteral(st.moduleSpecifier) &&
        st.moduleSpecifier.text === './telemetry.js',
    );
    expect(found).toBe(true);
  });

  // The single choke point for both delivery legs: `deliverMidTurnBlocks` and
  // `dispatchResultText` both pass through here.
  it('observes delivery inside sendToDestination', () => {
    const scope = findScope(parse(POLL_LOOP_TS), 'sendToDestination');
    expect(scope).toBeDefined();
    expect(callsWithin(scope!, 'delivery')).toBe(true);
  });

  // Both delivery legs must stamp the trace context — the MCP tool through
  // `session_state`, this one straight from memory. Stamping only one leg links
  // only the replies that happen to take that leg, so agent-to-agent traces
  // split whenever the other leg is used.
  it('stamps the trace context on the delivery it writes', () => {
    const scope = findScope(parse(POLL_LOOP_TS), 'sendToDestination');
    expect(scope).toBeDefined();
    expect(callsWithin(scope!, 'traceparentField')).toBe(true);
  });

  // Stamping the trace context changes the shape of what the delivery writes. An
  // echo guard that looks for a byte-identical `{text}` string never matches with
  // telemetry ON, so duplicate suppression silently stops working — a behavior
  // regression, not a telemetry one.
  // The guard must compare the FIELD, which also survives any key added later.
  //
  // Asserted as the PROPERTY, not as one spelling of it: pinning the exact text
  // would go red on any harmless rewrite of the guard while staying blind to the
  // defect.
  it('the echo guard matches on the text field, not the raw content', () => {
    const file = parse(POLL_LOOP_TS);
    const guard = findScope(file, 'wasWrittenInSeqWindow');
    expect(guard).toBeDefined();
    const src = guard!.getText();

    // THE DEFECT, in both spellings: comparing a rebuilt `{text}` against the
    // stored content. This is what must never come back.
    expect(src).not.toContain('JSON.stringify({ text: body })');
    expect(src).not.toMatch(/\.content\s*===\s*content\b/);

    // THE FIX: the comparison goes through the text extractor rather than
    // touching `.content` directly. Asserted across both scopes because the
    // extraction deliberately lives outside the guard — that is what keeps the
    // guard one line from upstream.
    expect(src).toContain('parsedText(message.content)');
    const extractor = findScope(file, 'parsedText');
    expect(extractor).toBeDefined();
    expect(extractor!.getText()).toMatch(/\.text\b/);
  });

  // Inside the `hasUnwrapped` branch and nowhere else: outside it the span would
  // fire on every result and mislabel the next continuation as a nudge.
  it('marks text that was delivered to nobody, only when it was', () => {
    const scope = findScope(parse(POLL_LOOP_TS), 'dispatchResultText');
    expect(scope).toBeDefined();
    expect(callWithinIf(scope!, 'dropped', 'hasUnwrapped')).toBe(true);
  });

  // `handleEvent` receives EVERY provider event in the main loop — where the
  // SDK's structured classification (`rate_limit` vs `quota`, with the reset time)
  // exists before dying in a `log()` that goes with the container.
  it('captures the quota block in handleEvent', () => {
    const scope = findScope(parse(POLL_LOOP_TS), 'handleEvent');
    expect(scope).toBeDefined();
    expect(callsWithin(scope!, 'providerBlocked')).toBe(true);
  });

  // Without this, a runner infrastructure failure exists only in the container
  // log again — which dies with `--rm`. The first two are the fatal ones: the
  // query loop's catch and `processQuery`'s outer catch.
  it('reports the errors the runner swallows', () => {
    const src = parse(POLL_LOOP_TS);
    for (const fn of ['runPollLoop', 'processQuery', 'chatRowWrittenSince', 'wasWrittenInSeqWindow']) {
      const scope = findScope(src, fn);
      expect(scope).toBeDefined();
      expect(callsWithin(scope!, 'runnerError')).toBe(true);
    }
  });
});

// `telemetry.ts` closes a turn in three places. Two of them bypass `turnEnd` —
// container shutdown and replacing a pending turn — and lost every per-turn
// counter.
//
// A PLACEMENT assertion rather than a behavioral one for a concrete reason:
// `shutdownTelemetry()` calls `provider.shutdown()` and tears down the in-memory
// exporter for the process, so no test can read the span afterwards. Without this
// assertion, deleting that call would break nothing.
describe('counters survive a turn without a result', () => {
  /**
   * `callsWithin` does not fit here: it looks for `telemetry.<method>`, and inside
   * `telemetry.ts` itself the call is bare.
   */
  function bareCallsWithin(scope: ts.Node, name: string): boolean {
    let hit = false;
    const visit = (node: ts.Node): void => {
      if (hit) return;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
        hit = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(scope, visit);
    return hit;
  }

  it('shutdownTelemetry stamps the counters before closing the turn', () => {
    // The span-closing body lives in `closeOpenSpans` (shared with the crash
    // handlers); `shutdownTelemetry` must delegate there so all exit paths agree.
    const src = parse(TELEMETRY_TS);
    const closeScope = findScope(src, 'closeOpenSpans');
    expect(closeScope).toBeDefined();
    expect(bareCallsWithin(closeScope!, 'applyTurnCounters')).toBe(true);
    const shutdownScope = findScope(src, 'shutdownTelemetry');
    expect(shutdownScope).toBeDefined();
    expect(bareCallsWithin(shutdownScope!, 'closeOpenSpans')).toBe(true);
  });
});
