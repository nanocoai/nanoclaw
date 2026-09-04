/**
 * PR Factory skill edit approval — technical gate for supervisor skill edits.
 *
 * Flow:
 *   1. Supervisor reads skill at /app/skills/ (RO mount)
 *   2. Supervisor calls `propose_skill_edit` MCP tool with new content
 *   3. Host computes diff, posts it in the supervisor's thread as a .diff file
 *   4. Host posts an approval card in the same thread (via supervisor bot)
 *   5. Human clicks Accept → host writes the new content to disk
 *   6. Human clicks Reject → change dropped, agent notified
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { createPendingApproval, updatePendingApprovalPlatformMessageId } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { prLog } from './activity-log.js';
import { DEFAULT_REPO } from './defaults.js';
import { dismissStaleApprovals } from './dismiss-approvals.js';
import { registerApprovalHandler, notifyAgent } from '../approvals/primitive.js';
import type { ApprovalHandlerContext } from '../approvals/primitive.js';
import type { Session } from '../../types.js';

const SKILLS_DIR = path.resolve(process.cwd(), 'container/skills');

const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Apply Edit', selectedLabel: '✅ Applied', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
];

function computeDiff(oldContent: string, newContent: string, filePath: string): string {
  const tmpOld = path.join('/tmp', `skill-old-${Date.now()}`);
  const tmpNew = path.join('/tmp', `skill-new-${Date.now()}`);
  try {
    fs.writeFileSync(tmpOld, oldContent);
    fs.writeFileSync(tmpNew, newContent);
    const diff = execFileSync('diff', ['-u', '--label', `a/${filePath}`, '--label', `b/${filePath}`, tmpOld, tmpNew], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return diff || '(no changes)';
  } catch (err: unknown) {
    // diff exits 1 when files differ — that's the normal case
    if (err && typeof err === 'object' && 'stdout' in err) {
      const stdout = (err as { stdout: string }).stdout;
      if (stdout) return stdout;
    }
    return '(diff unavailable)';
  } finally {
    try {
      fs.unlinkSync(tmpOld);
      // eslint-disable-next-line no-catch-all/no-catch-all -- tmp cleanup; nothing to do on failure
    } catch {
      // already gone
    }
    try {
      fs.unlinkSync(tmpNew);
      // eslint-disable-next-line no-catch-all/no-catch-all -- tmp cleanup; nothing to do on failure
    } catch {
      // already gone
    }
  }
}

export async function handleProposeSkillEdit(content: Record<string, unknown>, session: Session): Promise<void> {
  const skillName = content.skill_name as string;
  const fileName = content.file_name as string;
  const newContent = content.content as string;

  if (!skillName || !fileName || !newContent) {
    notifyAgent(session, 'propose_skill_edit requires skill_name, file_name, and content.');
    return;
  }

  // Validate path safety — no traversal
  const relPath = path.join(skillName, fileName);
  const fullPath = path.resolve(SKILLS_DIR, relPath);
  if (!fullPath.startsWith(SKILLS_DIR + path.sep)) {
    log.warn('propose_skill_edit: path traversal attempt', { skillName, fileName, fullPath });
    notifyAgent(session, `Invalid skill path: ${relPath}`);
    return;
  }

  const mg = getMessagingGroup(session.messaging_group_id!);
  if (!mg) {
    log.warn('propose_skill_edit: messaging group not found', { sessionId: session.id });
    return;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('propose_skill_edit: no delivery adapter');
    return;
  }

  // Compute diff against current file (or show full content for new files)
  const isNew = !fs.existsSync(fullPath);
  const oldContent = isNew ? '' : fs.readFileSync(fullPath, 'utf8');
  const diff = isNew ? `(new file)\n\n${newContent}` : computeDiff(oldContent, newContent, relPath);

  // Post diff as a .diff file in the supervisor's thread. The instance arg
  // routes through the bot identity that owns this messaging group (the
  // supervisor instance) — under exact-instance dispatch an omitted instance
  // would post through the default worker bot.
  const threadId = session.thread_id;
  const diffFile = [{ filename: `${skillName}-${fileName}.diff`, data: Buffer.from(diff) }];
  await adapter.deliver(
    mg.channel_type,
    mg.platform_id,
    threadId,
    'chat',
    JSON.stringify({ text: `Proposed edit to \`${relPath}\`` }),
    diffFile,
    mg.instance,
  );

  // Dismiss any existing approval cards in this thread before posting a new one
  await dismissStaleApprovals(session);

  // Post approval card in the same thread via the supervisor bot
  const approvalId = `appr-skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedOptions = normalizeOptions(APPROVAL_OPTIONS);

  createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    request_id: approvalId,
    action: 'pr_propose_skill_edit',
    payload: JSON.stringify({ skillName, fileName, content: newContent }),
    created_at: new Date().toISOString(),
    title: 'Skill Edit',
    options_json: JSON.stringify(normalizedOptions),
  });

  const platformMsgId = await adapter.deliver(
    mg.channel_type,
    mg.platform_id,
    threadId,
    'chat-sdk',
    JSON.stringify({
      type: 'ask_question',
      questionId: approvalId,
      title: 'Skill Edit',
      question: `Apply edit to \`${relPath}\`?`,
      options: APPROVAL_OPTIONS,
    }),
    undefined,
    mg.instance,
  );
  if (platformMsgId) updatePendingApprovalPlatformMessageId(approvalId, platformMsgId);

  // Skill edits are supervisor-level, not per-PR — log to PR 0 as a system event
  prLog(0, DEFAULT_REPO, 'skill_edit_proposed', { skillName, fileName });
  log.info('Skill edit approval card posted', { approvalId, skillName, fileName, sessionId: session.id });
}

// Approval handler — fires when human clicks Accept
async function onSkillEditApproved(ctx: ApprovalHandlerContext): Promise<void> {
  const { payload } = ctx;
  const skillName = payload.skillName as string;
  const fileName = payload.fileName as string;
  const content = payload.content as string;

  const relPath = path.join(skillName, fileName);
  const fullPath = path.resolve(SKILLS_DIR, relPath);

  // Re-validate path safety
  if (!fullPath.startsWith(SKILLS_DIR + path.sep)) {
    ctx.notify(`Invalid skill path: ${relPath}`);
    return;
  }

  // Ensure directory exists (for new skills)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  prLog(0, DEFAULT_REPO, 'skill_edit_applied', { skillName, fileName });
  log.info('Skill edit applied', { skillName, fileName });
  ctx.notify(`Skill edit applied to \`${relPath}\`.`);
}

registerApprovalHandler('pr_propose_skill_edit', onSkillEditApproved);
