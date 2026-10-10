import { randomUUID } from 'node:crypto';

import { dispatch } from '../cli/dispatch.js';
import { DEFAULT_AGENT_PROVIDER } from '../config.js';
import { getAgentGroupByFolder } from '../db/agent-groups.js';
import { getContainerConfig } from '../db/container-configs.js';
import { getDb } from '../db/connection.js';
import { getPendingApproval, getPendingQuestion } from '../db/sessions.js';
import { assertValidGroupFolder } from '../group-folder.js';
import { normalizeName } from '../modules/agent-to-agent/db/agent-destinations.js';
import '../providers/index.js';
import { listProviderContainerConfigNames } from '../providers/provider-container-registry.js';
import type { AgentGroup } from '../types.js';

export const LOCAL_WEB_CHANNEL_TYPE = 'local-web';
export const LOCAL_WEB_LEGACY_PLATFORM_ID = 'local-web:local';
export const LOCAL_WEB_USER_ID = LOCAL_WEB_LEGACY_PLATFORM_ID;

const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const ALLOWED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const ALLOWED_CREATE_FIELDS = new Set(['name', 'sourceConversationId', 'provider', 'model', 'effort']);

export interface LocalWebConversation {
  conversationId: string;
  agentName: string;
  provider: string;
  model?: string;
  effort?: string;
  isLegacy: boolean;
}

export interface LocalWebCatalog {
  conversations: LocalWebConversation[];
  installedProviders: string[];
  installationDefault: string;
  isInstallationDefaultInstalled: boolean;
}

export interface CreateLocalWebAgentRequest {
  name: string;
  sourceConversationId?: string;
  provider?: string;
  model?: string | null;
  effort?: string | null;
}

export type ParseCreateLocalWebAgentRequestResult =
  | { ok: true; value: CreateLocalWebAgentRequest }
  | { ok: false; message: string };

type CreateStage = 'agent group' | 'runtime configuration' | 'web conversation' | 'web wiring';

export type CreateLocalWebAgentResult =
  | { ok: true; created: boolean; conversation: LocalWebConversation }
  | {
      ok: false;
      reason: 'source_not_found' | 'provider_not_installed' | 'stage_failed';
      status: number;
      message: string;
      stage?: CreateStage;
      detail?: string;
    };

interface ConversationRow {
  conversation_id: string;
  platform_id: string;
  agent_group_id: string;
  agent_name: string;
  folder: string;
  provider: string | null;
  model: string | null;
  effort: string | null;
}

interface ResolvedRuntime {
  provider: string;
  model?: string;
  effort?: string;
  providerWasExplicit: boolean;
}

type StageResult = { ok: true; data: unknown } | { ok: false; stage: CreateStage; detail: string };

const creationLocks = new Map<string, Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): { ok: true; value?: string } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'string') return { ok: false, message: `${field} must be a string.` };
  return { ok: true, value: value.trim() };
}

function optionalRuntimeOverride(
  value: unknown,
  field: string,
): { ok: true; value?: string | null } | { ok: false; message: string } {
  const parsed = optionalString(value, field);
  if (!parsed.ok || parsed.value === undefined) return parsed;
  return { ok: true, value: parsed.value || null };
}

export function parseCreateLocalWebAgentRequest(value: unknown): ParseCreateLocalWebAgentRequestResult {
  if (!isRecord(value)) return { ok: false, message: 'Expected an agent object.' };
  const unexpected = Object.keys(value).find((field) => !ALLOWED_CREATE_FIELDS.has(field));
  if (unexpected) return { ok: false, message: `Unknown field: ${unexpected}.` };

  if (typeof value.name !== 'string') return { ok: false, message: 'Agent name is required.' };
  const name = value.name.trim();
  if (name.length === 0 || name.length > 64) return { ok: false, message: 'Agent name must be 1 to 64 characters.' };
  if (CONTROL_CHARACTER_PATTERN.test(name))
    return { ok: false, message: 'Agent name cannot contain control characters.' };
  if (!/[A-Za-z0-9]/.test(name)) {
    return { ok: false, message: 'Agent name must contain at least one ASCII letter or digit.' };
  }

  const source = optionalString(value.sourceConversationId, 'sourceConversationId');
  if (!source.ok) return source;
  if (source.value !== undefined && (source.value.length === 0 || source.value.length > 128)) {
    return { ok: false, message: 'sourceConversationId must be 1 to 128 characters.' };
  }
  const provider = optionalString(value.provider, 'provider');
  if (!provider.ok) return provider;
  if (provider.value !== undefined && provider.value.length === 0) {
    return { ok: false, message: 'provider cannot be empty.' };
  }
  const model = optionalRuntimeOverride(value.model, 'model');
  if (!model.ok) return model;
  if (model.value !== undefined && model.value !== null && !MODEL_PATTERN.test(model.value)) {
    return {
      ok: false,
      message: 'model must be 1 to 128 characters using letters, digits, dot, underscore, colon, slash, or hyphen.',
    };
  }
  const effort = optionalRuntimeOverride(value.effort, 'effort');
  if (!effort.ok) return effort;
  const normalizedEffort = effort.value?.toLowerCase() ?? effort.value;
  if (normalizedEffort !== undefined && normalizedEffort !== null && !ALLOWED_EFFORTS.has(normalizedEffort)) {
    return { ok: false, message: 'effort must be low, medium, high, or xhigh.' };
  }

  return {
    ok: true,
    value: {
      name,
      ...(source.value !== undefined && { sourceConversationId: source.value }),
      ...(provider.value !== undefined && { provider: provider.value.toLowerCase() }),
      ...(model.value !== undefined && { model: model.value }),
      ...(normalizedEffort !== undefined && { effort: normalizedEffort }),
    },
  };
}

function toConversation(row: ConversationRow): LocalWebConversation {
  return {
    conversationId: row.conversation_id,
    agentName: row.agent_name,
    provider: (row.provider ?? 'claude').toLowerCase(),
    ...(row.model && { model: row.model }),
    ...(row.effort && { effort: row.effort }),
    isLegacy: row.platform_id === LOCAL_WEB_LEGACY_PLATFORM_ID,
  };
}

function installedProviders(): string[] {
  const optional = listProviderContainerConfigNames()
    .map((provider) => provider.toLowerCase())
    .filter((provider) => provider !== 'claude')
    .sort((a, b) => a.localeCompare(b));
  return ['claude', ...new Set(optional)];
}

const CONVERSATION_SELECT = `
  SELECT mg.id AS conversation_id,
         mg.platform_id,
         ag.id AS agent_group_id,
         ag.name AS agent_name,
         ag.folder,
         cc.provider,
         cc.model,
         cc.effort
    FROM messaging_groups mg
    JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
    JOIN agent_groups ag ON ag.id = mga.agent_group_id
    LEFT JOIN container_configs cc ON cc.agent_group_id = ag.id
   WHERE mg.channel_type = ? AND mg.instance = ?`;

export async function listLocalWebCatalog(): Promise<LocalWebCatalog> {
  const rows = await getDb().all<ConversationRow>(
    `${CONVERSATION_SELECT}
     ORDER BY lower(ag.name) ASC, ag.id ASC`,
    LOCAL_WEB_CHANNEL_TYPE,
    LOCAL_WEB_CHANNEL_TYPE,
  );
  const providers = installedProviders();
  const installationDefault = DEFAULT_AGENT_PROVIDER.toLowerCase();
  return {
    conversations: rows.map(toConversation),
    installedProviders: providers,
    installationDefault,
    isInstallationDefaultInstalled: providers.includes(installationDefault),
  };
}

export async function getLocalWebConversation(conversationId: string): Promise<LocalWebConversation | undefined> {
  const rows = await getDb().all<ConversationRow>(
    `${CONVERSATION_SELECT} AND mg.id = ?`,
    LOCAL_WEB_CHANNEL_TYPE,
    LOCAL_WEB_CHANNEL_TYPE,
    conversationId,
  );
  return rows.length === 1 ? toConversation(rows[0]!) : undefined;
}

async function conversationByAgent(agentGroupId: string): Promise<LocalWebConversation | undefined> {
  const rows = await getDb().all<ConversationRow>(
    `${CONVERSATION_SELECT} AND ag.id = ?
     ORDER BY (mg.platform_id = ?) DESC, mg.id ASC`,
    LOCAL_WEB_CHANNEL_TYPE,
    LOCAL_WEB_CHANNEL_TYPE,
    agentGroupId,
    LOCAL_WEB_LEGACY_PLATFORM_ID,
  );
  return rows.length === 1 ? toConversation(rows[0]!) : undefined;
}

export async function localWebPlatformIdForConversation(conversationId: string): Promise<string | undefined> {
  const row = await getDb().get<{ platform_id: string }>(
    `SELECT mg.platform_id
       FROM messaging_groups mg
       JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
      WHERE mg.channel_type = ? AND mg.instance = ? AND mg.id = ?
      GROUP BY mg.id
     HAVING COUNT(mga.id) = 1`,
    LOCAL_WEB_CHANNEL_TYPE,
    LOCAL_WEB_CHANNEL_TYPE,
    conversationId,
  );
  return row?.platform_id;
}

export async function isKnownLocalWebPlatformId(platformId: string): Promise<boolean> {
  if (platformId === LOCAL_WEB_LEGACY_PLATFORM_ID) return true;
  const row = await getDb().get(
    `SELECT 1 FROM messaging_groups
      WHERE channel_type = ? AND instance = ? AND platform_id = ?
      LIMIT 1`,
    LOCAL_WEB_CHANNEL_TYPE,
    LOCAL_WEB_CHANNEL_TYPE,
    platformId,
  );
  return row !== undefined;
}

export async function localWebQuestionBelongsToConversation(
  questionId: string,
  conversationId: string,
): Promise<boolean> {
  const platformId = await localWebPlatformIdForConversation(conversationId);
  if (!platformId) return false;
  const question = await getPendingQuestion(questionId);
  if (question) return question.channel_type === LOCAL_WEB_CHANNEL_TYPE && question.platform_id === platformId;
  const approval = await getPendingApproval(questionId);
  return approval?.channel_type === LOCAL_WEB_CHANNEL_TYPE && approval.platform_id === platformId;
}

function platformIdForAgent(agentGroupId: string): string {
  return `local-web:agent:${agentGroupId}`;
}

function folderForAgentName(name: string): string {
  const normalized = normalizeName(name)
    .slice(0, 59)
    .replace(/[-_]+$/, '');
  const folder = `web-${normalized}`;
  assertValidGroupFolder(folder);
  return folder;
}

async function runStage(stage: CreateStage, command: string, args: Record<string, unknown>): Promise<StageResult> {
  const response = await dispatch({ id: `local-web-${randomUUID()}`, command, args }, { caller: 'host' });
  return response.ok ? { ok: true, data: response.data } : { ok: false, stage, detail: response.error.message };
}

function parseAgentGroup(value: unknown): AgentGroup {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.folder !== 'string' ||
    typeof value.created_at !== 'string'
  ) {
    throw new Error('groups-create returned an invalid agent group');
  }
  return {
    id: value.id,
    name: value.name,
    folder: value.folder,
    agent_provider: typeof value.agent_provider === 'string' ? value.agent_provider : null,
    created_at: value.created_at,
  };
}

async function ensureConversation(agent: AgentGroup): Promise<StageResult> {
  const platformId = platformIdForAgent(agent.id);
  const conversation = await runStage('web conversation', 'messaging-groups-create', {
    channel_type: LOCAL_WEB_CHANNEL_TYPE,
    instance: LOCAL_WEB_CHANNEL_TYPE,
    platform_id: platformId,
    name: agent.name,
    is_group: 0,
  });
  if (!conversation.ok) return conversation;
  return runStage('web wiring', 'wirings-create', {
    channel_type: LOCAL_WEB_CHANNEL_TYPE,
    instance: LOCAL_WEB_CHANNEL_TYPE,
    platform_id: platformId,
    agent_group_id: agent.id,
  });
}

export async function ensureLocalWebConversations(): Promise<void> {
  const missing = await getDb().all<AgentGroup>(
    `SELECT ag.*
       FROM agent_groups ag
      WHERE NOT EXISTS (
        SELECT 1
          FROM messaging_group_agents mga
          JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         WHERE mga.agent_group_id = ag.id
           AND mg.channel_type = ?
           AND mg.instance = ?
      )
      ORDER BY lower(ag.name) ASC, ag.id ASC`,
    LOCAL_WEB_CHANNEL_TYPE,
    LOCAL_WEB_CHANNEL_TYPE,
  );
  for (const agent of missing) {
    const result = await ensureConversation(agent);
    if (!result.ok) {
      throw new Error(`Local web backfill failed during ${result.stage}`, { cause: new Error(result.detail) });
    }
  }
}

function resolveRuntime(
  request: CreateLocalWebAgentRequest,
  source: LocalWebConversation | undefined,
): ResolvedRuntime {
  const provider = request.provider ?? source?.provider ?? DEFAULT_AGENT_PROVIDER.toLowerCase();
  const providerChanged = request.provider !== undefined && request.provider !== source?.provider;
  const inheritedModel = providerChanged ? undefined : source?.model;
  const inheritedEffort = providerChanged ? undefined : source?.effort;
  const model = request.model === undefined ? inheritedModel : (request.model ?? undefined);
  const effort = request.effort === undefined ? inheritedEffort : (request.effort ?? undefined);
  return {
    provider,
    ...(model !== undefined && { model }),
    ...(effort !== undefined && { effort }),
    providerWasExplicit: request.provider !== undefined,
  };
}

async function withCreationLock<T>(folder: string, action: () => Promise<T>): Promise<T> {
  const previous = creationLocks.get(folder) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  creationLocks.set(folder, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (creationLocks.get(folder) === tail) creationLocks.delete(folder);
  }
}

function stageFailure(result: Extract<StageResult, { ok: false }>): CreateLocalWebAgentResult {
  return {
    ok: false,
    reason: 'stage_failed',
    status: 409,
    stage: result.stage,
    detail: result.detail,
    message: `Agent creation stopped during ${result.stage}. Retry to resume.`,
  };
}

export async function createLocalWebAgent(request: CreateLocalWebAgentRequest): Promise<CreateLocalWebAgentResult> {
  const source = request.sourceConversationId ? await getLocalWebConversation(request.sourceConversationId) : undefined;
  if (request.sourceConversationId && !source) {
    return {
      ok: false,
      reason: 'source_not_found',
      status: 404,
      message: 'The selected conversation is no longer available.',
    };
  }
  const runtime = resolveRuntime(request, source);
  const providers = installedProviders();
  if (!providers.includes(runtime.provider)) {
    return {
      ok: false,
      reason: 'provider_not_installed',
      status: 409,
      message: `Provider "${runtime.provider}" is not installed. Choose an installed provider.`,
    };
  }

  const folder = folderForAgentName(request.name);
  return withCreationLock(folder, async () => {
    const existing = await getAgentGroupByFolder(folder);
    if (existing) {
      const complete = await conversationByAgent(existing.id);
      if (complete) return { ok: true, created: false, conversation: complete };
    }

    const createdGroup = await runStage('agent group', 'groups-create', { name: request.name, folder });
    if (!createdGroup.ok) return stageFailure(createdGroup);
    const agent = parseAgentGroup(createdGroup.data);
    const currentConfig = await getContainerConfig(agent.id);
    if (!currentConfig) throw new Error(`Container config missing after groups-create: ${agent.id}`);

    const configUpdates: Record<string, unknown> = { id: agent.id };
    if (runtime.providerWasExplicit || (currentConfig.provider ?? 'claude').toLowerCase() !== runtime.provider) {
      configUpdates.provider = runtime.provider;
    }
    if (runtime.model !== undefined && currentConfig.model !== runtime.model) configUpdates.model = runtime.model;
    if (runtime.effort !== undefined && currentConfig.effort !== runtime.effort) configUpdates.effort = runtime.effort;
    if (Object.keys(configUpdates).length > 1) {
      const configured = await runStage('runtime configuration', 'groups-config-update', configUpdates);
      if (!configured.ok) return stageFailure(configured);
    }

    const wired = await ensureConversation(agent);
    if (!wired.ok) return stageFailure(wired);
    const conversation = await conversationByAgent(agent.id);
    if (!conversation) throw new Error(`Local web conversation missing after wiring: ${agent.id}`);
    return { ok: true, created: existing === undefined, conversation };
  });
}
