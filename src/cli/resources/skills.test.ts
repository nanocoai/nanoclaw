/**
 * `ncl skills` — registration, the trailing-positional skill name as the CLI
 * sends it, the guard refusal that keeps malformed requests and secret inputs
 * out of any approval card, the approval hold and replay, the argv the
 * resource hands the headless engine, and the deferred, honest host restart.
 * The engine itself is covered in scripts/skill-headless.test.ts; here it is a
 * mock so the CLI seams are exercised in isolation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CallerContext } from '../frame.js';

const engine = vi.hoisted(() => ({
  runSkillHeadless: vi.fn(),
  hostServiceDefined: vi.fn(),
  restartHost: vi.fn(),
}));
vi.mock('../skill-runner.js', () => engine);

type ApprovalHandler = (args: {
  payload: Record<string, unknown>;
  approval: Record<string, unknown>;
  notify: (text: string) => void;
}) => Promise<unknown>;

const approvalState = vi.hoisted(() => ({
  requestApproval: vi.fn(),
  approvalHandler: null as null | ApprovalHandler,
  registerApprovalHandler: vi.fn((action: string, handler: ApprovalHandler) => {
    if (action === 'cli_command') approvalState.approvalHandler = handler;
  }),
}));
vi.mock('../../modules/approvals/index.js', () => ({
  registerApprovalHandler: approvalState.registerApprovalHandler,
  requestApproval: approvalState.requestApproval,
}));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
const mockGetContainerConfig = vi.fn();
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: (...args: unknown[]) => mockGetContainerConfig(...args),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn().mockResolvedValue({ id: 'ag-1', name: 'Nano' }),
}));
const mockGetPendingApproval = vi.fn();
vi.mock('../../db/sessions.js', () => ({
  getSession: vi.fn().mockResolvedValue({ id: 'sess-1', agent_group_id: 'ag-1', messaging_group_id: 'mg-1' }),
  getPendingApproval: (...args: unknown[]) => mockGetPendingApproval(...args),
}));
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroupAgentByPair: vi.fn(),
}));

import { dispatch } from '../dispatch.js';
import { parseArgv } from '../parse-argv.js';
import { GROUP_SCOPE_RESOURCES, commandGuard, lookup } from '../registry.js';
// Side-effect import: registers the `skills-*` commands.
import './skills.js';

const HOST: CallerContext = { caller: 'host' };
const AGENT: CallerContext = { caller: 'agent', sessionId: 'sess-1', agentGroupId: 'ag-1', messagingGroupId: 'mg-1' };

const appliedReport = (skill: string) => ({
  schema: 'nanoclaw-skill-apply/v1',
  skill,
  status: 'applied',
  applied: ['copy: src/x.ts'],
  skipped: ['run restart: owned by the caller'],
  deferred: [],
  agentTasks: [],
  operatorMessages: [],
  vars: {},
  pendingEffects: [{ effect: 'restart', line: 40, command: 'bash setup/lib/restart.sh' }],
});

const plan = (skill: string) => ({
  skill,
  steps: [],
  prompts: [
    { var: 'owner_handle', question: 'Your handle.', secret: false },
    { var: 'bot_token', question: 'Paste the bot token.', secret: true },
  ],
  needsInput: ['owner_handle', 'bot_token'],
  agentSteps: 0,
  callerOwnedEffects: ['restart'],
});

/** The engine mock answers `plan` and `apply` by their first argv word. */
function engineAnswers(report = appliedReport('add-slack')) {
  engine.runSkillHeadless.mockImplementation(async (argv: string[]) => {
    if (argv[0] === 'plan') return plan(argv[1]);
    if (argv[0] === 'list') return [];
    return report;
  });
}

/** What the `ncl` binary would send for these words. */
const cli = (...words: string[]) => {
  const parsed = parseArgv(words);
  return { id: words.join('-'), command: parsed.command, args: parsed.args };
};

const dataOf = (res: Awaited<ReturnType<typeof dispatch>>) => (res.ok ? (res.data as { restart: string }) : undefined);

beforeEach(() => {
  vi.clearAllMocks();
  engineAnswers();
  engine.hostServiceDefined.mockReturnValue(true);
  mockGetContainerConfig.mockResolvedValue({ cli_scope: 'global' });
});

describe('registration', () => {
  it('registers list, plan, and apply with the intended access', () => {
    expect(lookup('skills-list')?.access).toBe('open');
    expect(lookup('skills-plan')?.access).toBe('open');
    expect(lookup('skills-apply')?.access).toBe('approval');
    for (const name of ['skills-list', 'skills-plan', 'skills-apply']) expect(lookup(name)?.resource).toBe('skills');
  });

  it('apply holds through the cli_command approval channel and carries a refusal hook', () => {
    expect(commandGuard('skills-apply').grantActionName).toBe('cli_command');
    expect(typeof lookup('skills-apply')?.refuse).toBe('function');
  });

  it('is not reachable under group scope', () => {
    expect(GROUP_SCOPE_RESOURCES.has('skills')).toBe(false);
  });
});

describe('host caller', () => {
  it('takes the skill as the trailing positional, the way the CLI sends it', async () => {
    const planned = await dispatch(cli('skills', 'plan', 'add-slack'), HOST);
    expect(planned.ok).toBe(true);
    expect(engine.runSkillHeadless).toHaveBeenLastCalledWith(['plan', 'add-slack']);

    const applied = await dispatch(cli('skills', 'apply', 'add-codex', '--restart'), HOST);
    expect(applied.ok).toBe(true);
    expect(engine.runSkillHeadless).toHaveBeenLastCalledWith(['apply', 'add-codex'], { exclusive: true });
  });

  it('applies exclusively and defers the restart until the reply has left', async () => {
    const res = await dispatch(
      cli('skills', 'apply', 'add-slack', '--inputs', '{"owner_handle":"U1"}', '--restart'),
      HOST,
    );
    expect(res.ok).toBe(true);
    expect(engine.runSkillHeadless).toHaveBeenCalledWith(['apply', 'add-slack', '--inputs', '{"owner_handle":"U1"}'], {
      exclusive: true,
    });
    expect(dataOf(res)?.restart).toBe('requested');
    // Not yet — the transport runs it after its own egress.
    expect(engine.restartHost).not.toHaveBeenCalled();
    expect(res.afterReply).toEqual(expect.any(Function));
    res.afterReply!();
    expect(engine.restartHost).toHaveBeenCalledTimes(1);
  });

  it('says so instead of claiming a restart when no service is defined for this checkout', async () => {
    engine.hostServiceDefined.mockReturnValue(false);
    const res = await dispatch(cli('skills', 'apply', 'add-slack', '--restart'), HOST);
    expect(res.ok).toBe(true);
    expect(dataOf(res)?.restart).toBe('unmanaged');
    expect(res.afterReply).toBeUndefined();
    if (res.ok) expect(res.human).toMatch(/restart the host by hand/);
    expect(engine.restartHost).not.toHaveBeenCalled();
  });

  it('may pass secret inputs — credentials are entered on the host', async () => {
    const res = await dispatch(cli('skills', 'apply', 'add-slack', '--inputs', '{"bot_token":"xoxb-1"}'), HOST);
    expect(res.ok).toBe(true);
    const argv = engine.runSkillHeadless.mock.calls.at(-1)?.[0] as string[];
    expect(argv).not.toContain('--no-secret-inputs');
  });

  it('does not request a restart after a rolled-back apply', async () => {
    engineAnswers({ ...appliedReport('add-slack'), status: 'rolled-back' });
    const res = await dispatch(cli('skills', 'apply', 'add-slack', '--restart'), HOST);
    expect(res.ok).toBe(true);
    expect(dataOf(res)?.restart).toBe('not-requested');
    expect(res.afterReply).toBeUndefined();
  });

  it('rejects a name that could escape the skills directory', async () => {
    const res = await dispatch({ id: 'r3', command: 'skills-apply', args: { id: '../etc' } }, HOST);
    expect(res.ok).toBe(false);
    expect(engine.runSkillHeadless).not.toHaveBeenCalled();
  });

  it('lists through the engine', async () => {
    await dispatch(cli('skills', 'list'), HOST);
    expect(engine.runSkillHeadless).toHaveBeenLastCalledWith(['list']);
  });
});

describe('agent caller', () => {
  it('is denied under group scope', async () => {
    mockGetContainerConfig.mockResolvedValue({ cli_scope: 'group' });
    const res = await dispatch(cli('skills', 'apply', 'add-slack'), AGENT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
    expect(engine.runSkillHeadless).not.toHaveBeenCalled();
  });

  it('is refused before any card when an input answers a secret prompt', async () => {
    const res = await dispatch(
      cli('skills', 'apply', 'add-slack', '--inputs', '{"owner_handle":"U1","bot_token":"xoxb-1"}'),
      AGENT,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('forbidden');
      expect(res.error.message).toMatch(/bot_token/);
      expect(res.error.message).not.toMatch(/xoxb-1/);
    }
    expect(approvalState.requestApproval).not.toHaveBeenCalled();
    // The refusal consulted the skill's declared prompts; nothing was applied.
    expect(engine.runSkillHeadless).toHaveBeenCalledWith(['plan', 'add-slack']);
    expect(engine.runSkillHeadless).not.toHaveBeenCalledWith(expect.arrayContaining(['apply']), expect.anything());
  });

  it('is refused before any card when the request is malformed', async () => {
    const badName = await dispatch(cli('skills', 'apply', 'Add_Slack'), AGENT);
    expect(badName.ok).toBe(false);
    if (!badName.ok) expect(badName.error.message).toMatch(/not a skill directory name/);

    const badJson = await dispatch(cli('skills', 'apply', 'add-slack', '--inputs', '{not json'), AGENT);
    expect(badJson.ok).toBe(false);
    if (!badJson.ok) expect(badJson.error.message).toMatch(/valid JSON/);

    expect(approvalState.requestApproval).not.toHaveBeenCalled();
    expect(engine.runSkillHeadless).not.toHaveBeenCalled();
  });

  it('answers with the engine’s own message when the prompts cannot be checked', async () => {
    engine.runSkillHeadless.mockRejectedValue(
      new Error('unknown skill "add-slack" — no .claude/skills/add-slack/SKILL.md'),
    );
    const res = await dispatch(cli('skills', 'apply', 'add-slack', '--inputs', '{"owner_handle":"U1"}'), AGENT);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('forbidden');
      expect(res.error.message).toMatch(/cannot check the inputs for add-slack: unknown skill/);
    }
    expect(approvalState.requestApproval).not.toHaveBeenCalled();
  });

  it('is held with plain inputs shown, then applied on the agent path with the restart deferred past resolution', async () => {
    const res = await dispatch(
      cli('skills', 'apply', 'add-slack', '--inputs', '{"owner_handle":"U1"}', '--restart'),
      AGENT,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('approval-pending');

    const request = approvalState.requestApproval.mock.calls[0][0] as {
      question: string;
      payload: Record<string, unknown>;
    };
    expect(request.question).toContain('--inputs {"owner_handle":"U1"}');

    const grant = { approval_id: 'appr-1', action: 'cli_command', payload: JSON.stringify(request.payload) };
    mockGetPendingApproval.mockResolvedValue(grant);
    const notify = vi.fn();
    const result = (await approvalState.approvalHandler!({ payload: request.payload, approval: grant, notify })) as {
      afterResolved?: () => void;
    };

    expect(engine.runSkillHeadless).toHaveBeenCalledWith(
      ['apply', 'add-slack', '--inputs', '{"owner_handle":"U1"}', '--no-secret-inputs'],
      { exclusive: true },
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('approved and executed'));
    // The restart is handed back to the approval flow, which runs it once the
    // approval is fully resolved — never inside the handler.
    expect(engine.restartHost).not.toHaveBeenCalled();
    expect(result.afterResolved).toEqual(expect.any(Function));
    result.afterResolved!();
    expect(engine.restartHost).toHaveBeenCalledTimes(1);
  });
});
