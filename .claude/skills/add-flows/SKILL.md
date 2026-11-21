---
name: add-flows
description: Add flows — a small graph framework for scheduled-task pre-task scripts. A flow names its steps and edges, threads one context through them, prints the wake-gate line, and describes itself as JSON or Mermaid without running. Use when a task's --script outgrows a few lines of Bash, or the user asks for "flows", "readable task scripts", or "diagram a task script".
---

# Add Flows

A scheduled task can run a pre-task `--script` whose last stdout line decides
whether the agent wakes (`{"wakeAgent": false}` or
`{"wakeAgent": true, "data": {...}}`, see
[docs/scheduled-tasks.md](../../../docs/scheduled-tasks.md#script-gates)).
This skill adds a base class that lets that script be a readable graph
instead of a growing Bash file:

- **Nodes** are named steps, one function each.
- **Edges** declare every connection, including each branch a step may take.
- **One context object** is threaded through every step of a run.
- **The runner** walks the graph and prints the wake-gate line.
- **`--describe`** prints the graph (nodes, edges, Mermaid) as JSON without
  running any step; `--mermaid` prints only the diagram.

Flows run with Bun inside the agent container, which already ships it. The
agent-runner source is mounted read-only at `/app/src`, so files copied into
`container/agent-runner/src/flows/` are available to every agent group
without an image rebuild.

## Step 1: Copy the files

```bash
mkdir -p container/agent-runner/src/flows
cp .claude/skills/add-flows/flow.ts container/agent-runner/src/flows/flow.ts
cp .claude/skills/add-flows/example.flow.ts container/agent-runner/src/flows/example.flow.ts
cp .claude/skills/add-flows/flow.test.ts container/agent-runner/src/flows/flow.test.ts
```

Copying overwrites, so re-running this step refreshes the files.

## Step 2: Verify

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun test src/flows
```

The test covers execution order, context threading, the gate decision,
`--describe`, and runs the example flow through the agent-runner's own
pre-task script runner (`scheduling/task-script.ts`), so a change to the
wake-gate contract turns it red.

## Step 3: Write a flow

Put flow files in the agent group's folder, under `groups/<folder>/flows/`.
That folder is `/workspace/agent/flows/` inside the container. Import the base
class by its container path:

```typescript
import fs from 'node:fs';

import { Flow, runFlowCli, type FlowEdge, type FlowNode } from '/app/src/flows/flow.ts';

class DiskFlow extends Flow {
  readonly name = 'disk-check';
  readonly description = 'Wake the agent when the workspace is over 90% full';

  readonly nodes: Record<string, FlowNode> = {
    measure: {
      label: 'Measure usage',
      step: (ctx) => {
        const stats = fs.statfsSync('/workspace/agent');
        ctx.percent = Math.round(100 * (1 - stats.bavail / stats.blocks));
      },
    },
    decide: { label: 'Over 90%?', step: (ctx) => ((ctx.percent as number) > 90 ? 'alert' : 'quiet') },
    alert: { label: 'Wake with usage', step: (ctx) => this.wake({ percent: ctx.percent }) },
    quiet: { label: 'Stay asleep', step: () => this.skip() },
  };

  readonly edges: FlowEdge[] = [
    ['start', 'measure'],
    ['measure', 'decide'],
    { from: 'decide', to: 'alert', when: 'over' },
    { from: 'decide', to: 'quiet', when: 'under' },
    ['alert', 'end'],
    ['quiet', 'end'],
  ];
}

await runFlowCli(new DiskFlow());
```

Rules the runner enforces:

- Exactly one edge leaves `start`. `start` and `end` are reserved and are not
  node ids.
- A step with several outgoing edges must return the id of the next node, and
  that edge must be declared. A step with one outgoing edge returns nothing.
- Some step must call `this.wake(data)` or `this.skip()`. A run that ends
  without either throws, and the task records a failed run.
- Log with `this.log(...)`; it writes to stderr. Stdout carries only the gate
  line.

`container/agent-runner/src/flows/example.flow.ts` is a complete, runnable
flow: it wakes the agent when files are waiting in `/workspace/agent/inbox`
(override with `FLOW_INBOX_DIR`).

## Step 4: Point a task at the flow

Try it inside the agent's container first; the agent can run this itself:

```bash
bun /workspace/agent/flows/disk.flow.ts
bun /workspace/agent/flows/disk.flow.ts --describe
```

Then make the flow the task's script:

```bash
ncl tasks create \
  --group <agent-group-id> \
  --name "disk check" \
  --recurrence "*/30 * * * *" \
  --prompt "The workspace is nearly full. Report the largest directories." \
  --script "bun /workspace/agent/flows/disk.flow.ts"
```

For an existing task:

```bash
ncl tasks update <task-id> --group <agent-group-id> --script "bun /workspace/agent/flows/disk.flow.ts"
```

Editing the flow file changes the next run; the task keeps pointing at the
path.

Pre-task scripts share the 30-second timeout and 1 MB output limit described
in [docs/scheduled-tasks.md](../../../docs/scheduled-tasks.md#script-gates). A
flow that throws exits non-zero, which counts as a failed run and triggers
the task's failure backoff.

## Removal

See [REMOVE.md](REMOVE.md).
