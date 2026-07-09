/**
 * Dashboard pusher — collects NanoClaw state and POSTs a JSON
 * snapshot to the dashboard's /api/ingest endpoint every interval.
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import Database from 'better-sqlite3';

import { getAllAgentGroups, getAgentGroup } from './db/agent-groups.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { getAllMessagingGroups, getMessagingGroupAgents } from './db/messaging-groups.js';
import { getDestinations } from './modules/agent-to-agent/db/agent-destinations.js';
import { getMembers } from './modules/permissions/db/agent-group-members.js';
import { getAllUsers, getUser } from './modules/permissions/db/users.js';
import { getUserRoles, getAdminsOfAgentGroup } from './modules/permissions/db/user-roles.js';
import { getUserDmsForUser } from './modules/permissions/db/user-dms.js';
import { getActiveAdapters, getRegisteredChannelNames } from './channels/channel-registry.js';
import { DATA_DIR, ASSISTANT_NAME } from './config.js';
import { getDb } from './db/connection.js';
import { getContainerConfig } from './db/container-configs.js';
import { log } from './log.js';
import { readEnvFile } from './env.js';

interface PusherConfig {
  port: number;
  secret: string;
  intervalMs?: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let logTimer: ReturnType<typeof setInterval> | null = null;
let logOffset = 0;

export function startDashboardPusher(config: PusherConfig): void {
  const interval = config.intervalMs || 60000;

  // Push immediately on start, then on interval
  push(config).catch((err) => log.error('Dashboard push failed', { err }));
  timer = setInterval(() => {
    push(config).catch((err) => log.error('Dashboard push failed', { err }));
  }, interval);

  // Start log file tailing
  startLogTail(config);

  log.info('Dashboard pusher started', { intervalMs: interval });
}

export function stopDashboardPusher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (logTimer) {
    clearInterval(logTimer);
    logTimer = null;
  }
}

/**
 * Skill entry point — the single call wired into the host boot sequence.
 *
 * All of the dashboard's startup logic lives here, in the skill's own file,
 * so the integration point in src/index.ts is just `await startDashboard()`.
 * No-ops (and says so) when DASHBOARD_SECRET is unset.
 */
export async function startDashboard(): Promise<void> {
  const env = readEnvFile(['DASHBOARD_SECRET', 'DASHBOARD_PORT']);
  const secret = process.env.DASHBOARD_SECRET || env.DASHBOARD_SECRET;
  const port = parseInt(process.env.DASHBOARD_PORT || env.DASHBOARD_PORT || '3100', 10);
  if (!secret) {
    log.info('Dashboard disabled (no DASHBOARD_SECRET)');
    return;
  }
  const { startDashboard: startServer } = await import('@nanoco/nanoclaw-dashboard');
  startServer({ port, secret });
  startDashboardPusher({ port, secret, intervalMs: 60000 });
}

/** Fire-and-forget POST to the dashboard. */
function postJson(config: PusherConfig, urlPath: string, data: unknown): void {
  const body = JSON.stringify(data);
  const req = http.request({
    hostname: '127.0.0.1',
    port: config.port,
    path: urlPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Authorization: `Bearer ${config.secret}`,
    },
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function startLogTail(config: PusherConfig): void {
  const logFile = path.resolve(process.cwd(), 'logs', 'nanoclaw.log');
  if (!fs.existsSync(logFile)) return;

  // Send last 200 lines as backfill
  try {
    const allLines = fs
      .readFileSync(logFile, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    logOffset = fs.statSync(logFile).size;
    const tail = allLines.slice(-200).map((l) => l.replace(ANSI_RE, ''));
    if (tail.length > 0) postJson(config, '/api/logs/push', { lines: tail });
  } catch {
    return;
  }

  // Poll every 2s for new lines
  logTimer = setInterval(() => {
    try {
      const stat = fs.statSync(logFile);
      if (stat.size <= logOffset) {
        logOffset = stat.size;
        return;
      }
      const buf = Buffer.alloc(stat.size - logOffset);
      const fd = fs.openSync(logFile, 'r');
      fs.readSync(fd, buf, 0, buf.length, logOffset);
      fs.closeSync(fd);
      logOffset = stat.size;
      const lines = buf
        .toString()
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => l.replace(ANSI_RE, ''));
      if (lines.length > 0) postJson(config, '/api/logs/push', { lines });
    } catch {
      /* ignore */
    }
  }, 2000);
}

async function push(config: PusherConfig): Promise<void> {
  const snapshot = collectSnapshot();
  postJson(config, '/api/ingest', snapshot);
  log.debug('Dashboard snapshot pushed');
}

function collectSnapshot(): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    assistant_name: ASSISTANT_NAME,
    uptime: Math.floor(process.uptime()),
    agent_groups: collectAgentGroups(),
    sessions: collectSessions(),
    channels: collectChannels(),
    users: collectUsers(),
    tokens: collectTokens(),
    context_windows: collectContextWindows(),
    activity: collectActivity(),
    messages: collectMessages(),
    scheduled_tasks: collectScheduledTasks(),
    alerts: collectAlerts(),
  };
}

function parseContainerConfig(cc: ReturnType<typeof getContainerConfig> | null) {
  if (!cc) return null;
  const parse = (v: unknown, fallback: unknown) => {
    if (v === null || v === undefined) return fallback;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
    return v;
  };
  return {
    ...cc,
    mcp_servers: parse(cc.mcp_servers, {}),
    packages_apt: parse(cc.packages_apt, []),
    packages_npm: parse(cc.packages_npm, []),
    skills: parse(cc.skills, []),
    additional_mounts: parse(cc.additional_mounts, []),
  };
}

function resolveEffectiveModel(
  agentProvider: string | null,
  containerConfig: ReturnType<typeof getContainerConfig> | null,
): string | null {
  const provider = agentProvider ?? containerConfig?.provider ?? null;
  if (provider === 'opencode') {
    const envVars = readEnvFile(['OPENCODE_PROVIDER', 'OPENCODE_MODEL']);
    const p = process.env.OPENCODE_PROVIDER || envVars.OPENCODE_PROVIDER;
    const m = process.env.OPENCODE_MODEL || envVars.OPENCODE_MODEL;
    if (m) return m;
    if (p) return p;
    return null;
  }
  return containerConfig?.model ?? null;
}

function collectAgentGroups() {
  return getAllAgentGroups().map((g) => {
    const sessions = getSessionsByAgentGroup(g.id);
    const running = sessions.filter((s) => s.container_status === 'running' || s.container_status === 'idle');
    const destinations = getDestinations(g.id);
    const members = getMembers(g.id).map((m) => {
      const user = getUser(m.user_id);
      return { ...m, display_name: user?.display_name ?? null };
    });
    const admins = getAdminsOfAgentGroup(g.id).map((a) => {
      const user = getUser(a.user_id);
      return { ...a, display_name: user?.display_name ?? null };
    });

    // Wirings
    const db = getDb();
    const wirings = db
      .prepare(
        `SELECT mga.*, mg.channel_type, mg.platform_id, mg.name as mg_name, mg.is_group, mg.unknown_sender_policy
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         WHERE mga.agent_group_id = ?`,
      )
      .all(g.id) as Array<Record<string, unknown>>;

    const containerConfig = getContainerConfig(g.id) ?? null;
    const parsedConfig = parseContainerConfig(containerConfig);

    return {
      id: g.id,
      name: g.name,
      folder: g.folder,
      agent_provider: g.agent_provider,
      effective_model: resolveEffectiveModel(g.agent_provider, containerConfig),
      container_config: parsedConfig,
      sessionCount: sessions.length,
      runningSessions: running.length,
      wirings,
      destinations,
      members,
      admins,
      created_at: g.created_at,
    };
  });
}

function collectSessions() {
  const db = getDb();
  return db
    .prepare(
      `SELECT s.*, ag.name as agent_group_name, ag.folder as agent_group_folder,
              mg.channel_type, mg.platform_id, mg.name as messaging_group_name
       FROM sessions s
       LEFT JOIN agent_groups ag ON ag.id = s.agent_group_id
       LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
       ORDER BY s.last_active DESC NULLS LAST`,
    )
    .all() as Array<Record<string, unknown>>;
}

function collectChannels() {
  const messagingGroups = getAllMessagingGroups();
  const liveAdapters = getActiveAdapters().map((a) => a.channelType);
  const registeredChannels = getRegisteredChannelNames();

  const byType: Record<string, { channelType: string; isLive: boolean; isRegistered: boolean; groups: unknown[] }> = {};

  for (const mg of messagingGroups) {
    if (!byType[mg.channel_type]) {
      byType[mg.channel_type] = {
        channelType: mg.channel_type,
        isLive: liveAdapters.includes(mg.channel_type),
        isRegistered: registeredChannels.includes(mg.channel_type),
        groups: [],
      };
    }

    const agents = getMessagingGroupAgents(mg.id).map((a) => {
      const group = getAgentGroup(a.agent_group_id);
      return { agent_group_id: a.agent_group_id, agent_group_name: group?.name ?? null, priority: a.priority };
    });

    byType[mg.channel_type].groups.push({
      messagingGroup: {
        id: mg.id,
        platform_id: mg.platform_id,
        name: mg.name,
        is_group: mg.is_group,
        unknown_sender_policy: (mg as unknown as Record<string, unknown>).unknown_sender_policy ?? 'strict',
      },
      agents,
    });
  }

  // Include live adapters with no messaging groups
  for (const ct of liveAdapters) {
    if (!byType[ct]) {
      byType[ct] = { channelType: ct, isLive: true, isRegistered: true, groups: [] };
    }
  }

  return Object.values(byType).sort((a, b) => a.channelType.localeCompare(b.channelType));
}

function collectUsers() {
  return getAllUsers().map((u) => {
    const roles = getUserRoles(u.id);
    const dms = getUserDmsForUser(u.id);

    const db = getDb();
    const memberships = db
      .prepare(
        `SELECT agm.agent_group_id, ag.name as agent_group_name
         FROM agent_group_members agm
         JOIN agent_groups ag ON ag.id = agm.agent_group_id
         WHERE agm.user_id = ?`,
      )
      .all(u.id) as Array<Record<string, unknown>>;

    let privilege = 'none';
    if (roles.some((r) => r.role === 'owner')) privilege = 'owner';
    else if (roles.some((r) => r.role === 'admin' && !r.agent_group_id)) privilege = 'global_admin';
    else if (roles.some((r) => r.role === 'admin')) privilege = 'admin';
    else if (memberships.length > 0) privilege = 'member';

    return {
      id: u.id,
      kind: u.kind,
      display_name: u.display_name,
      privilege,
      roles,
      memberships,
      dmChannels: dms.map((d) => ({ channel_type: d.channel_type })),
      created_at: u.created_at,
    };
  });
}

function collectTokens() {
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  const allEntries: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    agentGroupId: string;
  }> = [];
  const agentGroups = getAllAgentGroups();
  const nameMap = new Map(agentGroups.map((g) => [g.id, g.name]));
  // Build a set of agent group IDs that use the opencode provider.
  // For opencode groups we skip JSONL (stale pre-switch Claude data); for
  // claude groups we skip the opencode DB (no sessions there).
  const opencodeGroupIds = new Set(
    agentGroups
      .filter((g) => {
        const p = g.agent_provider ?? getContainerConfig(g.id)?.provider ?? null;
        return p === 'opencode';
      })
      .map((g) => g.id),
  );

  if (fs.existsSync(sessionsDir)) {
    for (const group of agentGroups) {
      const agPath = path.join(sessionsDir, group.id);
      if (!fs.existsSync(agPath)) continue;
      const isOpencode = opencodeGroupIds.has(group.id);
      const entries = isOpencode ? scanOpencodeTokens(agPath) : scanJsonlTokens(agPath);
      allEntries.push(...entries.map((e) => ({ ...e, agentGroupId: group.id })));
    }
  }

  const byModel: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }
  > = {};
  const byGroup: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      name: string;
    }
  > = {};
  const totals = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

  for (const e of allEntries) {
    if (!byModel[e.model])
      byModel[e.model] = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    byModel[e.model].requests++;
    byModel[e.model].inputTokens += e.inputTokens;
    byModel[e.model].outputTokens += e.outputTokens;
    byModel[e.model].cacheReadTokens += e.cacheReadTokens;
    byModel[e.model].cacheCreationTokens += e.cacheCreationTokens;

    if (!byGroup[e.agentGroupId])
      byGroup[e.agentGroupId] = {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        name: nameMap.get(e.agentGroupId) || e.agentGroupId,
      };
    byGroup[e.agentGroupId].requests++;
    byGroup[e.agentGroupId].inputTokens += e.inputTokens;
    byGroup[e.agentGroupId].outputTokens += e.outputTokens;
    byGroup[e.agentGroupId].cacheReadTokens += e.cacheReadTokens;
    byGroup[e.agentGroupId].cacheCreationTokens += e.cacheCreationTokens;

    totals.requests++;
    totals.inputTokens += e.inputTokens;
    totals.outputTokens += e.outputTokens;
    totals.cacheReadTokens += e.cacheReadTokens;
    totals.cacheCreationTokens += e.cacheCreationTokens;
  }

  return { totals, byModel, byGroup };
}

function scanJsonlTokens(agentDir: string) {
  const claudeDir = path.join(agentDir, '.claude-shared', 'projects');
  if (!fs.existsSync(claudeDir)) return [];

  const entries: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }> = [];

  const walk = (dir: string): void => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.jsonl')) {
          try {
            for (const line of fs.readFileSync(full, 'utf-8').split('\n')) {
              if (!line.trim()) continue;
              try {
                const r = JSON.parse(line);
                if (r.type === 'assistant' && r.message?.usage) {
                  const u = r.message.usage;
                  entries.push({
                    model: r.message.model || 'unknown',
                    inputTokens: u.input_tokens || 0,
                    outputTokens: u.output_tokens || 0,
                    cacheReadTokens: u.cache_read_input_tokens || 0,
                    cacheCreationTokens: u.cache_creation_input_tokens || 0,
                  });
                }
              } catch {
                /* skip line */
              }
            }
          } catch {
            /* skip file */
          }
        }
      }
    } catch {
      /* skip dir */
    }
  };
  walk(claudeDir);
  return entries;
}

const OPENCODE_MAX_CONTEXT: Record<string, number> = {
  'google/gemini-2.5-flash': 1048576,
  'google/gemini-2.5-pro': 1048576,
  'google/gemini-2.0-flash': 1048576,
  'openrouter/google/gemini-2.5-flash': 1048576,
  'openrouter/google/gemini-2.5-pro': 1048576,
};

function scanOpencodeTokens(agentDir: string) {
  const entries: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }> = [];

  try {
    for (const sessDir of fs.readdirSync(agentDir).filter((d) => d.startsWith('sess-'))) {
      const dbPath = path.join(agentDir, sessDir, 'opencode-xdg', 'opencode', 'opencode.db');
      if (!fs.existsSync(dbPath)) continue;
      try {
        const db = new Database(dbPath, { readonly: true });

        const modelRow = db
          .prepare(
            `SELECT json_extract(data, '$.model.providerID') || '/' || json_extract(data, '$.model.modelID') as model
             FROM message
             WHERE json_extract(data, '$.role') = 'user'
               AND json_extract(data, '$.model') IS NOT NULL
             LIMIT 1`,
          )
          .get() as { model: string } | undefined;
        const model = modelRow?.model ?? 'unknown';

        const rows = db
          .prepare(
            `SELECT
              json_extract(data, '$.tokens.input') as inputTokens,
              json_extract(data, '$.tokens.output') as outputTokens,
              json_extract(data, '$.tokens.cache.write') as cacheCreationTokens,
              json_extract(data, '$.tokens.cache.read') as cacheReadTokens
             FROM message
             WHERE json_extract(data, '$.role') = 'assistant'
               AND json_extract(data, '$.tokens') IS NOT NULL`,
          )
          .all() as Array<{
          inputTokens: number | null;
          outputTokens: number | null;
          cacheCreationTokens: number | null;
          cacheReadTokens: number | null;
        }>;

        for (const row of rows) {
          entries.push({
            model,
            inputTokens: row.inputTokens ?? 0,
            outputTokens: row.outputTokens ?? 0,
            cacheReadTokens: row.cacheReadTokens ?? 0,
            cacheCreationTokens: row.cacheCreationTokens ?? 0,
          });
        }

        db.close();
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }

  return entries;
}

type ContextWindowEntry = { data: unknown; ts: number };

function latestClaudeContextWindow(
  agentDir: string,
  agDir: string,
  nameMap: Map<string, string>,
): ContextWindowEntry | null {
  const claudeDir = path.join(agentDir, '.claude-shared', 'projects');
  if (!fs.existsSync(claudeDir)) return null;

  const jsonlFiles: string[] = [];
  const walk = (dir: string): void => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.jsonl')) jsonlFiles.push(full);
      }
    } catch {
      /* skip */
    }
  };
  walk(claudeDir);
  if (jsonlFiles.length === 0) return null;

  jsonlFiles.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });

  const content = fs.readFileSync(jsonlFiles[0], 'utf-8');
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    try {
      const r = JSON.parse(lines[i]);
      if (r.type === 'assistant' && r.message?.usage) {
        const u = r.message.usage;
        const model = r.message.model || 'unknown';
        const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        const max = 200000;
        const ts = r.timestamp ? new Date(r.timestamp).getTime() : 0;
        return {
          ts,
          data: {
            agentGroupId: agDir,
            agentGroupName: nameMap.get(agDir),
            sessionId: path.basename(jsonlFiles[0], '.jsonl'),
            model,
            contextTokens: ctx,
            outputTokens: u.output_tokens || 0,
            cacheReadTokens: u.cache_read_input_tokens || 0,
            cacheCreationTokens: u.cache_creation_input_tokens || 0,
            maxContext: max,
            usagePercent: max > 0 ? Math.round((ctx / max) * 100) : 0,
            timestamp: r.timestamp || '',
          },
        };
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

function latestOpencodeContextWindow(
  agentDir: string,
  agDir: string,
  nameMap: Map<string, string>,
): ContextWindowEntry | null {
  const sessDirs = fs.readdirSync(agentDir).filter((d) => d.startsWith('sess-'));
  const candidates: Array<{ sessDir: string; dbPath: string; mtime: number }> = [];

  for (const sessDir of sessDirs) {
    const dbPath = path.join(agentDir, sessDir, 'opencode-xdg', 'opencode', 'opencode.db');
    if (!fs.existsSync(dbPath)) continue;
    try {
      candidates.push({ sessDir, dbPath, mtime: fs.statSync(dbPath).mtimeMs });
    } catch {
      /* skip */
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);

  for (const { sessDir, dbPath } of candidates) {
    try {
      const db = new Database(dbPath, { readonly: true });

      const modelRow = db
        .prepare(
          `SELECT json_extract(data, '$.model.providerID') || '/' || json_extract(data, '$.model.modelID') as model
           FROM message
           WHERE json_extract(data, '$.role') = 'user'
             AND json_extract(data, '$.model') IS NOT NULL
           LIMIT 1`,
        )
        .get() as { model: string } | undefined;
      const model = modelRow?.model ?? 'unknown';

      const row = db
        .prepare(
          `SELECT
            json_extract(data, '$.tokens.input') as inputTokens,
            json_extract(data, '$.tokens.output') as outputTokens,
            json_extract(data, '$.tokens.cache.write') as cacheCreationTokens,
            json_extract(data, '$.tokens.cache.read') as cacheReadTokens,
            time_created as timeCreated
           FROM message
           WHERE json_extract(data, '$.role') = 'assistant'
             AND json_extract(data, '$.tokens') IS NOT NULL
           ORDER BY time_created DESC
           LIMIT 1`,
        )
        .get() as
        | {
            inputTokens: number | null;
            outputTokens: number | null;
            cacheCreationTokens: number | null;
            cacheReadTokens: number | null;
            timeCreated: number;
          }
        | undefined;

      db.close();

      if (!row) continue;

      const inputTokens = row.inputTokens ?? 0;
      const cacheReadTokens = row.cacheReadTokens ?? 0;
      const cacheCreationTokens = row.cacheCreationTokens ?? 0;
      const ctx = inputTokens + cacheReadTokens + cacheCreationTokens;
      const max = OPENCODE_MAX_CONTEXT[model] ?? 200000;
      const ts = row.timeCreated;

      return {
        ts,
        data: {
          agentGroupId: agDir,
          agentGroupName: nameMap.get(agDir),
          sessionId: sessDir,
          model,
          contextTokens: ctx,
          outputTokens: row.outputTokens ?? 0,
          cacheReadTokens,
          cacheCreationTokens,
          maxContext: max,
          usagePercent: max > 0 ? Math.round((ctx / max) * 100) : 0,
          timestamp: new Date(ts).toISOString(),
        },
      };
    } catch {
      /* skip */
    }
  }
  return null;
}

function collectContextWindows() {
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const results: unknown[] = [];
  const agentGroups = getAllAgentGroups();
  const nameMap = new Map(agentGroups.map((g) => [g.id, g.name]));
  const opencodeGroupIds = new Set(
    agentGroups
      .filter((g) => {
        const p = g.agent_provider ?? getContainerConfig(g.id)?.provider ?? null;
        return p === 'opencode';
      })
      .map((g) => g.id),
  );

  for (const group of agentGroups) {
    const agPath = path.join(sessionsDir, group.id);
    if (!fs.existsSync(agPath)) continue;
    try {
      const isOpencode = opencodeGroupIds.has(group.id);
      const result = isOpencode
        ? latestOpencodeContextWindow(agPath, group.id, nameMap)
        : latestClaudeContextWindow(agPath, group.id, nameMap);
      if (result) results.push(result.data);
    } catch {
      /* skip */
    }
  }

  return results;
}

function collectScheduledTasks(): Array<{ agentGroupId: string; agentGroupName: string; tasks: unknown[] }> {
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const agentGroups = getAllAgentGroups();
  const nameMap = new Map(agentGroups.map((g) => [g.id, g.name]));
  const results: Array<{ agentGroupId: string; agentGroupName: string; tasks: unknown[] }> = [];

  for (const group of agentGroups) {
    const agPath = path.join(sessionsDir, group.id);
    if (!fs.existsSync(agPath)) continue;

    const allTasks: unknown[] = [];
    try {
      for (const sessDir of fs.readdirSync(agPath).filter((d) => d.startsWith('sess-'))) {
        const dbPath = path.join(agPath, sessDir, 'inbound.db');
        if (!fs.existsSync(dbPath)) continue;
        try {
          const db = new Database(dbPath, { readonly: true });
          const rows = db
            .prepare(
              `SELECT id, status, recurrence, process_after,
                      substr(json_extract(content, '$.prompt'), 1, 100) AS prompt
               FROM messages_in
               WHERE kind = 'task' AND status != 'completed'
               ORDER BY process_after ASC`,
            )
            .all();
          allTasks.push(...rows);
          db.close();
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    if (allTasks.length > 0) {
      results.push({ agentGroupId: group.id, agentGroupName: nameMap.get(group.id) ?? group.id, tasks: allTasks });
    }
  }

  return results;
}

function collectAlerts(): { pendingApprovals: unknown[]; droppedMessages: unknown[] } {
  const db = getDb();
  try {
    const pendingApprovals = db
      .prepare(
        `SELECT approval_id, agent_group_id, action, title, created_at, expires_at, status
         FROM pending_approvals WHERE status = 'pending' ORDER BY created_at ASC`,
      )
      .all() as unknown[];
    const droppedMessages = db
      .prepare(
        `SELECT channel_type, platform_id, sender_name, reason, message_count, first_seen, last_seen
         FROM unregistered_senders ORDER BY last_seen DESC`,
      )
      .all() as unknown[];
    return { pendingApprovals, droppedMessages };
  } catch {
    return { pendingApprovals: [], droppedMessages: [] };
  }
}

function collectActivity() {
  const now = Date.now();
  const buckets: Record<string, { inbound: number; outbound: number }> = {};

  for (let i = 0; i < 24; i++) {
    const key = new Date(now - i * 3600000).toISOString().slice(0, 13);
    buckets[key] = { inbound: 0, outbound: 0 };
  }

  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return toBucketArray(buckets);

  const cutoff = new Date(now - 86400000).toISOString();

  try {
    for (const agDir of fs.readdirSync(sessionsDir)) {
      const agPath = path.join(sessionsDir, agDir);
      if (!fs.statSync(agPath).isDirectory()) continue;
      for (const sessDir of fs.readdirSync(agPath).filter((d) => d.startsWith('sess-'))) {
        for (const [dbName, direction] of [
          ['outbound.db', 'outbound'],
          ['inbound.db', 'inbound'],
        ] as const) {
          const dbPath = path.join(agPath, sessDir, dbName);
          if (!fs.existsSync(dbPath)) continue;
          try {
            const db = new Database(dbPath, { readonly: true });
            const table = direction === 'outbound' ? 'messages_out' : 'messages_in';
            const rows = db.prepare(`SELECT timestamp FROM ${table} WHERE timestamp > ?`).all(cutoff) as {
              timestamp: string;
            }[];
            for (const row of rows) {
              const key = row.timestamp.slice(0, 13);
              if (buckets[key]) buckets[key][direction]++;
            }
            db.close();
          } catch {
            /* skip */
          }
        }
      }
    }
  } catch {
    /* skip */
  }

  return toBucketArray(buckets);
}

function toBucketArray(buckets: Record<string, { inbound: number; outbound: number }>) {
  return Object.entries(buckets)
    .map(([hour, counts]) => ({ hour, ...counts }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
}

function collectMessages() {
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const results: Array<{ agentGroupId: string; sessionId: string; inbound: unknown[]; outbound: unknown[] }> = [];
  const limit = 50;

  try {
    for (const agDir of fs.readdirSync(sessionsDir)) {
      const agPath = path.join(sessionsDir, agDir);
      if (!fs.statSync(agPath).isDirectory()) continue;
      for (const sessDir of fs.readdirSync(agPath).filter((d) => d.startsWith('sess-'))) {
        const inbound: unknown[] = [];
        const outbound: unknown[] = [];

        const inDbPath = path.join(agPath, sessDir, 'inbound.db');
        if (fs.existsSync(inDbPath)) {
          try {
            const db = new Database(inDbPath, { readonly: true });
            const rows = db.prepare('SELECT * FROM messages_in ORDER BY seq DESC LIMIT ?').all(limit);
            inbound.push(...(rows as unknown[]).reverse());
            db.close();
          } catch {
            /* skip */
          }
        }

        const outDbPath = path.join(agPath, sessDir, 'outbound.db');
        if (fs.existsSync(outDbPath)) {
          try {
            const db = new Database(outDbPath, { readonly: true });
            const rows = db.prepare('SELECT * FROM messages_out ORDER BY seq DESC LIMIT ?').all(limit);
            outbound.push(...(rows as unknown[]).reverse());
            db.close();
          } catch {
            /* skip */
          }
        }

        if (inbound.length > 0 || outbound.length > 0) {
          results.push({ agentGroupId: agDir, sessionId: sessDir, inbound, outbound });
        }
      }
    }
  } catch {
    /* skip */
  }

  return results;
}
