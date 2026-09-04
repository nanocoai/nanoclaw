/**
 * Idempotent setup for the PR Factory:
 *
 *   - PR Factory Worker agent group (one, fixed; default instructions seeded)
 *   - PR Factory Supervisor agent group (optional, gated by config)
 *   - messaging_groups for (PR channel × worker instance) and
 *     (PR channel × supervisor instance)
 *   - messaging_group for the supervisor's admin channel
 *   - wirings between them
 *
 * Drops any pre-existing wiring on the PR channel that doesn't belong to the
 * new worker, so a legacy agent group stops receiving PR-channel traffic once
 * this module takes over.
 *
 * Called from index.ts at startup once the Slack adapters are ready.
 */
import { createAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  deleteMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  updateMessagingGroupAgent,
} from '../../db/messaging-groups.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { SUPERVISOR_INSTANCE } from '../../channels/slack-supervisor.js';
import { TESTER_INSTANCE } from '../../channels/slack-tester.js';
import type { AgentGroup, MessagingGroupAgent, UnknownSenderPolicy } from '../../types.js';
import { SUPERVISOR_FOLDER, SUPERVISOR_INSTRUCTIONS } from './supervisor.js';
import { WORKER_INSTRUCTIONS } from './worker-instructions.js';

export const WORKER_FOLDER = 'pr-factory-worker';

/**
 * The tester agent group is operator-created (its instructions describe the
 * operator's test environment, so they don't ship with the module). Bootstrap
 * only wires it up: when an agent group with this folder exists, the tester's
 * messaging group on the PR channel is created automatically.
 */
export const TESTER_FOLDER = 'pr-tester';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureAgentGroup(folder: string, name: string, instructions?: string): AgentGroup {
  const existing = getAgentGroupByFolder(folder);
  if (existing) return existing;
  const ag: AgentGroup = {
    id: generateId('ag'),
    name,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  };
  createAgentGroup(ag);
  initGroupFilesystem(ag, instructions ? { instructions } : undefined);
  log.info('PR factory: created agent group', { id: ag.id, folder });
  return ag;
}

/**
 * Exact (channel_type, platform_id, instance) ensure. Lookups pass the
 * instance explicitly so a named-instance row (supervisor/tester) is never
 * confused with the worker's default-instance row on the same channel —
 * `getMessagingGroupByPlatform` is exact-only when instance is set.
 */
function ensureMessagingGroup(
  channelType: string,
  platformId: string,
  instance: string | undefined,
  name: string,
  unknownSenderPolicy: UnknownSenderPolicy,
): string {
  const inst = instance ?? channelType;
  const existing = getMessagingGroupByPlatform(channelType, platformId, inst);
  if (existing) return existing.id;
  const id = generateId('mg');
  createMessagingGroup({
    id,
    channel_type: channelType,
    platform_id: platformId,
    instance: inst,
    name,
    is_group: 1,
    unknown_sender_policy: unknownSenderPolicy,
    created_at: new Date().toISOString(),
  });
  log.info('PR factory: created messaging group', { id, platformId, instance: inst });
  return id;
}

type WiringOptions = Pick<
  MessagingGroupAgent,
  'engage_mode' | 'engage_pattern' | 'sender_scope' | 'ignored_message_policy' | 'session_mode'
>;

function ensureWiring(messagingGroupId: string, agentGroupId: string, opts: WiringOptions): void {
  const existing = getMessagingGroupAgents(messagingGroupId).find((m) => m.agent_group_id === agentGroupId);
  if (existing) {
    // Fix up an out-of-date wiring (e.g. an earlier version of bootstrap that
    // wrote different engage_mode / session_mode values). Ensures bootstrap
    // is self-correcting across upgrades, not just self-skipping.
    const drift: Partial<WiringOptions> = {};
    for (const k of Object.keys(opts) as (keyof WiringOptions)[]) {
      if (existing[k] !== opts[k]) {
        // narrow assignment: WiringOptions keys are a subset of MessagingGroupAgent.
        (drift as Record<string, unknown>)[k] = opts[k];
      }
    }
    if (Object.keys(drift).length > 0) {
      updateMessagingGroupAgent(existing.id, drift);
      log.info('PR factory: updated wiring', { id: existing.id, fields: Object.keys(drift) });
    }
    return;
  }
  const id = generateId('mga');
  createMessagingGroupAgent({
    id,
    messaging_group_id: messagingGroupId,
    agent_group_id: agentGroupId,
    ...opts,
    priority: 0,
    created_at: new Date().toISOString(),
  });
  log.info('PR factory: created wiring', { id, messagingGroupId, agentGroupId });
}

function dropForeignWirings(messagingGroupId: string, keepAgentGroupId: string): void {
  // Remove any wiring on the PR channel that doesn't belong to the new
  // worker. Without this, a legacy agent group keeps receiving PR-channel
  // traffic and double-engages on every message.
  for (const w of getMessagingGroupAgents(messagingGroupId)) {
    if (w.agent_group_id !== keepAgentGroupId) {
      deleteMessagingGroupAgent(w.id);
      log.info('PR factory: dropped foreign wiring', { id: w.id, agentGroupId: w.agent_group_id });
    }
  }
}

export interface BootstrapOptions {
  /** Bare Slack channel id for PR threads, e.g. C0B0XTGUTS5. */
  workerChannelId: string;
  /** Bare Slack channel id for the supervisor's admin channel. Supervisor disabled if absent. */
  supervisorChannelId?: string;
}

export interface BootstrapResult {
  workerAgentGroupId: string;
  workerMessagingGroupId: string;
  workerPlatformId: string;
}

export function bootstrapPrFactory(opts: BootstrapOptions): BootstrapResult {
  const workerPlatformId = `slack:${opts.workerChannelId}`;

  // === Worker ===
  const worker = ensureAgentGroup(WORKER_FOLDER, 'PR Factory Worker', WORKER_INSTRUCTIONS);
  const workerMgId = ensureMessagingGroup('slack', workerPlatformId, undefined, 'PR Factory Worker', 'public');
  dropForeignWirings(workerMgId, worker.id);
  ensureWiring(workerMgId, worker.id, {
    // mention-sticky + per-thread: worker only engages in threads it's been
    // explicitly subscribed to. The PR handler subscribes each new PR thread
    // on bootstrap so in-thread replies route automatically without anyone
    // needing to @-mention the worker. Top-level channel posts (e.g. someone
    // @-mentioning the supervisor to add them to the channel) don't engage
    // the worker because they're in an unsubscribed thread.
    engage_mode: 'mention-sticky',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
  });

  // === Supervisor (optional) ===
  if (opts.supervisorChannelId) {
    const supervisor = ensureAgentGroup(SUPERVISOR_FOLDER, 'PR Factory Supervisor', SUPERVISOR_INSTRUCTIONS);

    const adminMgId = ensureMessagingGroup(
      'slack',
      `slack:${opts.supervisorChannelId}`,
      SUPERVISOR_INSTANCE,
      'PR Factory Supervisor (admin)',
      'public',
    );
    ensureWiring(adminMgId, supervisor.id, {
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
    });

    const prMgForSupervisorId = ensureMessagingGroup(
      'slack',
      workerPlatformId,
      SUPERVISOR_INSTANCE,
      'PR Factory Supervisor (PR threads)',
      'public',
    );
    ensureWiring(prMgForSupervisorId, supervisor.id, {
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'accumulate',
      session_mode: 'per-thread',
    });
  }

  // === Tester (optional) ===
  // The pr-tester agent group is created by the operator (see TESTER_FOLDER).
  // When it exists, ensure the tester instance's messaging group on the PR
  // channel — the orchestrator resolves tester sessions against this row, and
  // index.ts refuses to start the test orchestrator without it.
  const tester = getAgentGroupByFolder(TESTER_FOLDER);
  if (tester) {
    const prMgForTesterId = ensureMessagingGroup(
      'slack',
      workerPlatformId,
      TESTER_INSTANCE,
      'PR Factory Tester (PR threads)',
      'public',
    );
    ensureWiring(prMgForTesterId, tester.id, {
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'accumulate',
      session_mode: 'per-thread',
    });
  }

  return {
    workerAgentGroupId: worker.id,
    workerMessagingGroupId: workerMgId,
    workerPlatformId,
  };
}
