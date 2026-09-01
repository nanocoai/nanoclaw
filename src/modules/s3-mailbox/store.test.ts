import { describe, expect, it } from 'vitest';

import type { InboundWrite, MailboxRecordByKind, MailboxRecordKind } from '../../mailbox/model.js';
import { parseIsoTimestamp } from '../../mailbox/model.js';
import { S3AgentMailbox } from './store.js';

const session = { agentGroupId: 'agent/group', sessionId: '..' };

function envelope<K extends MailboxRecordKind>(recordType: K, record: MailboxRecordByKind[K]) {
  return { modelVersion: 1, recordType, record };
}

class MemoryS3 {
  readonly objects = new Map<string, { body: string; etag: string }>();
  readonly requestedKeys: string[] = [];
  failOnceMatching: string | undefined;
  rejectConditionalDeletes = false;
  private version = 0;

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    if (url.searchParams.has('list-type')) {
      const prefix = url.searchParams.get('prefix') ?? '';
      this.requestedKeys.push(prefix);
      const contents = [...this.objects]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => `<Contents><Key>${key}</Key><ETag>${value.etag}</ETag></Contents>`)
        .join('');
      return new Response(`<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`);
    }
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    this.requestedKeys.push(key);
    const current = this.objects.get(key);
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
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (this.failOnceMatching && key.includes(this.failOnceMatching)) {
      this.failOnceMatching = undefined;
      return new Response(null, { status: 503 });
    }
    const etag = `"v${++this.version}"`;
    this.objects.set(key, { body: String(init.body), etag });
    return new Response(null, { headers: { etag } });
  };
}

describe('S3AgentMailbox', () => {
  it('does not provision on an existence check or an unprepared session', async () => {
    const s3 = new MemoryS3();
    const mailbox = new S3AgentMailbox(
      {
        bucket: 'mailboxes',
        prefix: 'tenant',
        endpoint: 'http://localhost:4566',
        region: 'us-east-1',
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
      s3,
    );

    await expect(mailbox.exists(session)).resolves.toBe(false);
    await expect(mailbox.session(session, () => undefined)).rejects.toThrow('does not exist');
    expect(s3.objects.size).toBe(0);
  });

  it('refuses identity collisions from malformed Unicode', async () => {
    const mailbox = new S3AgentMailbox({
      bucket: 'mailboxes',
      endpoint: 'http://localhost:4566',
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });
    const key = { agentGroupId: '\ud800', sessionId: 'session' };
    mailbox.prepare(key);
    await expect(mailbox.runnerContext(key)).rejects.toThrow('well-formed Unicode');
  });

  it('persists the host mailbox lifecycle', async () => {
    const s3 = new MemoryS3();
    const options = {
      bucket: 'mailboxes',
      prefix: 'tenant',
      endpoint: 'http://localhost:4566',
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    };
    const key = { agentGroupId: 'agent', sessionId: 'contract' };
    const store = new S3AgentMailbox(options, s3);
    store.prepare(key);
    await store.session(key, async (mailbox) => {
      mailbox.setRouting({
        channelType: 'test',
        platformId: 'room',
        threadId: 'thread',
      });
      mailbox.replaceDestinations([
        {
          name: 'test-room',
          displayName: 'Test Room',
          type: 'channel',
          channelType: 'test',
          platformId: 'room',
          agentGroupId: null,
        },
      ]);
      await mailbox.insertMessage({
        id: 'in-1',
        kind: 'chat',
        timestamp: '2026-01-01T00:00:00.000Z',
        platformId: 'room',
        channelType: 'test',
        threadId: 'thread',
        content: '{"text":"hello"}',
        processAfter: null,
        recurrence: null,
      });
      await mailbox.insertTask({
        id: 'task-1',
        seriesId: 'task-alpha-abcd',
        processAfter: '2999-01-01T00:00:00.000Z',
        recurrence: null,
        content: '{"prompt":"later"}',
      });
      await mailbox.writeDirect({
        id: 'out-1',
        kind: 'chat',
        platformId: 'room',
        channelType: 'test',
        threadId: 'thread',
        content: '{"text":"hi"}',
      });
    });

    await expect(
      new S3AgentMailbox(options, s3).session(key, (mailbox) => ({
        dueInbound: mailbox.countDueMessages(),
        task: mailbox.getTask('task-1')?.seriesId,
        taskBySlug: mailbox.findTaskBySeriesSlug('task-alpha')?.id,
        inboundKinds: mailbox.getInboundHistory(10).map(({ kind }) => kind),
        conversationRoot: mailbox.getConversationRoot()?.content,
        dueOutbound: mailbox.getDueMessages().map(({ id }) => id),
        outboundKinds: mailbox.getOutboundHistory(10).map(({ kind }) => kind),
        topLevelOutbound: mailbox.getTopLevelOutbound(10),
        pruned: mailbox.prunePendingMessages('test', '2027-01-01T00:00:00.000Z', 10),
      })),
    ).resolves.toEqual({
      dueInbound: 1,
      task: 'task-alpha-abcd',
      taskBySlug: 'task-1',
      inboundKinds: ['task', 'chat'],
      conversationRoot: '{"text":"hello"}',
      dueOutbound: ['out-1'],
      outboundKinds: ['chat'],
      topLevelOutbound: [],
      pruned: 1,
    });
  });

  it('stages inbound attachment bytes as session-scoped S3 objects', async () => {
    const s3 = new MemoryS3();
    const options = {
      bucket: 'mailboxes',
      prefix: 'tenant',
      endpoint: 'http://localhost:4566',
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    };
    const key = { agentGroupId: 'agent', sessionId: 'contract' };
    const mailbox = new S3AgentMailbox(options, s3);
    mailbox.prepare(key);
    const capability = ((await mailbox.runnerContext(key)) as { capability: string }).capability;

    const content = await mailbox.stageInboundAttachments!(
      key,
      '1788181543.404539:a9326232-5748-4bd2-84dd-090efbb18dd7',
      JSON.stringify({
        text: 'image',
        attachments: [{ name: 'image.png', mimeType: 'image/png', data: Buffer.from('png-bytes').toString('base64') }],
      }),
    );

    const parsed = JSON.parse(content);
    expect(parsed.attachments).toEqual([
      {
        name: 'image.png',
        mimeType: 'image/png',
        localPath: 'inbox/1788181543.404539:a9326232-5748-4bd2-84dd-090efbb18dd7/image.png',
      },
    ]);
    const attachmentKey = [...s3.objects.keys()].find((objectKey) => objectKey.includes('/attachments/'));
    expect(attachmentKey).toBe(
      `tenant/v2/agent-groups/agent/sessions/contract/capabilities/${capability}/attachments/1788181543%2E404539%3Aa9326232-5748-4bd2-84dd-090efbb18dd7/image%2Epng`,
    );
    expect(s3.objects.get(attachmentKey!)?.body).toBe('png-bytes');
  });

  it('destroys the complete session mailbox without touching siblings', async () => {
    const s3 = new MemoryS3();
    const options = {
      bucket: 'mailboxes',
      prefix: 'tenant',
      endpoint: 'http://localhost:4566',
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    };
    const mailbox = new S3AgentMailbox(options, s3);
    mailbox.prepare(session);
    await mailbox.session(session, async (view) => {
      await view.insertMessage({
        id: 'delete-me',
        kind: 'chat',
        timestamp: '2026-01-01T00:00:00.000Z',
        processAfter: null,
        recurrence: null,
        platformId: null,
        channelType: null,
        threadId: null,
        content: '{}',
      });
    });
    const sibling = { ...session, sessionId: 'sibling' };
    await mailbox.runnerContext(sibling);

    const capability = ((await mailbox.runnerContext(session)) as { capability: string }).capability;
    const sessionPrefix = `tenant/v2/agent-groups/agent%2Fgroup/sessions/%2E%2E/capabilities/${capability}`;
    s3.objects.set(`${sessionPrefix}/future/unreadable.json`, { body: '{', etag: '"future"' });
    s3.rejectConditionalDeletes = true;

    await mailbox.destroy(session);
    expect([...s3.objects.keys()].some((key) => key.startsWith(`${sessionPrefix}/`))).toBe(false);
    expect([...s3.objects.keys()].some((key) => key.includes('/sessions/%2E%2E.json'))).toBe(false);
    expect([...s3.objects.keys()].some((key) => key.includes('/sessions/sibling.json'))).toBe(true);
    await expect(mailbox.destroy(session)).resolves.toBeUndefined();
  });

  it('keeps due task snapshots immutable and selects the future schedule anchor', async () => {
    const s3 = new MemoryS3();
    const options = {
      bucket: 'mailboxes',
      prefix: 'tenant',
      endpoint: 'http://localhost:4566',
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    };
    const mailbox = new S3AgentMailbox(options, s3);
    mailbox.prepare(session);
    await mailbox.session(session, async (view) => {
      await view.insertTask({
        id: 'series',
        seriesId: 'series',
        processAfter: '2099-01-01T00:00:00.000Z',
        recurrence: null,
        content: '{"prompt":"anchor"}',
      });
      await view.insertTask({
        id: 'series-run',
        seriesId: 'series',
        processAfter: '2020-01-01T00:00:00.000Z',
        recurrence: null,
        content: '{"prompt":"snapshot"}',
      });

      expect(view.getTask('series')?.id).toBe('series');
      expect(view.listLiveTasks()[0]?.id).toBe('series');
      expect(view.updateTask('series', { prompt: 'next' })).toBe(1);
      expect(JSON.parse(view.getTask('series')!.content).prompt).toBe('next');
      expect(JSON.parse(view.getTask('series-run')!.content).prompt).toBe('snapshot');
    });

    await expect(
      new S3AgentMailbox(options, s3).session(session, (view) => ({
        selected: view.getTask('series')?.id,
        anchor: JSON.parse(view.getTask('series')!.content).prompt,
        snapshot: JSON.parse(view.getTask('series-run')!.content).prompt,
      })),
    ).resolves.toEqual({ selected: 'series', anchor: 'next', snapshot: 'snapshot' });
  });

  it('persists native JSON records and reloads them without database objects', async () => {
    const s3 = new MemoryS3();
    const options = {
      bucket: 'mailboxes',
      prefix: 'tenant',
      endpoint: 'http://localhost:4566',
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    };
    const writer = new S3AgentMailbox(options, s3);
    writer.prepare(session);
    await writer.session(session, async (mailbox) => {
      await mailbox.insertMessage({
        id: 'm1',
        kind: 'chat',
        timestamp: '2026-01-01T00:00:00.000Z',
        processAfter: null,
        recurrence: null,
        trigger: true,
        platformId: null,
        channelType: null,
        threadId: null,
        content: '{"text":"hello"}',
        sourceSessionId: null,
        onWake: false,
      });
    });

    const objectKey = [...s3.objects.keys()].find((key) => key.endsWith('/inbound/messages/m1.json'))!;
    expect(objectKey).toMatch(
      /^tenant\/v2\/agent-groups\/agent%2Fgroup\/sessions\/%2E%2E\/capabilities\/[a-f0-9]{64}\//,
    );
    expect(s3.objects.has(objectKey)).toBe(true);
    expect(JSON.parse(s3.objects.get(objectKey)!.body)).toMatchObject({
      modelVersion: 1,
      recordType: 'inbound',
      record: { id: 'm1', content: '{"text":"hello"}' },
    });
    expect([...s3.objects.keys()].some((key) => key.endsWith('.db'))).toBe(false);

    const pendingBody = s3.objects.get(objectKey)!.body;
    const reader = new S3AgentMailbox(options, s3);
    expect(await reader.session(session, (mailbox) => mailbox.countDueMessages())).toBe(1);

    s3.objects.set(objectKey, {
      etag: '"remote"',
      body: pendingBody.replace('pending', 'failed'),
    });
    expect(await reader.session(session, (mailbox) => mailbox.countDueMessages())).toBe(0);

    // Containment: records the strict parser rejects are skipped with a
    // warning, never wedge the session, and are left untouched in S3 so a
    // fixed reader (or an operator) can still recover them.
    const envelope = JSON.parse(s3.objects.get(objectKey)!.body);
    s3.objects.set(objectKey, {
      etag: '"future"',
      body: JSON.stringify({ ...envelope, modelVersion: 2 }),
    });
    expect(await reader.session(session, (mailbox) => mailbox.countDueMessages())).toBe(0);
    expect(JSON.parse(s3.objects.get(objectKey)!.body).modelVersion).toBe(2);

    s3.objects.set(objectKey, {
      etag: '"wrong-key"',
      body: JSON.stringify({
        ...envelope,
        record: { ...envelope.record, id: 'other' },
      }),
    });
    expect(await reader.session(session, (mailbox) => mailbox.countDueMessages())).toBe(0);

    s3.objects.set(objectKey, {
      etag: '"extra-envelope-field"',
      body: JSON.stringify({ ...envelope, future: true }),
    });
    expect(await reader.session(session, (mailbox) => mailbox.countDueMessages())).toBe(0);

    const survivorKey = objectKey.replace('/m1.json', '/survivor.json');
    const pendingEnvelope = JSON.parse(pendingBody);
    s3.objects.set(survivorKey, {
      etag: '"survivor"',
      body: JSON.stringify({ ...pendingEnvelope, record: { ...pendingEnvelope.record, id: 'survivor' } }),
    });
    s3.objects.set(objectKey, { etag: '"oversized"', body: 'x'.repeat(8 * 1024 * 1024 + 1) });
    expect(await reader.session(session, (mailbox) => mailbox.countDueMessages())).toBe(1);
    expect(s3.objects.get(objectKey)?.body.length).toBe(8 * 1024 * 1024 + 1);
    s3.objects.delete(survivorKey);

    s3.objects.set(objectKey, {
      etag: '"native-timestamp"',
      body: JSON.stringify({
        ...envelope,
        record: { ...envelope.record, timestamp: '2026-01-01 00:00:00' },
      }),
    });
    expect(await reader.session(session, (mailbox) => mailbox.countDueMessages())).toBe(0);

    s3.objects.set(objectKey, {
      etag: '"extra-field"',
      body: JSON.stringify({
        ...envelope,
        record: { ...envelope.record, extraField: 7 },
      }),
    });
    expect(await reader.session(session, (mailbox) => mailbox.countDueMessages())).toBe(0);

    s3.objects.set(objectKey, {
      etag: '"nested-record-field"',
      body: JSON.stringify({
        ...envelope,
        record: { ...envelope.record, content: { text: 'nested' } },
      }),
    });
    expect(await reader.session(session, (mailbox) => mailbox.countDueMessages())).toBe(0);

    s3.objects.set(objectKey, { etag: '"invalid"', body: '{' });
    expect(await reader.session(session, (mailbox) => mailbox.countDueMessages())).toBe(0);
    expect(s3.objects.get(objectKey)!.body).toBe('{');

    // A repaired object is picked up again on the next session.
    s3.objects.set(objectKey, { etag: '"repaired"', body: pendingBody });
    expect(await reader.session(session, (mailbox) => mailbox.countDueMessages())).toBe(1);
    expect(
      s3.requestedKeys.every((key) => key.includes('/agent-groups/agent%2Fgroup/') && key.includes('/sessions/%2E%2E')),
    ).toBe(true);
  });

  it('uses path-safe record keys', async () => {
    const s3 = new MemoryS3();
    const options = {
      bucket: 'mailboxes',
      prefix: 'tenant',
      endpoint: 'http://localhost:4566',
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    };
    const id = '1787378431.344819:U1';
    const writer = new S3AgentMailbox(options, s3);
    writer.prepare(session);
    await writer.session(session, (mailbox) =>
      mailbox.insertMessage({
        id,
        kind: 'chat',
        timestamp: '2026-01-01T00:00:00.000Z',
        processAfter: null,
        recurrence: null,
        trigger: true,
        platformId: 'U1',
        channelType: 'slack',
        threadId: null,
        content: '{"text":"ping"}',
        sourceSessionId: null,
        onWake: false,
      }),
    );
    const canonicalKey = [...s3.objects.keys()].find((key) =>
      key.endsWith('/inbound/messages/~MTc4NzM3ODQzMS4zNDQ4MTk6VTE.json'),
    )!;
    expect(s3.objects.has(canonicalKey)).toBe(true);
    expect([...s3.objects.keys()].some((key) => key.includes('1787378431%2E344819%3AU1'))).toBe(false);
    await expect(new S3AgentMailbox(options, s3).session(session, (mailbox) => mailbox.countDueMessages())).resolves.toBe(1);
  });

  it('gives each session a stable opaque capability', async () => {
    const s3 = new MemoryS3();
    const options = {
      bucket: 'mailboxes',
      prefix: 'tenant',
      endpoint: 'http://localhost:4566',
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    };
    const first = (await new S3AgentMailbox(options, s3).runnerContext(session)) as { capability: string };
    const again = (await new S3AgentMailbox(options, s3).runnerContext(session)) as { capability: string };
    const sibling = (await new S3AgentMailbox(options, s3).runnerContext({
      ...session,
      sessionId: 'sibling',
    })) as {
      capability: string;
    };

    expect(first.capability).toMatch(/^[a-f0-9]{64}$/);
    expect(again.capability).toBe(first.capability);
    expect(sibling.capability).not.toBe(first.capability);
    expect([...s3.objects.keys()].filter((key) => key.includes('/control/'))).toHaveLength(2);
  });

  it('shares one even sequence space across inbound and direct outbound', async () => {
    const s3 = new MemoryS3();
    const mailbox = new S3AgentMailbox(
      {
        bucket: 'mailboxes',
        prefix: 'tenant',
        endpoint: 'http://localhost:4566',
        region: 'us-east-1',
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
      s3,
    );
    mailbox.prepare(session);
    const insert = (id: string): InboundWrite => ({
      id,
      kind: 'chat',
      timestamp: '2026-01-01T00:00:00.000Z',
      processAfter: null,
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{}',
    });

    await mailbox.session(session, async (view) => {
      await view.insertMessage(insert('in-1'));
      await view.writeDirect({
        id: 'out-1',
        kind: 'chat',
        platformId: null,
        channelType: null,
        threadId: null,
        content: '{}',
      });
      await view.insertMessage(insert('in-2'));
    });

    const sequences = [...s3.objects.values()]
      .map(({ body }) => (JSON.parse(body) as { record?: { id?: string; sequence?: number } }).record ?? {})
      .filter(({ id }) => id === 'in-1' || id === 'out-1' || id === 'in-2')
      .map(({ sequence }) => sequence)
      .sort();
    expect(sequences).toEqual([2, 4, 6]);
  });

  it('preserves runner-owned outbound state while reading delivery', async () => {
    const s3 = new MemoryS3();
    const mailbox = new S3AgentMailbox(
      {
        bucket: 'mailboxes',
        prefix: 'tenant',
        endpoint: 'http://localhost:4566',
        region: 'us-east-1',
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
      s3,
    );
    const { capability } = (await mailbox.runnerContext(session)) as {
      capability: string;
    };
    const stateKey = `tenant/v2/agent-groups/agent%2Fgroup/sessions/%2E%2E/capabilities/${capability}/outbound/state/current_in_reply_to.json`;
    s3.objects.set(stateKey, {
      etag: '"runner"',
      body: JSON.stringify(
        envelope('state', {
          key: 'current_in_reply_to',
          value: 'in-1',
          updatedAt: parseIsoTimestamp('2026-01-01T00:00:00.000Z'),
        }),
      ),
    });
    await expect(mailbox.session(session, (view) => view.getDueMessages())).resolves.toEqual([]);
    expect(s3.objects.get(stateKey)?.etag).toBe('"runner"');
  });

  it('recovers after a partial multi-record commit', async () => {
    const s3 = new MemoryS3();
    const mailbox = new S3AgentMailbox(
      {
        bucket: 'mailboxes',
        prefix: 'tenant',
        endpoint: 'http://localhost:4566',
        region: 'us-east-1',
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
      s3,
    );
    mailbox.prepare(session);
    const replace = () =>
      mailbox.session(session, (view) =>
        view.replaceDestinations([
          {
            name: 'a',
            displayName: 'A',
            type: 'channel',
            channelType: 'test',
            platformId: 'a',
            agentGroupId: null,
          },
          {
            name: 'b',
            displayName: 'B',
            type: 'channel',
            channelType: 'test',
            platformId: 'b',
            agentGroupId: null,
          },
        ]),
      );

    s3.failOnceMatching = '/b.json';
    await expect(replace()).rejects.toThrow('503');
    await expect(replace()).resolves.toBeUndefined();
    expect([...s3.objects.keys()].filter((key) => key.includes('/destinations/'))).toHaveLength(2);
  });
});
