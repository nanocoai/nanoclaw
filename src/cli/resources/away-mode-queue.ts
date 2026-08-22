/**
 * Away Mode development queue — durable, ordered work items Claude processes
 * independently while Kirk is away. See away-mode/POLICY.md.
 *
 * Same `hostOnly: true` reasoning as away-mode-sessions.ts, on every
 * operation including `ask-kirk` -- see that file's header for why relying
 * on cli_scope's GROUP_SCOPE_RESOURCES allowlist alone would not be enough
 * (it never gates `global`-scoped agents, e.g. Pepper). No agent can reach
 * this table today, including via `ask-kirk` -- that flow is intended to be
 * driven by the host-side Away Mode operator (Claude Code / Kirk), never by
 * an agent container asking on its own initiative.
 *
 * No credentials, tenant PII, or other private information belongs in any
 * field here — queue items describe engineering work in the abstract (e.g.
 * "Fixed-Term PDF generation"), never real tenant/business specifics.
 *
 * Ported from old commit 0fb28c04, adapted to await getDb().get(...) (now
 * async) in preUpdate -- the OperationSpec/hostOnly mechanism this depends
 * on landed standalone in 4d39c31d.
 */
import { getDb } from '../../db/connection.js';
import { requestAwayModeDecision } from '../../modules/away-mode-decisions/index.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'away-mode-queue-item',
  plural: 'away-mode-queue',
  table: 'away_mode_queue',
  description:
    'One Away Mode development-queue item: goal, authority level, acceptance criteria, status, and what Claude has learned/decided so far.',
  idColumn: 'id',
  // Deliberately no scopeField: per src/cli/dispatch.ts, a resource with no
  // scopeField hard-rejects any group-scoped agent caller outright ("not
  // available in group scope") rather than silently filtering rows -- the
  // same protection sensitive resources like `roles` and `approvals` rely
  // on. `session_id` here is an away_mode_sessions id, not an agent group
  // id, so declaring it as scopeField would be a semantic mismatch and a
  // weaker (silently-empty-list) failure mode instead of a clear reject.
  columns: [
    { name: 'id', type: 'string', description: 'Auto-generated.', generated: true },
    { name: 'session_id', type: 'string', description: 'Away Mode session this item belongs to.', required: true },
    { name: 'position', type: 'number', description: 'Order within the queue.', required: true, updatable: true },
    { name: 'title', type: 'string', description: 'Short title.', required: true, updatable: true },
    {
      name: 'goal',
      type: 'string',
      description: 'What "done" means for this item, in concrete terms.',
      required: true,
      updatable: true,
    },
    {
      name: 'authority_level',
      type: 'string',
      description:
        'A=development, B=deployment (needs standing authorization or asks Kirk), C=production action (always through existing approval mechanisms).',
      enum: ['A', 'B', 'C'],
      default: 'A',
      updatable: true,
    },
    {
      name: 'acceptance_criteria',
      type: 'string',
      description: 'Measurable definition of done.',
      default: '',
      updatable: true,
    },
    {
      name: 'allowed_scope',
      type: 'string',
      description: 'What this item is allowed to touch.',
      default: '',
      updatable: true,
    },
    {
      name: 'production_exclusions',
      type: 'string',
      description: 'Explicit statement of what this item must NOT touch.',
      default: '',
      updatable: true,
    },
    {
      name: 'dependencies',
      type: 'json',
      description: 'JSON array of other queue item ids this depends on.',
      default: '[]',
      updatable: true,
    },
    {
      name: 'status',
      type: 'string',
      enum: ['QUEUED', 'IN_PROGRESS', 'TESTING', 'WAITING_FOR_KIRK', 'READY_FOR_KIRK_REVIEW', 'COMPLETED', 'BLOCKED'],
      description: 'Current workflow status.',
      default: 'QUEUED',
      updatable: true,
    },
    {
      name: 'key_decisions',
      type: 'json',
      description: 'JSON array of brief implementation decisions made and why.',
      default: '[]',
      updatable: true,
    },
    {
      name: 'test_results',
      type: 'json',
      description: 'JSON array of {what, result} test outcomes.',
      default: '[]',
      updatable: true,
    },
    {
      name: 'kirk_questions',
      type: 'json',
      description:
        'JSON array of {question_id, asked_at, question_text, answered_at, answer_text} — the record of anything routed through Pepper for this item.',
      default: '[]',
      updatable: true,
    },
    {
      name: 'next_action',
      type: 'string',
      description: 'What happens next on this item.',
      default: '',
      updatable: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
    {
      name: 'updated_at',
      type: 'string',
      description:
        'Auto-set to now on create (crud.ts special-cases any generated column ending in "_at"). Also updatable so ' +
        'each `away-mode-queue-update` call can explicitly refresh it (`--updated-at <ISO now>`) -- the generic CRUD ' +
        'helper does not auto-touch timestamps on update, only on create.',
      generated: true,
      updatable: true,
    },
  ],
  operations: {
    list: { access: 'open', hostOnly: true },
    get: { access: 'open', hostOnly: true },
    create: { access: 'open', hostOnly: true },
    update: { access: 'open', hostOnly: true },
  },
  // Real (not just policy-level) enforcement of "stopping Away Mode prevents
  // another queued task from starting": entering IN_PROGRESS is the one
  // transition that begins or resumes active work on an item, so it's the
  // one gated on the parent session actually being ACTIVE. Finishing an
  // already-resolved item (COMPLETED/BLOCKED) is still allowed regardless —
  // this only blocks *new* work from starting under a stopped session.
  preUpdate: async (updates, current) => {
    if (updates.status !== 'IN_PROGRESS') return;
    const sessionId = current.session_id as string;
    const session = await getDb().get<{ status?: string }>(
      'SELECT status FROM away_mode_sessions WHERE id = ?',
      sessionId,
    );
    if (!session || session.status !== 'ACTIVE') {
      throw new Error(
        `Cannot start/resume queue item ${current.id as string}: its Away Mode session ` +
          `(${sessionId}) is not ACTIVE (status=${session?.status ?? 'missing'}).`,
      );
    }
  },
  customOperations: {
    'ask-kirk': {
      access: 'open',
      hostOnly: true,
      description:
        'Send Kirk a real, structured decision card (title fixed to "Away Mode — Claude Needs Your Decision") for ' +
        'this queue item, via the same approval-delivery path every other approval already uses. --question must ' +
        'be plain-language and decision-focused (what, why, choices, recommendation) -- never raw technical ' +
        "output, a stack trace, or JSON. Sets the item to WAITING_FOR_KIRK and records the question. Kirk's " +
        'resolution (Approve, Reject, or Reject-with-reason free text) is recorded back onto this exact question ' +
        'automatically -- check kirk_questions[].answered_at on this item to know when it resolves. A card by ' +
        'itself is never authorization; only Kirk actually resolving it counts.',
      args: [
        { name: 'id', type: 'string', description: 'Queue item id.', required: true },
        {
          name: 'question',
          type: 'string',
          description: 'Plain-language, decision-focused question text.',
          required: true,
        },
      ],
      // Thin wrapper: all validation (item exists, session ACTIVE), card
      // creation, and kirk_questions bookkeeping lives in
      // requestAwayModeDecision (modules/away-mode-decisions/request.ts) so
      // it's exercised directly by that module's own tests, not just through
      // the CLI.
      handler: async (args) => {
        const result = await requestAwayModeDecision({
          queueItemId: args.id as string,
          question: args.question as string,
        });
        if (!result.ok) throw new Error(result.reason);
        return { question_id: result.questionId, status: 'WAITING_FOR_KIRK' };
      },
    },
  },
});
