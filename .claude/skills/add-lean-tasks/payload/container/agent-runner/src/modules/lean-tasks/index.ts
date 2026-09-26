/**
 * Lean task runs — agent-runner half.
 *
 * A task whose content carries `lean: true` runs its turn for a small or
 * local model: a slim plain system prompt, no filesystem settings (skills,
 * instruction files, memory hook), no resume, no MCP servers, no built-in
 * tools. The model delivers through the result doors in doors.ts.
 *
 * Two registrations:
 * - a turn hook marks the opening query of a lean task batch;
 * - a provider wrapper sends a marked query to a second, minimal-context
 *   provider instance and delivers the doors from each result before the
 *   poll loop sees it.
 */
import type { MemorySessionHookRegistration } from '../../memory/session-hook.js';
import type { MessageInRow } from '../../db/messages-in.js';
import { getTaskSeriesId } from '../../db/session-routing.js';
import type { RoutingContext } from '../../formatter.js';
import { registerProviderWrapper, type ProviderWrapperContext } from '../../providers/provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from '../../providers/types.js';
import { registerTurnHook } from '../../turn-hooks.js';
import { applyResultDoors, buildLeanInstructions } from './doors.js';

interface LeanPlan {
  routing: RoutingContext;
  render?: string;
}

/** Carried on the query input; object spreads by other hooks and wrappers keep it. */
const LEAN = Symbol('lean-task');
type MarkedInput = QueryInput & { [LEAN]?: LeanPlan };

function log(msg: string): void {
  console.error(`[lean-tasks] ${msg}`);
}

/** The lean settings of the batch's task row, or null when it is not lean. */
export function readLeanTask(messages: MessageInRow[]): { render?: string } | null {
  for (const msg of messages) {
    if (msg.kind !== 'task') continue;
    try {
      const content = JSON.parse(msg.content) as Record<string, unknown>;
      if (content.lean !== true) continue;
      return typeof content.render === 'string' && content.render.trim() ? { render: content.render } : {};
    } catch {
      /* not a JSON envelope */
    }
  }
  return null;
}

registerTurnHook({
  name: 'lean-tasks',
  prepareQuery(input, ctx) {
    if (!ctx.routing.taskRun) return;
    const lean = readLeanTask(ctx.messages);
    if (!lean) return;
    log(`Lean task batch${lean.render ? ' with render command' : ''}`);
    const marked: MarkedInput = { ...input, [LEAN]: { routing: ctx.routing, ...lean } };
    return marked;
  },
});

function leanQuery(query: AgentQuery, plan: LeanPlan): AgentQuery {
  async function* events(): AsyncGenerator<ProviderEvent> {
    for await (const event of query.events) {
      // A lean session is never the one the next turn resumes.
      if (event.type === 'init') continue;
      if (event.type === 'result' && !event.isError && event.text) {
        yield { ...event, text: await applyResultDoors(event.text, plan.routing, plan.render) };
        continue;
      }
      yield event;
    }
  }
  return {
    push: (message) => query.push(message),
    end: () => query.end(),
    abort: () => query.abort(),
    events: events(),
  };
}

/**
 * Decorates the provider in place, the way the factory attaches contract
 * hooks, so it stays the same instance: unmarked queries reach the original
 * `query` untouched.
 */
export function wrapForLeanTasks(inner: AgentProvider, context: ProviderWrapperContext): AgentProvider {
  let memoryHook: [MemorySessionHookRegistration, unknown] | undefined;
  let lean: AgentProvider | undefined;
  const leanProvider = (): AgentProvider => {
    if (!lean) {
      lean = context.create({ ...context.options, mcpServers: {}, systemPromptMode: 'plain', minimalContext: true });
      if (memoryHook) lean.registerMemorySessionHook(...memoryHook);
    }
    return lean;
  };

  const registerMemorySessionHook = inner.registerMemorySessionHook.bind(inner);
  inner.registerMemorySessionHook = (hook, memory) => {
    memoryHook = [hook, memory];
    registerMemorySessionHook(hook, memory);
    lean?.registerMemorySessionHook(hook, memory);
  };

  const query = inner.query.bind(inner);
  inner.query = (input: MarkedInput) => {
    const plan = input[LEAN];
    if (!plan) return query(input);
    const instructions = buildLeanInstructions({
      assistantName: context.options.assistantName,
      taskId: getTaskSeriesId(),
      render: plan.render !== undefined,
    });
    return leanQuery(
      leanProvider().query({ ...input, continuation: undefined, systemContext: { instructions } }),
      plan,
    );
  };
  return inner;
}

registerProviderWrapper('claude', wrapForLeanTasks);
