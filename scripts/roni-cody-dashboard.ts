import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const port = Number(process.env.RONI_CODY_DASHBOARD_PORT ?? process.env.PORT ?? 4377);
const remoteSsh = process.env.NANOTALK_REMOTE_SSH ?? 'root@5.78.42.198';
const remoteRoot = process.env.NANOTALK_REMOTE_ROOT ?? '/opt/nanoclaw';
const remoteDisabled = ['0', 'false', 'off', 'none', 'local'].includes(
  (process.env.NANOTALK_REMOTE_SSH ?? '').toLowerCase(),
);
const syncIntervalMs = Number(process.env.NANOTALK_REMOTE_SYNC_INTERVAL_MS ?? 5000);
const remoteCacheDir = path.join(dataDir, 'nanotalk-cache', 'remote');
let lastRemoteSyncAt = 0;
let lastRemoteSyncError: string | null = null;

type AgentGroup = {
  id: string;
  name: string;
  folder: string;
  created_at: string;
};

type SessionRow = {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  status: string | null;
  container_status: string | null;
  last_active: string | null;
  created_at: string;
  sourceLabel?: string;
};

type DataSource = {
  id: string;
  label: string;
  dataDir: string;
  location: string;
  status: 'ok' | 'error';
  error?: string;
};

type RawMessage = {
  seq: number | null;
  id: string;
  timestamp: string;
  kind: string;
  content: string;
  channel_type: string | null;
  platform_id: string | null;
  source_session_id?: string | null;
};

type ParsedContent = {
  text: string;
  sender?: string;
};

type DashboardMessage = {
  id: string;
  seq: number | null;
  timestamp: string;
  direction: 'roni-to-cody' | 'cody-to-roni';
  from: 'Roni' | 'Cody';
  to: 'Roni' | 'Cody';
  text: string;
  kind: string;
  sessionId: string;
  sourceId: string;
  sourceLabel: string;
};

type AgentPair = {
  roni: AgentGroup | null;
  cody: AgentGroup | null;
};

function openReadonly(dbPath: string) {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function getAgentGroups(db: Database.Database) {
  return db
    .prepare('select id, name, folder, created_at from agent_groups order by created_at')
    .all() as AgentGroup[];
}

function pickAgentPair(rows: AgentGroup[]): AgentPair {
  const roni = rows.find((row) => row.name.toLowerCase() === 'roni');
  const cody = rows.find((row) => row.name.toLowerCase().includes('cody') || row.name.includes('코디'));
  return { roni: roni ?? null, cody: cody ?? null };
}

function getSessions(db: Database.Database, agentGroupId: string) {
  return db
    .prepare(
      `select id, agent_group_id, messaging_group_id, status, container_status, last_active, created_at
       from sessions
       where agent_group_id = ?
       order by coalesce(last_active, created_at) desc`,
    )
    .all(agentGroupId) as SessionRow[];
}

function sessionPaths(source: DataSource, session: SessionRow) {
  const dir = path.join(source.dataDir, 'v2-sessions', session.agent_group_id, session.id);
  return {
    dir,
    inbound: path.join(dir, 'inbound.db'),
    outbound: path.join(dir, 'outbound.db'),
  };
}

function parseContent(content: string): string {
  return parseMessageContent(content).text;
}

function parseMessageContent(content: string): ParsedContent {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object') {
      const text = 'text' in parsed && typeof parsed.text === 'string' ? parsed.text : content;
      const sender = 'sender' in parsed && typeof parsed.sender === 'string' ? parsed.sender : undefined;
      return { text, sender };
    }
  } catch {
    // Fall through to raw content.
  }
  return { text: content };
}

function parseRemoteRoniBridgeText(text: string) {
  const marker = '\n\n원격 메시지 ID:';
  const withoutMetadata = text.includes(marker) ? text.slice(0, text.indexOf(marker)) : text;
  return withoutMetadata.replace(/^Roni가 보낸 메시지입니다\.\s*/, '').trim();
}

function timestampMs(value: string) {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? 0 : ms;
}

function syncRemoteSource() {
  if (remoteDisabled || !remoteSsh) return null;
  const now = Date.now();
  const central = path.join(remoteCacheDir, 'v2.db');
  if (existsSync(central) && now - lastRemoteSyncAt < syncIntervalMs) {
    return lastRemoteSyncError;
  }

  mkdirSync(remoteCacheDir, { recursive: true });
  try {
    execFileSync(
      'rsync',
      [
        '-az',
        '--delete',
        '--include',
        'v2.db*',
        '--include',
        'v2-sessions/',
        '--include',
        'v2-sessions/***/',
        '--include',
        'v2-sessions/**/*.db*',
        '--include',
        'v2-sessions/**/.heartbeat',
        '--exclude',
        '*',
        `${remoteSsh}:${remoteRoot.replace(/\/$/, '')}/data/`,
        `${remoteCacheDir}/`,
      ],
      { stdio: 'pipe', timeout: 12_000 },
    );
    lastRemoteSyncAt = now;
    lastRemoteSyncError = null;
  } catch (error) {
    lastRemoteSyncAt = now;
    lastRemoteSyncError = error instanceof Error ? error.message : String(error);
  }
  return lastRemoteSyncError;
}

function getSources(): DataSource[] {
  const sources: DataSource[] = [];
  const remoteError = syncRemoteSource();
  const remoteDb = path.join(remoteCacheDir, 'v2.db');
  if (!remoteDisabled && existsSync(remoteDb)) {
    sources.push({
      id: 'server',
      label: 'Server',
      dataDir: remoteCacheDir,
      location: `${remoteSsh}:${remoteRoot}`,
      status: remoteError ? 'error' : 'ok',
      error: remoteError ?? undefined,
    });
  } else if (!remoteDisabled && remoteError) {
    sources.push({
      id: 'server',
      label: 'Server',
      dataDir: remoteCacheDir,
      location: `${remoteSsh}:${remoteRoot}`,
      status: 'error',
      error: remoteError,
    });
  }

  sources.push({
    id: 'local',
    label: 'Local Mac',
    dataDir,
    location: root,
    status: 'ok',
  });
  return sources;
}

function readAgentSessionMessages(
  source: DataSource,
  session: SessionRow,
  self: 'Roni' | 'Cody',
  peer: AgentGroup,
): DashboardMessage[] {
  const paths = sessionPaths(source, session);
  const messages: DashboardMessage[] = [];
  const peerName = self === 'Roni' ? 'Cody' : 'Roni';
  const inboundDirection = self === 'Roni' ? 'cody-to-roni' : 'roni-to-cody';
  const outboundDirection = self === 'Roni' ? 'roni-to-cody' : 'cody-to-roni';

  if (existsSync(paths.inbound)) {
    const db = openReadonly(paths.inbound);
    try {
      const inboundAgent = db
        .prepare(
          `select id, seq, timestamp, kind, content, channel_type, platform_id, source_session_id
           from messages_in
           where channel_type = 'agent' and platform_id = ?
           order by seq asc`,
        )
        .all(peer.id) as RawMessage[];
      for (const row of inboundAgent) {
        messages.push({
          id: row.id,
          seq: row.seq,
          timestamp: row.timestamp,
          direction: inboundDirection,
          from: peerName,
          to: self,
          text: parseContent(row.content),
          kind: row.kind,
          sessionId: session.id,
          sourceId: source.id,
          sourceLabel: source.label,
        });
      }

      if (self === 'Cody') {
        const inboundRemoteRoni = db
          .prepare(
            `select id, seq, timestamp, kind, content, channel_type, platform_id, source_session_id
             from messages_in
             where channel_type = 'telegram_cody'
             order by seq asc`,
          )
          .all() as RawMessage[];
        for (const row of inboundRemoteRoni) {
          const content = parseMessageContent(row.content);
          if (content.sender !== 'Roni' && !content.text.startsWith('Roni가 보낸 메시지입니다.')) continue;
          messages.push({
            id: row.id,
            seq: row.seq,
            timestamp: row.timestamp,
            direction: 'roni-to-cody',
            from: 'Roni',
            to: 'Cody',
            text: parseRemoteRoniBridgeText(content.text),
            kind: row.kind,
            sessionId: session.id,
            sourceId: source.id,
            sourceLabel: `${source.label} Bridge`,
          });
        }
      }
    } finally {
      db.close();
    }
  }

  if (existsSync(paths.outbound)) {
    const db = openReadonly(paths.outbound);
    try {
      const outboundAgent = db
        .prepare(
          `select id, seq, timestamp, kind, content, channel_type, platform_id, thread_id
           from messages_out
           where channel_type = 'agent' and platform_id = ?
           order by seq asc`,
        )
        .all(peer.id) as RawMessage[];
      for (const row of outboundAgent) {
        messages.push({
          id: row.id,
          seq: row.seq,
          timestamp: row.timestamp,
          direction: outboundDirection,
          from: self,
          to: peerName,
          text: parseContent(row.content),
          kind: row.kind,
          sessionId: session.id,
          sourceId: source.id,
          sourceLabel: source.label,
        });
      }

      if (self === 'Cody') {
        const outboundServerRoni = db
          .prepare(
            `select id, seq, timestamp, kind, content, channel_type, platform_id, thread_id
             from messages_out
             where channel_type = 'server_roni' and platform_id = 'roni'
             order by seq asc`,
          )
          .all() as RawMessage[];
        for (const row of outboundServerRoni) {
          messages.push({
            id: row.id,
            seq: row.seq,
            timestamp: row.timestamp,
            direction: 'cody-to-roni',
            from: 'Cody',
            to: 'Roni',
            text: parseContent(row.content),
            kind: row.kind,
            sessionId: session.id,
            sourceId: source.id,
            sourceLabel: `${source.label} Bridge`,
          });
        }
      }
    } finally {
      db.close();
    }
  }

  return messages;
}

function readSourceAgents(source: DataSource) {
  const centralDbPath = path.join(source.dataDir, 'v2.db');
  if (!existsSync(centralDbPath)) {
    return {
      source,
      agents: [] as AgentGroup[],
      error: `Missing ${centralDbPath}`,
    };
  }

  const db = openReadonly(centralDbPath);
  try {
    return {
      source,
      agents: getAgentGroups(db),
      error: null,
    };
  } catch (error) {
    return {
      source,
      agents: [] as AgentGroup[],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
}

function readSourceData(source: DataSource, pair: AgentPair, agentError: string | null) {
  const centralDbPath = path.join(source.dataDir, 'v2.db');
  if (!existsSync(centralDbPath)) {
    return {
      source,
      agents: null,
      sessions: { roni: [] as SessionRow[], cody: [] as SessionRow[] },
      messages: [] as DashboardMessage[],
      error: `Missing ${centralDbPath}`,
    };
  }

  const db = openReadonly(centralDbPath);
  try {
    const sourcePair = pickAgentPair(getAgentGroups(db));
    const roniSessions = sourcePair.roni ? getSessions(db, sourcePair.roni.id) : [];
    const codySessions = sourcePair.cody ? getSessions(db, sourcePair.cody.id) : [];
    const messages: DashboardMessage[] = [];

    if (sourcePair.cody && pair.roni) {
      messages.push(...codySessions.flatMap((session) => readAgentSessionMessages(source, session, 'Cody', pair.roni!)));
    }
    if (sourcePair.roni && pair.cody) {
      messages.push(...roniSessions.flatMap((session) => readAgentSessionMessages(source, session, 'Roni', pair.cody!)));
    }

    messages.sort((a, b) => timestampMs(a.timestamp) - timestampMs(b.timestamp) || (a.seq ?? 0) - (b.seq ?? 0));

    return {
      source,
      agents: { roni: pair.roni, cody: pair.cody },
      sessions: { roni: roniSessions, cody: codySessions },
      messages,
      error: agentError,
    };
  } catch (error) {
    return {
      source,
      agents: null,
      sessions: { roni: [] as SessionRow[], cody: [] as SessionRow[] },
      messages: [] as DashboardMessage[],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
}

function messageKey(message: DashboardMessage) {
  return [
    message.direction,
    timestampMs(message.timestamp),
    message.from,
    message.to,
    message.text,
  ].join('|');
}

function getDashboardData() {
  const agentResults = getSources().map(readSourceAgents);
  const pair = pickAgentPair(agentResults.flatMap((result) => result.agents));
  const missing = [pair.roni ? null : 'Roni', pair.cody ? null : 'Cody'].filter(Boolean);
  const agentError = missing.length
    ? `Could not find ${missing.join(' and ')} agent group across configured sources`
    : null;
  const sourceResults = agentResults.map((result) => readSourceData(result.source, pair, result.error ?? agentError));
  const seen = new Set<string>();
  const messages: DashboardMessage[] = [];
  for (const result of sourceResults) {
    for (const message of result.messages) {
      const key = messageKey(message);
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push(message);
    }
  }
  messages.sort((a, b) => timestampMs(a.timestamp) - timestampMs(b.timestamp) || (a.seq ?? 0) - (b.seq ?? 0));

  const firstGood = sourceResults.find((result) => result.agents?.roni && result.agents?.cody);
  const isCurrentSession = (session: SessionRow) => session.container_status !== 'stopped';
  const roniSessions = sourceResults.flatMap((result) =>
    result.sessions.roni.filter(isCurrentSession).map((session) => ({ ...session, sourceLabel: result.source.label })),
  );
  const codySessions = sourceResults.flatMap((result) =>
    result.sessions.cody.filter(isCurrentSession).map((session) => ({ ...session, sourceLabel: result.source.label })),
  );

    return {
      generatedAt: new Date().toISOString(),
      agents: firstGood?.agents ?? null,
      sessions: {
        roni: roniSessions,
        cody: codySessions,
      },
      sources: sourceResults.map((result) => ({
        ...result.source,
        lastSyncAt:
          result.source.id === 'server' && existsSync(path.join(remoteCacheDir, 'v2.db'))
            ? statSync(path.join(remoteCacheDir, 'v2.db')).mtime.toISOString()
            : null,
        messageCount: result.messages.length,
        error: result.error ?? result.source.error ?? null,
      })),
      summary: {
        total: messages.length,
        roniToCody: messages.filter((message) => message.direction === 'roni-to-cody').length,
        codyToRoni: messages.filter((message) => message.direction === 'cody-to-roni').length,
        latest: messages.at(-1)?.timestamp ?? null,
        sources: sourceResults.length,
      },
      messages,
    };
}

const page = String.raw`<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NanoTalk</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101312;
      --panel: #171b19;
      --panel-2: #202622;
      --line: #303832;
      --text: #edf4ee;
      --muted: #99a59d;
      --roni: #79c9ef;
      --cody: #f6a44b;
      --good: #8bd18d;
      --warn: #f2cf72;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      overflow: hidden;
      min-height: 100vh;
      background:
        radial-gradient(circle at 18% 10%, rgba(121, 201, 239, .16), transparent 30%),
        radial-gradient(circle at 92% 14%, rgba(246, 164, 75, .14), transparent 28%),
        var(--bg);
      color: var(--text);
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    button, input { font: inherit; }
    .app {
      display: block;
      height: 100vh;
      overflow: hidden;
    }
    aside {
      position: fixed;
      inset: 0 auto 0 0;
      width: 320px;
      border-right: 1px solid var(--line);
      background: rgba(16, 19, 18, .78);
      backdrop-filter: blur(22px);
      padding: 22px;
      height: 100vh;
      overflow: hidden;
    }
    main {
      margin-left: 320px;
      height: 100vh;
      overflow-y: auto;
      padding: 22px;
    }
    .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
    .avatar-stack { display: flex; }
    .avatar {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      object-fit: cover;
      background: var(--panel-2);
      box-shadow: 0 10px 24px rgba(0, 0, 0, .24);
    }
    h1 { margin: 0; font-size: 22px; line-height: 1.1; font-weight: 760; }
    .subtle { color: var(--muted); font-size: 12px; }
    .section-title {
      margin: 22px 0 10px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    .metric-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .metric, .session, .toolbar, .empty {
      border: 1px solid var(--line);
      background: rgba(23, 27, 25, .88);
      border-radius: 8px;
    }
    .metric { padding: 12px; }
    .metric strong { display: block; font-size: 22px; line-height: 1.1; }
    .metric span { color: var(--muted); font-size: 12px; }
    .session, .source { padding: 12px; margin-bottom: 10px; }
    .session-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 8px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); }
    .dot.running { background: var(--good); }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      margin-bottom: 16px;
      position: sticky;
      top: 0;
      z-index: 2;
      backdrop-filter: blur(18px);
    }
    .search {
      flex: 1;
      min-width: 180px;
      border: 1px solid var(--line);
      background: #101412;
      color: var(--text);
      border-radius: 8px;
      padding: 10px 12px;
      outline: none;
    }
    .toggle {
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
      border-radius: 8px;
      padding: 9px 11px;
      cursor: pointer;
    }
    .toggle.active { border-color: rgba(121, 201, 239, .6); background: rgba(121, 201, 239, .14); }
    .timeline { max-width: 980px; margin: 0 auto; }
    .message {
      display: grid;
      grid-template-columns: 88px minmax(0, 1fr);
      gap: 14px;
      margin-bottom: 14px;
    }
    .time { color: var(--muted); font-size: 12px; padding-top: 12px; text-align: right; }
    .bubble {
      border: 1px solid var(--line);
      background: rgba(23, 27, 25, .92);
      border-radius: 8px;
      padding: 13px 14px;
      box-shadow: 0 14px 35px rgba(0, 0, 0, .16);
    }
    .bubble.roni-to-cody { border-left: 4px solid var(--roni); }
    .bubble.cody-to-roni { border-left: 4px solid var(--cody); }
    .meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
    .route { font-weight: 720; }
    .route .roni { color: var(--roni); }
    .route .cody { color: var(--cody); }
    .seq { color: var(--muted); font-size: 12px; }
    .source-line {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 4px;
    }
    .text {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: #e7eee8;
    }
    .empty { padding: 28px; text-align: center; color: var(--muted); }
    @media (max-width: 760px) {
      aside { width: 236px; }
      main { margin-left: 236px; }
      aside, main { padding: 16px; }
      .brand { align-items: flex-start; gap: 10px; margin-bottom: 16px; }
      .avatar { width: 38px; height: 38px; border-radius: 10px; }
      h1 { font-size: 18px; }
      .metric-grid { grid-template-columns: 1fr; }
      .metric { padding: 10px; }
      .metric strong { font-size: 18px; }
      .section-title { margin: 16px 0 8px; }
      .session, .source { padding: 10px; }
      .message { grid-template-columns: 64px minmax(0, 1fr); gap: 10px; }
      .toolbar { gap: 8px; }
      .toggle { padding: 8px 9px; }
    }
    @media (max-width: 560px) {
      body { overflow: auto; }
      .app { height: auto; overflow: visible; }
      aside {
        position: static;
        width: auto;
        border-right: 0;
        border-bottom: 1px solid var(--line);
        height: auto;
        max-height: 44vh;
        overflow-y: auto;
      }
      main { margin-left: 0; height: auto; overflow: visible; }
      .message { grid-template-columns: 1fr; gap: 6px; }
      .time { text-align: left; padding-top: 0; }
      .toolbar { flex-wrap: wrap; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <div class="brand">
        <div class="avatar-stack">
          <img class="avatar" src="/assets/nanotalk" alt="NanoTalk" />
        </div>
        <div>
          <h1>NanoTalk</h1>
          <div class="subtle">agent conversation dashboard</div>
        </div>
      </div>
      <div class="metric-grid">
        <div class="metric"><strong id="total">0</strong><span>total messages</span></div>
        <div class="metric"><strong id="latest">-</strong><span>latest</span></div>
        <div class="metric"><strong id="toCody">0</strong><span>Roni → Cody</span></div>
        <div class="metric"><strong id="toRoni">0</strong><span>Cody → Roni</span></div>
      </div>
      <div class="section-title">Sessions</div>
      <div id="sessions"></div>
      <div class="section-title">Sources</div>
      <div id="sources"></div>
      <div class="subtle">Server snapshots are synced over SSH, then merged with local session DBs. Telegram DMs are excluded unless routed agent-to-agent.</div>
    </aside>
    <main>
      <div class="toolbar">
        <input class="search" id="search" placeholder="Search agent conversations" />
        <button class="toggle active" data-filter="all">All</button>
        <button class="toggle" data-filter="roni-to-cody">Roni → Cody</button>
        <button class="toggle" data-filter="cody-to-roni">Cody → Roni</button>
        <span class="subtle" id="refreshed">Loading...</span>
      </div>
      <div class="timeline" id="timeline"></div>
    </main>
  </div>
  <script>
    const state = { data: null, filter: 'all', query: '', didInitialScroll: false };
    const fmt = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
    const rel = new Intl.RelativeTimeFormat('ko-KR', { numeric: 'auto' });

    function parseTs(ts) {
      return new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
    }

    function relative(ts) {
      if (!ts) return '-';
      const diff = Math.round((parseTs(ts).getTime() - Date.now()) / 60000);
      if (Math.abs(diff) < 60) return rel.format(diff, 'minute');
      return fmt.format(parseTs(ts));
    }

    function escapeHtml(value) {
      return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]));
    }

    function renderSessions() {
      const el = document.getElementById('sessions');
      const sessions = [...state.data.sessions.roni.map((s) => ['Roni', s]), ...state.data.sessions.cody.map((s) => ['Cody', s])];
      el.innerHTML = sessions.map(([name, s]) => {
        const running = s.container_status === 'running';
        return '<div class="session">' +
          '<div class="session-top">' +
            '<strong>' + name + '</strong>' +
            '<span class="pill"><span class="dot ' + (running ? 'running' : '') + '"></span>' + (s.container_status || s.status || 'unknown') + '</span>' +
          '</div>' +
          '<div class="subtle">' + escapeHtml(s.sourceLabel || 'Source') + ' · ' + escapeHtml(s.id) + '</div>' +
          '<div class="subtle">active ' + relative(s.last_active || s.created_at) + '</div>' +
        '</div>';
      }).join('');
    }

    function renderSources() {
      const el = document.getElementById('sources');
      el.innerHTML = state.data.sources.map((source) => {
        const ok = source.status === 'ok' && !source.error;
        return '<div class="source">' +
          '<div class="source-line">' +
            '<strong>' + escapeHtml(source.label) + '</strong>' +
            '<span class="pill"><span class="dot ' + (ok ? 'running' : '') + '"></span>' + (ok ? 'connected' : 'stale') + '</span>' +
          '</div>' +
          '<div class="subtle">' + source.messageCount + ' messages</div>' +
          '<div class="subtle">' + escapeHtml(source.location) + '</div>' +
          (source.lastSyncAt ? '<div class="subtle">synced ' + relative(source.lastSyncAt) + '</div>' : '') +
          (source.error ? '<div class="subtle">sync issue: ' + escapeHtml(source.error.split('\\n')[0]).slice(0, 140) + '</div>' : '') +
        '</div>';
      }).join('');
    }

    function renderTimeline() {
      const timeline = document.getElementById('timeline');
      const query = state.query.trim().toLowerCase();
      const messages = state.data.messages.filter((message) => {
        if (state.filter !== 'all' && message.direction !== state.filter) return false;
        if (query && !message.text.toLowerCase().includes(query)) return false;
        return true;
      });
      if (!messages.length) {
        timeline.innerHTML = '<div class="empty">No messages match the current view.</div>';
        return;
      }
      timeline.innerHTML = messages.map((message) => {
        const when = parseTs(message.timestamp);
        return '<article class="message">' +
          '<div class="time">' + fmt.format(when) + '</div>' +
          '<div class="bubble ' + message.direction + '">' +
            '<div class="meta">' +
              '<div class="route"><span class="' + message.from.toLowerCase() + '">' + message.from + '</span> → <span class="' + message.to.toLowerCase() + '">' + message.to + '</span></div>' +
              '<div class="seq">' + message.sourceLabel + ' · seq ' + (message.seq ?? '-') + '</div>' +
            '</div>' +
            '<div class="text">' + escapeHtml(message.text) + '</div>' +
          '</div>' +
        '</article>';
      }).join('');
    }

    function isNearTimelineBottom() {
      const main = document.querySelector('main');
      if (!main) return true;
      return main.scrollHeight - main.scrollTop - main.clientHeight < 120;
    }

    function scrollTimelineToBottom() {
      const main = document.querySelector('main');
      if (!main) return;
      main.scrollTop = main.scrollHeight;
    }

    function render(options = {}) {
      const shouldStickToBottom = options.forceBottom || isNearTimelineBottom();
      const { summary } = state.data;
      document.getElementById('total').textContent = summary.total;
      document.getElementById('toCody').textContent = summary.roniToCody;
      document.getElementById('toRoni').textContent = summary.codyToRoni;
      document.getElementById('latest').textContent = summary.latest ? relative(summary.latest) : '-';
      document.getElementById('refreshed').textContent = 'Updated ' + relative(state.data.generatedAt);
      renderSessions();
      renderSources();
      renderTimeline();
      if (shouldStickToBottom) {
        requestAnimationFrame(scrollTimelineToBottom);
      }
    }

    async function load() {
      const res = await fetch('/api/dashboard', { cache: 'no-store' });
      if (!res.ok) throw new Error(await res.text());
      state.data = await res.json();
      const forceBottom = !state.didInitialScroll;
      render({ forceBottom });
      state.didInitialScroll = true;
    }

    document.getElementById('search').addEventListener('input', (event) => {
      state.query = event.target.value;
      renderTimeline();
      requestAnimationFrame(scrollTimelineToBottom);
    });
    document.querySelectorAll('[data-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelectorAll('[data-filter]').forEach((b) => b.classList.remove('active'));
        button.classList.add('active');
        state.filter = button.dataset.filter;
        renderTimeline();
        requestAnimationFrame(scrollTimelineToBottom);
      });
    });

    load().catch((error) => {
      document.getElementById('timeline').innerHTML = '<div class="empty">' + escapeHtml(error.message) + '</div>';
    });
    setInterval(load, 5000);
  </script>
</body>
</html>`;

function sendJson(res: Parameters<Parameters<typeof createServer>[0]>[1], value: unknown) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function sendFile(res: Parameters<Parameters<typeof createServer>[0]>[1], filePath: string, contentType: string) {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'public, max-age=60' });
  res.end(readFileSync(filePath));
}

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
      return;
    }
    if (url.pathname === '/api/dashboard') {
      sendJson(res, getDashboardData());
      return;
    }
    if (url.pathname === '/assets/roni') {
      sendFile(res, path.join(root, 'assets/agents/roni-profile-basic.png'), 'image/png');
      return;
    }
    if (url.pathname === '/assets/cody') {
      sendFile(res, path.join(root, 'assets/agents/cody-profile-macbook.png'), 'image/png');
      return;
    }
    if (url.pathname === '/assets/nanotalk') {
      sendFile(res, path.join(root, 'assets/nanotalk-icon.png'), 'image/png');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`NanoTalk dashboard: http://127.0.0.1:${port}`);
});
