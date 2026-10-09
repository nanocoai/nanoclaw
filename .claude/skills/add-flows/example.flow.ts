/**
 * Example flow: wake the agent when files are waiting in an inbox folder.
 *
 *   bun /app/src/flows/example.flow.ts
 *   bun /app/src/flows/example.flow.ts --describe
 *
 * The folder defaults to /workspace/agent/inbox; FLOW_INBOX_DIR overrides it.
 */
import fs from 'node:fs';

import { Flow, runFlowCli, type FlowCtx, type FlowEdge, type FlowNode } from './flow.js';

const DEFAULT_INBOX = '/workspace/agent/inbox';
const MAX_LISTED = 20;

export class InboxFlow extends Flow {
  readonly name = 'inbox-check';
  readonly description = 'Wake the agent when files are waiting in the inbox folder';

  readonly nodes: Record<string, FlowNode> = {
    scan: { label: 'List inbox files', step: (ctx) => this.scan(ctx) },
    decide: { label: 'Anything waiting?', step: (ctx) => ((ctx.files as string[]).length > 0 ? 'report' : 'quiet') },
    report: { label: 'Wake with the file list', step: (ctx) => this.report(ctx) },
    quiet: { label: 'Stay asleep', step: () => this.skip() },
  };

  readonly edges: FlowEdge[] = [
    ['start', 'scan'],
    ['scan', 'decide'],
    { from: 'decide', to: 'report', when: 'files found' },
    { from: 'decide', to: 'quiet', when: 'empty' },
    ['report', 'end'],
    ['quiet', 'end'],
  ];

  private scan(ctx: FlowCtx): void {
    const dir = process.env.FLOW_INBOX_DIR || DEFAULT_INBOX;
    ctx.dir = dir;
    ctx.files = fs.existsSync(dir)
      ? fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
          .map((entry) => entry.name)
          .sort()
      : [];
    this.log(`${(ctx.files as string[]).length} file(s) in ${dir}`);
  }

  private report(ctx: FlowCtx): void {
    const files = ctx.files as string[];
    this.wake({ dir: ctx.dir, count: files.length, files: files.slice(0, MAX_LISTED) });
  }
}

if (import.meta.main) {
  await runFlowCli(new InboxFlow());
}
