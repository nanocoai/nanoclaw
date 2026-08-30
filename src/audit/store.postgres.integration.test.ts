import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import { PostgresDriver } from '../db/drivers/postgres/index.js';
import { withPostgresTestEnvironment } from '../db/drivers/postgres/test-helpers.js';
import { buildHostAuditEventV1 } from './contract.js';
import { drainGovernanceQueue } from './governance-drain.js';
import '../db/migrations/registered-modules.js';
import { listAuditEvents } from './reader.js';
import { createAuditStore } from './store.js';

const TEST_DB_URL = process.env.NANOCLAW_TEST_DB_URL || '';
const HOST_ID = 'host-audit-pg-test';

function buildEvent(index: number, seq: number, occurredAt?: string) {
  return buildHostAuditEventV1(
    {
      eventType: 'message_received',
      actor: { type: 'human', id: `hmac:${index.toString(16).padStart(64, '0')}` },
      agentId: 'agent-test',
      sessionId: 'session-test',
      dimensions: {
        transport: 'channel',
        channel_type: 'test',
        messaging_group_id: 'group-test',
        activity_id: `message-${index}`,
      },
    },
    {
      hostId: HOST_ID,
      seq,
      eventId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      occurredAt: occurredAt ?? new Date(Date.UTC(2026, 7, 25, 10, 0, index)).toISOString(),
    },
  );
}

afterEach(async () => {
  await closeDb();
});

describe.skipIf(!TEST_DB_URL)('PostgreSQL host audit store', () => {
  it('forces synchronous WAL commit at the durable audit boundary', async () => {
    await withPostgresTestEnvironment('host_audit_sync_commit', async () => {
      const db = await initTestDb({ fresh: true });
      const store = createAuditStore(db, HOST_ID);
      await db.exec(`
        CREATE OR REPLACE FUNCTION host_audit_require_sync_commit()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF current_setting('synchronous_commit') <> 'on' THEN
            RAISE EXCEPTION 'host audit insert did not force synchronous_commit=on';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER host_audit_require_sync_commit
          BEFORE INSERT ON host_audit_events
          FOR EACH ROW EXECUTE FUNCTION host_audit_require_sync_commit();
      `);

      await db.transaction(async () => {
        await db.run('SET LOCAL synchronous_commit = off');
        await store.append((seq) => buildEvent(1, seq));
      });
      expect(await store.allocatedThrough()).toBe(1);
    });
  });

  it('registers its portable migration and allocates concurrent sequences without rollback gaps', async () => {
    await withPostgresTestEnvironment('host_audit_store', async () => {
      const db = await initTestDb({ fresh: true });
      const store = createAuditStore(db, HOST_ID);

      const committed = await Promise.all(
        Array.from({ length: 24 }, (_, index) => store.append((seq) => buildEvent(index + 1, seq))),
      );
      expect(committed.map(({ event }) => event.seq).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 24 }, (_, index) => index + 1),
      );

      await expect(
        store.append(() => {
          throw new Error('simulated envelope failure after sequence allocation');
        }),
      ).rejects.toThrow('simulated envelope failure');

      const afterRollback = await store.append((seq) => buildEvent(25, seq));
      expect(afterRollback.event.seq).toBe(25);

      const restarted = createAuditStore(db, HOST_ID);
      const afterRestart = await restarted.append((seq) => buildEvent(26, seq));
      expect(afterRestart.event.seq).toBe(26);

      const rows = await db.all<{ seq: number; event_json: string }>(
        'SELECT seq, event_json FROM host_audit_events WHERE host_id = ? ORDER BY seq',
        HOST_ID,
      );
      expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 26 }, (_, index) => index + 1));
      expect(rows.map((row) => JSON.parse(row.event_json).seq)).toEqual(
        Array.from({ length: 26 }, (_, index) => index + 1),
      );

      await expect(
        db.run(
          'UPDATE host_audit_events SET event_json = ? WHERE host_id = ? AND seq = 1',
          '{}',
          HOST_ID,
        ),
      ).rejects.toThrow(/immutable/i);
      await expect(
        db.run('DELETE FROM host_audit_events WHERE host_id = ? AND seq = 1', HOST_ID),
      ).rejects.toThrow(/acknowledged retention prefix/i);
      await expect(
        db.run('DELETE FROM host_audit_producer_state WHERE host_id = ?', HOST_ID),
      ).rejects.toThrow(/cannot be deleted/i);
    });
  });

  it('retention on a Host that has never appended does not violate the delivery FK', async () => {
    // The first-install case, and the one every other test skips by appending
    // first. host_audit_delivery_state.host_id references
    // host_audit_producer_state(host_id); retention maintenance reaches
    // lockDeliveryState before anything has been produced, so on a fresh
    // install the parent table is empty and the insert failed once a minute:
    //   insert or update on table "host_audit_delivery_state" violates foreign
    //   key constraint "host_audit_delivery_state_host_id_fkey"
    await withPostgresTestEnvironment('host_audit_cursor', async () => {
      const db = await initTestDb({ fresh: true });
      const store = createAuditStore(db, HOST_ID);
      // No append(). Nothing produced. Retention still has to be a no-op, not
      // a database error.
      expect(await store.pruneAcknowledgedBefore(new Date())).toBe(0);
      expect(await store.acknowledgedThrough()).toBe(0);
    });
  });

  it('advances acknowledgement only across a durable prefix and prunes only old acknowledged rows', async () => {
    await withPostgresTestEnvironment('host_audit_cursor', async () => {
      const db = await initTestDb({ fresh: true });
      const store = createAuditStore(db, HOST_ID);
      const old = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();

      await store.append((seq) => buildEvent(1, seq, old));
      await store.append((seq) => buildEvent(2, seq, old));
      await store.append((seq) => buildEvent(3, seq, old));
      expect(await store.acknowledgedThrough()).toBe(0);

      await store.advanceAcknowledgement(1);
      expect(await store.acknowledgedThrough()).toBe(1);
      expect(await store.pruneAcknowledgedBefore(new Date(Date.now() - 12 * 60 * 60 * 1000))).toBe(1);
      expect((await store.readAfter(0, 10)).map(({ event }) => event.seq)).toEqual([2, 3]);

      await expect(store.advanceAcknowledgement(0)).rejects.toThrow(/backwards/i);
      await store.advanceAcknowledgement(3);
      await expect(
        db.run(
          'UPDATE host_audit_delivery_state SET pruned_through_seq = 3 WHERE host_id = ?',
          HOST_ID,
        ),
      ).rejects.toThrow(/retained rows/i);
      await expect(
        db.transaction(async () => {
          await db.get(`SELECT set_config('nanoclaw.host_audit_prune_host', ?, true)`, HOST_ID);
          await db.get(`SELECT set_config('nanoclaw.host_audit_prune_through', '3', true)`);
          await db.get(
            `SELECT set_config('nanoclaw.host_audit_prune_before', ?, true)`,
            new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
          );
          await db.get(
            `SELECT set_config('nanoclaw.host_audit_prune_updated_at', ?, true)`,
            new Date().toISOString(),
          );
          await db.run('DELETE FROM host_audit_events WHERE host_id = ? AND seq = 3', HOST_ID);
        }),
      ).rejects.toThrow(/contiguous acknowledged prefix/i);
      expect(await store.pruneAcknowledgedBefore(new Date(Date.now() - 12 * 60 * 60 * 1000))).toBe(2);
      expect(await store.readAfter(0, 10)).toEqual([]);
    });
  });

  it('prunes a large acknowledged backlog in bounded contiguous pages', async () => {
    await withPostgresTestEnvironment('host_audit_bounded_prune', async () => {
      const db = await initTestDb({ fresh: true });
      const store = createAuditStore(db, HOST_ID);
      const old = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
      for (let index = 1; index <= 513; index++) {
        await store.append((seq) => buildEvent(index, seq, old));
      }
      await store.advanceAcknowledgement(513);
      const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);

      expect(await store.pruneAcknowledgedBefore(cutoff)).toBe(512);
      expect((await store.readAfter(0, 2)).map(({ event }) => event.seq)).toEqual([513]);
      expect(await store.pruneAcknowledgedBefore(cutoff)).toBe(1);
      expect(await store.readAfter(0, 2)).toEqual([]);
    });
  });

  it('replays identical committed bytes when Governance accepts before the DB cursor commits', async () => {
    await withPostgresTestEnvironment('host_audit_replay', async () => {
      const db = await initTestDb({ fresh: true });
      const store = createAuditStore(db, HOST_ID);
      for (let index = 1; index <= 3; index++) {
        await store.append((seq) => buildEvent(index, seq));
      }

      const bodies: Buffer[] = [];
      let withholdFirstAck = true;
      const send = async (batch: { body: Buffer; lastSeq: number; batch: { items: unknown[] } }) => {
        bodies.push(Buffer.from(batch.body));
        if (withholdFirstAck) {
          withholdFirstAck = false;
          throw new Error('simulated acknowledgement loss after Governance commit');
        }
        return { kind: 'acknowledged' as const, ack: {
          schema_version: 'nanoco.host-audit.v1' as const,
          status: 'accepted' as const,
          host_id: HOST_ID,
          acked_through_seq: batch.lastSeq,
          accepted: 0,
          duplicates: batch.batch.items.length,
        } };
      };

      await expect(drainGovernanceQueue(send, store)).rejects.toThrow(/acknowledgement loss/);
      expect(await store.acknowledgedThrough()).toBe(0);
      await expect(drainGovernanceQueue(send, store)).resolves.toBe(3);
      expect(await store.acknowledgedThrough()).toBe(3);
      expect(bodies).toHaveLength(2);
      expect(bodies[0].equals(bodies[1])).toBe(true);
    });
  });

  it('serves filtered rows and exact NDJSON from the PostgreSQL source', async () => {
    await withPostgresTestEnvironment('host_audit_reader', async () => {
      const db = await initTestDb({ fresh: true });
      const store = createAuditStore(db, HOST_ID);
      for (let index = 1; index <= 3; index++) {
        await store.append((seq) => buildEvent(index, seq));
      }

      const actor = `hmac:${'2'.padStart(64, '0')}`;
      await expect(listAuditEvents({ actor }, store)).resolves.toEqual([
        expect.objectContaining({ actor, seq: 2 }),
      ]);
      const ndjson = await listAuditEvents({ format: 'ndjson', limit: 2 }, store);
      expect(ndjson).toBe(
        (await store.readNewest(null, 2)).map(({ line }) => line).join('\n'),
      );
    });
  });

  it('operates through a DML-only runtime role while owner-only mutations stay refused', async () => {
    await withPostgresTestEnvironment('host_audit_runtime_role', async (context) => {
      const ownerDb = await initTestDb({ fresh: true });
      const active = await ownerDb.get<{ schema: string }>('SELECT current_schema() AS schema');
      if (!active?.schema) throw new Error('PostgreSQL test schema is unavailable');
      const role = `nc_audit_rt_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
      const password = randomUUID();
      const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-audit-runtime-role-'));
      const passwordFile = path.join(secretDir, 'password');
      fs.writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
      const quotedRole = `"${role}"`;
      const quotedSchema = `"${active.schema}"`;
      let runtimeDb: PostgresDriver | null = null;

      try {
        await context.admin.query(`CREATE ROLE ${quotedRole} LOGIN PASSWORD '${password}'`);
        await context.admin.query(`GRANT USAGE ON SCHEMA ${quotedSchema} TO ${quotedRole}`);
        await context.admin.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quotedSchema} TO ${quotedRole}`,
        );

        const runtimeUrl = new URL(context.runtimeUrl);
        runtimeUrl.username = role;
        runtimeDb = await PostgresDriver.create(
          {
            path: '',
            url: runtimeUrl.toString(),
            passwordFile,
            schema: active.schema,
            hostLock: false,
          },
          { role: 'host' },
        );
        const store = createAuditStore(runtimeDb, HOST_ID);
        await store.initialize();
        const old = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
        await store.append((seq) => buildEvent(1, seq, old));
        await store.advanceAcknowledgement(1);
        expect(await store.pruneAcknowledgedBefore(new Date(Date.now() - 12 * 60 * 60 * 1000))).toBe(1);

        await expect(
          runtimeDb.run('DELETE FROM host_audit_delivery_state WHERE host_id = ?', HOST_ID),
        ).rejects.toThrow(/cannot be deleted/i);
        await expect(
          runtimeDb.run('CREATE TABLE forbidden_runtime_ddl (id TEXT PRIMARY KEY)'),
        ).rejects.toThrow();
      } finally {
        await runtimeDb?.close();
        await closeDb();
        await context.admin.query(`DROP OWNED BY ${quotedRole}`);
        await context.admin.query(`DROP ROLE ${quotedRole}`);
        fs.rmSync(secretDir, { recursive: true, force: true });
      }
    });
  });
});
