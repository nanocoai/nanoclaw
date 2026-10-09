/**
 * Error reports, driven through the real wiring: the modules barrel registers
 * the sink, core raises the error through reportOperationalError, the
 * destination resolves from the real central DB, and the report goes out
 * through the delivery adapter core hands to onDeliveryAdapterReady.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ENV = vi.hoisted(() => ({ ERROR_REPORTS_MESSAGING_GROUP: 'mg-errors' }) as Record<string, string>);

vi.mock('../../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../env.js')>();
  return {
    ...actual,
    readEnvFile: (keys: string[], root?: string) => {
      const values = actual.readEnvFile(keys, root);
      for (const key of keys) if (ENV[key]) values[key] = ENV[key];
      return values;
    },
  };
});

import '../index.js';
import { closeDb, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { reportOperationalError } from '../../operational-errors.js';

interface Sent {
  channelType: string;
  platformId: string;
  threadId: string | null;
  kind: string;
  text: string;
  instance?: string;
}

const sent: Sent[] = [];

beforeAll(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await createMessagingGroup({
    id: 'mg-errors',
    channel_type: 'telegram',
    platform_id: 'telegram:ops',
    instance: 'telegram',
    name: 'Ops',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  });
});

afterAll(async () => {
  vi.useRealTimers();
  await closeDb();
});

describe('error reports', () => {
  it('queues a report raised before channels are up and sends it once the adapter is ready', async () => {
    reportOperationalError({
      kind: 'host.startup-backoff',
      message: 'Host restarted 3 times within an hour',
      key: 'host.startup-backoff',
      details: { attempt: 4, delaySec: 30 },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(0);

    setDeliveryAdapter({
      async deliver(channelType, platformId, threadId, kind, content, _files, instance) {
        sent.push({ channelType, platformId, threadId, kind, text: JSON.parse(content).text, instance });
        return undefined;
      },
    });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      channelType: 'telegram',
      platformId: 'telegram:ops',
      threadId: null,
      kind: 'chat-sdk',
      instance: 'telegram',
    });
    expect(sent[0].text).toContain('Host restarted 3 times within an hour');
    expect(sent[0].text).toContain('attempt: 4');
  });

  it('suppresses repeats of one key inside the quiet window and counts them on the next report', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    sent.length = 0;
    const failing = (n: number) =>
      reportOperationalError({
        kind: 'task.script-failing',
        message: `script failed ${n} run(s) in a row`,
        key: 'task.script-failing:series-1',
      });

    failing(1);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    failing(2);
    failing(3);
    reportOperationalError({
      kind: 'task.auto-paused',
      message: 'other series paused',
      key: 'task.auto-paused:series-2',
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].text).toContain('other series paused');

    vi.setSystemTime(Date.now() + 61 * 60_000);
    failing(4);
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2].text).toContain('script failed 4 run(s) in a row');
    expect(sent[2].text).toContain('2 similar report(s) suppressed');
  });
});
