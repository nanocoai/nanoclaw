/**
 * scripts/context-preview.ts — render the exact context an agent sees.
 *
 * For maintainers: simulates a scenario (first message, scheduled task fire,
 * restart wake, agent-to-agent message, …) and prints every context surface
 * the agent would receive — the composed CLAUDE.md (imports expanded), the
 * runtime system-prompt addendum, the SDK options, the MCP tool list, and
 * the exact prompt string — using the REAL production code paths, so edits
 * to CLAUDE.md sources, the formatter, the composer, etc. are reflected
 * immediately. Nothing is duplicated and nothing in the live install is
 * touched: the whole run happens in a throwaway sandbox with an in-memory
 * central DB, and the container half runs the real poll loop under Bun
 * (container/agent-runner/scripts/context-preview-runner.ts).
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
 *   --group <folder|id>   Use a real agent group from data/v2.db (read-only
 *                         snapshot of its config, persona, memory, destinations).
 *                         Default: a synthetic group named "preview".
 *   --message <text>      User/task/wake message text.
 *   --sender <name>       Sender display name (default "Dana").
 *   --channel <type>      Channel type for the messaging group (default "whatsapp").
 *   --section <name>      Print one section: scenario|environment|claude-md|
 *                         system-prompt|sdk-options|mcp-tools|prompt|notes
 *   --json                Machine-readable output of everything.
 *   --keep                Keep the sandbox dir (path printed) for inspection.
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import type { AgentGroup, ContainerConfigRow, Session } from '../src/types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCENARIOS = ['first-message', 'followup', 'accumulate', 'task-fire', 'on-wake', 'a2a', 'subagent'] as const;
type Scenario = (typeof SCENARIOS)[number];

interface Args {
  scenario: Scenario;
  group?: string;
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
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--keep') args.keep = true;
    else if (a === '--group') args.group = argv[++i];
    else if (a === '--message') args.message = argv[++i];
    else if (a === '--sender') args.sender = argv[++i];
    else if (a === '--channel') args.channel = argv[++i];
    else if (a === '--section') args.section = argv[++i];
    else if (a.startsWith('--')) fail(`Unknown flag: ${a}`);
    else positional.push(a);
  }
  const SECTIONS = ['scenario', 'environment', 'claude-md', 'system-prompt', 'sdk-options', 'mcp-tools', 'prompt', 'notes'];
  if (args.section && !SECTIONS.includes(args.section)) {
    fail(`Unknown section "${args.section}". Sections: ${SECTIONS.join(', ')}`);
  }
  if (positional.length > 1) fail(`Expected one scenario, got: ${positional.join(' ')}`);
  if (positional[0]) {
    if (!SCENARIOS.includes(positional[0] as Scenario)) {
      fail(`Unknown scenario "${positional[0]}". Scenarios: ${SCENARIOS.join(', ')}`);
    }
    args.scenario = positional[0] as Scenario;
  }
  return args;
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
  if (!fs.existsSync(dbPath)) fail(`--group requires a live install (${dbPath} not found)`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const group = db
      .prepare('SELECT * FROM agent_groups WHERE folder = ? OR id = ?')
      .get(ref, ref) as AgentGroup | undefined;
    if (!group) {
      const known = (db.prepare('SELECT folder FROM agent_groups').all() as Array<{ folder: string }>)
        .map((r) => r.folder)
        .join(', ');
      fail(`Agent group "${ref}" not found. Known folders: ${known || '(none)'}`);
    }
    const configRow = db
      .prepare('SELECT * FROM container_configs WHERE agent_group_id = ?')
      .get(group.id) as ContainerConfigRow | undefined;
    const hasDest = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_destinations'")
      .get();
    const destinations = hasDest
      ? (db.prepare('SELECT * FROM agent_destinations WHERE agent_group_id = ?').all(group.id) as Array<
          Record<string, unknown>
        >)
      : [];
    // Messaging groups referenced by channel destinations (for routing rows).
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

/** Insert a raw row into the in-memory DB, keeping only columns that exist. */
function insertRaw(db: Database.Database, table: string, row: Record<string, unknown>): void {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  const keys = Object.keys(row).filter((k) => cols.has(k));
  db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`).run(
    Object.fromEntries(keys.map((k) => [k, row[k]])),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Keep stdout clean for the rendered preview — src/log.ts logs info to
  // stdout. Must be set before the first src import evaluates the threshold.
  if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'warn';

  // Live-group snapshot must be read BEFORE chdir (relative to real repo).
  const live = args.group ? snapshotLiveGroup(args.group) : null;

  // ── Sandbox ──
  // GROUPS_DIR / DATA_DIR resolve from process.cwd() at src/config.js import
  // time, and the composer discovers fragments under cwd/container/. Chdir
  // into a throwaway root (with container/ symlinked back to the repo) before
  // importing any src module, so every host-side write lands in the sandbox.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-context-preview-'));
  fs.mkdirSync(path.join(sandbox, 'groups'));
  fs.mkdirSync(path.join(sandbox, 'data'));
  fs.symlinkSync(path.join(REPO_ROOT, 'container'), path.join(sandbox, 'container'));
  // Carry over only the non-secret .env keys the preview actually renders
  // (identity + timezone). Never copy the whole file — the sandbox lives in
  // tmp and credentials (ONECLI_API_KEY etc.) must not leave the repo.
  const ENV_WHITELIST = new Set(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'TZ']);
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
    // Host modules — imported only now, with cwd = sandbox.
    const dbMod = await import('../src/db/index.js');
    const sessionManager = await import('../src/session-manager.js');
    const sessionDb = await import('../src/db/session-db.js');
    const groupInit = await import('../src/group-init.js');
    const containerConfigMod = await import('../src/container-config.js');
    const containerRunner = await import('../src/container-runner.js');
    const schedulingDb = await import('../src/modules/scheduling/db.js');
    const tasksResource = await import('../src/cli/resources/tasks.js');
    const writeDestMod = await import('../src/modules/agent-to-agent/write-destinations.js');
    const configMod = await import('../src/config.js');

    const central = dbMod.initTestDb();
    dbMod.runMigrations(central);

    // ── Seed the agent group ──
    let group: AgentGroup;
    if (live) {
      group = live.group;
      insertRaw(central, 'agent_groups', group as unknown as Record<string, unknown>);
      if (live.configRow) insertRaw(central, 'container_configs', live.configRow as unknown as Record<string, unknown>);
      for (const mg of live.messagingGroups) insertRaw(central, 'messaging_groups', mg);
      for (const ag of live.targetAgentGroups) insertRaw(central, 'agent_groups', ag);
      for (const d of live.destinations) insertRaw(central, 'agent_destinations', d);
      // Copy the group's real files (persona, memory, template extras) so the
      // composed doc and CLAUDE.local.md match the install. The composed
      // CLAUDE.md/.claude-fragments get regenerated in the sandbox anyway.
      const liveGroupDir = path.join(REPO_ROOT, 'groups', group.folder);
      if (fs.existsSync(liveGroupDir)) {
        fs.cpSync(liveGroupDir, path.join(sandbox, 'groups', group.folder), { recursive: true });
      }
      // Per-group real skill dirs + settings live under data/v2-sessions/<id>/.claude-shared.
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
      dbMod.createAgentGroup(group);
    }

    // Messaging group for chat scenarios (synthetic mode, or when the live
    // group has no channel destination to reuse).
    const liveMg = live?.messagingGroups[0] as { id?: string; channel_type?: string; platform_id?: string } | undefined;
    let mgId: string;
    let mgChannel: string;
    let mgPlatformId: string;
    if (liveMg?.id) {
      mgId = liveMg.id;
      mgChannel = liveMg.channel_type as string;
      mgPlatformId = liveMg.platform_id as string;
    } else {
      mgId = 'preview-mg';
      mgChannel = args.channel;
      mgPlatformId = args.scenario === 'accumulate' ? 'preview-group-chat' : 'preview-dm';
      dbMod.createMessagingGroup({
        id: mgId,
        channel_type: mgChannel,
        platform_id: mgPlatformId,
        name: args.scenario === 'accumulate' ? 'Preview Group Chat' : 'Preview DM',
        is_group: args.scenario === 'accumulate' ? 1 : 0,
        unknown_sender_policy: 'strict',
        created_at: new Date().toISOString(),
      });
      // Destination row so the addendum + originAttr resolve a name for the
      // channel — mirrors what /init-first-agent and /manage-channels create.
      insertRaw(central, 'agent_destinations', {
        agent_group_id: group.id,
        local_name: `${mgChannel}-main`,
        target_type: 'channel',
        target_id: mgId,
        created_at: new Date().toISOString(),
      });
    }

    // ── Filesystem scaffold ──
    // initGroupFilesystem is the once-per-lifetime creation scaffold (also run
    // defensively at spawn); materializeContainerJson + buildMounts below are
    // the per-spawn steps. Pass the provider so surfaces-owning providers skip
    // the CLAUDE.local.md scaffold exactly as production does (group-init.ts).
    groupInit.initGroupFilesystem(group, { provider: live?.configRow?.provider ?? null });
    const containerConfig = containerConfigMod.materializeContainerJson(group.id);
    const runnerProvider = (containerConfig.provider || 'claude').toLowerCase();

    // ── Session + scenario staging ──
    const senderId = `${mgChannel}:15551230000`;
    const text = args.message ?? defaultMessage(args.scenario);
    let session: Session;
    const notes: string[] = [];

    if (args.scenario === 'task-fire') {
      session = sessionManager.resolveTaskSession(group.id, 'preview-task').session;
    } else {
      session = sessionManager.resolveSession(group.id, mgId, null, 'shared').session;
    }

    const chatContent = (t: string, sender: string, sid: string) => JSON.stringify({ text: t, sender, senderId: sid });
    const now = () => new Date().toISOString();

    switch (args.scenario) {
      case 'first-message':
        sessionManager.writeSessionMessage(group.id, session.id, {
          id: 'preview-1', kind: 'chat', timestamp: now(),
          platformId: mgPlatformId, channelType: mgChannel, threadId: null,
          content: chatContent(text, args.sender, senderId),
          processAfter: null, recurrence: null,
        });
        notes.push(
          'Fresh session: no continuation in session_state, so the SDK starts a new conversation (no `resume`).',
          'Content shape here is the minimal {text, sender, senderId} that e.g. the CLI channel writes; real adapters write richer content — the chat-sdk bridge adds author/replyTo/attachments (src/channels/chat-sdk-bridge.ts messageToInbound), and native adapters (WhatsApp, Signal, …) populate equivalent fields directly.',
        );
        break;
      case 'followup': {
        // A prior completed turn + a stored continuation → the SDK resumes.
        sessionManager.writeSessionMessage(group.id, session.id, {
          id: 'preview-prior', kind: 'chat', timestamp: now(),
          platformId: mgPlatformId, channelType: mgChannel, threadId: null,
          content: chatContent('An earlier message, already handled.', args.sender, senderId),
          processAfter: null, recurrence: null,
        });
        const inb = sessionDb.openInboundDb(sessionManager.inboundDbPath(group.id, session.id));
        inb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'preview-prior'").run();
        inb.close();
        // Keyed per provider — the poll loop looks up continuation:<provider
        // from container.json> (container/agent-runner/src/db/session-state.ts).
        const outb = sessionDb.openOutboundDbRw(sessionManager.outboundDbPath(group.id, session.id));
        outb
          .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
          .run(`continuation:${runnerProvider}`, 'preview-continuation-id', now());
        outb.close();
        sessionManager.writeSessionMessage(group.id, session.id, {
          id: 'preview-2', kind: 'chat', timestamp: now(),
          platformId: mgPlatformId, channelType: mgChannel, threadId: null,
          content: chatContent(text, args.sender, senderId),
          processAfter: null, recurrence: null,
        });
        notes.push(
          'The stored continuation (outbound.db session_state, key continuation:claude) becomes the SDK `resume` option — the agent keeps its full prior conversation.',
          'A message arriving while the container is mid-turn takes a different path: it is pushed into the open query via formatMessages (its own <context> header), not a new query. See container/agent-runner/src/poll-loop.ts processQuery.',
        );
        break;
      }
      case 'accumulate':
        for (let i = 1; i <= 3; i++) {
          sessionManager.writeSessionMessage(group.id, session.id, {
            id: `preview-acc-${i}`, kind: 'chat', timestamp: now(),
            platformId: mgPlatformId, channelType: mgChannel, threadId: null,
            content: chatContent(`Group chatter #${i} the agent was not mentioned in.`, `Member ${i}`, `${mgChannel}:1555999000${i}`),
            processAfter: null, recurrence: null,
            trigger: 0,
          });
        }
        sessionManager.writeSessionMessage(group.id, session.id, {
          id: 'preview-mention', kind: 'chat', timestamp: now(),
          platformId: mgPlatformId, channelType: mgChannel, threadId: null,
          content: chatContent(text, args.sender, senderId),
          processAfter: null, recurrence: null,
        });
        notes.push(
          'trigger=0 rows are stored by the router under ignored_message_policy=accumulate (engage_mode mention/pattern) and do NOT wake the agent; when the trigger=1 mention lands, the most recent rows ride into the same prompt as ordinary <message> blocks — the batch cap (maxMessagesPerPrompt, mention included) bounds the total, and older accumulated rows fall out of the window. See src/router.ts + container/agent-runner/src/db/messages-in.ts.',
        );
        break;
      case 'task-fire': {
        const inb = sessionDb.openInboundDb(sessionManager.inboundDbPath(group.id, session.id));
        schedulingDb.insertTaskRow(inb, {
          id: 'preview-task', seriesId: 'preview-task',
          processAfter: null, recurrence: null,
          content: JSON.stringify({
            prompt: tasksResource.taskPromptWithLog(text, 'preview-task'),
            script: null,
            originSessionId: null,
          }),
        });
        inb.close();
        notes.push(
          'Tasks run in an isolated per-series session (thread system:tasks:<seriesId>, no messaging group) — the destinations addendum is the ONLY way a task run can reach the user, which is why the appended run-log directive insists on explicit <message to>.',
          'Tasks with a `script` run it BEFORE the agent wakes and inject scriptOutput into the <task> block (container/agent-runner/src/scheduling/task-script.ts); not staged here.',
        );
        break;
      }
      case 'on-wake':
        // Exact payload restartAgentGroupContainers writes (src/container-restart.ts).
        sessionManager.writeSessionMessage(group.id, session.id, {
          id: 'preview-wake', kind: 'chat', timestamp: now(),
          platformId: group.id, channelType: 'agent', threadId: null,
          content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
          processAfter: null, recurrence: null,
          onWake: 1,
        });
        notes.push(
          'on_wake=1 rows are only visible to a fresh container\'s FIRST poll (container/agent-runner/src/db/messages-in.ts) — a dying container in its SIGTERM grace period can never steal them.',
          'Used by ncl groups restart --message and the self-mod apply flow (src/modules/self-mod/apply.ts).',
        );
        break;
      case 'a2a': {
        // A message from another agent group, as performAgentRoute writes it
        // (src/modules/agent-to-agent/agent-route.ts): content is the source's
        // verbatim {text}, channel_type='agent', platform_id=<source group id>.
        const parent: AgentGroup = {
          id: 'preview-parent', name: 'parent-agent', folder: 'preview-parent',
          agent_provider: null, created_at: now(),
        };
        dbMod.createAgentGroup(parent);
        insertRaw(central, 'agent_destinations', {
          agent_group_id: group.id, local_name: 'parent-agent',
          target_type: 'agent', target_id: parent.id, created_at: now(),
        });
        sessionManager.writeSessionMessage(group.id, session.id, {
          id: 'preview-a2a', kind: 'chat', timestamp: now(),
          platformId: parent.id, channelType: 'agent', threadId: null,
          content: JSON.stringify({ text }),
          processAfter: null, recurrence: null,
          sourceSessionId: 'sess-parent-origin',
        });
        notes.push(
          'A2A content carries no sender field, so the block renders sender="Unknown" with from=<the local destination name for the source agent>. source_session_id is the return path for replies.',
          'If a message policy exists for this edge, the send is held for approval by the policy\'s approver first (routeAgentMessage in src/modules/agent-to-agent/agent-route.ts; message-gate.ts is the approve-side handler) — not simulated here.',
        );
        break;
      }
      case 'subagent':
        notes.push(
          'SDK-native subagents (Task tool / agent teams) run INSIDE the same container and the same provider query — there is no new NanoClaw session. They are enabled by CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 in the per-group settings.json (see ENVIRONMENT section) and by Task/TaskOutput/TaskStop/TeamCreate/TeamDelete/SendMessage in the SDK allowedTools (see SDK OPTIONS).',
          'A subagent gets the same project doc (cwd /workspace/agent → composed CLAUDE.md + CLAUDE.local.md), the same tools and MCP servers, but NOT the parent\'s conversation history — only the prompt the parent passes to Task.',
          'The other "agent spawns an agent" mechanism is create_agent (mcp__nanoclaw__create_agent): a full new agent group with its own container, workspace, and composed context — preview that with: context-preview first-message.',
        );
        break;
    }

    // ── Destinations + routing into inbound.db (same as every wake) ──
    sessionManager.writeSessionRouting(group.id, session.id);
    writeDestMod.writeDestinations(group.id, session.id);

    // ── Mounts (side effects: skill symlink sync + CLAUDE.md composition) ──
    const provider = containerRunner.resolveProviderName(session.agent_provider, containerConfig.provider);
    const mounts = containerRunner.buildMounts(group, session, containerConfig, provider, {});

    // ── Container half: real poll loop under Bun ──
    const spec = {
      inboundDbPath: sessionManager.inboundDbPath(group.id, session.id),
      outboundDbPath: sessionManager.outboundDbPath(group.id, session.id),
      containerConfig: JSON.parse(
        fs.readFileSync(path.join(sandbox, 'groups', group.folder, 'container.json'), 'utf8'),
      ),
      // index.ts discovers these by scanning /workspace/extra/* — derive the
      // same set from the mount table so the SDK options match a real spawn.
      additionalDirectories: mounts
        .map((m) => m.containerPath)
        .filter((p) => p.startsWith('/workspace/extra/')),
    };
    const specPath = path.join(sandbox, 'preview-spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec));
    let runner: {
      captured: boolean;
      prompt: string | null;
      continuation: string | null;
      systemPromptAddendum: string;
      sdkOptions: Record<string, unknown> | null;
      mcpTools: Array<{ name: string; description?: string }>;
      provider: string;
      batch: Array<Record<string, unknown>>;
    };
    try {
      // Strip host-shell CLAUDE_* overrides — a real container's env is only
      // TZ + OneCLI vars (src/container-runner.ts buildContainerArgs), so e.g.
      // an exported CLAUDE_CODE_AUTO_COMPACT_WINDOW must not leak into the
      // rendered options.
      const bunEnv: Record<string, string | undefined> = { ...process.env, TZ: configMod.TIMEZONE };
      for (const key of Object.keys(bunEnv)) {
        if (key.startsWith('CLAUDE_')) delete bunEnv[key];
      }
      const out = execFileSync('bun', [path.join(REPO_ROOT, 'container', 'agent-runner', 'scripts', 'context-preview-runner.ts'), specPath], {
        env: bunEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      });
      runner = JSON.parse(out);
    } catch (err) {
      const e = err as { stderr?: string; message?: string; code?: string };
      // Throw (not fail/exit) so the finally-cleanup removes the sandbox.
      if (e.code === 'ENOENT') throw new Error('bun not found on PATH — the container half of the preview runs under Bun.');
      throw new Error(`context-preview-runner failed:\n${e.stderr || e.message}`);
    }

    // ── Read back the composed surfaces ──
    const groupDir = path.join(sandbox, 'groups', group.folder);
    const containerToHost = mounts
      .map((m) => ({ containerPath: m.containerPath, hostPath: m.hostPath }))
      .sort((a, b) => b.containerPath.length - a.containerPath.length);
    const resolveContainerPath = (p: string): string | null => {
      for (const m of containerToHost) {
        if (p === m.containerPath || p.startsWith(m.containerPath + '/')) {
          return path.join(m.hostPath, p.slice(m.containerPath.length));
        }
      }
      return null;
    };

    const composedEntry = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf8');
    const claudeMdParts: Array<{ import: string; source: string; content: string }> = [];
    for (const line of composedEntry.split('\n')) {
      if (!line.startsWith('@')) continue;
      const rel = line.slice(1);
      const abs = path.resolve(groupDir, rel);
      let hostFile = abs;
      let sourceLabel = rel;
      const lst = fs.lstatSync(abs, { throwIfNoEntry: false });
      if (lst?.isSymbolicLink()) {
        const target = fs.readlinkSync(abs); // container path (dangling on host)
        const mapped = resolveContainerPath(target);
        if (!mapped) {
          claudeMdParts.push({ import: line, source: `${target} (unresolvable — no mount)`, content: '' });
          continue;
        }
        hostFile = mapped;
        // Realpath through the sandbox's container/ symlink so the label
        // points at the repo file the content actually comes from.
        const real = fs.existsSync(mapped) ? fs.realpathSync(mapped) : mapped;
        sourceLabel = `${target} → ${path.relative(REPO_ROOT, real)}`;
      }
      claudeMdParts.push({
        import: line,
        source: sourceLabel,
        content: fs.existsSync(hostFile) ? fs.readFileSync(hostFile, 'utf8') : '(missing)',
      });
    }
    const claudeLocal = fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))
      ? fs.readFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'utf8')
      : '';

    const claudeSharedDir = path.join(sandbox, 'data', 'v2-sessions', group.id, '.claude-shared');
    const settingsJson = fs.existsSync(path.join(claudeSharedDir, 'settings.json'))
      ? fs.readFileSync(path.join(claudeSharedDir, 'settings.json'), 'utf8')
      : '(none)';
    const skillsDir = path.join(claudeSharedDir, 'skills');
    const skills: string[] = [];
    if (fs.existsSync(skillsDir)) {
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) {
          skills.push(`${entry.name} → ${fs.readlinkSync(path.join(skillsDir, entry.name))}`);
        } else {
          skills.push(`${entry.name} (group-private dir, template-stamped)`);
        }
      }
    }

    const result = {
      scenario: args.scenario,
      group: { id: group.id, name: group.name, folder: group.folder, provider, source: live ? 'live' : 'synthetic' },
      session: { id: session.id, thread_id: session.thread_id, messaging_group_id: session.messaging_group_id },
      batch: runner.batch,
      mounts,
      settingsJson,
      skills,
      claudeMd: { entry: composedEntry, parts: claudeMdParts, local: claudeLocal },
      systemPrompt: {
        base: "Claude Code preset ({ type: 'preset', preset: 'claude_code' }) — the SDK's built-in system prompt",
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
    case 'followup': return 'And one more thing — can you also check the weather for tomorrow?';
    case 'accumulate': return '@preview can you summarize what everyone just said?';
    case 'task-fire': return 'Check the team calendar and flag any conflicts for today.';
    case 'on-wake': return 'Your install_packages request was applied. Verify that `jq --version` works and report the result to the user.';
    case 'a2a': return 'Parent agent here — please compile the weekly metrics and send them back to me.';
    default: return 'Hey, can you help me plan a birthday dinner for Saturday?';
  }
}

// ── Rendering ──

const HR = '─'.repeat(78);

function heading(title: string, provenance: string): string {
  return `\n${HR}\n  ${title}\n  ${provenance}\n${HR}`;
}

function render(r: {
  scenario: string;
  group: { id: string; name: string; folder: string; provider: string; source: string };
  session: { id: string; thread_id: string | null; messaging_group_id: string | null };
  batch: Array<Record<string, unknown>>;
  mounts: Array<{ hostPath: string; containerPath: string; readonly: boolean }>;
  settingsJson: string;
  skills: string[];
  claudeMd: { entry: string; parts: Array<{ import: string; source: string; content: string }>; local: string };
  systemPrompt: { base: string; append: string };
  sdkOptions: Record<string, unknown> | null;
  mcpTools: Array<{ name: string; description?: string }>;
  continuation: string | null;
  prompt: string | null;
  notes: string[];
}, only?: string): void {
  const want = (name: string) => !only || only === name;
  const p = (s: string) => console.log(s);

  if (want('scenario')) {
    p(heading('SCENARIO', 'staged into a sandboxed session by scripts/context-preview.ts'));
    p(`  ${r.scenario} — agent group "${r.group.name}" (${r.group.source}), provider ${r.group.provider}`);
    p(`  session ${r.session.id}  thread=${r.session.thread_id ?? '-'}  messaging_group=${r.session.messaging_group_id ?? '- (system session)'}`);
    p('');
    p('  messages_in staged:');
    for (const m of r.batch) {
      p(`    seq=${m.seq} kind=${m.kind} trigger=${m.trigger} on_wake=${m.on_wake} status=${m.status} channel=${m.channel_type ?? '-'}`);
    }
  }

  if (want('environment')) {
    p(heading('CONTAINER ENVIRONMENT', 'src/container-runner.ts buildMounts() — exact mount table for this spawn'));
    for (const m of r.mounts) {
      p(`  ${m.containerPath}${m.readonly ? '  (ro)' : '  (rw)'}`);
      p(`    ← ${m.hostPath}`);
    }
    p('');
    p('  /home/node/.claude/settings.json (src/group-init.ts — SDK user settings; enables agent teams + PreCompact hook):');
    p(indent(r.settingsJson, 4));
    p('  /home/node/.claude/skills/ (src/container-runner.ts syncSkillSymlinks + template-stamped dirs):');
    for (const s of r.skills) p(`    ${s}`);
    if (r.skills.length === 0) p('    (none)');
  }

  if (want('claude-md')) {
    p(heading('PROJECT DOC — /workspace/agent/CLAUDE.md', 'composed per spawn by src/claude-md-compose.ts; @-imports expanded by Claude Code in-container'));
    p(indent(r.claudeMd.entry.trimEnd(), 2));
    for (const part of r.claudeMd.parts) {
      p(`\n  ┌─ ${part.import}`);
      p(`  │  source: ${part.source}`);
      p('  └─');
      p(indent(part.content.trimEnd(), 4));
    }
    p('\n  ┌─ CLAUDE.local.md (per-group memory, settingSources "local", RW for the agent)');
    p('  └─');
    p(indent(r.claudeMd.local.trimEnd() || '(empty)', 4));
  }

  if (want('system-prompt')) {
    p(heading('SYSTEM PROMPT', 'base: SDK preset; append: container/agent-runner/src/destinations.ts buildSystemPromptAddendum()'));
    p(`  base: ${r.systemPrompt.base}`);
    p('  append:');
    p(indent(r.systemPrompt.append, 4));
  }

  if (want('sdk-options')) {
    p(heading('SDK OPTIONS', 'container/agent-runner/src/providers/claude.ts buildQueryOptions() — exact options object'));
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
