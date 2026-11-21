/**
 * PR Factory MCP tools — supervisor skill-edit proposals, testing gate,
 * credentialed GitHub commands, and test-result submission.
 *
 * The container can't write to inbound.db (host-owned), so each tool emits
 * a system action via messages_out and the host's delivery loop dispatches
 * it (see src/modules/pr-factory/index.ts on the host).
 *
 * These tools are visible in every container today; the host action
 * handlers are only registered when the pr-factory module is enabled,
 * so calling them from a non-PR-factory agent group is a no-op (host
 * logs "Unknown system action" and drops the request).
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const proposeSkillEdit: McpToolDefinition = {
  tool: {
    name: 'propose_skill_edit',
    description:
      'PR Factory supervisor only. Propose an edit to a container skill file. The host posts the diff for human approval — the edit is only applied if the human accepts. Read the current file from /app/skills/ first, then pass the full new content here.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skill_name: {
          type: 'string',
          description: 'Skill directory name under /app/skills/, e.g. "my-review-skill".',
        },
        file_name: {
          type: 'string',
          description: 'File within the skill directory, e.g. "SKILL.md".',
        },
        content: {
          type: 'string',
          description: 'Full new file content to propose.',
        },
      },
      required: ['skill_name', 'file_name', 'content'],
    },
  },
  async handler(args) {
    const skill_name = args.skill_name as string;
    const file_name = args.file_name as string;
    const content = args.content as string;
    if (!skill_name || !file_name || !content) return err('skill_name, file_name, and content are required');

    writeMessageOut({
      id: genId('sys'),
      kind: 'system',
      content: JSON.stringify({ action: 'pr_propose_skill_edit', skill_name, file_name, content }),
    });
    log(`pr_propose_skill_edit: ${skill_name}/${file_name}`);
    return ok(`Skill edit proposed for ${skill_name}/${file_name} — waiting for human approval.`);
  },
};

export const sendToTesting: McpToolDefinition = {
  tool: {
    name: 'send_to_testing',
    description:
      'PR Factory worker only. Request that the test plan (previously saved to /workspace/agent/test-plans/) be sent to the orchestrator for execution. The host will post the plan in the thread with an approval card — a human must approve before the plan is forwarded. Call this after writing the test plan file.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  async handler() {
    writeMessageOut({
      id: genId('sys'),
      kind: 'system',
      content: JSON.stringify({ action: 'pr_send_to_testing' }),
    });
    log('pr_send_to_testing requested');
    return ok('Test plan approval requested — waiting for human to accept.');
  },
};

export const ghCommand: McpToolDefinition = {
  tool: {
    name: 'credentialed_gh',
    description:
      'Run credentialed GitHub CLI commands that take action on a repository (merge, close, comment, label, approve, etc.). Write the full command(s) starting with `gh`, exactly as you would type in a terminal. The host shows the commands to a human for approval — they only execute if approved. When you need multiple commands (e.g. comment then merge), pass them as an array in `commands` — they execute sequentially on a single approval. Do NOT use this for read-only lookups (viewing PRs, listing checks, fetching user info, etc.) — use the `gh` CLI in your shell directly for those. Follow the merge strategy named in your group instructions when merging PRs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'A single gh CLI command. Use `commands` instead when you need multiple commands.',
        },
        commands: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Array of gh CLI commands to execute sequentially on a single approval. E.g. ["gh pr comment 42 --repo org/repo --body \'LGTM\'", "gh pr merge 42 --repo org/repo --merge --delete-branch"].',
        },
        description: {
          type: 'string',
          description: 'Short human-readable explanation of what these commands do, e.g. "comments LGTM and merges the PR".',
        },
      },
      required: ['description'],
    },
  },
  async handler(args) {
    const description = args.description as string;
    if (!description) return err('description is required');

    // Accept either `commands` (array) or `command` (string)
    let commands: string[];
    if (Array.isArray(args.commands) && args.commands.length > 0) {
      commands = args.commands as string[];
    } else if (typeof args.command === 'string' && args.command) {
      commands = [args.command];
    } else {
      return err('command or commands is required');
    }

    writeMessageOut({
      id: genId('sys'),
      kind: 'system',
      content: JSON.stringify({ action: 'pr_gh', commands, description }),
    });
    log(`pr_gh: ${commands.join(' && ')}`);
    return ok(
      `Credentialed gh command(s) proposed — waiting for human approval.\n${commands.map((c) => `\`${c}\``).join('\n')}`,
    );
  },
};

export const submitTestResults: McpToolDefinition = {
  tool: {
    name: 'submit_test_results',
    description:
      'PR Factory tester only. Submit the results of a test run. Include an explicit verdict (PASS, PARTIAL, or FAIL) and the full test results as markdown.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pr_number: {
          type: 'number',
          description: 'Pull request number that was tested.',
        },
        repo: {
          type: 'string',
          description:
            'Full repository name, e.g. "acme/widgets". Omit to use the host\'s configured default repo (PR_FACTORY_DEFAULT_REPO).',
        },
        verdict: {
          type: 'string',
          enum: ['PASS', 'PARTIAL', 'FAIL'],
          description:
            'Test verdict: PASS (all must-pass tests passed), PARTIAL (some skipped or should-pass failed), FAIL (must-pass test failed).',
        },
        content: {
          type: 'string',
          description: 'Full markdown test results including individual test outcomes and any error details.',
        },
      },
      required: ['pr_number', 'verdict', 'content'],
    },
  },
  async handler(args) {
    const pr_number = args.pr_number as number;
    // Omitted repo stays omitted — the host applies PR_FACTORY_DEFAULT_REPO.
    const repo = args.repo as string | undefined;
    const verdict = args.verdict as string;
    const content = args.content as string;
    if (!pr_number || !verdict || !content) return err('pr_number, verdict, and content are required');

    writeMessageOut({
      id: genId('sys'),
      kind: 'system',
      content: JSON.stringify({
        action: 'pr_submit_test_results',
        pr_number,
        ...(repo ? { repo } : {}),
        verdict,
        content,
      }),
    });
    log(`pr_submit_test_results: ${repo ?? '<default repo>'}#${pr_number} verdict=${verdict}`);
    return ok(`Test results submitted for ${repo ?? 'the default repo'}#${pr_number} — verdict: ${verdict}`);
  },
};

registerTools([proposeSkillEdit, sendToTesting, ghCommand, submitTestResults]);
