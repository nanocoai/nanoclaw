/**
 * Dashboard pusher — collects NanoClaw state and POSTs a JSON
 * snapshot to the dashboard's /api/ingest endpoint every interval.
 *
 * Two read boundaries, both deliberate:
 * - Central state goes through the async `DbDriver` (`getDb()`), so every
 *   hand-written query here stays dialect-agnostic — no SQLite-only syntax.
 * - Per-session messages go through the host mailbox seam
 *   (`withExistingMailboxSession`), the same read path `ncl sessions history`
 *   uses. Session storage is not necessarily SQLite files on disk, so this
 *   file never opens `inbound.db` / `outbound.db` itself.
 */
import fs from 'fs';
import path from 'path';
import http from 'http';

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
import { onHostShutdown } from './host-lifecycle.js';
import { withExistingMailboxSession } from './session-manager.js';
import { readEnvFile } from './env.js';

interface PusherConfig {
  port: number;
  secret: string;
  intervalMs?: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let logTimer: ReturnType<typeof setInterval> | null = null;
let logOffset = 0;
let serverStarted = false;

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
 * Skill entry point — the single startup call wired into the host boot sequence.
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
  serverStarted = true;
  // @nanoco/nanoclaw-dashboard@0.3.0 listens on 0.0.0.0 and its config accepts
  // only { port, secret } — there is no bind option to narrow it to loopback.
  // The snapshot carries full message content, so say the exposure out loud
  // once per boot instead of letting the operator discover it from `ss -lptn`.
  log.warn('Dashboard listening on all interfaces (0.0.0.0) — DASHBOARD_SECRET is the only access control', { port });
  startDashboardPusher({ port, secret, intervalMs: 60000 });
}

/**
 * Teardown counterpart of startDashboard(), driven by the host's shutdown
 * registry (see the onHostShutdown call below). Stops the two pusher timers
 * and closes the dashboard's listening socket, so nothing pushes into a closed
 * DB driver and the port is released before the process exits. Safe to call
 * when startDashboard() never ran, and safe to call twice.
 */
export async function stopDashboard(): Promise<void> {
  stopDashboardPusher();
  if (!serverStarted) return;
  serverStarted = false;
  const { stopDashboard: stopServer } = await import('@nanoco/nanoclaw-dashboard');
  await stopServer();
  log.info('Dashboard stopped');
}

// Teardown rides the host's own lifecycle registry, registered here at import
// time and inert until shutdown — so the integration point in src/index.ts
// stays a single startup call with nothing to remember in shutdown().
// stopHostModules() runs before the delivery polls stop and before closeDb(),
// so the push timer can never fire into a closed driver.
onHostShutdown(() => stopDashboard());

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
  const snapshot = await collectSnapshot();
  postJson(config, '/api/ingest', snapshot);
  log.debug('Dashboard snapshot pushed');
}

async function collectSnapshot(): Promise<Record<string, unknown>> {
  const [agentGroups, sessions, channels, users, tokens, contextWindows] = await Promise.all([
    collectAgentGroups(),
    collectSessions(),
    collectChannels(),
    collectUsers(),
    collectTokens(),
    collectContextWindows(),
  ]);
  // The activity chart and the Messages page read the same per-session
  // mailboxes, so they share one pass over the sessions we just listed.
  const { activity, messages } = await collectSessionMailboxes(sessions);
  return {
    timestamp: new Date().toISOString(),
    assistant_name: ASSISTANT_NAME,
    uptime: Math.floor(process.uptime()),
    agent_groups: agentGroups,
    sessions,
    channels,
    users,
    tokens,
    context_windows: contextWindows,
    activity,
    messages,
  };
}

async function collectAgentGroups() {
  const groups = await getAllAgentGroups();
  return Promise.all(
    groups.map(async (g) => {
      const [sessions, destinations, rawMembers, rawAdmins, containerConfig, wirings] = await Promise.all([
        getSessionsByAgentGroup(g.id),
        getDestinations(g.id),
        getMembers(g.id),
        getAdminsOfAgentGroup(g.id),
        getContainerConfig(g.id),
        getDb().all<Record<string, unknown>>(
          `SELECT mga.*, mg.channel_type, mg.platform_id, mg.name as mg_name, mg.is_group, mg.unknown_sender_policy
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         WHERE mga.agent_group_id = ?`,
          g.id,
        ),
      ]);
      const running = sessions.filter((s) => s.container_status === 'running' || s.container_status === 'idle');
      const members = await Promise.all(
        rawMembers.map(async (m) => {
          const user = await getUser(m.user_id);
          return { ...m, display_name: user?.display_name ?? null };
        }),
      );
      const admins = await Promise.all(
        rawAdmins.map(async (a) => {
          const user = await getUser(a.user_id);
          return { ...a, display_name: user?.display_name ?? null };
        }),
      );

      return {
        id: g.id,
        name: g.name,
        folder: g.folder,
        agent_provider: g.agent_provider,
        container_config: containerConfig ?? null,
        sessionCount: sessions.length,
        runningSessions: running.length,
        wirings,
        destinations,
        members,
        admins,
        created_at: g.created_at,
      };
    }),
  );
}

interface SessionRow extends Record<string, unknown> {
  id: string;
  agent_group_id: string;
  last_active: string | null;
}

async function collectSessions(): Promise<SessionRow[]> {
  const rows = await getDb().all<SessionRow>(
    `SELECT s.*, ag.name as agent_group_name, ag.folder as agent_group_folder,
              mg.channel_type, mg.platform_id, mg.name as messaging_group_name
       FROM sessions s
       LEFT JOIN agent_groups ag ON ag.id = s.agent_group_id
       LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id`,
  );
  // Most-recently-active first, sessions that never ran last. Sorted here, not
  // in SQL: `ORDER BY ... DESC NULLS LAST` is SQLite/Postgres-only syntax, and
  // getDb() fronts a dialect-agnostic driver (src/db/driver.ts). ISO-8601 UTC
  // timestamps compare correctly as strings.
  return [...rows].sort((a, b) => {
    if (a.last_active === b.last_active) return a.id.localeCompare(b.id);
    if (!a.last_active) return 1;
    if (!b.last_active) return -1;
    return a.last_active < b.last_active ? 1 : -1;
  });
}

async function collectChannels() {
  const messagingGroups = await getAllMessagingGroups();
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

    const wiringAgents = await getMessagingGroupAgents(mg.id);
    const agents = await Promise.all(
      wiringAgents.map(async (a) => {
        const group = await getAgentGroup(a.agent_group_id);
        return { agent_group_id: a.agent_group_id, agent_group_name: group?.name ?? null, priority: a.priority };
      }),
    );

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

async function collectUsers() {
  const users = await getAllUsers();
  return Promise.all(
    users.map(async (u) => {
      const [roles, dms, memberships] = await Promise.all([
        getUserRoles(u.id),
        getUserDmsForUser(u.id),
        getDb().all<Record<string, unknown>>(
          `SELECT agm.agent_group_id, ag.name as agent_group_name
         FROM agent_group_members agm
         JOIN agent_groups ag ON ag.id = agm.agent_group_id
         WHERE agm.user_id = ?`,
          u.id,
        ),
      ]);

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
    }),
  );
}

async function collectTokens() {
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  const allEntries: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    agentGroupId: string;
  }> = [];
  const agentGroups = await getAllAgentGroups();
  const nameMap = new Map(agentGroups.map((g) => [g.id, g.name]));

  if (fs.existsSync(sessionsDir)) {
    for (const agDir of fs.readdirSync(sessionsDir).filter((d) => d.startsWith('ag-'))) {
      const entries = scanJsonlTokens(path.join(sessionsDir, agDir));
      allEntries.push(...entries.map((e) => ({ ...e, agentGroupId: agDir })));
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

async function collectContextWindows() {
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const results: unknown[] = [];
  const agentGroups = await getAllAgentGroups();
  const nameMap = new Map(agentGroups.map((g) => [g.id, g.name]));

  for (const agDir of fs.readdirSync(sessionsDir).filter((d) => d.startsWith('ag-'))) {
    const claudeDir = path.join(sessionsDir, agDir, '.claude-shared', 'projects');
    if (!fs.existsSync(claudeDir)) continue;

    // Find most recent JSONL
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
    if (jsonlFiles.length === 0) continue;

    jsonlFiles.sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });

    // Read last assistant turn from newest file
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
          results.push({
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
          });
          break;
        }
      } catch {
        /* skip */
      }
    }
  }

  return results;
}

// "YYYY-MM-DDTHH" in the host's local time — the chart's hour labels are read
// by a human, so bucket by local hour, not UTC. sv-SE renders "YYYY-MM-DD HH".
function localHourKey(d: Date): string {
  return d
    .toLocaleString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .replace(' ', 'T');
}

function toBucketArray(buckets: Record<string, { inbound: number; outbound: number }>) {
  return Object.entries(buckets)
    .map(([hour, counts]) => ({ hour, ...counts }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
}

/** Newest messages read per session per side. Caps both consumers below. */
const MAILBOX_READ_LIMIT = 500;
/** What the Messages page shows per session per side. */
const MESSAGES_PAGE_LIMIT = 50;

interface MailboxMessage {
  timestamp: string;
  kind: string;
  content: string;
}

/**
 * Activity buckets (last 24 local hours) + the Messages page, in one pass.
 *
 * Reads through the host mailbox seam — `withExistingMailboxSession`, the same
 * read path `ncl sessions history` uses — so this works on whatever mailbox
 * implementation is composed, not just SQLite files under
 * `data/v2-sessions/`. Sessions come from the central `sessions` table rather
 * than a directory scan, and read-only callers never provision storage: a
 * session with no mailbox yet resolves to `undefined` and is skipped.
 *
 * The seam serves the newest `MAILBOX_READ_LIMIT` messages per side, which is
 * exactly the {timestamp, kind, content} triple the dashboard renders. A
 * session with more than that inside 24h contributes only its newest
 * MAILBOX_READ_LIMIT to the chart.
 */
async function collectSessionMailboxes(sessions: SessionRow[]): Promise<{
  activity: Array<{ hour: string; inbound: number; outbound: number }>;
  messages: Array<{
    agentGroupId: string;
    sessionId: string;
    inbound: MailboxMessage[];
    outbound: MailboxMessage[];
  }>;
}> {
  const now = Date.now();
  const buckets: Record<string, { inbound: number; outbound: number }> = {};
  for (let i = 0; i < 24; i++) {
    buckets[localHourKey(new Date(now - i * 3600000))] = { inbound: 0, outbound: 0 };
  }
  const cutoff = new Date(now - 86400000).toISOString();
  const messages: Array<{
    agentGroupId: string;
    sessionId: string;
    inbound: MailboxMessage[];
    outbound: MailboxMessage[];
  }> = [];

  for (const session of sessions) {
    let history: { inbound: MailboxMessage[]; outbound: MailboxMessage[] } | undefined;
    try {
      history = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => ({
        inbound: mailbox.getInboundHistory(MAILBOX_READ_LIMIT),
        outbound: mailbox.getOutboundHistory(MAILBOX_READ_LIMIT),
      }));
    } catch (err) {
      log.debug('Dashboard mailbox read failed', { sessionId: session.id, err });
      continue;
    }
    if (!history) continue;

    for (const direction of ['inbound', 'outbound'] as const) {
      for (const row of history[direction]) {
        // Seam timestamps are ISO-8601 UTC, so the cutoff compares as a string.
        if (!row.timestamp || row.timestamp <= cutoff) continue;
        const key = localHourKey(new Date(row.timestamp));
        if (buckets[key]) buckets[key][direction]++;
      }
    }

    // The seam returns newest-first; the Messages page reads chronologically.
    const inbound = [...history.inbound].reverse().slice(-MESSAGES_PAGE_LIMIT);
    const outbound = [...history.outbound].reverse().slice(-MESSAGES_PAGE_LIMIT);
    if (inbound.length > 0 || outbound.length > 0) {
      messages.push({ agentGroupId: session.agent_group_id, sessionId: session.id, inbound, outbound });
    }
  }

  return { activity: toBucketArray(buckets), messages };
}
