/**
 * Step: register — Create v2 entities (agent group, messaging group, wiring).
 *
 * Writes to the v2 central DB (data/v2.db) — NOT the v1 store/messages.db.
 * Creates: agent_group, messaging_group, messaging_group_agents.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { ensureContainerConfig } from '../src/db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
  getMessagingGroupAgentByPair,
} from '../src/db/messaging-groups.js';
import { isValidGroupFolder } from '../src/group-folder.js';
import { log } from '../src/log.js';
import { namespacedPlatformId } from '../src/platform-id.js';
import { resolveSession, writeSessionMessage } from '../src/session-manager.js';
import { emitStatus } from './status.js';

interface RegisterArgs {
  /** Platform-specific channel/group ID (Discord channel ID, Slack channel, etc.) */
  platformId: string;
  /** Human-readable name for the messaging group */
  name: string;
  /** Trigger pattern (regex or keyword) */
  trigger: string;
  /** Agent group folder name */
  folder: string;
  /** Channel type (discord, slack, telegram, etc.) */
  channel: string;
  /** Whether messages require the trigger pattern to activate */
  requiresTrigger: boolean;
  /** Display name for the assistant */
  assistantName: string;
  /** Session mode: 'shared' (one session per channel) or 'per-thread' */
  sessionMode: string;
}

function parseArgs(args: string[]): RegisterArgs {
  const result: RegisterArgs = {
    platformId: '',
    name: '',
    trigger: '',
    folder: '',
    channel: 'discord',
    requiresTrigger: false,
    assistantName: 'Andy',
    sessionMode: 'shared',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--platform-id':
        result.platformId = args[++i] || '';
        break;
      case '--name':
        result.name = args[++i] || '';
        break;
      case '--trigger':
        result.trigger = args[++i] || '';
        break;
      case '--folder':
        result.folder = args[++i] || '';
        break;
      case '--channel':
        result.channel = (args[++i] || '').toLowerCase();
        break;
      case '--no-trigger-required':
        result.requiresTrigger = false;
        break;
      case '--assistant-name':
        result.assistantName = args[++i] || 'Andy';
        break;
      case '--session-mode':
        result.sessionMode = args[++i] || 'shared';
        break;
    }
  }

  return result;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const parsed = parseArgs(args);

  if (!parsed.platformId || !parsed.name || !parsed.folder) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'missing_required_args',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  if (!isValidGroupFolder(parsed.folder)) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'invalid_folder',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  // Normalize platform_id to the same shape the adapter will emit at runtime,
  // so the router's (channel_type, platform_id) lookup matches what we store.
  // Chat SDK adapters prefix, native adapters (WhatsApp/iMessage/Signal) don't.
  parsed.platformId = namespacedPlatformId(parsed.channel, parsed.platformId);

  log.info('Registering channel', { ...parsed });

  // Init v2 central DB
  fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);

  // 1. Create or find agent group. Provider-agnostic: provider is a DB
  // property set via `ncl groups config update --provider`, not a creation
  // flag. The workspace is scaffolded at the first spawn (group-init), where
  // the DB-resolved provider is known; here we only ensure the config row
  // exists so that update has a row to write.
  let agentGroup = getAgentGroupByFolder(parsed.folder);
  if (!agentGroup) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: parsed.assistantName,
      folder: parsed.folder,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    agentGroup = getAgentGroupByFolder(parsed.folder)!;
    log.info('Created agent group', { id: agId, folder: parsed.folder });
  }
  ensureContainerConfig(agentGroup.id);

  // 2. Create or find messaging group
  let messagingGroup = getMessagingGroupByPlatform(parsed.channel, parsed.platformId);
  if (!messagingGroup) {
    const mgId = generateId('mg');
    createMessagingGroup({
      id: mgId,
      channel_type: parsed.channel,
      platform_id: parsed.platformId,
      name: parsed.name,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    messagingGroup = getMessagingGroupByPlatform(parsed.channel, parsed.platformId)!;
    log.info('Created messaging group', { id: mgId, channel: parsed.channel, platformId: parsed.platformId });
  }

  // 3. Wire agent to messaging group — createMessagingGroupAgent auto-creates
  // the companion agent_destinations row so delivery's ACL admits this target.
  let newlyWired = false;
  const existing = getMessagingGroupAgentByPair(messagingGroup.id, agentGroup.id);
  if (!existing) {
    newlyWired = true;
    const mgaId = generateId('mga');
    // Mirrors scripts/init-first-agent.ts:wireIfMissing so both setup paths
    // create rows with the same shape. Groups default to 'mention' (bot only
    // responds when addressed); DMs default to 'pattern'/'.' (respond to
    // every message). An explicit --trigger overrides the pattern regex.
    const isGroup = messagingGroup.is_group === 1;
    const engageMode: 'pattern' | 'mention' = isGroup && !parsed.trigger ? 'mention' : 'pattern';
    const engagePattern: string | null = engageMode === 'pattern' ? parsed.trigger || '.' : null;
    createMessagingGroupAgent({
      id: mgaId,
      messaging_group_id: messagingGroup.id,
      agent_group_id: agentGroup.id,
      engage_mode: engageMode,
      engage_pattern: engagePattern,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: parsed.sessionMode as 'shared' | 'per-thread' | 'agent-shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
    log.info('Wired agent to messaging group', {
      mgaId,
      agentGroup: agentGroup.id,
      messagingGroup: messagingGroup.id,
    });
  }

  // 4. Send onboarding message — only on first wiring, not re-registration
  if (newlyWired) {
    const { session } = resolveSession(
      agentGroup.id,
      messagingGroup.id,
      null,
      parsed.sessionMode as 'shared' | 'per-thread' | 'agent-shared',
    );
    writeSessionMessage(agentGroup.id, session.id, {
      id: generateId('onboard'),
      kind: 'task',
      timestamp: new Date().toISOString(),
      platformId: parsed.platformId,
      channelType: parsed.channel,
      content: JSON.stringify({
        prompt: `A new ${parsed.channel} channel has been connected. Run /welcome to introduce yourself to the user.`,
      }),
    });
    log.info('Onboarding message written', { sessionId: session.id, channel: parsed.channel });
  }

  // 5. Apply assistant name to JUST the group being registered.
  //
  // Earlier behavior did a project-wide find-replace of "Andy" across every
  // `groups/*/CLAUDE.md` and overwrote `.env`'s `ASSISTANT_NAME`, which
  // caused two real-world problems:
  //   - registering a second agent (e.g. "Homie") clobbered the unrelated
  //     primary agent's CLAUDE.md (replacing "Andy" with "Homie" in
  //     groups/diddyclaw/CLAUDE.md when Diddyclaw was already in place);
  //   - the global `.env` ASSISTANT_NAME flipped to the most recently-
  //     registered agent, which then became the install-wide default
  //     trigger for any *new* group registered without an explicit
  //     `--assistant-name`.
  // Both were unintentional global side-effects of a per-agent operation.
  // Scope is now strictly: only the freshly-registered agent's own
  // `groups/<folder>/CLAUDE.md`.
  let nameUpdated = false;
  if (parsed.assistantName !== 'Andy') {
    const mdFile = path.join(projectRoot, 'groups', parsed.folder, 'CLAUDE.md');
    if (fs.existsSync(mdFile)) {
      const before = fs.readFileSync(mdFile, 'utf-8');
      const after = before
        .replace(/^# Andy$/m, `# ${parsed.assistantName}`)
        .replace(/You are Andy/g, `You are ${parsed.assistantName}`);
      if (after !== before) {
        fs.writeFileSync(mdFile, after);
        log.info('Updated assistant name in registered group only', {
          file: mdFile,
          to: parsed.assistantName,
        });
        nameUpdated = true;
      }
    }
  }

  emitStatus('REGISTER_CHANNEL', {
    PLATFORM_ID: parsed.platformId,
    NAME: parsed.name,
    FOLDER: parsed.folder,
    CHANNEL: parsed.channel,
    TRIGGER: parsed.trigger,
    REQUIRES_TRIGGER: parsed.requiresTrigger,
    ASSISTANT_NAME: parsed.assistantName,
    SESSION_MODE: parsed.sessionMode,
    NAME_UPDATED: nameUpdated,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
