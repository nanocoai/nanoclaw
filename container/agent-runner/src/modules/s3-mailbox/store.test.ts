import { describe, expect, test } from 'bun:test';
import type { MailboxRecordByKind, MailboxRecordKind } from '../../mailbox/model.generated.js';
import { parseIsoTimestamp } from '../../mailbox/model.generated.js';
import { nextMailboxSyncDelay, S3AgentMailbox } from './store.js';

const capability = 'a'.repeat(64);
const key = {
  agentGroupId: 'agent',
  sessionId: 'session',
  mailbox: { capability },
};
const options = {
  endpoint: 'https://s3.us-east-1.amazonaws.com',
  bucket: 'mailboxes',
  prefix: 'tenant',
  region: 'us-east-1',
};
const sessionPrefix = `tenant/v2/agent-groups/agent/sessions/session/capabilities/${capability}`;

function envelope<K extends MailboxRecordKind>(recordType: K, record: MailboxRecordByKind[K]) {
  return { modelVersion: 1, recordType, record };
}

class MemoryS3 {
  readonly objects = new Map<string, { body: string; etag: string }>();
  readonly requestedKeys: string[] = [];
  rejectConditionalDeletes = false;
  private version = 0;

  put(key: string, body: unknown): void {
    this.objects.set(key, {
      body: JSON.stringify(body),
      etag: `"v${++this.version}"`,
    });
  }

  putRecord<K extends MailboxRecordKind>(key: string, type: K, record: MailboxRecordByKind[K]): void {
    this.put(key, envelope(type, record));
  }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    if (url.searchParams.has('list-type')) {
      const prefix = url.searchParams.get('prefix') ?? '';
      this.requestedKeys.push(prefix);
      const contents = [...this.objects]
        .filter(([objectKey]) => objectKey.startsWith(prefix))
        .map(([objectKey, value]) => `<Contents><Key>${objectKey}</Key><ETag>${value.etag}</ETag></Contents>`)
        .join('');
      return new Response(`<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`);
    }
    const objectKey = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    this.requestedKeys.push(objectKey);
    const current = this.objects.get(objectKey);
    if ((init.method ?? 'GET') === 'GET')
      return current
        ? new Response(current.body, { headers: { etag: current.etag } })
        : new Response(null, { status: 404 });
    const headers = new Headers(init.headers);
    if (headers.get('if-none-match') === '*' && current) return new Response(null, { status: 412 });
    if (init.method === 'DELETE' && headers.has('if-match') && this.rejectConditionalDeletes)
      return new Response(null, { status: 501 });
    if (headers.has('if-match') && headers.get('if-match') !== current?.etag)
      return new Response(null, { status: 412 });
    if (init.method === 'DELETE') {
      this.objects.delete(objectKey);
      return new Response(null, { status: 204 });
    }
    const etag = `"v${++this.version}"`;
    this.objects.set(objectKey, { body: String(init.body), etag });
    return new Response(null, { headers: { etag } });
  };
}

function inboundMessage(id: string, sequence: number, content = '{"text":"hello"}') {
  return {
    id,
    sequence,
    kind: 'chat',
    timestamp: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    processAfter: null,
    recurrence: null,
    seriesId: id,
    tries: 0,
    trigger: true,
    platformId: 'U1',
    channelType: 'slack',
    threadId: null,
    content,
    sourceSessionId: null,
    onWake: false,
  };
}

describe('S3AgentMailbox', () => {
  test('backs unchanged polling off to a bounded ceiling and resets on activity', () => {
    const timing = { minMs: 500, maxMs: 5_000 };
    expect(nextMailboxSyncDelay(500, false, timing)).toBe(1_000);
    expect(nextMailboxSyncDelay(1_000, false, timing)).toBe(2_000);
    expect(nextMailboxSyncDelay(4_000, false, timing)).toBe(5_000);
    expect(nextMailboxSyncDelay(5_000, false, timing)).toBe(5_000);
    expect(nextMailboxSyncDelay(5_000, true, timing)).toBe(500);
  });

  test('keeps idle S3 listings inside the adaptive request budget', async () => {
    const s3 = new MemoryS3();
    const store = new S3AgentMailbox(options, s3, { minMs: 10, maxMs: 40 });
    await store.start(key);
    s3.requestedKeys.length = 0;
    await Bun.sleep(120);
    await store.stop();

    const lists = s3.requestedKeys.filter((request) => request.endsWith('/inbound/') || request.endsWith('/outbound/'));
    // 10ms -> 20ms -> 40ms -> 40ms, two side listings each, plus stop's
    // final two. A fixed 10ms loop would exceed twenty list calls here.
    expect(lists.length).toBeLessThanOrEqual(12);
  });

  test('flushes local mutations without re-listing both S3 sides', async () => {
    const s3 = new MemoryS3();
    const store = new S3AgentMailbox(options, s3, { minMs: 60_000, maxMs: 60_000 });
    await store.start(key);
    s3.requestedKeys.length = 0;

    store.operations.setState('continuation', 'one');
    store.operations.setState('continuation', 'two');
    store.operations.markMessages(['message-1'], 'processing');
    await store.stop();

    expect(s3.requestedKeys.some((request) => request.endsWith('/outbound/state/continuation.json'))).toBe(true);
    expect(s3.requestedKeys.filter((request) => request.endsWith('/inbound/') || request.endsWith('/outbound/'))).toEqual(
      [],
    );
  });

  test('a tool action refreshes once before execution and only flushes afterward', async () => {
    const s3 = new MemoryS3();
    const store = new S3AgentMailbox(options, s3, { minMs: 60_000, maxMs: 60_000 });
    await store.start(key);
    s3.requestedKeys.length = 0;

    await store.run(() => store.operations.setState('tool-state', 'done'));
    await store.stop();

    expect(s3.requestedKeys.filter((request) => request.endsWith('/inbound/') || request.endsWith('/outbound/'))).toEqual([
      `${sessionPrefix}/inbound/`,
      `${sessionPrefix}/outbound/`,
    ]);
  });

  test('during-action mode stays idle between tools and refreshes while a long tool waits', async () => {
    const s3 = new MemoryS3();
    const store = new S3AgentMailbox(options, s3, { minMs: 10, maxMs: 40 });
    store.setBackgroundSyncMode('during-action');
    await store.start(key);
    s3.requestedKeys.length = 0;

    await Bun.sleep(60);
    expect(s3.requestedKeys).toEqual([]);

    const answer = await store.run(async () => {
      setTimeout(() => {
        s3.putRecord(
          `${sessionPrefix}/inbound/messages/tool-answer.json`,
          'inbound',
          inboundMessage('tool-answer', 2, '{"questionId":"q-tool","answer":"yes"}'),
        );
      }, 15);
      for (let attempt = 0; attempt < 20; attempt++) {
        const found = store.operations.findQuestionResponse('q-tool');
        if (found) return found.id;
        await Bun.sleep(10);
      }
      return undefined;
    });
    await store.stop();

    expect(answer).toBe('tool-answer');
    expect(s3.requestedKeys.some((request) => request.endsWith('/inbound/'))).toBe(true);
  });

  test('rescues an older trigger message from a newer context-only window', async () => {
    const s3 = new MemoryS3();
    for (const message of [
      inboundMessage('mention', 2),
      { ...inboundMessage('context-1', 4), trigger: false },
      { ...inboundMessage('context-2', 6), trigger: false },
    ]) {
      s3.putRecord(`${sessionPrefix}/inbound/messages/${message.id}.json`, 'inbound', message);
    }
    const store = new S3AgentMailbox(options, s3);
    await store.start(key);
    try {
      expect(store.operations.getPendingMessages(2, true).map(({ id }) => id)).toEqual([
        'mention',
        'context-1',
        'context-2',
      ]);
    } finally {
      await store.stop();
    }
  });

  test('refuses a legacy null context', async () => {
    await expect(new S3AgentMailbox(options, new MemoryS3()).start(null)).rejects.toThrow(
      'invalid S3 request capability',
    );
  });

  test('refuses to start without the host-issued session capability', async () => {
    await expect(
      new S3AgentMailbox(options, new MemoryS3()).start({
        ...key,
        mailbox: null,
      }),
    ).rejects.toThrow('invalid S3 request capability');
  });

  test('refuses identity collisions from malformed Unicode', async () => {
    await expect(
      new S3AgentMailbox(options, new MemoryS3()).start({ ...key, agentGroupId: '\ud800' }),
    ).rejects.toThrow('well-formed Unicode');
  });

  test('skips unreadable canonical records without wedging the cache', async () => {
    const s3 = new MemoryS3();
    const badKey = `${sessionPrefix}/inbound/messages/user-message.json`;
    s3.put(badKey, {
      ...envelope('inbound', inboundMessage('user-message', 2)),
      modelVersion: 2,
    });
    s3.putRecord(`${sessionPrefix}/inbound/messages/other-message.json`, 'inbound', inboundMessage('other-message', 4));
    const store = new S3AgentMailbox(options, s3);
    await store.start(key);
    try {
      // The bad object's blast radius is itself: everything else is served.
      expect(store.operations.getPendingMessages(10, true).map(({ id }) => id)).toEqual(['other-message']);

      // A sync pass must leave the unreadable object untouched in S3 — never
      // deleted or overwritten by the flush diff.
      await store.run(() => {});
      expect(JSON.parse(s3.objects.get(badKey)!.body).modelVersion).toBe(2);

      // Key/identity mismatch is skipped the same way.
      s3.putRecord(badKey, 'inbound', inboundMessage('different-id', 2));
      await store.run(() => {});
      expect(store.operations.getPendingMessages(10, true).map(({ id }) => id)).toEqual(['other-message']);
      expect(s3.objects.has(badKey)).toBe(true);

      // The envelope parser delegates its nested record to the canonical
      // parser, so a non-flat record is isolated without affecting siblings.
      s3.put(badKey, {
        ...envelope('inbound', inboundMessage('user-message', 2)),
        record: {
          ...inboundMessage('user-message', 2),
          content: { text: 'nested' },
        },
      });
      await store.run(() => {});
      expect(store.operations.getPendingMessages(10, true).map(({ id }) => id)).toEqual(['other-message']);
      expect(s3.objects.has(badKey)).toBe(true);

      s3.objects.set(badKey, { body: 'x'.repeat(8 * 1024 * 1024 + 1), etag: '"oversized"' });
      await store.run(() => {});
      expect(store.operations.getPendingMessages(10, true).map(({ id }) => id)).toEqual(['other-message']);
      expect(s3.objects.get(badKey)?.body.length).toBe(8 * 1024 * 1024 + 1);

      s3.objects.set(badKey, { body: '{', etag: '"small-again"' });
      const oversizedOutbound = `${sessionPrefix}/outbound/messages/oversized.json`;
      s3.objects.set(oversizedOutbound, { body: 'x'.repeat(8 * 1024 * 1024 + 1), etag: '"oversized-out"' });
      await store.run(() => {});
      expect(store.operations.getPendingMessages(10, true).map(({ id }) => id)).toEqual(['other-message']);
      expect(s3.objects.get(oversizedOutbound)?.body.length).toBe(8 * 1024 * 1024 + 1);
    } finally {
      await store.stop();
    }
  });

  test('reads inbound JSON and writes outbound JSON without POSIX mailbox files', async () => {
    const s3 = new MemoryS3();
    s3.putRecord(`${sessionPrefix}/inbound/messages/user-message.json`, 'inbound', inboundMessage('user-message', 2));
    const store = new S3AgentMailbox(options, s3);

    await store.start(key);
    try {
      await store.run(async () => {
        const pending = store.operations.getPendingMessages(10, true);
        expect(pending.map(({ id }) => id)).toEqual(['user-message']);
        store.operations.markMessages(
          pending.map(({ id }) => id),
          'processing',
        );
        await expect(
          store.operations.writeMessageOut({
            id: '1787378431.344819:U1',
            inReplyTo: pending[0]?.id ?? null,
            kind: 'chat',
            platformId: 'room',
            channelType: 'test',
            threadId: 'thread',
            content: '{"text":"hi"}',
          }),
        ).resolves.toBe(3);
        store.operations.setState('continuation', 'token');
        expect(store.operations.getState('continuation')?.value).toBe('token');
      });
      await store.run(() => store.operations.deleteState('continuation'));
      expect([...s3.objects.keys()].some((objectKey) => objectKey.endsWith('/outbound/state/continuation.json'))).toBe(
        false,
      );
    } finally {
      await store.stop();
    }

    const keys = [...s3.objects.keys()];
    expect(
      keys.some((objectKey) =>
        objectKey.endsWith('/outbound/messages/~MTc4NzM3ODQzMS4zNDQ4MTk6VTE.json'),
      ),
    ).toBe(true);
    expect(s3.requestedKeys.every((objectKey) => !objectKey.includes('%'))).toBe(true);
    expect(keys.some((objectKey) => objectKey.endsWith('.db'))).toBe(false);
    expect(s3.requestedKeys.every((objectKey) => objectKey.startsWith(sessionPrefix))).toBe(true);
  });

  test('allocates unique odd sequences across independent runner processes', async () => {
    const s3 = new MemoryS3();
    s3.putRecord(`${sessionPrefix}/inbound/messages/user-message.json`, 'inbound', inboundMessage('user-message', 2));
    const first = new S3AgentMailbox(options, s3);
    const second = new S3AgentMailbox(options, s3);
    await Promise.all([first.start(key), second.start(key)]);
    try {
      const sequences = await Promise.all([
        first.operations.writeMessageOut({
          id: 'out-a',
          kind: 'chat',
          content: 'a',
        }),
        second.operations.writeMessageOut({
          id: 'out-b',
          kind: 'chat',
          content: 'b',
        }),
      ]);
      expect(new Set(sequences).size).toBe(2);
      expect(sequences.every((sequence) => sequence % 2 === 1)).toBe(true);
      expect([...sequences].sort((a, b) => a - b)).toEqual([3, 5]);
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
  });

  test('imports clean outbound state and messages from a sibling process', async () => {
    const s3 = new MemoryS3();
    const first = new S3AgentMailbox(options, s3);
    const second = new S3AgentMailbox(options, s3);
    await Promise.all([first.start(key), second.start(key)]);
    try {
      await first.run(async () => {
        first.operations.setState('current_in_reply_to', 'in-1');
        await first.operations.writeMessageOut({
          id: 'tool-message',
          kind: 'chat',
          content: 'hello',
        });
      });
      await expect(second.run(() => second.operations.getState('current_in_reply_to')?.value)).resolves.toBe('in-1');
      await expect(second.run(() => second.operations.getUndeliveredMessages().map(({ id }) => id))).resolves.toContain(
        'tool-message',
      );
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
  });

  test('syncs outbound and refreshes inbound while a long tool call is running', async () => {
    const s3 = new MemoryS3();
    const store = new S3AgentMailbox(options, s3);
    await store.start(key);
    try {
      const response = await store.run(async () => {
        await store.operations.writeMessageOut({
          id: 'question',
          kind: 'question',
          content: '{}',
        });
        expect(s3.objects.has(`${sessionPrefix}/outbound/messages/question.json`)).toBe(true);
        setTimeout(() => {
          s3.putRecord(
            `${sessionPrefix}/inbound/messages/answer.json`,
            'inbound',
            inboundMessage('answer', 2, '{"questionId":"q1","answer":"yes"}'),
          );
        }, 50);
        for (let attempt = 0; attempt < 20; attempt++) {
          const found = store.operations.findQuestionResponse('q1');
          if (found) return found.id;
          await Bun.sleep(100);
        }
        return undefined;
      });
      expect(response).toBe('answer');
    } finally {
      await store.stop();
    }
  });

  test('serializes overlapping tool calls', async () => {
    const s3 = new MemoryS3();
    const store = new S3AgentMailbox(options, s3);
    await store.start(key);
    let active = 0;
    let maxActive = 0;
    const action = () =>
      store.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(50);
        active--;
      });
    try {
      await Promise.all([action(), action()]);
      expect(maxActive).toBe(1);
    } finally {
      await store.stop();
    }
  });

  test('retries a stale ETag update without wedging the cache', async () => {
    const s3 = new MemoryS3();
    const stateKey = `${sessionPrefix}/outbound/state/continuation.json`;
    s3.putRecord(stateKey, 'state', {
      key: 'continuation',
      value: 'old',
      updatedAt: parseIsoTimestamp('2026-01-01T00:00:00.000Z'),
    });
    const store = new S3AgentMailbox(options, s3);
    await store.start(key);
    try {
      await store.run(() => {
        store.operations.setState('continuation', 'local');
        s3.putRecord(stateKey, 'state', {
          key: 'continuation',
          value: 'remote',
          updatedAt: parseIsoTimestamp('2026-01-02T00:00:00.000Z'),
        });
      });
      expect(JSON.parse(s3.objects.get(stateKey)!.body).record.value).toBe('local');
      await expect(store.run(() => store.operations.getState('continuation')?.value)).resolves.toBe('local');
    } finally {
      await store.stop();
    }
  });
});
