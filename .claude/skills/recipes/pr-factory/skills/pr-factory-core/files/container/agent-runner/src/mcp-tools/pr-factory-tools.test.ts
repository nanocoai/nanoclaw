/**
 * pr-factory-core guard — the six PR Factory MCP tool handlers' session-DB
 * consumption and the exact cross-process action-string contract.
 *
 * Each handler writes a kind:'system' row into messages_out whose
 * JSON.parse(content).action must equal the host-side registerDeliveryAction
 * key EXACTLY (pairs with src/modules/pr-factory/registration.test.ts on the
 * host) — a drifted string is a silent "Unknown system action" drop in
 * production, so it must go red here. Also pins the container's odd-seq
 * convention, pr_gh's command/commands normalization, and the repo-default
 * contract: when the agent omits `repo`, the payload omits it too — the HOST
 * action handlers apply PR_FACTORY_DEFAULT_REPO (the container never sees
 * that env var, so a container-side default would silently override it).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { ghCommand, proposeSkillEdit, sendToTesting, submitTestResults } from './pr-factory.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function systemRows(): Array<{ seq: number; kind: string; action: string; content: Record<string, unknown> }> {
  return getUndeliveredMessages().map((m) => {
    const content = JSON.parse(m.content) as Record<string, unknown>;
    return { seq: m.seq as number, kind: m.kind, action: String(content.action), content };
  });
}

describe('pr-factory MCP tools → messages_out contract', () => {
  it('propose_skill_edit emits pr_propose_skill_edit with the full file payload', async () => {
    await proposeSkillEdit.handler({ skill_name: 'my-review-skill', file_name: 'SKILL.md', content: '# v2' });
    const [row] = systemRows();
    expect(row.action).toBe('pr_propose_skill_edit');
    expect(row.content).toMatchObject({ skill_name: 'my-review-skill', file_name: 'SKILL.md', content: '# v2' });
  });

  it('send_to_testing emits a bare pr_send_to_testing action', async () => {
    await sendToTesting.handler({});
    const [row] = systemRows();
    expect(row.kind).toBe('system');
    expect(row.seq % 2).toBe(1); // container writes odd seq
    expect(row.action).toBe('pr_send_to_testing');
  });

  it('credentialed_gh normalizes a single command string into the commands array', async () => {
    await ghCommand.handler({ command: 'gh pr merge 42 --merge', description: 'merge it' });
    const [row] = systemRows();
    expect(row.action).toBe('pr_gh');
    expect(row.content.commands).toEqual(['gh pr merge 42 --merge']);
    expect(row.content.description).toBe('merge it');
  });

  it('credentialed_gh passes a commands array through and errors when neither form is given', async () => {
    await ghCommand.handler({ commands: ['gh pr comment 42 --body hi', 'gh pr merge 42 --merge'], description: 'both' });
    const [row] = systemRows();
    expect(row.content.commands).toEqual(['gh pr comment 42 --body hi', 'gh pr merge 42 --merge']);

    const err = await ghCommand.handler({ description: 'no commands' });
    expect(err.isError).toBe(true);
    expect(systemRows()).toHaveLength(1); // nothing extra written
  });

  it('submit_test_results emits pr_submit_test_results with verdict, requires it, and omits repo unless given', async () => {
    await submitTestResults.handler({ pr_number: 42, verdict: 'PASS', content: '## results' });
    const [row] = systemRows();
    expect(row.action).toBe('pr_submit_test_results');
    expect(row.content).toMatchObject({ pr_number: 42, verdict: 'PASS', content: '## results' });
    // Repo absent in the payload → host-side PR_FACTORY_DEFAULT_REPO applies.
    expect('repo' in row.content).toBe(false);

    await submitTestResults.handler({ pr_number: 43, repo: 'acme/widgets', verdict: 'FAIL', content: 'x' });
    const explicit = systemRows()[1];
    expect(explicit.content.repo).toBe('acme/widgets');

    const err = await submitTestResults.handler({ pr_number: 42, content: 'missing verdict' });
    expect(err.isError).toBe(true);
  });
});
