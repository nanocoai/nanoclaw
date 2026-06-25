/**
 * Daily NanoClaw system state snapshot + diff.
 *
 * Reads agent groups, messaging groups, wirings, scheduled tasks, and env
 * defaults. Compares against data/system-snapshot.json. If nothing changed,
 * exits silently (0 tokens). If something changed, formats the diff as plain
 * text and writes it directly to the delivery agent's outbound.db so the host
 * delivery poller sends it — no agent container, no LLM.
 *
 * Run via systemd timer or launchd plist daily at your chosen time.
 *
 * CONFIGURE: The four constants below are patched by the /system-digest skill
 * install step. Do not edit them by hand unless you know what you're doing.
 */

import path from 'path';
import fs from 'fs';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { initDb, getDb } from '../src/db/index.js';
import { readEnvFile } from '../src/env.js';
import { writeOutboundDirect } from '../src/session-manager.js';

// --- Delivery target (patched by skill install) ---
const DELIVERY_AGENT_GROUP_ID = 'PLACEHOLDER_AGENT_GROUP_ID';
const DELIVERY_MG_ID = 'PLACEHOLDER_MG_ID';
const DELIVERY_PLATFORM_ID = 'PLACEHOLDER_PLATFORM_ID';
const DELIVERY_CHANNEL_TYPE = 'PLACEHOLDER_CHANNEL_TYPE';

const SNAPSHOT_PATH = path.join(DATA_DIR, 'system-snapshot.json');

// --- Types ---

interface AgentGroupSnap {
  id: string;
  name: string;
  provider: string | null;
  model: string | null;
  cliScope: string | null;
  mcpServers: string[];
  packagesApt: string[];
  packagesNpm: string[];
}

interface MessagingGroupSnap {
  id: string;
  channelType: string;
  name: string;
  unknownSenderPolicy: string;
}

interface WiringSnap {
  id: string;
  agentGroupName: string;
  messagingGroupName: string;
  sessionMode: string;
  engageMode: string | null;
  engagePattern: string | null;
}

interface TaskSnap {
  id: string;
  recurrence: string | null;
  processAfter: string | null;
}

interface GroupTasksSnap {
  agentGroupId: string;
  agentGroupName: string;
  tasks: TaskSnap[];
}

interface Snapshot {
  capturedAt: string;
  agentGroups: AgentGroupSnap[];
  messagingGroups: MessagingGroupSnap[];
  wirings: WiringSnap[];
  scheduledTasks: GroupTasksSnap[];
  pendingApprovals: number;
  unregisteredSenders: number;
  defaults: { model: string; smallModel: string };
}

// --- State reading ---

function readState(db: Database.Database): Snapshot {
  const rawGroups = db.prepare(`
    SELECT ag.id, ag.name,
           cc.provider, cc.model, cc.cli_scope,
           cc.mcp_servers, cc.packages_apt, cc.packages_npm
    FROM agent_groups ag
    LEFT JOIN container_configs cc ON cc.agent_group_id = ag.id
    ORDER BY ag.id
  `).all() as any[];

  const agentGroups: AgentGroupSnap[] = rawGroups.map(g => ({
    id: g.id,
    name: g.name,
    provider: g.provider ?? null,
    model: g.model ?? null,
    cliScope: g.cli_scope ?? null,
    mcpServers: g.mcp_servers ? Object.keys(JSON.parse(g.mcp_servers)) : [],
    packagesApt: g.packages_apt ? JSON.parse(g.packages_apt) : [],
    packagesNpm: g.packages_npm ? JSON.parse(g.packages_npm) : [],
  }));

  const messagingGroups: MessagingGroupSnap[] = (db.prepare(`
    SELECT id, channel_type, name, unknown_sender_policy
    FROM messaging_groups ORDER BY id
  `).all() as any[]).map(g => ({
    id: g.id,
    channelType: g.channel_type,
    name: g.name ?? '',
    unknownSenderPolicy: g.unknown_sender_policy,
  }));

  const rawWirings = db.prepare(`
    SELECT mga.id, mga.session_mode, mga.engage_mode, mga.engage_pattern,
           mg.name as mg_name, ag.name as ag_name
    FROM messaging_group_agents mga
    JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
    JOIN agent_groups ag ON ag.id = mga.agent_group_id
    ORDER BY mga.id
  `).all() as any[];

  const wirings: WiringSnap[] = rawWirings.map(w => ({
    id: w.id,
    agentGroupName: w.ag_name,
    messagingGroupName: w.mg_name ?? '',
    sessionMode: w.session_mode,
    engageMode: w.engage_mode ?? null,
    engagePattern: w.engage_pattern ?? null,
  }));

  const scheduledTasks: GroupTasksSnap[] = [];
  for (const group of rawGroups) {
    const session = db.prepare(
      'SELECT id FROM sessions WHERE agent_group_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(group.id) as { id: string } | undefined;
    if (!session) continue;

    const inDbPath = path.join(DATA_DIR, 'v2-sessions', group.id, session.id, 'inbound.db');
    if (!fs.existsSync(inDbPath)) continue;

    const inDb = new Database(inDbPath, { readonly: true });
    try {
      inDb.pragma('journal_mode = DELETE');
      const tasks = inDb.prepare(
        "SELECT id, recurrence, process_after FROM messages_in WHERE kind='task' ORDER BY id",
      ).all() as any[];

      scheduledTasks.push({
        agentGroupId: group.id,
        agentGroupName: group.name,
        tasks: tasks.map(t => ({
          id: t.id,
          recurrence: t.recurrence ?? null,
          // For one-shot tasks only — recurring process_after advances daily, not meaningful to diff
          processAfter: t.recurrence ? null : (t.process_after ?? null),
        })),
      });
    } finally {
      inDb.close();
    }
  }

  const pendingApprovals = (db.prepare('SELECT COUNT(*) as c FROM pending_approvals').get() as any).c as number;
  const unregisteredSenders = (db.prepare('SELECT COUNT(*) as c FROM unregistered_senders').get() as any).c as number;

  const env = readEnvFile(['OPENCODE_MODEL', 'OPENCODE_SMALL_MODEL']);
  const defaults = {
    model: env.OPENCODE_MODEL ?? '',
    smallModel: env.OPENCODE_SMALL_MODEL ?? '',
  };

  return {
    capturedAt: new Date().toISOString(),
    agentGroups,
    messagingGroups,
    wirings,
    scheduledTasks,
    pendingApprovals,
    unregisteredSenders,
    defaults,
  };
}

// --- Diff ---

type Change = string;

function diffArrayByKey<T extends Record<string, any>>(
  prev: T[],
  curr: T[],
  key: string,
  label: (item: T) => string,
  fields: string[],
): Change[] {
  const changes: Change[] = [];
  const prevMap = new Map(prev.map(i => [i[key], i]));
  const currMap = new Map(curr.map(i => [i[key], i]));

  for (const [id, item] of currMap) {
    if (!prevMap.has(id)) {
      changes.push(`+ ${label(item)} added`);
    } else {
      const p = prevMap.get(id)!;
      for (const f of fields) {
        const pv = JSON.stringify(p[f] ?? null);
        const cv = JSON.stringify(item[f] ?? null);
        if (pv !== cv) {
          const display = (v: string) => (v === 'null' ? 'none' : v.replace(/^"|"$/g, ''));
          changes.push(`~ ${label(item)}: ${f} ${display(pv)} → ${display(cv)}`);
        }
      }
    }
  }

  for (const [id, item] of prevMap) {
    if (!currMap.has(id)) changes.push(`- ${label(item)} removed`);
  }

  return changes;
}

function diffState(prev: Snapshot, curr: Snapshot): Record<string, Change[]> {
  const sections: Record<string, Change[]> = {};

  sections['Agent groups'] = diffArrayByKey(
    prev.agentGroups, curr.agentGroups, 'id',
    g => g.name,
    ['name', 'provider', 'model', 'cliScope', 'mcpServers', 'packagesApt', 'packagesNpm'],
  );

  sections['Messaging groups'] = diffArrayByKey(
    prev.messagingGroups, curr.messagingGroups, 'id',
    g => `${g.name || g.id} (${g.channelType})`,
    ['name', 'unknownSenderPolicy'],
  );

  sections['Wirings'] = diffArrayByKey(
    prev.wirings, curr.wirings, 'id',
    w => `${w.messagingGroupName} → ${w.agentGroupName}`,
    ['sessionMode', 'engageMode', 'engagePattern'],
  );

  const taskChanges: Change[] = [];
  const prevGroupMap = new Map(prev.scheduledTasks.map(g => [g.agentGroupId, g]));
  const currGroupMap = new Map(curr.scheduledTasks.map(g => [g.agentGroupId, g]));

  for (const [gid, group] of currGroupMap) {
    const prevGroup = prevGroupMap.get(gid);
    const prevTasks = prevGroup ? prevGroup.tasks : [];
    const inner = diffArrayByKey(
      prevTasks, group.tasks, 'id',
      t => `[${group.agentGroupName}] ${t.id}`,
      ['recurrence', 'processAfter'],
    );
    taskChanges.push(...inner);
  }
  for (const [gid, group] of prevGroupMap) {
    if (!currGroupMap.has(gid)) {
      taskChanges.push(`- All tasks for ${group.agentGroupName} removed`);
    }
  }
  sections['Scheduled tasks'] = taskChanges;

  sections['Defaults'] = [];
  if (prev.defaults.model !== curr.defaults.model) {
    sections['Defaults'].push(`~ default model: ${prev.defaults.model || 'none'} → ${curr.defaults.model || 'none'}`);
  }
  if (prev.defaults.smallModel !== curr.defaults.smallModel) {
    sections['Defaults'].push(`~ small model: ${prev.defaults.smallModel || 'none'} → ${curr.defaults.smallModel || 'none'}`);
  }

  const alertChanges: Change[] = [];
  if (curr.pendingApprovals > 0) {
    alertChanges.push(`⚠ ${curr.pendingApprovals} pending approval(s) waiting`);
  }
  if (curr.unregisteredSenders > prev.unregisteredSenders) {
    alertChanges.push(`⚠ ${curr.unregisteredSenders - prev.unregisteredSenders} new unregistered sender attempt(s)`);
  }
  sections['Alerts'] = alertChanges;

  return sections;
}

function formatDiff(sections: Record<string, Change[]>, capturedAt: string): string {
  const date = new Date(capturedAt).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });

  const lines: string[] = [`*NanoClaw system update — ${date}*`, ''];

  for (const [section, changes] of Object.entries(sections)) {
    if (changes.length === 0) continue;
    lines.push(`*${section}*`);
    for (const c of changes) lines.push(`  ${c}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

// --- Deliver ---

function deliver(db: Database.Database, text: string): void {
  const session = db.prepare(
    'SELECT id FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(DELIVERY_AGENT_GROUP_ID, DELIVERY_MG_ID) as { id: string } | undefined;

  if (!session) {
    console.log('No delivery session found — cannot deliver. Message:\n', text);
    return;
  }

  writeOutboundDirect(DELIVERY_AGENT_GROUP_ID, session.id, {
    id: `system-snapshot-${Date.now()}`,
    kind: 'chat',
    platformId: DELIVERY_PLATFORM_ID,
    channelType: DELIVERY_CHANNEL_TYPE,
    threadId: null,
    content: JSON.stringify({ text }),
  });

  console.log(`Delivered system change notification (session ${session.id})`);
}

// --- Main ---

async function main(): Promise<void> {
  initDb(path.join(process.cwd(), 'data', 'v2.db'));
  const db = getDb();

  const current = readState(db);

  if (!fs.existsSync(SNAPSHOT_PATH)) {
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2));
    console.log('First run — snapshot saved. Nothing to compare yet.');
    return;
  }

  const previous: Snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  const sections = diffState(previous, current);
  const totalChanges = Object.values(sections).reduce((n, arr) => n + arr.length, 0);

  if (totalChanges === 0) {
    console.log('No changes. Exiting. (0 tokens)');
    return;
  }

  const message = formatDiff(sections, current.capturedAt);
  deliver(db, message);

  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2));
}

main().catch(err => {
  console.error('system-snapshot failed:', err);
  process.exit(1);
});
