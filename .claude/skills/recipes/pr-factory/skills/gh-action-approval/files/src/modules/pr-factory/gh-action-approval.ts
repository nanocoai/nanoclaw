/**
 * gh-action-approval component — human gate for agent-initiated GitHub CLI
 * commands. Registers on pr-factory-core's gh-action seam at import time.
 *
 * Flow:
 *   1. Agent calls the `credentialed_gh` MCP tool with raw command string(s)
 *   2. System action `pr_gh` lands here via core's seam (gh-action.ts)
 *   3. Host posts the command + reason as a preview in the Slack thread
 *   4. Host posts an approval card
 *   5. Human clicks Accept → host executes `gh <command>` with the
 *      approver's credentials (see gh-users mapping below)
 *   6. Human clicks Reject → action dropped, agent notified
 *
 * KNOWN SMELL (declared in SKILL.md, carried with sign-off): command
 * execution threads the approver's gh oauth_token from
 * ~/.config/gh/hosts.yml into the subprocess env as GH_TOKEN — credential
 * handling outside the OneCLI gateway. It is what attributes merge actions
 * to the human approver. Redesign direction: route `gh` through the OneCLI
 * forward proxy with per-approver vault credentials so no token transits
 * the host process env. Do not extend this pattern to new commands or new
 * credential sources.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { DATA_DIR } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getPrThreadBySession } from '../../db/pr-threads.js';
import { createPendingApproval, updatePendingApprovalPlatformMessageId } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { prLog } from './activity-log.js';
import { dismissStaleApprovals } from './dismiss-approvals.js';
import { setGhActionHandler } from './gh-action.js';
import { registerApprovalHandler, notifyAgent } from '../approvals/primitive.js';
import type { ApprovalHandlerContext } from '../approvals/primitive.js';
import type { Session } from '../../types.js';
import { markAwaitingApproval, clearAwaitingApproval } from './reactions.js';

function approvalOptions(description: string): RawOption[] {
  return [
    { label: 'Approve', selectedLabel: `✅ ${description}`, value: 'approve' },
    { label: 'Reject', selectedLabel: `❌ Rejected — ${description}`, value: 'reject' },
  ];
}

// Approver → gh CLI account mapping. Operator config at data/gh-users.json,
// keyed by NAMESPACED user ids exactly as core's approval flow reports them
// (`<channel>:<handle>`, e.g. {"slack:U0XXXXXXX": "their-gh-login"} — see
// gh-users.sample.json). There is deliberately no bare-id fallback: an
// unmapped approver always uses the default gh credentials. Read lazily and
// fail-soft: a missing or malformed file means every approver falls back to
// the default credentials — it must never crash module import.
let ghUserMapCache: Record<string, string> | null = null;
function getGhUserMap(): Record<string, string> {
  if (ghUserMapCache) return ghUserMapCache;
  const ghUsersPath = path.join(DATA_DIR, 'gh-users.json');
  try {
    ghUserMapCache = JSON.parse(fs.readFileSync(ghUsersPath, 'utf8')) as Record<string, string>;
    // eslint-disable-next-line no-catch-all/no-catch-all -- fail-soft by contract: no/bad mapping file degrades to default credentials
  } catch {
    log.debug('pr-factory: no gh-users mapping at data/gh-users.json — gh commands use default credentials');
    ghUserMapCache = {};
  }
  return ghUserMapCache;
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Optional repo allowlist for approved gh commands
// (PR_FACTORY_GH_REPO_ALLOWLIST, comma-separated `owner/name` entries).
// Best-effort defense in depth — the human approval card is the primary
// gate. When set, any command that explicitly references a repo (an
// `-R`/`--repo` value, a `repos/owner/name` API path, or a github.com URL)
// outside the list is refused before execution. Commands with no
// recognizable repo reference run against the default gh context and are
// not blocked. Unset = no restriction.
const allowlistEnv = readEnvFile(['PR_FACTORY_GH_REPO_ALLOWLIST']);
const REPO_ALLOWLIST = (process.env.PR_FACTORY_GH_REPO_ALLOWLIST || allowlistEnv.PR_FACTORY_GH_REPO_ALLOWLIST || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function repoRefsIn(command: string): string[] {
  const refs = new Set<string>();
  for (const m of command.matchAll(/(?:^|\s)(?:-R|--repo)[=\s]+["']?([\w.-]+\/[\w.-]+)/g)) refs.add(m[1].toLowerCase());
  for (const m of command.matchAll(/repos\/([\w.-]+\/[\w.-]+)/g)) refs.add(m[1].toLowerCase());
  for (const m of command.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)/g)) refs.add(m[1].toLowerCase());
  return [...refs];
}

/** Returns the offending repo ref when the allowlist is set and violated, else null. */
function repoViolation(command: string): string | null {
  if (REPO_ALLOWLIST.length === 0) return null;
  for (const ref of repoRefsIn(command)) {
    if (!REPO_ALLOWLIST.includes(ref)) return ref;
  }
  return null;
}

/**
 * Look up the GH_TOKEN for a gh CLI account from ~/.config/gh/hosts.yml.
 * Parses just the oauth_token line for the given account — the file structure
 * is stable enough that a regex is simpler than adding a YAML dependency.
 */
function getGhToken(ghAccount: string): string | null {
  try {
    const hostsPath = path.join(os.homedir(), '.config', 'gh', 'hosts.yml');
    const content = fs.readFileSync(hostsPath, 'utf8');
    // Match: "        <account>:\n            oauth_token: <token>"
    const re = new RegExp(`^\\s+${ghAccount}:\\s*\\n\\s+oauth_token:\\s*(.+)$`, 'm');
    const m = content.match(re);
    return m ? m[1].trim() : null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- fail-soft by contract: unreadable hosts.yml degrades to default credentials
  } catch {
    return null;
  }
}

function gh(args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: 30_000, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || stdout?.trim() || err.message;
        return reject(new Error(msg));
      }
      resolve(stdout.trim());
    });
  });
}

// ── pr_gh executor (called by core through the gh-action seam) ──

async function handleGh(content: Record<string, unknown>, session: Session): Promise<void> {
  const description = content.description as string;

  // Accept either `commands` (array) or `command` (string) for backwards compat
  let commands: string[];
  if (Array.isArray(content.commands) && content.commands.length > 0) {
    commands = content.commands as string[];
  } else if (typeof content.command === 'string' && content.command) {
    commands = [content.command];
  } else {
    notifyAgent(session, 'pr_gh requires command(s) and description.');
    return;
  }

  if (!description) {
    notifyAgent(session, 'pr_gh requires command(s) and description.');
    return;
  }

  const mg = getMessagingGroup(session.messaging_group_id!);
  if (!mg) {
    log.warn('pr_gh: messaging group not found', { sessionId: session.id });
    return;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('pr_gh: no delivery adapter');
    return;
  }

  const threadId = session.thread_id;

  const preview = `\n━━━  GitHub  ━━━━━━━━━━━━━━━━━━━\n\n${description}`;

  // Post the preview text in the thread (short — full commands are in the
  // approval card). The instance arg routes through the bot identity that
  // owns this messaging group — under exact-instance dispatch an omitted
  // instance would post through the default bot.
  await adapter.deliver(
    mg.channel_type,
    mg.platform_id,
    threadId,
    'chat',
    JSON.stringify({ text: preview }),
    undefined,
    mg.instance,
  );

  // Dismiss any existing approval cards in this thread before posting a new one
  await dismissStaleApprovals(session);

  // Post approval card
  const approvalId = genId('appr-gh');
  const options = approvalOptions(description);
  const normalizedOptions = normalizeOptions(options);

  createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    request_id: approvalId,
    action: 'pr_gh',
    payload: JSON.stringify({ commands, description }),
    created_at: new Date().toISOString(),
    title: 'GitHub CLI',
    options_json: JSON.stringify(normalizedOptions),
  });

  const commandBlock = commands.map((c) => c.replace(/```/g, "'''")).join('\n');
  const platformMsgId = await adapter.deliver(
    mg.channel_type,
    mg.platform_id,
    threadId,
    'chat-sdk',
    JSON.stringify({
      type: 'ask_question',
      questionId: approvalId,
      title: 'GitHub CLI',
      question: `${description}\n\`\`\`\n${commandBlock}\n\`\`\``,
      options,
    }),
    undefined,
    mg.instance,
  );
  if (platformMsgId) updatePendingApprovalPlatformMessageId(approvalId, platformMsgId);

  await markAwaitingApproval(session);
  const prThread = getPrThreadBySession(session.id);
  if (prThread) prLog(prThread.pr_number, prThread.repo_full_name, 'gh_action_proposed', { commands, description });
  log.info('GH action approval card posted', { approvalId, commands, sessionId: session.id });
}

// ── Approval handler (fires when human clicks Accept) ──

async function onGhApproved(ctx: ApprovalHandlerContext): Promise<void> {
  await clearAwaitingApproval(ctx.session);
  const prThread = getPrThreadBySession(ctx.session.id);

  // Support both `commands` (array) and legacy `command` (string)
  let commands: string[];
  if (Array.isArray(ctx.payload.commands)) {
    commands = ctx.payload.commands as string[];
  } else {
    commands = [ctx.payload.command as string];
  }

  // Resolve the approver's GitHub credentials. ctx.userId is namespaced
  // (`<channel>:<handle>`) and the mapping keys are too — exact match only.
  const ghAccount = getGhUserMap()[ctx.userId];
  const env: Record<string, string> = {};
  if (ghAccount) {
    const token = getGhToken(ghAccount);
    if (token) {
      env.GH_TOKEN = token;
      log.info('gh commands will run as', { ghAccount, userId: ctx.userId });
    } else {
      log.warn('gh account found in mapping but no token in hosts.yml', { ghAccount, userId: ctx.userId });
    }
  } else {
    log.warn('No gh account mapping for approver — using default credentials', { userId: ctx.userId });
  }

  // Execute commands sequentially — stop on first failure
  const results: string[] = [];
  for (const command of commands) {
    const violation = repoViolation(command);
    if (violation) {
      log.warn('gh command refused by repo allowlist', { command, repo: violation, userId: ctx.userId });
      results.push(`\`${command}\` refused: repo \`${violation}\` is not in PR_FACTORY_GH_REPO_ALLOWLIST.`);
      break; // Stop — same contract as a failed command
    }

    // Strip leading `gh ` — the agent writes the full command, but execFile
    // invokes the `gh` binary directly so we only pass the arguments.
    const argsStr = command.replace(/^gh\s+/, '');
    const args = argsStr.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    const cleanArgs = args.map((a) => a.replace(/^["']|["']$/g, ''));

    try {
      const output = await gh(cleanArgs, env);
      if (prThread)
        prLog(prThread.pr_number, prThread.repo_full_name, 'gh_command_executed', {
          command,
          ghAccount: ghAccount || 'default',
        });
      log.info('gh command executed', { command, ghAccount: ghAccount || 'default' });
      results.push(output ? `\`${command}\` succeeded:\n\`\`\`\n${output}\n\`\`\`` : `\`${command}\` succeeded.`);
      // eslint-disable-next-line no-catch-all/no-catch-all -- a failed gh command is reported to the agent, never thrown past the loop
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (prThread) prLog(prThread.pr_number, prThread.repo_full_name, 'gh_command_failed', { command, error: msg });
      log.error('gh command failed', {
        command,
        err,
        prNumber: prThread?.pr_number,
        repo: prThread?.repo_full_name,
        category: 'gh-command',
      });

      // Detect merge failures and provide actionable guidance
      const isMergeCmd = /\bpr\s+merge\b/.test(command);
      if (isMergeCmd) {
        results.push(
          [
            `\`${command}\` failed: ${msg}`,
            '',
            'This is likely due to branch protection rules or auto-merge being disabled on the repository.',
            'Post a message in the PR thread informing the author that tests passed but the merge must be performed manually by a maintainer with merge permissions.',
            'Do NOT attempt alternative merge strategies — the blocker is repository-level, not command-level.',
          ].join('\n'),
        );
      } else {
        results.push(`\`${command}\` failed: ${msg}`);
      }
      break; // Stop on first failure
    }
  }

  ctx.notify(results.join('\n\n'));
}

setGhActionHandler(handleGh);
registerApprovalHandler('pr_gh', onGhApproved);
