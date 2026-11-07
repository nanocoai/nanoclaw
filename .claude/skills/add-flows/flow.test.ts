import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from '../scheduling/task-script.js';
import { Flow, runFlowCli, type FlowCtx, type FlowEdge, type FlowNode } from './flow.js';

const EXAMPLE = path.join(import.meta.dir, 'example.flow.ts');

class ThresholdFlow extends Flow {
  readonly name = 'threshold';
  readonly description = 'wakes when count exceeds the limit';
  readonly order: string[] = [];

  protected override log(): void {}

  readonly nodes: Record<string, FlowNode> = {
    load: {
      label: 'Load count',
      step: (ctx: FlowCtx) => {
        this.order.push('load');
        ctx.count = typeof ctx.count === 'number' ? ctx.count : 5;
      },
    },
    double: {
      label: 'Double it',
      step: async (ctx: FlowCtx) => {
        this.order.push('double');
        ctx.count = (ctx.count as number) * 2;
      },
    },
    decide: {
      label: 'Over the limit?',
      step: (ctx: FlowCtx) => {
        this.order.push('decide');
        return (ctx.count as number) > 6 ? 'alert' : 'quiet';
      },
    },
    alert: {
      label: 'Wake "the agent"',
      step: (ctx: FlowCtx) => {
        this.order.push('alert');
        this.wake({ count: ctx.count });
      },
    },
    quiet: {
      label: 'Stay asleep',
      step: () => {
        this.order.push('quiet');
        this.skip();
      },
    },
  };

  readonly edges: FlowEdge[] = [
    ['start', 'load'],
    ['load', 'double'],
    ['double', 'decide'],
    { from: 'decide', to: 'alert', when: 'over | limit' },
    { from: 'decide', to: 'quiet', when: 'under' },
    ['alert', 'end'],
    ['quiet', 'end'],
  ];
}

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('Flow execution', () => {
  it('runs steps in edge order and follows the returned branch', async () => {
    const flow = new ThresholdFlow();
    await flow.run();
    expect(flow.order).toEqual(['load', 'double', 'decide', 'alert']);

    const quiet = new ThresholdFlow();
    await quiet.run({ count: 1 });
    expect(quiet.order).toEqual(['load', 'double', 'decide', 'quiet']);
  });

  it('threads one context through every step and returns it', async () => {
    const ctx: FlowCtx = { count: 2, keep: 'me' };
    const result = await new ThresholdFlow().run(ctx);
    expect(result).toBe(ctx);
    expect(result).toEqual({ count: 4, keep: 'me' });
  });

  it('returns the gate decision a step made', async () => {
    expect(await new ThresholdFlow().gate()).toEqual({ wakeAgent: true, data: { count: 10 } });
    expect(await new ThresholdFlow().gate({ count: 1 })).toEqual({ wakeAgent: false });
  });

  it('fails a run that ends without a decision', async () => {
    class Undecided extends ThresholdFlow {
      override readonly edges: FlowEdge[] = [
        ['start', 'load'],
        ['load', 'end'],
      ];
    }
    await expect(new Undecided().gate()).rejects.toThrow(/without calling wake\(\) or skip\(\)/);
  });

  it('rejects a branch to an undeclared edge', async () => {
    class Bad extends ThresholdFlow {
      override readonly nodes: Record<string, FlowNode> = {
        ...new ThresholdFlow().nodes,
        decide: { label: 'x', step: () => 'load' },
      };
    }
    await expect(new Bad().run()).rejects.toThrow(/undeclared edge/);
  });

  it('requires a step to choose between several outgoing edges', async () => {
    class Ambiguous extends ThresholdFlow {
      override readonly nodes: Record<string, FlowNode> = {
        ...new ThresholdFlow().nodes,
        decide: { label: 'x', step: () => undefined },
      };
    }
    await expect(new Ambiguous().run()).rejects.toThrow(/must return one/);
  });

  it('rejects edges naming unknown nodes and reserved node ids', async () => {
    class Typo extends ThresholdFlow {
      override readonly edges: FlowEdge[] = [['start', 'lod']];
    }
    await expect(new Typo().run()).rejects.toThrow(/unknown node "lod"/);

    class Reserved extends ThresholdFlow {
      override readonly nodes: Record<string, FlowNode> = { end: { label: 'x', step: () => undefined } };
    }
    expect(() => new Reserved().describe()).toThrow(/reserved/);
  });

  it('stops a cycle', async () => {
    class Loop extends ThresholdFlow {
      override readonly edges: FlowEdge[] = [
        ['start', 'load'],
        ['load', 'double'],
        ['double', 'load'],
      ];
    }
    await expect(new Loop().run()).rejects.toThrow(/exceeded 100 steps/);
  });
});

describe('Flow description', () => {
  it('describes nodes, edges, and Mermaid without running a step', () => {
    const flow = new ThresholdFlow();
    const d = flow.describe();
    expect(flow.order).toEqual([]);
    expect(d.name).toBe('threshold');
    expect(d.nodes.map((n) => n.id)).toEqual(['load', 'double', 'decide', 'alert', 'quiet']);
    expect(d.edges).toContainEqual({ from: 'decide', to: 'quiet', when: 'under' });
    expect(d.edges).toContainEqual({ from: 'load', to: 'double' });
    expect(d.mermaid.split('\n')[0]).toBe('flowchart TD');
    expect(d.mermaid).toContain(`alert["Wake 'the agent'"]`);
    expect(d.mermaid).toContain('decide -->|over / limit| alert');
    expect(d.mermaid).toContain('alert --> end_');
  });
});

describe('runFlowCli', () => {
  it('prints the gate decision as the last stdout line', async () => {
    const out = captureStdout();
    try {
      await runFlowCli(new ThresholdFlow(), []);
    } finally {
      out.restore();
    }
    expect(JSON.parse(out.lines.at(-1)!)).toEqual({ wakeAgent: true, data: { count: 10 } });
  });

  it('--describe prints the graph and runs no step', async () => {
    const flow = new ThresholdFlow();
    const out = captureStdout();
    try {
      await runFlowCli(flow, ['--describe']);
    } finally {
      out.restore();
    }
    expect(flow.order).toEqual([]);
    expect(JSON.parse(out.lines.join('\n'))).toEqual(flow.describe());
  });
});

describe('example flow as a task script', () => {
  let inbox: string;
  let previous: string | undefined;

  beforeEach(() => {
    inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-inbox-'));
    previous = process.env.FLOW_INBOX_DIR;
    process.env.FLOW_INBOX_DIR = inbox;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.FLOW_INBOX_DIR;
    else process.env.FLOW_INBOX_DIR = previous;
    fs.rmSync(inbox, { recursive: true, force: true });
  });

  const script = `"${process.execPath}" "${EXAMPLE}"`;

  it('gates the task when the inbox is empty', async () => {
    expect(await runScript(script, `flow-empty-${process.pid}`)).toEqual({ wakeAgent: false });
  });

  it('wakes the agent with the file list when files are waiting', async () => {
    fs.writeFileSync(path.join(inbox, 'b.txt'), '');
    fs.writeFileSync(path.join(inbox, 'a.txt'), '');
    fs.writeFileSync(path.join(inbox, '.hidden'), '');
    expect(await runScript(script, `flow-files-${process.pid}`)).toEqual({
      wakeAgent: true,
      data: { dir: inbox, count: 2, files: ['a.txt', 'b.txt'] },
    });
  });

  it('--describe prints the graph from the command line', () => {
    const proc = Bun.spawnSync([process.execPath, EXAMPLE, '--describe']);
    expect(proc.exitCode).toBe(0);
    const d = JSON.parse(proc.stdout.toString());
    expect(d.name).toBe('inbox-check');
    expect(d.edges).toContainEqual({ from: 'decide', to: 'report', when: 'files found' });
    expect(d.mermaid).toContain('flowchart TD');
  });
});
