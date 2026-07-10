import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-cli-tasks',
    GROUPS_DIR: '/tmp/nanoclaw-test-cli-tasks/groups',
    TIMEZONE: 'UTC',
  };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-cli-tasks';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession, findSessionByAgentGroup, getSessionsByAgentGroup, taskThreadId } from '../../db/sessions.js';
import { countDueMessages } from '../../db/session-db.js';
import { inboundDbPath, initSessionFolder } from '../../session-manager.js';
import { dispatch } from '../dispatch.js';
import { formatTasksTable } from '../format-tasks.js';
import type { CallerContext } from '../frame.js';
import './tasks.js';
import '../commands/index.js'; // registers tasks-help for the help-topic test

function now(): string {
  return new Date().toISOString();
}

function createGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

function createChatSession(group: string, id: string): void {
  createSession({
    id,
    agent_group_id: group,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder(group, id);
}

function agentCtx(group = 'ag-1', session = 'chat-1'): CallerContext {
  return { caller: 'agent', agentGroupId: group, sessionId: session, messagingGroupId: 'mg-1' };
}

describe('tasks CLI resource', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createGroup('ag-1');
    createGroup('ag-2');
    createChatSession('ag-1', 'chat-1');
    createChatSession('ag-2', 'chat-2');
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('create writes the task into the group system session, not the caller chat session', async () => {
    const resp = await dispatch(
      {
        id: 'req-1',
        command: 'tasks-create',
        args: { prompt: 'send a briefing', process_after: '2026-01-15T09:00:00Z' },
      },
      agentCtx(),
    );

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    const created = resp.data as { series_id: string; session_id: string };
    expect(created.session_id).not.toBe('chat-1');

    // The task lands in its own isolated per-series session, not the chat session.
    const sessions = getSessionsByAgentGroup('ag-1');
    const taskSession = sessions.find((s) => s.id === created.session_id);
    expect(taskSession?.thread_id).toBe(taskThreadId(created.series_id));

    const chatDb = new Database(inboundDbPath('ag-1', 'chat-1'), { readonly: true });
    expect(chatDb.prepare("SELECT COUNT(*) AS count FROM messages_in WHERE kind = 'task'").get()).toEqual({
      count: 0,
    });
    chatDb.close();

    const systemDb = new Database(inboundDbPath('ag-1', created.session_id), { readonly: true });
    const row = systemDb.prepare("SELECT content FROM messages_in WHERE kind = 'task'").get() as { content: string };
    const content = JSON.parse(row.content);
    expect(content).toMatchObject({ originSessionId: 'chat-1' });
    expect(content.prompt).toContain('send a briefing');
    expect(content.prompt).toContain(`tasks/${created.series_id}.md`); // log-path hint injected
    systemDb.close();
  });

  it('tasks-list attaches a server-rendered human table (so the container agent gets it too)', async () => {
    await dispatch(
      {
        id: 'c',
        command: 'tasks-create',
        args: { prompt: 'x', name: 'briefing', process_after: '2999-01-01T00:00:00Z' },
      },
      agentCtx(),
    );
    const resp = await dispatch({ id: 'l', command: 'tasks-list', args: {} }, agentCtx());
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    // Red-on-delete guard for the dispatch wiring: the host renders format-tasks
    // once and ships it as `human`, so the Bun container prints the aligned
    // table instead of a raw column dump (it cannot import the host formatter).
    expect(resp.human).toBeDefined();
    expect(resp.human).toMatch(/SERIES\s+SCHEDULE\s+RUNS\s+FAILED\s+LAST RUN\s+NEXT RUN/);
    expect(resp.human).toContain('briefing-');
  });

  it('recurrence more frequent than 4x/day is refused with the quota warning', async () => {
    const resp = await dispatch(
      { id: 'c', command: 'tasks-create', args: { prompt: 'x', name: 'spam', recurrence: '*/2 * * * *' } },
      agentCtx(),
    );
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.message).toContain('this task has not been scheduled');
      expect(resp.error.message).toContain('ncl tasks create --help');
      expect(resp.error.message).toContain('--dangerously-override-recurrence-limit');
    }
  });

  it('exactly 4 fires/day passes; the override flag bypasses the limit', async () => {
    const four = await dispatch(
      { id: 'c4', command: 'tasks-create', args: { prompt: 'x', name: 'four', recurrence: '0 0,6,12,18 * * *' } },
      agentCtx(),
    );
    expect(four.ok).toBe(true);

    const overridden = await dispatch(
      {
        id: 'co',
        command: 'tasks-create',
        args: { prompt: 'x', name: 'fast', recurrence: '*/30 * * * *', dangerously_override_recurrence_limit: true },
      },
      agentCtx(),
    );
    expect(overridden.ok).toBe(true);
  });

  it('a --script gate exempts frequent recurrence — the sanctioned monitor pattern', async () => {
    const scripted = await dispatch(
      {
        id: 'cs',
        command: 'tasks-create',
        args: {
          prompt: 'triage queue',
          name: 'watch',
          recurrence: '*/10 * * * *',
          script: 'echo {"wakeAgent": false}',
        },
      },
      agentCtx(),
    );
    expect(scripted.ok).toBe(true);

    // update --recurrence on a task that already has a script: also exempt.
    if (!scripted.ok) return;
    const seriesId = (scripted.data as { series_id: string }).series_id;
    const upd = await dispatch(
      { id: 'us', command: 'tasks-update', args: { id: seriesId, recurrence: '*/5 * * * *' } },
      agentCtx(),
    );
    expect(upd.ok).toBe(true);

    // …but clearing the script in the same update re-arms the guard.
    const cleared = await dispatch(
      { id: 'uc', command: 'tasks-update', args: { id: seriesId, recurrence: '*/5 * * * *', script: 'none' } },
      agentCtx(),
    );
    expect(cleared.ok).toBe(false);
  });

  it('the limit also guards update --recurrence (no create-slow-then-update bypass)', async () => {
    const created = await dispatch(
      { id: 'c', command: 'tasks-create', args: { prompt: 'x', name: 'sneak', recurrence: '0 9 * * *' } },
      agentCtx(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const seriesId = (created.data as { series_id: string }).series_id;

    const upd = await dispatch(
      { id: 'u', command: 'tasks-update', args: { id: seriesId, recurrence: '* * * * *' } },
      agentCtx(),
    );
    expect(upd.ok).toBe(false);
    if (!upd.ok) expect(upd.error.message).toContain('this task has not been scheduled');
  });

  it('tasks create --help carries the script contract and the frequency-limit caveat', async () => {
    // --help and `tasks help create` render the same deep verb help.
    const resp = await dispatch({ id: 'h', command: 'tasks-create', args: { help: true } }, agentCtx());
    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const text = resp.data as string;
      expect(text).toContain('wakeAgent');
      expect(text).toContain('Frequency limit');
    }
  });

  it('agent-shared lookup skips the task system session', async () => {
    await dispatch(
      {
        id: 'req-1',
        command: 'tasks-create',
        args: { prompt: 'send a briefing', process_after: '2026-01-15T09:00:00Z' },
      },
      agentCtx(),
    );

    expect(findSessionByAgentGroup('ag-1')?.id).toBe('chat-1');
  });

  it('group-scoped agents cannot list tasks from another group session', async () => {
    const resp = await dispatch(
      { id: 'req-1', command: 'tasks-list', args: { session: 'chat-2' } },
      agentCtx('ag-1', 'chat-1'),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('handler-error');
      expect(resp.error.message).toContain('session not found');
    }
  });

  it('--name yields a short, readable, fs/thread-safe id', async () => {
    const r = await dispatch(
      {
        id: 'rn',
        command: 'tasks-create',
        args: { prompt: 'x', name: 'Morning Joke!!', process_after: '2999-01-01T00:00:00Z' },
      },
      agentCtx('ag-1', 'chat-1'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const id = (r.data as { series_id: string }).series_id;
    expect(id).toMatch(/^morning-joke-[0-9a-f]{4}$/);
    expect(id).toMatch(/^[a-z0-9-]+$/); // safe as thread suffix / filename / --id
  });

  it('no name yields a t-<hex> id', async () => {
    const r = await dispatch(
      { id: 'rnn', command: 'tasks-create', args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z' } },
      agentCtx('ag-1', 'chat-1'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as { series_id: string }).series_id).toMatch(/^t-[0-9a-f]{6}$/);
  });

  it('recurring create derives the first run from the cron grid when --process-after is omitted', async () => {
    const r = await dispatch(
      { id: 'rec', command: 'tasks-create', args: { prompt: 'x', name: 'nightly', recurrence: '0 9 * * 1-5' } },
      agentCtx('ag-1', 'chat-1'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const task = r.data as { process_after: string; recurrence: string };
    expect(task.recurrence).toBe('0 9 * * 1-5');
    // First fire snapped onto the cron grid (TIMEZONE=UTC in this suite).
    const firstRun = new Date(task.process_after);
    expect(Number.isNaN(firstRun.getTime())).toBe(false);
    expect(firstRun.getUTCHours()).toBe(9);
    expect(firstRun.getTime()).toBeGreaterThan(Date.now());
  });

  it('one-shot create still requires --process-after (nothing to derive it from)', async () => {
    const r = await dispatch(
      { id: 'os', command: 'tasks-create', args: { prompt: 'x', name: 'once' } },
      agentCtx('ag-1', 'chat-1'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('--process-after is required');
  });

  it('run queues an extra immediate occurrence without consuming the scheduled one', async () => {
    const created = await dispatch(
      {
        id: 'c',
        command: 'tasks-create',
        args: { prompt: 'x', name: 'pingable', process_after: '2999-01-01T00:00:00Z' },
      },
      agentCtx('ag-1', 'chat-1'),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { series_id, session_id } = created.data as { series_id: string; session_id: string };

    const run = await dispatch({ id: 'r', command: 'tasks-run', args: { id: series_id } }, agentCtx('ag-1', 'chat-1'));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const fired = run.data as { series_id: string; row_id: string; status: string };
    expect(fired.series_id).toBe(series_id);
    expect(fired.row_id).not.toBe(series_id);
    expect(fired.status).toBe('pending');

    const db = new Database(inboundDbPath('ag-1', session_id), { readonly: true });
    const pending = db
      .prepare(
        "SELECT id, recurrence, process_after FROM messages_in WHERE kind = 'task' AND status = 'pending' AND series_id = ?",
      )
      .all(series_id) as Array<{ id: string; recurrence: string | null; process_after: string }>;
    db.close();
    // Original scheduled row + the new run-now occurrence both still pending.
    expect(pending).toHaveLength(2);
    const runRow = pending.find((p) => p.id === fired.row_id);
    expect(runRow?.recurrence).toBeNull(); // never re-armed into a phantom series
    expect(new Date(runRow!.process_after).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('task object exposes origin_session_id and created_at', async () => {
    const r = await dispatch(
      {
        id: 'ro',
        command: 'tasks-create',
        args: { prompt: 'x', name: 'o', process_after: '2999-01-01T00:00:00Z' },
      },
      agentCtx('ag-1', 'chat-1'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { origin_session_id: string | null; created_at: string };
    expect(d.origin_session_id).toBe('chat-1'); // the session that created it
    expect(d.created_at).toBeTruthy();
  });

  it('each task gets its own isolated session, and list fans out across them', async () => {
    const a = await dispatch(
      { id: 'r-a', command: 'tasks-create', args: { prompt: 'task A', process_after: '2026-01-15T09:00:00Z' } },
      agentCtx('ag-1', 'chat-1'),
    );
    const b = await dispatch(
      { id: 'r-b', command: 'tasks-create', args: { prompt: 'task B', process_after: '2026-01-15T09:00:00Z' } },
      agentCtx('ag-1', 'chat-1'),
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const ta = a.data as { session_id: string; series_id: string };
    const tb = b.data as { session_id: string; series_id: string };

    // Distinct per-series sessions — not one shared system:tasks session.
    expect(ta.session_id).not.toBe(tb.session_id);

    // list (no --session) fans out across every task session in the group.
    const list = await dispatch({ id: 'r-l', command: 'tasks-list', args: {} }, agentCtx('ag-1', 'chat-1'));
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const ids = (list.data as Array<{ series_id: string }>).map((t) => t.series_id);
    expect(ids).toContain(ta.series_id);
    expect(ids).toContain(tb.series_id);
  });

  it('list enriches each series with run history (CronJob view)', async () => {
    const created = await dispatch(
      {
        id: 'r-agg',
        command: 'tasks-create',
        args: { prompt: 'brain digest', recurrence: '0 9 * * *', 'process-after': '2026-01-15T09:05:00Z' },
      },
      agentCtx('ag-1', 'chat-1'),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { session_id, series_id } = created.data as { session_id: string; series_id: string };

    // Seed three completed fires for this series into its own session inbound.db.
    const db = new Database(inboundDbPath('ag-1', session_id));
    const ins = db.prepare(
      'INSERT INTO messages_in (id, seq, timestamp, status, tries, kind, content, series_id, process_after) ' +
        "VALUES (?, ?, datetime('now'), 'completed', 0, 'task', '{}', ?, ?)",
    );
    ins.run('run-1', 100, series_id, '2026-01-15T09:02:00Z');
    ins.run('run-2', 102, series_id, '2026-01-15T09:03:00Z');
    ins.run('run-3', 104, series_id, '2026-01-15T09:04:00Z');
    db.close();

    const list = await dispatch({ id: 'r-agg-l', command: 'tasks-list', args: {} }, agentCtx('ag-1', 'chat-1'));
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const row = (list.data as Array<Record<string, unknown>>).find((t) => t.series_id === series_id);
    expect(row).toBeDefined();
    expect(row?.runs).toBe(3);
    expect(row?.last_run).toBe('2026-01-15T09:04:00Z'); // max completed process_after
    expect(String(row?.next_run)).toMatch(/^2026-01-15T09:05:00/); // the live pending occurrence
    expect(row?.schedule).toBe('0 9 * * *');
    expect(row?.log).toBe(`tasks/${series_id}.md`);
  });

  // The schedule→wake primitive without a container: a task created through the
  // real `ncl tasks create` path must land in the agent group's system session
  // AND be counted by the same due-message query the host sweep uses to decide a
  // wake. Goes red if trigger defaulting, system-session routing, or the due
  // predicate ever drift apart.
  describe('a due task makes the system session wakeable', () => {
    it('countDueMessages sees a past task and ignores a future one', async () => {
      const created = await dispatch(
        { id: 'r-due', command: 'tasks-create', args: { prompt: 'run me', 'process-after': '2020-01-01T00:00:00Z' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const systemId = (created.data as { session_id: string }).session_id;

      const dueDb = new Database(inboundDbPath('ag-1', systemId), { readonly: true });
      expect(countDueMessages(dueDb)).toBe(1); // host sweep would wake this session
      dueDb.close();

      // A far-future task in the same system session is not yet due.
      const future = await dispatch(
        { id: 'r-fut', command: 'tasks-create', args: { prompt: 'later', 'process-after': '2999-01-01T00:00:00Z' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(future.ok).toBe(true);

      const stillDb = new Database(inboundDbPath('ag-1', systemId), { readonly: true });
      expect(countDueMessages(stillDb)).toBe(1); // still just the one past task
      stillDb.close();
    });
  });

  describe('append-log', () => {
    const logFile = (folder: string, series: string) => `${TEST_DIR}/groups/${folder}/tasks/${series}.md`;

    it('writes a host-timestamped line to the run log and creates the file (explicit --id)', async () => {
      const resp = await dispatch(
        { id: 'al-1', command: 'tasks-append-log', args: { id: 'my-task-1', msg: 'did the thing; it worked' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(resp.ok).toBe(true);
      if (!resp.ok) return;
      const content = fs.readFileSync(logFile('ag-1', 'my-task-1'), 'utf8').trim();
      // Local-time stamp (formatLocalStamp): "YYYY-MM-DD HH:mm".
      expect(content).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} — did the thing; it worked$/);
    });

    it('derives the series from the caller task session when --id is omitted', async () => {
      const created = await dispatch(
        {
          id: 'al-c',
          command: 'tasks-create',
          args: { name: 'derive-me', prompt: 'x', 'process-after': '2999-01-01T00:00:00Z' },
        },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const { series_id, session_id } = created.data as { series_id: string; session_id: string };

      // The fire runs INSIDE that task session, so no --id is needed.
      const resp = await dispatch(
        { id: 'al-2', command: 'tasks-append-log', args: { msg: 'auto-derived run' } },
        agentCtx('ag-1', session_id),
      );
      expect(resp.ok).toBe(true);
      if (!resp.ok) return;
      expect((resp.data as { series: string }).series).toBe(series_id);
      expect(fs.readFileSync(logFile('ag-1', series_id), 'utf8')).toContain('auto-derived run');
    });

    it('requires --msg', async () => {
      const resp = await dispatch(
        { id: 'al-3', command: 'tasks-append-log', args: { id: 'my-task-1' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(resp.ok).toBe(false);
      if (!resp.ok) expect(resp.error.message).toContain('--msg is required');
    });

    it('errors when there is no --id and the caller is not in a task session', async () => {
      // chat-1 is a normal chat session, not system:tasks:* → nothing to derive.
      const resp = await dispatch(
        { id: 'al-4', command: 'tasks-append-log', args: { msg: 'orphan' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(resp.ok).toBe(false);
      if (!resp.ok) expect(resp.error.message).toMatch(/--id is required/);
    });
  });
});

describe('formatTasksTable', () => {
  const now = Date.parse('2026-01-15T09:05:30Z');
  const rows = [
    {
      series_id: 'task-5bbe082a-6298-4699',
      schedule: '* * * * *',
      runs: 7,
      failed_runs: 2,
      last_run: '2026-01-15T09:04:30Z',
      next_run: '2026-01-15T09:06:00Z',
      status: 'pending',
      log: 'tasks/task-5bbe082a.md',
      created_at: '2026-01-15T08:05:30Z', // 1h before now
      prompt: 'You are NanoClaw, wired into the company brain, your job this run is to read it',
    },
  ];

  it('renders an aligned table with run history', () => {
    const lines = formatTasksTable(rows, now).split('\n');
    expect(lines[0]).toMatch(/SERIES\s+SCHEDULE\s+RUNS\s+FAILED\s+LAST RUN\s+NEXT RUN\s+STATUS\s+AGE\s+PROMPT/);
    expect(lines[1]).toContain('1h'); // AGE column — created 1h ago
    expect(lines[1]).toContain('task-5bbe082a-6298-4699'); // FULL series id — copy-pasteable into `tasks get --id`
    expect(lines[1]).toContain('* * * * *');
    expect(lines[1]).toContain('1m ago'); // 09:04:30 vs 09:05:30
    expect(lines[1]).toContain('in 30s'); // 09:06:00 vs 09:05:30
    expect(lines[1]).toContain('…'); // prompt truncated
  });

  it('handles a never-fired series and an empty list', () => {
    expect(formatTasksTable([], now)).toBe('No tasks.');
    const oneShot = formatTasksTable(
      [
        {
          series_id: 'task-x',
          schedule: 'once',
          runs: 0,
          last_run: null,
          next_run: '2026-01-15T09:00:00Z',
          status: 'pending',
        },
      ],
      now,
    ).split('\n')[1];
    expect(oneShot).toContain('once');
    expect(oneShot).toMatch(/\bdue\b/); // next_run in the past → due
    expect(oneShot).toContain('-'); // last_run '-' (never fired)
  });
});

describe('deep verb help (ncl tasks help create)', () => {
  it('resolves through the dispatcher fallback and renders the full contract + examples', async () => {
    // Side-effect import mirrors the CLI server boot: registers <plural>-help.
    await import('../commands/index.js');
    const resp = await dispatch({ id: 'h1', command: 'tasks-help-create', args: {} }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const text = resp.data as string;
      expect(text).toContain('ncl tasks create');
      expect(text).toContain('wakeAgent'); // full multi-line script contract present
      expect(text).toContain('Examples:'); // examples block rendered
    }
  });

  it('rejects an unknown verb with a pointer back to resource help', async () => {
    await import('../commands/index.js');
    const resp = await dispatch({ id: 'h2', command: 'tasks-help-frobnicate', args: {} }, { caller: 'host' });
    expect(resp.ok).toBe(false);
  });
});
