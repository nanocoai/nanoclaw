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

// Transcripts and logs only grow, and a busy agent's transcript can pass the
// largest string Node can hold (~512 MB): readFileSync(…, 'utf-8') then throws.
// So files are never read whole — only their tail, or the bytes appended since
// the last snapshot, a chunk at a time.
const READ_CHUNK_BYTES = 1024 * 1024;
const TAIL_WINDOW_BYTES = 256 * 1024;
const LOG_BACKFILL_BYTES = 512 * 1024;

/**
 * Calls `onLine` for each newline-terminated line in the byte range [start, end)
 * of `file`. Returns the offset just past the last newline, and the bytes after
 * it (a line still being written, or the file's unterminated last line).
 */
function readLines(
  file: string,
  start: number,
  end: number,
  onLine: (line: string) => void,
): { next: number; rest: string } {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(READ_CHUNK_BYTES);
    // An unfinished line, kept as chunks and joined once, so a long line is copied once.
    let pending: Buffer[] = [];
    let pendingLen = 0;
    let pos = start;
    while (pos < end) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
      if (n === 0) break;
      pos += n;
      const chunk = buf.subarray(0, n);
      let from = 0;
      for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, from)) {
        if (pendingLen > 0) {
          onLine(Buffer.concat([...pending, chunk.subarray(from, nl)]).toString('utf-8'));
          pending = [];
          pendingLen = 0;
        } else onLine(chunk.toString('utf-8', from, nl));
        from = nl + 1;
      }
      if (from < n) {
        pending.push(Buffer.from(chunk.subarray(from)));
        pendingLen += n - from;
      }
    }
    return { next: pos - pendingLen, rest: Buffer.concat(pending).toString('utf-8') };
  } finally {
    fs.closeSync(fd);
  }
}

function startLogTail(config: PusherConfig): void {
  const logFile = path.resolve(process.cwd(), 'logs', 'nanoclaw.log');
  if (!fs.existsSync(logFile)) return;

  // Send last 200 lines as backfill
  try {
    const size = fs.statSync(logFile).size;
    const start = Math.max(0, size - LOG_BACKFILL_BYTES);
    const allLines: string[] = [];
    const { rest } = readLines(logFile, start, size, (l) => allLines.push(l));
    allLines.push(rest);
    if (start > 0) allLines.shift(); // the window starts mid-line
    logOffset = size;
    const tail = allLines
      .filter((l) => l.trim())
      .slice(-200)
      .map((l) => l.replace(ANSI_RE, ''));
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
    activity: collectActivity(),
    messages: collectMessages(),
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

async function collectSessions() {
  return getDb().all<Record<string, unknown>>(
    `SELECT s.*, ag.name as agent_group_name, ag.folder as agent_group_folder,
              mg.channel_type, mg.platform_id, mg.name as messaging_group_name
       FROM sessions s
       LEFT JOIN agent_groups ag ON ag.id = s.agent_group_id
       LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
       ORDER BY s.last_active DESC NULLS LAST`,
  );
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

  const seen = new Set<string>();
  if (fs.existsSync(sessionsDir)) {
    for (const agDir of fs.readdirSync(sessionsDir).filter((d) => d.startsWith('ag-'))) {
      const entries = scanJsonlTokens(path.join(sessionsDir, agDir), seen);
      allEntries.push(...entries.map((e) => ({ ...e, agentGroupId: agDir })));
    }
  }
  for (const file of tokenScanCache.keys()) if (!seen.has(file)) tokenScanCache.delete(file);

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

interface TokenEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// Per transcript: the entries read so far and the byte offset they cover. Each
// snapshot reads only what was appended since; a file that shrank or was
// replaced (new inode) is read again from the start.
const tokenScanCache = new Map<string, { ino: number; offset: number; entries: TokenEntry[] }>();

interface UsageLine {
  timestamp?: string;
  model?: string;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** An assistant line's usage, or null. Cheap substring check before parsing: most lines are tool results. */
function parseUsageLine(line: string): UsageLine | null {
  if (!line.includes('"usage"')) return null;
  try {
    const r = JSON.parse(line);
    return r.type === 'assistant' && r.message?.usage
      ? { timestamp: r.timestamp, model: r.message.model, usage: r.message.usage }
      : null;
  } catch {
    return null;
  }
}

function scanJsonlTokens(agentDir: string, seen: Set<string>): TokenEntry[] {
  const claudeDir = path.join(agentDir, '.claude-shared', 'projects');
  if (!fs.existsSync(claudeDir)) return [];

  const entries: TokenEntry[] = [];

  const walk = (dir: string): void => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.jsonl')) {
          try {
            const st = fs.statSync(full);
            let cached = tokenScanCache.get(full);
            if (!cached || cached.ino !== st.ino || st.size < cached.offset) {
              cached = { ino: st.ino, offset: 0, entries: [] };
              tokenScanCache.set(full, cached);
            }
            const fileEntries = cached.entries;
            cached.offset = readLines(full, cached.offset, st.size, (line) => {
              const hit = parseUsageLine(line);
              if (!hit) return;
              fileEntries.push({
                model: hit.model || 'unknown',
                inputTokens: hit.usage.input_tokens || 0,
                outputTokens: hit.usage.output_tokens || 0,
                cacheReadTokens: hit.usage.cache_read_input_tokens || 0,
                cacheCreationTokens: hit.usage.cache_creation_input_tokens || 0,
              });
            }).next;
            seen.add(full);
            for (const e of fileEntries) entries.push(e);
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

/**
 * The last assistant line with usage in a transcript, read from the end: a
 * 256 KB window, doubled until a match is found or the window covers the file.
 */
function lastUsageLine(file: string): UsageLine | null {
  const size = fs.statSync(file).size;
  for (let window = TAIL_WINDOW_BYTES; ; window *= 2) {
    const start = Math.max(0, size - window);
    const found: { last: UsageLine | null; skip: boolean } = { last: null, skip: start > 0 }; // skip: window starts mid-line
    const { rest } = readLines(file, start, size, (line) => {
      if (found.skip) found.skip = false;
      else found.last = parseUsageLine(line) ?? found.last;
    });
    if (!found.skip) found.last = parseUsageLine(rest) ?? found.last;
    if (found.last || start === 0) return found.last;
  }
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
    let hit: UsageLine | null = null;
    try {
      hit = lastUsageLine(jsonlFiles[0]);
    } catch {
      continue; // e.g. rotated away since the walk: skip it, not the whole snapshot
    }
    if (!hit) continue;
    const u = hit.usage;
    const model = hit.model || 'unknown';
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
      timestamp: hit.timestamp || '',
    });
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

function collectActivity() {
  const now = Date.now();
  const buckets: Record<string, { inbound: number; outbound: number }> = {};

  for (let i = 0; i < 24; i++) {
    const key = localHourKey(new Date(now - i * 3600000));
    buckets[key] = { inbound: 0, outbound: 0 };
  }

  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return toBucketArray(buckets);

  const cutoff = new Date(now - 86400000).toISOString();

  try {
    for (const agDir of fs.readdirSync(sessionsDir).filter((d) => d.startsWith('ag-'))) {
      const agPath = path.join(sessionsDir, agDir);
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
              const key = localHourKey(new Date(row.timestamp));
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
    for (const agDir of fs.readdirSync(sessionsDir).filter((d) => d.startsWith('ag-'))) {
      const agPath = path.join(sessionsDir, agDir);
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
