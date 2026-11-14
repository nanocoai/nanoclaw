/**
 * Flows: pre-task scripts written as small, readable graphs.
 *
 * A flow names its nodes (one step function each) and declares every edge
 * between them. The base class owns the rest: walking the graph from `start`,
 * threading one shared context through every step, emitting the wake-gate
 * line a scheduled task's `--script` must print, and describing the graph
 * (nodes, edges, Mermaid) without running any step.
 *
 * Execution:
 *   - The run starts at the node the `start` edge points to.
 *   - A step may return the id of the next node; that is how a branch is
 *     taken. The returned id must be a declared edge out of the current node.
 *   - A step that returns nothing follows the node's single outgoing edge.
 *   - Reaching `end`, or a node with no outgoing edge, stops the run.
 *   - A step decides the gate by calling `this.wake(data)` or `this.skip()`.
 *     A run that ends without a decision throws, so the task records a failed
 *     run instead of silently skipping.
 */

/** Shared mutable state threaded through every step of one run. */
export type FlowCtx = Record<string, unknown>;

/** A step returns the next node id to branch, or nothing to follow the single outgoing edge. */
export type FlowStep = (ctx: FlowCtx) => Promise<string | void> | string | void;

export interface FlowNode {
  /** Human label for the diagram; the node id is its key in `nodes`. */
  label: string;
  step: FlowStep;
}

/** `[from, to]`, or `{ from, to, when }` to label a branch in the diagram. */
export type FlowEdge = [string, string] | { from: string; to: string; when?: string };

export interface FlowDescription {
  name: string;
  description: string;
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ from: string; to: string; when?: string }>;
  mermaid: string;
}

/** The wake-gate decision a task script prints as its last stdout line. */
export interface GateResult {
  wakeAgent: boolean;
  data?: unknown;
}

export const START = 'start';
export const END = 'end';

const MAX_STEPS = 100;
const NODE_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

export abstract class Flow {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly nodes: Record<string, FlowNode>;
  /** Every connection, including each possible branch. */
  abstract readonly edges: FlowEdge[];

  private decision: GateResult | null = null;

  /** Progress goes to stderr; stdout is reserved for the gate line. */
  protected log(message: string): void {
    console.error(`[flow:${this.name}] ${message}`);
  }

  /** Wake the agent; `data` is added to its prompt. */
  protected wake(data?: unknown): void {
    this.decision = data === undefined ? { wakeAgent: true } : { wakeAgent: true, data };
  }

  /** Finish the run without waking the agent. */
  protected skip(): void {
    this.decision = { wakeAgent: false };
  }

  private normalizedEdges(): Array<{ from: string; to: string; when?: string }> {
    return this.edges.map((e) => (Array.isArray(e) ? { from: e[0], to: e[1] } : e));
  }

  private validate(): void {
    for (const id of Object.keys(this.nodes)) {
      if (id === START || id === END) throw new Error(`flow ${this.name}: "${id}" is reserved`);
      if (!NODE_ID.test(id)) throw new Error(`flow ${this.name}: invalid node id "${id}"`);
    }
    const ids = new Set([START, END, ...Object.keys(this.nodes)]);
    const edges = this.normalizedEdges();
    for (const { from, to } of edges) {
      if (!ids.has(from)) throw new Error(`flow ${this.name}: edge from unknown node "${from}"`);
      if (!ids.has(to)) throw new Error(`flow ${this.name}: edge to unknown node "${to}"`);
    }
    const starts = edges.filter((e) => e.from === START);
    if (starts.length !== 1) throw new Error(`flow ${this.name}: expected exactly one start edge`);
  }

  /** Walk the graph, threading `ctx` through every step. Returns the final context. */
  async run(ctx: FlowCtx = {}): Promise<FlowCtx> {
    this.validate();
    this.decision = null;
    const edges = this.normalizedEdges();
    let current = edges.find((e) => e.from === START)!.to;
    let steps = 0;

    while (current !== END) {
      const node = this.nodes[current];
      if (++steps > MAX_STEPS) throw new Error(`flow ${this.name}: exceeded ${MAX_STEPS} steps`);

      this.log(`-> ${current}`);
      const branch = await node.step(ctx);

      if (typeof branch === 'string') {
        if (!edges.some((e) => e.from === current && e.to === branch)) {
          throw new Error(`flow ${this.name}: "${current}" returned undeclared edge to "${branch}"`);
        }
        current = branch;
        continue;
      }
      const out = edges.filter((e) => e.from === current);
      if (out.length === 0) break;
      if (out.length > 1) {
        throw new Error(`flow ${this.name}: "${current}" has ${out.length} outgoing edges and must return one`);
      }
      current = out[0].to;
    }
    return ctx;
  }

  /** Run the flow and return its gate decision. */
  async gate(ctx: FlowCtx = {}): Promise<GateResult> {
    await this.run(ctx);
    if (!this.decision) throw new Error(`flow ${this.name}: finished without calling wake() or skip()`);
    return this.decision;
  }

  /** The graph as data. Runs no step. */
  describe(): FlowDescription {
    this.validate();
    return {
      name: this.name,
      description: this.description,
      nodes: Object.entries(this.nodes).map(([id, n]) => ({ id, label: n.label })),
      edges: this.normalizedEdges(),
      mermaid: this.toMermaid(),
    };
  }

  /** The graph as a Mermaid `flowchart TD`. `end` is a Mermaid keyword, so it renders as `end_`. */
  toMermaid(): string {
    const ref = (id: string) => (id === END ? 'end_' : id);
    const lines = ['flowchart TD', '  start([start])', '  end_([end])'];
    for (const [id, n] of Object.entries(this.nodes)) {
      lines.push(`  ${id}["${n.label.replace(/"/g, "'")}"]`);
    }
    for (const { from, to, when } of this.normalizedEdges()) {
      lines.push(when ? `  ${ref(from)} -->|${when.replace(/\|/g, '/')}| ${ref(to)}` : `  ${ref(from)} --> ${ref(to)}`);
    }
    return lines.join('\n');
  }
}

/**
 * Command-line entry for a flow file:
 *
 *   bun my.flow.ts              run the flow and print the gate line
 *   bun my.flow.ts --describe   print the graph as JSON, running no step
 *   bun my.flow.ts --mermaid    print the Mermaid diagram
 */
export async function runFlowCli(flow: Flow, argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === '--describe') {
    console.log(JSON.stringify(flow.describe(), null, 2));
    return;
  }
  if (argv[0] === '--mermaid') {
    console.log(flow.toMermaid());
    return;
  }
  console.log(JSON.stringify(await flow.gate()));
}
