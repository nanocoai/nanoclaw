import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-s3-scheduling',
    GROUPS_DIR: '/tmp/nanoclaw-test-s3-scheduling/groups',
    TIMEZONE: 'UTC',
    EGRESS_LOCKDOWN: false,
  };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext } from '../../cli/frame.js';
import '../../cli/resources/tasks.js';
import { wakeContainer } from '../../container-runner.js';
import { startHostSweep, stopHostSweep } from '../../host-sweep.js';
import { registerAgentMailbox, resetAgentMailboxForTesting } from '../../mailbox/index.js';
import { S3AgentMailbox } from './store.js';

const TEST_DIR = '/tmp/nanoclaw-test-s3-scheduling';
const GOVERNANCE_SCHEDULES_RESOURCE = fileURLToPath(
  new URL('../../cli/resources/schedules.ts', import.meta.url),
);

class MemoryS3 {
  readonly objects = new Map<string, { body: string; etag: string }>();
  private version = 0;

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    if (url.searchParams.has('list-type')) {
      const prefix = url.searchParams.get('prefix') ?? '';
      const contents = [...this.objects]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => `<Contents><Key>${key}</Key><ETag>${value.etag}</ETag></Contents>`)
        .join('');
      return new Response(`<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`);
    }

    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    const current = this.objects.get(key);
    if ((init.method ?? 'GET') === 'GET') {
      return current
        ? new Response(current.body, { headers: { etag: current.etag } })
        : new Response(null, { status: 404 });
    }

    const headers = new Headers(init.headers);
    if (headers.get('if-none-match') === '*' && current) {
      return new Response(null, { status: 412 });
    }
    if (headers.has('if-match') && headers.get('if-match') !== current?.etag) {
      return new Response(null, { status: 412 });
    }
    if (init.method === 'DELETE') {
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }

    const etag = `"v${++this.version}"`;
    this.objects.set(key, { body: String(init.body), etag });
    return new Response(null, { headers: { etag } });
  };
}

function agentContext(): CallerContext {
  return {
    caller: 'agent',
    agentGroupId: 'agent-1',
    sessionId: 'chat-1',
    messagingGroupId: 'messaging-1',
  };
}

describe('S3 mailbox task scheduling', () => {
  beforeEach(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = await initTestDb();
    await runMigrations(db);
    createAgentGroup({
      id: 'agent-1',
      name: 'Agent 1',
      folder: 'agent-1',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    const s3 = new MemoryS3();
    resetAgentMailboxForTesting();
    registerAgentMailbox(
      () =>
        new S3AgentMailbox(
          {
            bucket: 'mailboxes',
            prefix: 'tenant',
            endpoint: 'http://localhost:4566',
            region: 'us-east-1',
            accessKeyId: 'test',
            secretAccessKey: 'test',
          },
          s3,
        ),
    );
  });

  afterEach(() => {
    stopHostSweep();
    closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('persists a due ncl task in S3 and wakes its isolated task session', async () => {
    const created = await dispatch(
      {
        id: 'schedule-1',
        command: 'tasks-create',
        args: {
          name: 'mailbox-proof',
          prompt: 'write the mailbox proof',
          process_after: '2020-01-01T00:00:00Z',
        },
      },
      agentContext(),
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const task = created.data as { series_id: string; session_id: string };

    startHostSweep();

    await vi.waitFor(() => {
      expect(wakeContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: task.session_id,
          agent_group_id: 'agent-1',
        }),
      );
    });
    expect(task.series_id).toMatch(/^mailbox-proof-/);
  });

  it.skipIf(!fs.existsSync(GOVERNANCE_SCHEDULES_RESOURCE))(
    'exposes S3-backed tasks through the optional Governance schedules surface',
    async () => {
      await import(['..', '..', 'cli', 'resources', 'schedules.js'].join('/'));

      const created = await dispatch(
        {
          id: 'schedule-governance-1',
          command: 'tasks-create',
          args: {
            name: 'governance-mailbox-proof',
            prompt: 'prove the Governance schedules surface uses S3',
            process_after: '2030-01-01T00:00:00Z',
          },
        },
        agentContext(),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const task = created.data as { series_id: string };

      const listed = await dispatch(
        { id: 'schedule-governance-list', command: 'schedules-list', args: { group: 'agent-1' } },
        { caller: 'host' },
      );
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.data).toMatchObject({
        tasks: [expect.objectContaining({ series_id: task.series_id, status: 'pending' })],
      });

      const paused = await dispatch(
        {
          id: 'schedule-governance-pause',
          command: 'schedules-pause',
          args: { group: 'agent-1', task_id: task.series_id },
        },
        { caller: 'host' },
      );
      expect(paused).toMatchObject({ ok: true, data: { paused: task.series_id, rows: 1 } });

      const resumed = await dispatch(
        {
          id: 'schedule-governance-resume',
          command: 'schedules-resume',
          args: { group: 'agent-1', task_id: task.series_id },
        },
        { caller: 'host' },
      );
      expect(resumed).toMatchObject({ ok: true, data: { resumed: task.series_id, rows: 1 } });

      const cancelled = await dispatch(
        {
          id: 'schedule-governance-cancel',
          command: 'schedules-cancel',
          args: { group: 'agent-1', task_id: task.series_id },
        },
        { caller: 'host' },
      );
      expect(cancelled).toMatchObject({ ok: true, data: { cancelled: task.series_id, rows: 1 } });
    },
  );
});
