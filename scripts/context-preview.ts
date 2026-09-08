/**
 * scripts/context-preview.ts — render the exact context an agent sees.
 *
 * For maintainers: simulates a scenario (first message, scheduled task fire,
 * restart wake, agent-to-agent message, a replayed real turn, …) and prints
 * every context surface the agent would receive — the composed project doc
 * (CLAUDE.md), the runtime system-prompt addendum, the SDK options, the MCP
 * tool list, and the exact prompt string — using the REAL production code
 * paths, so edits to instruction sources, the formatter, the composer, etc.
 * are reflected immediately. Nothing is duplicated and nothing in the live
 * install is touched: the whole run happens in a throwaway sandbox with an
 * in-memory central DB, and the container half runs the real poll loop under
 * Bun (container/agent-runner/scripts/context-preview-runner.ts).
 *
 * Usage:
 *   pnpm exec tsx scripts/context-preview.ts <scenario> [flags]
 *
 * Scenarios:
 *   first-message   Fresh session, first user message         (default)
 *   followup        Existing session (continuation on file), next message
 *   accumulate      Group chat: silent trigger=0 rows ride in with a mention
 *   task-fire       A scheduled task (`ncl tasks create`) comes due
 *   on-wake         Container restart with an on_wake message
 *   a2a             Message arriving from another agent group
 *   subagent        What SDK-native subagents (Task tool) inherit
 *
 * Flags:
 *   --group <folder|id>     Use a real agent group from data/v2.db (read-only
 *                           snapshot of its config, persona, destinations).
 *                           Default: a synthetic group named "preview".
 *   --persona-file <path>   Stage this file as the group's standing
 *                           instructions (instructions.prepend.md).
 *   --replay <jsonl>        Stage real inbound rows from a session dump (the
 *                           mailbox record format: one {recordType, record}
 *                           JSON object per line) instead of the scenario's
 *                           synthetic message. Destination, routing and
 *                           continuation records in the dump are staged too.
 *   --turn <seq|a-b>        With --replay: which record(s) form the batch
 *                           being previewed. Earlier records are staged as
 *                           already-handled history; later ones are dropped.
 *                           Default: the last inbound record.
 *   --message <text>        User/task/wake message text.
 *   --sender <name>         Sender display name (default "Dana").
 *   --channel <type>        Channel type for the messaging group (default "whatsapp").
 *   --section <name>        Print one section: scenario|environment|claude-md|
 *                           system-prompt|sdk-options|mcp-tools|prompt|notes
 *   --json                  Machine-readable output of everything.
 *   --keep                  Keep the sandbox dir (path printed) for inspection.
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import type { DbDriver } from '../src/db/driver.js';
import type { AgentGroup, ContainerConfigRow, Session } from '../src/types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCENARIOS = ['first-message', 'followup', 'accumulate', 'task-fire', 'on-wake', 'a2a', 'subagent'] as const;
type Scenario = (typeof SCENARIOS)[number];
const SECTIONS = [
  'scenario',
  'environment',
  'claude-md',
  'system-prompt',
  'sdk-options',
  'mcp-tools',
  'prompt',
  'notes',
];

interface Args {
  scenario: Scenario;
  group?: string;
  personaFile?: string;
  replay?: string;
  turn?: [number, number];
  message?: string;
  sender: string;
  channel: string;
  section?: string;
  json: boolean;
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { scenario: 'first-message', sender: 'Dana', channel: 'whatsapp', json: false, keep: false };
  const positional: string[] = [];
  const value = (flag: string, v: string | undefined): string => {
    if (v === undefined || v.startsWith('--')) fail(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--keep') args.keep = true;
    else if (a === '--group') args.group = value(a, argv[++i]);
    else if (a === '--persona-file') args.personaFile = value(a, argv[++i]);
    else if (a === '--replay') args.replay = value(a, argv[++i]);
    else if (a === '--turn') args.turn = parseTurn(value(a, argv[++i]));
    else if (a === '--message') args.message = value(a, argv[++i]);
    else if (a === '--sender') args.sender = value(a, argv[++i]);
    else if (a === '--channel') args.channel = value(a, argv[++i]);
    else if (a === '--section') args.section = value(a, argv[++i]);
    else if (a.startsWith('--')) fail(`Unknown flag: ${a}`);
    else positional.push(a);
  }
  if (args.section && !SECTIONS.includes(args.section)) {
    fail(`Unknown section "${args.section}". Sections: ${SECTIONS.join(', ')}`);
  }
  if (args.turn && !args.replay) fail('--turn only applies with --replay');
  if (positional.length > 1) fail(`Expected one scenario, got: ${positional.join(' ')}`);
  if (positional[0]) {
    if (!SCENARIOS.includes(positional[0] as Scenario)) {
      fail(`Unknown scenario "${positional[0]}". Scenarios: ${SCENARIOS.join(', ')}`);
    }
    args.scenario = positional[0] as Scenario;
  }
  if (args.replay && args.scenario !== 'first-message' && args.scenario !== 'followup') {
    fail('--replay stages the dump as the session; use it with first-message (default) or followup');
  }
  for (const f of [args.personaFile, args.replay]) {
    if (f && !fs.existsSync(f)) fail(`File not found: ${f}`);
  }
  return args;
}

function parseTurn(spec: string): [number, number] {
  const m = spec.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) fail(`--turn expects <seq> or <from>-<to>, got "${spec}"`);
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  if (b < a) fail(`--turn range is reversed: ${spec}`);
  return [a, b];
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

/** Snapshot of a real group read from the live central DB (read-only). */
interface LiveGroup {
  group: AgentGroup;
  configRow: ContainerConfigRow | null;
  destinations: Array<Record<string, unknown>>;
  messagingGroups: Array<Record<string, unknown>>;
  /** Agent groups referenced by agent-type destinations — writeDestinations
   *  silently drops a destination whose target group row is missing. */
  targetAgentGroups: Array<Record<string, unknown>>;
}

function snapshotLiveGroup(ref: string): LiveGroup {
  const dbPath = path.join(REPO_ROOT, 'data', 'v2.db');
  if (!fs.existsSync(dbPath)) fail(`--group requires a live SQLite install (${dbPath} not found)`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const group = db.prepare('SELECT * FROM agent_groups WHERE folder = ? OR id = ?').get(ref, ref) as
      | AgentGroup
      | undefined;
    if (!group) {
      const known = (db.prepare('SELECT folder FROM agent_groups').all() as Array<{ folder: string }>)
        .map((r) => r.folder)
        .join(', ');
      fail(`Agent group "${ref}" not found. Known folders: ${known || '(none)'}`);
    }
    const configRow = db.prepare('SELECT * FROM container_configs WHERE agent_group_id = ?').get(group.id) as
      | ContainerConfigRow
      | undefined;
    const hasDest = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_destinations'").get();
    const destinations = hasDest
      ? (db.prepare('SELECT * FROM agent_destinations WHERE agent_group_id = ?').all(group.id) as Array<
          Record<string, unknown>
        >)
      : [];
    const mgIds = destinations.filter((d) => d.target_type === 'channel').map((d) => d.target_id as string);
    const messagingGroups = mgIds.length
      ? (db
          .prepare(`SELECT * FROM messaging_groups WHERE id IN (${mgIds.map(() => '?').join(',')})`)
          .all(...mgIds) as Array<Record<string, unknown>>)
      : [];
    const agIds = destinations.filter((d) => d.target_type === 'agent').map((d) => d.target_id as string);
    const targetAgentGroups = agIds.length
      ? (db
          .prepare(`SELECT * FROM agent_groups WHERE id IN (${agIds.map(() => '?').join(',')})`)
          .all(...agIds) as Array<Record<string, unknown>>)
      : [];
    return { group, configRow: configRow ?? null, destinations, messagingGroups, targetAgentGroups };
  } finally {
    db.close();
  }
}

/** Insert a raw row into the in-memory central DB, keeping only columns that exist. */
async function insertRaw(db: DbDriver, table: string, row: Record<string, unknown>): Promise<void> {
  const cols = new Set((await db.all<{ name: string }>(`PRAGMA table_info('${table}')`)).map((c) => c.name));
  const keys = Object.keys(row).filter((k) => cols.has(k));
  await db.run(
    `INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    ...keys.map((k) => row[k]),
  );
}

// ── Replay: a session dump in the mailbox record format ──

/** One inbound row as the mailbox serializes it (camelCase InboundRecord). */
interface ReplayInbound {
  id: string;
  sequence: number;
  kind: string;
  timestamp: string;
  status?: string;
  trigger?: boolean;
  onWake?: boolean;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  content: string;
  processAfter?: string | null;
  recurrence?: string | null;
  sourceSessionId?: string | null;
}

interface ReplayDump {
  inbound: ReplayInbound[];
  routing: { channelType: string | null; platformId: string | null; threadId: string | null } | null;
  destinations: Array<{
    name: string;
    displayName: string | null;
    type: string;
    channelType: string | null;
    platformId: string | null;
    agentGroupId: string | null;
  }>;
  /** session_state rows, e.g. continuation:<provider>. */
  state: Array<{ key: string; value: string; updatedAt?: string }>;
}

function readReplayDump(file: string): ReplayDump {
  const dump: ReplayDump = { inbound: [], routing: null, destinations: [], state: [] };
  let n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    n++;
    let obj: { recordType?: string; record?: Record<string, unknown> };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      fail(`--replay: line ${n} is not JSON`);
    }
    const rec = obj.record;
    if (!rec) continue;
    switch (obj.recordType) {
      case 'inbound':
        dump.inbound.push(rec as unknown as ReplayInbound);
        break;
      case 'sessionRouting':
        dump.routing = rec as ReplayDump['routing'];
        break;
      case 'destination':
        dump.destinations.push(rec as ReplayDump['destinations'][number]);
        break;
      case 'state':
        dump.state.push(rec as ReplayDump['state'][number]);
        break;
      default:
        break; // outbound, deliveries, acks, container: not context inputs
    }
  }
  if (dump.inbound.length === 0) fail(`--replay: no inbound records in ${file}`);
  dump.inbound.sort((a, b) => a.sequence - b.sequence || a.timestamp.localeCompare(b.timestamp));
  return dump;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Keep stdout clean for the rendered preview — src/log.ts logs info to
  // stdout. Must be set before the first src import evaluates the threshold.
  if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'warn';

  // Inputs that live outside the sandbox — read BEFORE chdir.
  const live = args.group ? snapshotLiveGroup(args.group) : null;
  const persona = args.personaFile ? fs.readFileSync(path.resolve(args.personaFile), 'utf8') : null;
  const replay = args.replay ? readReplayDump(path.resolve(args.replay)) : null;

  // ── Sandbox ──
  // GROUPS_DIR / DATA_DIR resolve from process.cwd() at src/config.js import
  // time, and the composer discovers instruction sources under cwd/container/.
  // Chdir into a throwaway root (with container/ symlinked back to the repo)
  // before importing any src module, so every host-side write lands in the
  // sandbox.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-context-preview-'));
  fs.mkdirSync(path.join(sandbox, 'groups'));
  fs.mkdirSync(path.join(sandbox, 'data'));
  fs.symlinkSync(path.join(REPO_ROOT, 'container'), path.join(sandbox, 'container'));
  // Carry over only the non-secret .env keys the preview actually renders
  // (identity + timezone). Never copy the whole file — the sandbox lives in
  // tmp and credentials (ONECLI_API_KEY etc.) must not leave the repo.
  const ENV_WHITELIST = new Set(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'TZ', 'DEFAULT_AGENT_PROVIDER']);
  const liveEnvFile = path.join(REPO_ROOT, '.env');
  if (fs.existsSync(liveEnvFile)) {
    const kept = fs
      .readFileSync(liveEnvFile, 'utf8')
      .split('\n')
      .filter((line) => ENV_WHITELIST.has(line.split('=')[0]?.trim()));
    fs.writeFileSync(path.join(sandbox, '.env'), kept.join('\n') + '\n');
  }
  process.chdir(sandbox);

  const cleanup = () => {
    if (args.keep) {
      console.error(`Sandbox kept: ${sandbox}`);
    } else {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  };

  try {
    // Host modules — imported only now, with cwd = sandbox. The modules barrel
    // first: it registers the mailbox implementation (same as src/index.ts).
    await import('../src/modules/index.js');
    const dbMod = await import('../src/db/index.js');
    const sessionManager = await import('../src/session-manager.js');
    const mailboxPaths = await import('../src/mailbox/sqlite/index.js');
    const sessionDb = await import('../src/mailbox/sqlite/session-db.js');
    const groupInit = await import('../src/group-init.js');
    const groupPersona = await import('../src/group-persona.js');
    const containerConfigMod = await import('../src/container-config.js');
    const containerRunner = await import('../src/container-runner.js');
    const scheduling = await import('../src/modules/scheduling/create.js');
    const writeDestMod = await import('../src/modules/agent-to-agent/write-destinations.js');
    const configMod = await import('../src/config.js');

    const central = await dbMod.initTestDb();
    // initTestDb migrates only on backends that own a test schema; the SQLite
    // composition does not, and runMigrations is idempotent either way.
    await dbMod.runMigrations(central);

    // ── Seed the agent group ──
    let group: AgentGroup;
    if (live) {
      group = live.group;
      await insertRaw(central, 'agent_groups', group as unknown as Record<string, unknown>);
      if (live.configRow) {
        await insertRaw(central, 'container_configs', live.configRow as unknown as Record<string, unknown>);
      }
      for (const mg of live.messagingGroups) await insertRaw(central, 'messaging_groups', mg);
      for (const ag of live.targetAgentGroups) await insertRaw(central, 'agent_groups', ag);
      for (const d of live.destinations) await insertRaw(central, 'agent_destinations', d);
      // Copy the group's real files (persona, memory, plugins) so the composed
      // doc matches the install. The composed doc is regenerated in the sandbox.
      const liveGroupDir = path.join(REPO_ROOT, 'groups', group.folder);
      if (fs.existsSync(liveGroupDir)) {
        fs.cpSync(liveGroupDir, path.join(sandbox, 'groups', group.folder), { recursive: true });
      }
      // Per-group provider state (settings, skill links) — the default Claude layout.
      const liveClaudeShared = path.join(REPO_ROOT, 'data', 'v2-sessions', group.id, '.claude-shared');
      if (fs.existsSync(liveClaudeShared)) {
        fs.cpSync(liveClaudeShared, path.join(sandbox, 'data', 'v2-sessions', group.id, '.claude-shared'), {
          recursive: true,
        });
      }
    } else {
      group = {
        id: 'preview-group',
        name: 'preview',
        folder: 'preview',
        agent_provider: null,
        created_at: new Date().toISOString(),
      };
      await dbMod.createAgentGroup(group);
    }
    const groupDir = path.join(sandbox, 'groups', group.folder);

    // --persona-file: the staged standing instructions replace whatever the
    // group had, through the same writer group creation uses (stageGroupPersona
    // via initGroupFilesystem below).
    if (persona !== null) {
      fs.rmSync(path.join(groupDir, groupPersona.PERSONA_PREPEND_FILE), { force: true });
    }

    // ── Messaging group + destinations ──
    // Synthetic mode: one DM (or group chat) the agent is wired to, plus the
    // destination row /init-first-agent and /manage-channels create. A replay
    // dump carries the real session routing and destination map, so the
    // synthetic rows take their channel/platform/name from it.
    const liveMg = live?.messagingGroups[0] as { id?: string; channel_type?: string; platform_id?: string } | undefined;
    let mgId: string;
    let mgChannel: string;
    let mgPlatformId: string;
    if (liveMg?.id) {
      mgId = liveMg.id;
      mgChannel = liveMg.channel_type as string;
      mgPlatformId = liveMg.platform_id as string;
    } else {
      const routing = replay?.routing ?? replay?.inbound.find((r) => r.channelType && r.platformId) ?? null;
      mgId = 'preview-mg';
      mgChannel = routing?.channelType ?? args.channel;
      mgPlatformId = routing?.platformId ?? (args.scenario === 'accumulate' ? 'preview-group-chat' : 'preview-dm');
      const ownDest = replay?.destinations.find(
        (d) => d.type === 'channel' && d.channelType === mgChannel && d.platformId === mgPlatformId,
      );
      await dbMod.createMessagingGroup({
        id: mgId,
        channel_type: mgChannel,
        platform_id: mgPlatformId,
        name: ownDest?.displayName ?? (args.scenario === 'accumulate' ? 'Preview Group Chat' : 'Preview DM'),
        is_group: args.scenario === 'accumulate' ? 1 : 0,
        unknown_sender_policy: 'strict',
        created_at: new Date().toISOString(),
      });
      await insertRaw(central, 'agent_destinations', {
        agent_group_id: group.id,
        local_name: ownDest?.name ?? `${mgChannel}-main`,
        target_type: 'channel',
        target_id: mgId,
        created_at: new Date().toISOString(),
      });
      // Every other destination in the dump, so the addendum's map matches.
      let n = 0;
      for (const d of replay?.destinations ?? []) {
        if (d === ownDest) continue;
        n++;
        if (d.type === 'channel' && d.channelType && d.platformId) {
          const id = `preview-mg-${n}`;
          await dbMod.createMessagingGroup({
            id,
            channel_type: d.channelType,
            platform_id: d.platformId,
            name: d.displayName ?? d.name,
            is_group: 0,
            unknown_sender_policy: 'strict',
            created_at: new Date().toISOString(),
          });
          await insertRaw(central, 'agent_destinations', {
            agent_group_id: group.id,
            local_name: d.name,
            target_type: 'channel',
            target_id: id,
            created_at: new Date().toISOString(),
          });
        } else if (d.type === 'agent') {
          const id = d.agentGroupId ?? `preview-agent-${n}`;
          await dbMod.createAgentGroup({
            id,
            name: d.displayName ?? d.name,
            folder: id,
            agent_provider: null,
            created_at: new Date().toISOString(),
          });
          await insertRaw(central, 'agent_destinations', {
            agent_group_id: group.id,
            local_name: d.name,
            target_type: 'agent',
            target_id: id,
            created_at: new Date().toISOString(),
          });
        }
      }
    }

    // ── Filesystem scaffold ──
    // initGroupFilesystem is the once-per-lifetime creation scaffold (also run
    // defensively at spawn); materializeContainerJson + resolveProviderContribution
    // + buildMounts below are the per-spawn steps, in spawn order.
    const providerHint = live?.configRow?.provider ?? null;
    await groupInit.initGroupFilesystem(group, { provider: providerHint, instructions: persona ?? undefined });
    const containerConfig = await containerConfigMod.materializeContainerJson(group.id);
    const runnerProvider = containerRunner.resolveProviderName(null, containerConfig.provider);

    // ── Session + scenario staging ──
    const senderId = `${mgChannel}:15551230000`;
    const text = args.message ?? defaultMessage(args.scenario);
    let session: Session;
    const notes: string[] = [];
    const chatContent = (t: string, sender: string, sid: string) => JSON.stringify({ text: t, sender, senderId: sid });
    const now = () => new Date().toISOString();

    if (args.scenario === 'task-fire') {
      // The exact writer behind `ncl tasks create`: series id, isolated task
      // session (thread system:tasks:<id>), content shape.
      const prepared = scheduling.prepareScheduledTask({
        name: 'preview-task',
        prompt: text,
        processAfter: now(),
        timezone: configMod.TIMEZONE,
      });
      const created = await scheduling.createScheduledTask(group.id, prepared);
      const full = await dbMod.getSession(created.session.id);
      if (!full) throw new Error('task session not found after create');
      session = full;
      notes.push(
        'Tasks run in an isolated per-series session (thread system:tasks:<seriesId>, no messaging group). The runner derives task mode from that thread id (getTaskSeriesId) and buildSystemPromptAddendum renders the task contract — explicit `to`, run-log summary — in the SYSTEM PROMPT, not in the task prompt (the pre-#3004 run-log directive appended to the prompt is gone; formatter.ts strips it from legacy rows).',
        'Tasks with a `script` run it BEFORE the agent wakes and inject scriptOutput into the <task> block (container/agent-runner/src/scheduling/task-script.ts); not staged here.',
      );
    } else {
      session = (await sessionManager.resolveSession(group.id, mgId, null, 'shared')).session;
    }

    const inboundPath = mailboxPaths.inboundDbPath(group.id, session.id);
    const outboundPath = mailboxPaths.outboundDbPath(group.id, session.id);
    const setContinuation = (value: string) => {
      // Keyed per provider — the poll loop looks up continuation:<provider
      // from container.json> (container/agent-runner/src/db/session-state.ts).
      const outb = sessionDb.openOutboundDbRw(outboundPath);
      outb
        .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run(`continuation:${runnerProvider}`, value, now());
      outb.close();
    };
    const markCompleted = (ids: string[]) => {
      if (ids.length === 0) return;
      const inb = sessionDb.openInboundDb(inboundPath);
      inb
        .prepare(`UPDATE messages_in SET status = 'completed' WHERE id IN (${ids.map(() => '?').join(',')})`)
        .run(...ids);
      inb.close();
    };

    let replayInfo: {
      file: string;
      turn: [number, number];
      staged: string[];
      history: string[];
      dropped: number;
    } | null = null;

    if (replay) {
      // Real rows, through the real host writer, in sequence order. Records
      // before the turn are history (already handled), the turn's records are
      // the pending batch, later records never happened yet.
      const last = replay.inbound[replay.inbound.length - 1].sequence;
      const turn = args.turn ?? [last, last];
      const history: string[] = [];
      const staged: string[] = [];
      let dropped = 0;
      for (const r of replay.inbound) {
        if (r.sequence > turn[1]) {
          dropped++;
          continue;
        }
        await sessionManager.writeSessionMessage(group.id, session.id, {
          id: r.id,
          kind: r.kind as Parameters<typeof sessionManager.writeSessionMessage>[2]['kind'],
          timestamp: r.timestamp,
          platformId: r.platformId,
          channelType: r.channelType,
          threadId: r.threadId,
          content: r.content,
          processAfter: r.processAfter ?? null,
          recurrence: r.recurrence ?? null,
          trigger: r.trigger ?? true,
          sourceSessionId: r.sourceSessionId ?? null,
          onWake: r.onWake ?? false,
        });
        (r.sequence < turn[0] ? history : staged).push(r.id);
      }
      if (staged.length === 0) fail(`--turn ${turn[0]}-${turn[1]} matches no inbound record in the dump`);
      markCompleted(history);
      // A resumed turn: the dump's stored continuation becomes the SDK resume.
      const cont = replay.state.find((s) => s.key === `continuation:${runnerProvider}`);
      if (history.length > 0 && cont) setContinuation(cont.value);
      replayInfo = { file: path.resolve(args.replay!), turn, staged, history, dropped };
      notes.push(
        `Replayed ${staged.length} real inbound row(s) as the pending batch (seq ${turn[0]}${turn[1] !== turn[0] ? `-${turn[1]}` : ''}); ${history.length} earlier row(s) staged as completed history, ${dropped} later row(s) dropped.`,
        history.length > 0 && cont
          ? `The dump's stored continuation (${cont.key}) is staged, so this renders as a resumed turn.`
          : 'No stored continuation applies to this turn: it renders as a fresh SDK conversation.',
      );
    } else {
      switch (args.scenario) {
        case 'first-message':
          await sessionManager.writeSessionMessage(group.id, session.id, {
            id: 'preview-1',
            kind: 'chat',
            timestamp: now(),
            platformId: mgPlatformId,
            channelType: mgChannel,
            threadId: null,
            content: chatContent(text, args.sender, senderId),
          });
          notes.push(
            'Fresh session: no continuation in session_state, so the SDK starts a new conversation (no `resume`).',
            'Content shape here is the minimal {text, sender, senderId} that e.g. the CLI channel writes; real adapters write richer content — the chat-sdk bridge adds author/replyTo/attachments (src/channels/chat-sdk-bridge.ts messageToInbound). Use --replay to render a real row.',
          );
          break;
        case 'followup': {
          await sessionManager.writeSessionMessage(group.id, session.id, {
            id: 'preview-prior',
            kind: 'chat',
            timestamp: now(),
            platformId: mgPlatformId,
            channelType: mgChannel,
            threadId: null,
            content: chatContent('An earlier message, already handled.', args.sender, senderId),
          });
          markCompleted(['preview-prior']);
          setContinuation('preview-continuation-id');
          await sessionManager.writeSessionMessage(group.id, session.id, {
            id: 'preview-2',
            kind: 'chat',
            timestamp: now(),
            platformId: mgPlatformId,
            channelType: mgChannel,
            threadId: null,
            content: chatContent(text, args.sender, senderId),
          });
          notes.push(
            `The stored continuation (outbound.db session_state, key continuation:${runnerProvider}) becomes the SDK \`resume\` option — the agent keeps its full prior conversation.`,
            'A message arriving while the container is mid-turn takes a different path: it is pushed into the open query via formatMessages (its own <context> header), not a new query. See container/agent-runner/src/poll-loop.ts processQuery.',
          );
          break;
        }
        case 'accumulate':
          for (let i = 1; i <= 3; i++) {
            await sessionManager.writeSessionMessage(group.id, session.id, {
              id: `preview-acc-${i}`,
              kind: 'chat',
              timestamp: now(),
              platformId: mgPlatformId,
              channelType: mgChannel,
              threadId: null,
              content: chatContent(
                `Group chatter #${i} the agent was not mentioned in.`,
                `Member ${i}`,
                `${mgChannel}:1555999000${i}`,
              ),
              trigger: false,
            });
          }
          await sessionManager.writeSessionMessage(group.id, session.id, {
            id: 'preview-mention',
            kind: 'chat',
            timestamp: now(),
            platformId: mgPlatformId,
            channelType: mgChannel,
            threadId: null,
            content: chatContent(text, args.sender, senderId),
          });
          notes.push(
            'trigger=0 rows are stored by the router under ignored_message_policy=accumulate (engage_mode mention/pattern) and do NOT wake the agent; when the trigger=1 mention lands, the most recent rows ride into the same prompt as ordinary <message> blocks — the batch cap (maxMessagesPerPrompt, mention included) bounds the total, and older accumulated rows fall out of the window. See src/router.ts + container/agent-runner/src/db/messages-in.ts.',
          );
          break;
        case 'task-fire':
          break; // staged above, through createScheduledTask
        case 'on-wake':
          // Exact payload restartAgentGroupContainers writes (src/container-restart.ts).
          await sessionManager.writeSessionMessage(group.id, session.id, {
            id: 'preview-wake',
            kind: 'chat',
            timestamp: now(),
            platformId: group.id,
            channelType: 'agent',
            threadId: null,
            content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
            onWake: true,
          });
          notes.push(
            "on_wake=1 rows are only visible to a fresh container's FIRST poll (container/agent-runner/src/db/messages-in.ts) — a dying container in its SIGTERM grace period can never steal them.",
            'Used by ncl groups restart --message and the self-mod apply flow (src/modules/self-mod/apply.ts).',
          );
          break;
        case 'a2a': {
          // A message from another agent group, as performAgentRoute writes it
          // (src/modules/agent-to-agent/agent-route.ts): content is the source's
          // verbatim {text}, channel_type='agent', platform_id=<source group id>.
          const parent: AgentGroup = {
            id: 'preview-parent',
            name: 'parent-agent',
            folder: 'preview-parent',
            agent_provider: null,
            created_at: now(),
          };
          await dbMod.createAgentGroup(parent);
          await insertRaw(central, 'agent_destinations', {
            agent_group_id: group.id,
            local_name: 'parent-agent',
            target_type: 'agent',
            target_id: parent.id,
            created_at: now(),
          });
          await sessionManager.writeSessionMessage(group.id, session.id, {
            id: 'preview-a2a',
            kind: 'chat',
            timestamp: now(),
            platformId: parent.id,
            channelType: 'agent',
            threadId: null,
            content: JSON.stringify({ text }),
            sourceSessionId: 'sess-parent-origin',
          });
          notes.push(
            'A2A content carries no sender field, so the block renders sender="Unknown" with from=<the local destination name for the source agent>. source_session_id is the return path for replies.',
            "If a message policy exists for this edge, the send is held for approval by the policy's approver first (routeAgentMessage in src/modules/agent-to-agent/agent-route.ts; message-gate.ts is the approve-side handler) — not simulated here.",
          );
          break;
        }
        case 'subagent':
          notes.push(
            'SDK-native subagents (Task tool / agent teams) run INSIDE the same container and the same provider query — there is no new NanoClaw session. They are enabled by the per-group settings.json (see ENVIRONMENT section) and by the Task/TaskOutput/TaskStop/TeamCreate/TeamDelete/SendMessage entries in the SDK allowedTools (see SDK OPTIONS).',
            "A subagent gets the same project doc (cwd /workspace/agent → composed CLAUDE.md), the same tools and MCP servers, but NOT the parent's conversation history — only the prompt the parent passes to Task.",
            'The other "agent spawns an agent" mechanism is create_agent (mcp__nanoclaw__create_agent): a full new agent group with its own container, workspace, and composed context — preview that with: context-preview first-message.',
          );
          break;
      }
    }

    // ── Destinations + routing into the inbound mailbox (same as every wake) ──
    await writeDestMod.writeDestinations(group.id, session.id);
    await sessionManager.writeSessionRouting(group.id, session.id);

    // ── Provider surfaces + mounts (side effects: skill links + project-doc composition) ──
    const { provider, contribution, surfaces } = await containerRunner.resolveProviderContribution(
      session,
      group,
      containerConfig,
    );
    const mounts = await containerRunner.buildMounts(group, session, containerConfig, provider, contribution, surfaces);

    // ── Container half: real poll loop under Bun ──
    const spec = {
      inboundDbPath: inboundPath,
      outboundDbPath: outboundPath,
      containerConfig: JSON.parse(fs.readFileSync(path.join(groupDir, 'container.json'), 'utf8')),
      // index.ts discovers these by scanning /workspace/extra/* — derive the
      // same set from the mount table so the SDK options match a real spawn.
      additionalDirectories: mounts.map((m) => m.containerPath).filter((p) => p.startsWith('/workspace/extra/')),
    };
    const specPath = path.join(sandbox, 'preview-spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec));
    let runner: {
      captured: boolean;
      prompt: string | null;
      continuation: string | null;
      systemPromptAddendum: string;
      sessionMode: { kind: string; taskId?: string };
      sdkOptions: Record<string, unknown> | null;
      mcpTools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
      provider: string;
      batch: Array<Record<string, unknown>>;
    };
    try {
      // Strip host-shell CLAUDE_* overrides — a real container's env is only
      // TZ + OneCLI vars (src/container-runner.ts buildContainerArgs), so e.g.
      // an exported CLAUDE_CODE_AUTO_COMPACT_WINDOW must not leak into the
      // rendered options. The heartbeat goes to the sandbox, never /workspace.
      const bunEnv: Record<string, string | undefined> = {
        ...process.env,
        TZ: configMod.TIMEZONE,
        NANOCLAW_HEARTBEAT_PATH: path.join(sandbox, '.heartbeat'),
      };
      for (const key of Object.keys(bunEnv)) {
        if (key.startsWith('CLAUDE_')) delete bunEnv[key];
      }
      const out = execFileSync(
        'bun',
        [path.join(REPO_ROOT, 'container', 'agent-runner', 'scripts', 'context-preview-runner.ts'), specPath],
        { env: bunEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
      );
      runner = JSON.parse(out);
    } catch (err) {
      const e = err as { stderr?: string; message?: string; code?: string };
      // Throw (not fail/exit) so the finally-cleanup removes the sandbox.
      if (e.code === 'ENOENT')
        throw new Error('bun not found on PATH — the container half of the preview runs under Bun.');
      throw new Error(`context-preview-runner failed:\n${e.stderr || e.message}`);
    }

    // ── Read back the composed surfaces ──
    // The composed project document is the read-only file mount nested on top
    // of the group dir — found from the real mount table, not by name.
    const docMount = mounts.find(
      (m) =>
        m.readonly &&
        path.dirname(m.hostPath) === groupDir &&
        fs.statSync(m.hostPath, { throwIfNoEntry: false })?.isFile(),
    );
    const docFile = docMount?.hostPath ?? path.join(groupDir, 'CLAUDE.md');
    const composed = fs.existsSync(docFile) ? fs.readFileSync(docFile, 'utf8') : '';
    // Section index: the composer's `# <name>` blocks (fenced code skipped),
    // with word counts — the same shape a pod-side `awk` over the file gives.
    const sections: Array<{ name: string; words: number }> = [];
    let fenced = false;
    for (const line of composed.split('\n')) {
      if (line.startsWith('```')) fenced = !fenced;
      if (!fenced && line.startsWith('# ')) sections.push({ name: line.slice(2), words: 0 });
      else if (sections.length > 0 && line.trim())
        sections[sections.length - 1].words += line.trim().split(/\s+/).length;
    }

    // Provider home (Claude: /home/node/.claude) — settings + skill links.
    const homeMount = mounts.find((m) => m.containerPath === '/home/node/.claude');
    const settingsFile = homeMount ? path.join(homeMount.hostPath, 'settings.json') : null;
    const settingsJson = settingsFile && fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '(none)';
    const skills: string[] = [];
    const skillsDir = homeMount ? path.join(homeMount.hostPath, 'skills') : null;
    if (skillsDir && fs.existsSync(skillsDir)) {
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        skills.push(
          entry.isSymbolicLink()
            ? `${entry.name} → ${fs.readlinkSync(path.join(skillsDir, entry.name))}`
            : `${entry.name} (group-private dir, template-stamped)`,
        );
      }
    }

    const result = {
      scenario: args.scenario,
      group: { id: group.id, name: group.name, folder: group.folder, provider, source: live ? 'live' : 'synthetic' },
      session: { id: session.id, thread_id: session.thread_id, messaging_group_id: session.messaging_group_id },
      replay: replayInfo,
      batch: runner.batch,
      mounts,
      settingsJson,
      skills,
      persona: {
        file: path.join(groupDir, groupPersona.PERSONA_PREPEND_FILE),
        source: args.personaFile ? path.resolve(args.personaFile) : live ? 'live group dir' : null,
        content: groupPersona.readGroupPersona(groupDir),
      },
      claudeMd: {
        containerPath: docMount?.containerPath ?? '/workspace/agent/CLAUDE.md',
        hostPath: docFile,
        sections,
        content: composed,
      },
      systemPrompt: {
        base: "Claude Code preset ({ type: 'preset', preset: 'claude_code' }) — the SDK's built-in system prompt",
        mode: runner.sessionMode,
        append: runner.systemPromptAddendum,
      },
      sdkOptions: runner.sdkOptions,
      mcpTools: runner.mcpTools,
      continuation: runner.continuation,
      prompt: runner.prompt,
      notes,
    };

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      render(result, args.section);
    }
  } finally {
    cleanup();
  }
}

function defaultMessage(scenario: Scenario): string {
  switch (scenario) {
    case 'followup':
      return 'And one more thing — can you also check the weather for tomorrow?';
    case 'accumulate':
      return '@preview can you summarize what everyone just said?';
    case 'task-fire':
      return 'Check the team calendar and flag any conflicts for today.';
    case 'on-wake':
      return 'Your install_packages request was applied. Verify that `jq --version` works and report the result to the user.';
    case 'a2a':
      return 'Parent agent here — please compile the weekly metrics and send them back to me.';
    default:
      return 'Hey, can you help me plan a birthday dinner for Saturday?';
  }
}

// ── Rendering ──

const HR = '─'.repeat(78);

function heading(title: string, provenance: string): string {
  return `\n${HR}\n  ${title}\n  ${provenance}\n${HR}`;
}

type Result = {
  scenario: string;
  group: { id: string; name: string; folder: string; provider: string; source: string };
  session: { id: string; thread_id: string | null; messaging_group_id: string | null };
  replay: { file: string; turn: [number, number]; staged: string[]; history: string[]; dropped: number } | null;
  batch: Array<Record<string, unknown>>;
  mounts: Array<{ hostPath: string; containerPath: string; readonly: boolean }>;
  settingsJson: string;
  skills: string[];
  persona: { file: string; source: string | null; content: string | null };
  claudeMd: {
    containerPath: string;
    hostPath: string;
    sections: Array<{ name: string; words: number }>;
    content: string;
  };
  systemPrompt: { base: string; mode: { kind: string; taskId?: string }; append: string };
  sdkOptions: Record<string, unknown> | null;
  mcpTools: Array<{ name: string; description?: string }>;
  continuation: string | null;
  prompt: string | null;
  notes: string[];
};

function render(r: Result, only?: string): void {
  const want = (name: string) => !only || only === name;
  const p = (s: string) => console.log(s);

  if (want('scenario')) {
    p(heading('SCENARIO', 'staged into a sandboxed session by scripts/context-preview.ts'));
    p(`  ${r.scenario} — agent group "${r.group.name}" (${r.group.source}), provider ${r.group.provider}`);
    p(
      `  session ${r.session.id}  thread=${r.session.thread_id ?? '-'}  messaging_group=${r.session.messaging_group_id ?? '- (system session)'}`,
    );
    if (r.replay) {
      p(`  replay ${r.replay.file}`);
      p(
        `    turn seq ${r.replay.turn[0]}${r.replay.turn[1] !== r.replay.turn[0] ? `-${r.replay.turn[1]}` : ''}: ${r.replay.staged.length} pending, ${r.replay.history.length} history, ${r.replay.dropped} dropped`,
      );
    }
    p('');
    p('  messages_in staged:');
    for (const m of r.batch) {
      p(
        `    seq=${m.seq} kind=${m.kind} trigger=${m.trigger} on_wake=${m.on_wake} status=${m.status} channel=${m.channel_type ?? '-'} id=${m.id}`,
      );
    }
  }

  if (want('environment')) {
    p(heading('CONTAINER ENVIRONMENT', 'src/container-runner.ts buildMounts() — exact mount table for this spawn'));
    for (const m of r.mounts) {
      p(`  ${m.containerPath}${m.readonly ? '  (ro)' : '  (rw)'}`);
      p(`    ← ${m.hostPath}`);
    }
    p('');
    p('  /home/node/.claude/settings.json (src/group-init.ts — SDK user settings):');
    p(indent(r.settingsJson, 4));
    p('  /home/node/.claude/skills/ (src/container-runner.ts syncSkillSymlinks + template-stamped dirs):');
    for (const s of r.skills) p(`    ${s}`);
    if (r.skills.length === 0) p('    (none)');
  }

  if (want('claude-md')) {
    p(
      heading(
        `PROJECT DOC — ${r.claudeMd.containerPath}`,
        'composed per spawn by src/project-doc-compose.ts composeGroupProjectDoc(); one flat file, no imports',
      ),
    );
    p(`  source file: ${r.claudeMd.hostPath}`);
    p(
      `  persona (${r.persona.file}): ${r.persona.content ? `${r.persona.content.split(/\s+/).length} words${r.persona.source ? ` from ${r.persona.source}` : ''}` : '(none)'}`,
    );
    p('  sections:');
    for (const s of r.claudeMd.sections) p(`    ${s.name}: ${s.words} words`);
    p('');
    p(indent(r.claudeMd.content.trimEnd() || '(empty)', 2));
  }

  if (want('system-prompt')) {
    p(
      heading(
        'SYSTEM PROMPT',
        'base: SDK preset; append: container/agent-runner/src/destinations.ts buildSystemPromptAddendum()',
      ),
    );
    p(`  base: ${r.systemPrompt.base}`);
    p(
      `  mode: ${r.systemPrompt.mode.kind}${r.systemPrompt.mode.taskId ? ` (task ${r.systemPrompt.mode.taskId})` : ''}`,
    );
    p('  append:');
    p(indent(r.systemPrompt.append, 4));
  }

  if (want('sdk-options')) {
    p(
      heading(
        'SDK OPTIONS',
        'container/agent-runner/src/providers/claude.ts buildQueryOptions() — exact options object',
      ),
    );
    p(indent(JSON.stringify(r.sdkOptions, null, 2), 2));
  }

  if (want('mcp-tools')) {
    p(heading('MCP TOOLS (mcp__nanoclaw__*)', 'container/agent-runner/src/mcp-tools/* — the registered tool surface'));
    for (const t of r.mcpTools) {
      p(`  ${t.name}`);
      if (t.description) p(indent(t.description.split('\n')[0], 6));
    }
  }

  if (want('prompt')) {
    p(heading('PROMPT', 'the exact string the poll loop hands the provider — captured from the real runPollLoop'));
    if (r.continuation) p(`  (SDK resume: ${r.continuation})\n`);
    p(indent(r.prompt ?? '(no query captured — no wake-eligible messages staged)', 2));
  }

  if (want('notes') && r.notes.length > 0) {
    p(heading('NOTES', 'scenario-specific caveats'));
    for (const n of r.notes) p(`  • ${n}`);
  }
  p('');
}

function indent(s: string, n: number): string {
  const pad = ' '.repeat(n);
  return s
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
