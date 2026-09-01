import { gatewayUnsignedFetch, type MailboxFetch } from './gateway-fetch.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  LISTING_RECONCILE_AFTER_MS,
  changePointerBody,
  changePointerKey,
  changePointerReadHeaders,
} from './wire.generated.js';

import { createMailboxOperations, type InboundData, type OutboundData } from './operations.js';
import type { AgentMailbox, MailboxOperations, MailboxSessionKey, OutboundMessageDraft } from '../../mailbox/types.js';
import { createOutboundRecord, parseMailboxRecord } from '../../mailbox/model.generated.js';
import type { MailboxRecordByKind, MailboxRecordKind } from '../../mailbox/model.generated.js';

export interface S3MailboxOptions {
  endpoint: string;
  bucket: string;
  prefix?: string;
  region: string;
}


interface StoredRecord {
  json: string;
  etag: string;
}

type MailboxSide = 'inbound' | 'outbound';

interface RecordTable<K extends MailboxRecordKind> {
  readonly name: string;
  readonly recordType: K;
  readonly records: Map<string, MailboxRecordByKind[K]>;
}

interface InboundTables {
  messages: RecordTable<'inbound'>;
  deliveries: RecordTable<'delivery'>;
  destinations: RecordTable<'destination'>;
  routing: RecordTable<'sessionRouting'>;
}

interface OutboundTables {
  messages: RecordTable<'outbound'>;
  acknowledgements: RecordTable<'processingAck'>;
  state: RecordTable<'state'>;
  container: RecordTable<'container'>;
}

interface CachedSide<T> {
  tables: T;
  persisted: Map<string, StoredRecord>;
  /** Listed objects we could not parse: left untouched in S3, never flushed or deleted. */
  foreign: Map<string, StoredRecord>;
  /** ETag of this side's change pointer when we last synced, or null when unknown. */
  changeEtag: string | null;
  /** When this side last listed for real. 0 = never. */
  lastListedAtMs: number;
}


interface SyncTiming {
  minMs: number;
  maxMs: number;
}

/**
 * How long the agent may wait before looking again.
 *
 * The ceiling is the dominant term in a warm reply: an idle agent had backed
 * off to five seconds, so a message could sit unseen for five of the ten
 * seconds a one-word answer took end to end (measured on nancy-v3,
 * 2026-09-01). It was set when every look cost a LIST of the whole prefix.
 * A look is now a conditional GET that answers 304 on an idle side, roughly a
 * twelfth the price and a fraction of the bytes, so the ceiling can come down
 * to where latency wants it rather than where cost forced it.
 */
const DEFAULT_SYNC_TIMING: SyncTiming = { minMs: 500, maxMs: 1_000 };
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const S3_FORMAT_VERSION = 1;

export function nextMailboxSyncDelay(currentMs: number, changed: boolean, timing = DEFAULT_SYNC_TIMING): number {
  if (!Number.isFinite(timing.minMs) || timing.minMs <= 0) throw new Error('mailbox sync minMs must be positive');
  if (!Number.isFinite(timing.maxMs) || timing.maxMs < timing.minMs)
    throw new Error('mailbox sync maxMs must be at least minMs');
  return changed ? timing.minMs : Math.min(timing.maxMs, Math.max(timing.minMs, currentMs * 2));
}

class MailboxObjectTooLargeError extends Error {}

function recordKey<K extends MailboxRecordKind>(kind: K, record: MailboxRecordByKind[K]): string {
  const value = parseMailboxRecord(kind, record);
  switch (kind) {
    case 'inbound':
    case 'outbound':
      return (value as MailboxRecordByKind['inbound'] | MailboxRecordByKind['outbound']).id;
    case 'processingAck':
      return (value as MailboxRecordByKind['processingAck']).messageId;
    case 'delivery':
      return (value as MailboxRecordByKind['delivery']).messageOutId;
    case 'destination':
      return (value as MailboxRecordByKind['destination']).name;
    case 'sessionRouting':
      return 'routing';
    case 'state':
      return (value as MailboxRecordByKind['state']).key;
    case 'container':
      return 'container';
  }
}

function encodeRecord<K extends MailboxRecordKind>(recordType: K, record: MailboxRecordByKind[K]): string {
  return JSON.stringify({
    modelVersion: S3_FORMAT_VERSION,
    recordType,
    record: parseMailboxRecord(recordType, record),
  });
}

function decodeRecord<K extends MailboxRecordKind>(recordType: K, json: string): MailboxRecordByKind[K] {
  const value = JSON.parse(json) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid S3 mailbox envelope');
  const envelope = value as Record<string, unknown>;
  const keys = Object.keys(envelope);
  if (keys.length !== 3 || !['modelVersion', 'recordType', 'record'].every((key) => keys.includes(key)))
    throw new Error('invalid S3 mailbox envelope fields');
  if (envelope.modelVersion !== S3_FORMAT_VERSION)
    throw new Error(`unsupported S3 mailbox format version: ${String(envelope.modelVersion)}`);
  if (envelope.recordType !== recordType)
    throw new Error(`unexpected S3 mailbox record type: ${String(envelope.recordType)}`);
  return parseMailboxRecord(recordType, envelope.record);
}


export class S3AgentMailbox implements AgentMailbox {
  readonly operations: MailboxOperations;

  private readonly client: MailboxFetch;
  private sessionPrefix = '';
  private readonly inboundSide: CachedSide<InboundTables> = {
    tables: makeInboundTables(),
    persisted: new Map(),
    foreign: new Map(),
    changeEtag: null,
    lastListedAtMs: 0,
  };
  private readonly outboundSide: CachedSide<OutboundTables> = {
    tables: makeOutboundTables(),
    persisted: new Map(),
    foreign: new Map(),
    changeEtag: null,
    lastListedAtMs: 0,
  };
  private readonly inbound = inboundData(this.inboundSide);
  private readonly outbound = outboundData(this.outboundSide);
  private readonly reportedBadObjects = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerSyncPending = false;
  private syncDelayMs: number;
  private running = false;
  private backgroundSyncMode: 'always' | 'during-action' = 'always';
  private flushGeneration = 0;
  private flushPending = false;
  private syncTail = Promise.resolve(false);
  private actionTail = Promise.resolve();

  constructor(
    private readonly options: S3MailboxOptions,
    client?: MailboxFetch,
    private readonly syncTiming: SyncTiming = DEFAULT_SYNC_TIMING,
  ) {
    validateOptions(options);
    nextMailboxSyncDelay(syncTiming.minMs, true, syncTiming);
    this.syncDelayMs = syncTiming.minMs;
    this.client = client ?? gatewayUnsignedFetch(process.env.HTTPS_PROXY);
    const operations = createMailboxOperations(this.inbound, this.outbound, (message) => this.writeMessageOut(message));
    // Processing acks are the host's completion/kill signal and continuation
    // state is the crash-resume anchor. The seam keeps these methods
    // synchronous, so full durability-before-return is impossible here — but
    // an immediate queued flush shrinks the loss window from the background poll
    // to the next tick of the event loop.
    this.operations = {
      ...operations,
      markMessages: (ids, status) => {
        operations.markMessages(ids, status);
        this.syncSoon();
      },
      markScriptSkipped: (skips) => {
        operations.markScriptSkipped(skips);
        this.syncSoon();
      },
      clearStaleProcessingAcks: () => {
        operations.clearStaleProcessingAcks();
        this.syncSoon();
      },
      setState: (key, value) => {
        operations.setState(key, value);
        this.syncSoon();
      },
      deleteState: (key) => {
        operations.deleteState(key);
        this.syncSoon();
      },
    };
  }

  async start(key: MailboxSessionKey | null): Promise<void> {
    if (!key) throw new Error('invalid S3 request capability');
    const capability = requestCapability(key.mailbox);
    this.sessionPrefix = [
      normalizePrefix(this.options.prefix ?? ''),
      'v2',
      'agent-groups',
      keySegment(key.agentGroupId, 'agentGroupId'),
      'sessions',
      keySegment(key.sessionId, 'sessionId'),
      'capabilities',
      capability,
    ]
      .filter(Boolean)
      .join('/');
    this.client.bindCapability?.(capability);
    await Promise.all([
      this.load('inbound', this.inboundSide, makeInboundTables, copyInbound, loadInbound),
      this.load('outbound', this.outboundSide, makeOutboundTables, copyOutbound, loadOutbound),
    ]);
    if (this.backgroundSyncMode === 'always') this.startBackgroundSync();
  }

  async stop(): Promise<void> {
    this.stopBackgroundSync();
    await this.queueFlush();
  }

  setBackgroundSyncMode(mode: 'always' | 'during-action'): void {
    if (this.sessionPrefix) throw new Error('mailbox background sync mode must be selected before start');
    this.backgroundSyncMode = mode;
  }

  async run<T>(action: () => T | Promise<T>): Promise<T> {
    const previous = this.actionTail.catch(() => {});
    let release!: () => void;
    const turn = new Promise<void>((resolve) => (release = resolve));
    this.actionTail = previous.then(() => turn);
    await previous;
    const scopedBackgroundSync = this.backgroundSyncMode === 'during-action' && !this.running;
    if (scopedBackgroundSync) this.startBackgroundSync();
    try {
      await this.queueSync();
      return await action();
    } finally {
      try {
        await this.queueFlush();
      } finally {
        if (scopedBackgroundSync) this.stopBackgroundSync();
        release();
      }
    }
  }

  private async writeMessageOut(message: OutboundMessageDraft): Promise<number> {
    if (this.outbound.messages.has(message.id)) throw new Error(`duplicate mailbox record: ${message.id}`);
    const sequence = await this.allocateSequence();
    this.outbound.messages.set(message.id, createOutboundRecord(message, sequence, new Date().toISOString()));
    await this.queueFlush();
    return sequence;
  }

  private async allocateSequence(): Promise<number> {
    const objectKey = `${this.sessionKey()}/meta/sequence.json`;
    const localMax = Math.max(
      ...[...this.inbound.messages.values(), ...this.outbound.messages.values()].map(({ sequence }) => sequence ?? 0),
      0,
    );
    for (;;) {
      const current = await this.client.fetch(this.objectUrl(objectKey));
      let value = localMax;
      let etag: string | undefined;
      if (current.status !== 404) {
        await requireOk(current, this.options.bucket, objectKey);
        value = Math.max(value, sequenceValue(await current.text(), objectKey));
        etag = requireVersion(current, this.options.bucket, objectKey);
      }
      const next = value % 2 === 0 ? value + 1 : value + 2;
      const response = await this.client.fetch(this.objectUrl(objectKey), {
        method: 'PUT',
        body: JSON.stringify({ value: next }),
        headers: {
          'content-type': 'application/json',
          [etag ? 'if-match' : 'if-none-match']: etag ?? '*',
        },
      });
      // 412 = lost the CAS race; 409 = AWS "conditional request conflict"
      // (another conditional write in flight on the same key). Both retriable.
      if (response.status === 412 || response.status === 409) continue;
      await requireOk(response, this.options.bucket, objectKey);
      return next;
    }
  }

  private scheduleSync(): void {
    if (!this.running) return;
    if (this.timerSyncPending) {
      this.armSync();
      return;
    }
    this.timerSyncPending = true;
    void this.queueSync()
      .then((changed) => {
        this.syncDelayMs = nextMailboxSyncDelay(this.syncDelayMs, changed, this.syncTiming);
      })
      .catch((error) =>
        console.error(`[s3-mailbox] sync failed: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        this.timerSyncPending = false;
        this.armSync();
      });
  }

  private armSync(): void {
    if (!this.running || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scheduleSync();
    }, this.syncDelayMs);
  }

  private startBackgroundSync(): void {
    if (this.running) return;
    this.running = true;
    this.syncDelayMs = this.syncTiming.minMs;
    this.armSync();
  }

  private stopBackgroundSync(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Queue an immediate flush for a durability-sensitive sync mutation. */
  private syncSoon(): void {
    this.flushGeneration += 1;
    this.startQueuedFlush();
  }

  private startQueuedFlush(): void {
    if (this.flushPending) return;
    this.flushPending = true;
    const generation = this.flushGeneration;
    void this.queueFlush()
      .catch((error) =>
        console.error(`[s3-mailbox] flush failed: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        this.flushPending = false;
        if (this.flushGeneration !== generation) this.startQueuedFlush();
      });
  }

  private queueSync(): Promise<boolean> {
    const sync = this.syncTail
      .catch(() => false)
      .then(async () => {
        const inboundChanged = await this.refreshInbound();
        const outboundFlushed = await this.flushOutbound();
        const outboundChanged = await this.refreshOutbound();
        return inboundChanged || outboundFlushed || outboundChanged;
      });
    this.syncTail = sync;
    return sync;
  }

  /** Serialize a local durability flush with background refreshes, but do not
   * turn every state/ack mutation into two remote prefix listings. Sibling
   * process discovery remains the background sync's responsibility. */
  private queueFlush(): Promise<boolean> {
    const flush = this.syncTail.catch(() => false).then(() => this.flushOutbound());
    this.syncTail = flush;
    return flush;
  }

  private knownEtag<T>(side: CachedSide<T>, key: string, etag: string): boolean {
    return side.persisted.get(key)?.etag === etag || side.foreign.get(key)?.etag === etag;
  }

  private unchanged<T>(side: CachedSide<T>, listed: Array<{ key: string; etag: string }>): boolean {
    return (
      listed.length === side.persisted.size + side.foreign.size &&
      listed.every(({ key, etag }) => this.knownEtag(side, key, etag))
    );
  }

  private async refreshInbound(): Promise<boolean> {
    // The Host bumps this side's pointer whenever it stores an inbound
    // message, so a 304 means there is nothing new to read and the agent skips
    // the listing entirely. A changed pointer still lists — the listing is the
    // record, the pointer only says whether to consult it.
    if (await this.sideUnchanged('inbound', this.inboundSide)) return false;
    const listed = await this.list(this.baseKey('inbound'));
    this.inboundSide.lastListedAtMs = Date.now();
    if (this.unchanged(this.inboundSide, listed)) return false;
    await this.load('inbound', this.inboundSide, makeInboundTables, copyInbound, loadInbound, listed);
    return true;
  }

  private async refreshOutbound(): Promise<boolean> {
    const baseKey = this.baseKey('outbound');
    const listed = await this.list(baseKey);
    if (this.unchanged(this.outboundSide, listed)) return false;

    const remote = new Map<string, StoredRecord>();
    const foreignNext = new Map<string, StoredRecord>();
    for (const { key: objectKey, etag } of listed) {
      const foreign = this.outboundSide.foreign.get(objectKey);
      if (foreign?.etag === etag) {
        foreignNext.set(objectKey, foreign);
        continue;
      }
      const cached = this.outboundSide.persisted.get(objectKey);
      try {
        remote.set(objectKey, {
          json: cached?.etag === etag ? cached.json : await this.readObject(objectKey),
          etag,
        });
      } catch (error) {
        if (!(error instanceof MailboxObjectTooLargeError)) throw error;
        this.reportBadObject(objectKey, etag, error);
        foreignNext.set(objectKey, { json: '', etag });
      }
    }
    this.outboundSide.foreign = foreignNext;

    const current = snapshotOutbound(this.outboundSide.tables, baseKey);
    const dirty = new Set(
      [...new Set([...current.keys(), ...this.outboundSide.persisted.keys()])].filter(
        (objectKey) => current.get(objectKey) !== this.outboundSide.persisted.get(objectKey)?.json,
      ),
    );

    for (const [objectKey, json] of current) {
      if (dirty.has(objectKey) || remote.has(objectKey)) continue;
      removeOutbound(this.outboundSide.tables, baseKey, objectKey, json);
      this.outboundSide.persisted.delete(objectKey);
    }
    for (const [objectKey, record] of remote) {
      if (!dirty.has(objectKey)) this.adoptRecord(objectKey, record);
    }
    for (const objectKey of this.outboundSide.persisted.keys()) {
      if (!dirty.has(objectKey) && !remote.has(objectKey)) this.outboundSide.persisted.delete(objectKey);
    }
    return true;
  }

  private async flushOutbound(): Promise<boolean> {
    let changed = false;
    const current = snapshotOutbound(this.outboundSide.tables, this.baseKey('outbound'));
    for (const [objectKey, previous] of this.outboundSide.persisted) {
      if (current.has(objectKey)) continue;
      const response = await this.deleteObject(objectKey, previous.etag);
      if (response.status === 412 || response.status === 409) {
        await this.adoptRemote(objectKey);
        throw new Error(`outbound mailbox changed concurrently: ${objectKey}`);
      }
      if (response.status !== 404) await requireOk(response, this.options.bucket, objectKey);
      this.outboundSide.persisted.delete(objectKey);
      changed = true;
    }

    for (const [objectKey, json] of current) {
      for (let attempt = 0; ; attempt++) {
        const previous = this.outboundSide.persisted.get(objectKey);
        if (previous?.json === json) break;
        const response = await this.client.fetch(this.objectUrl(objectKey), {
          method: 'PUT',
          body: json,
          headers: {
            'content-type': 'application/json',
            [previous ? 'if-match' : 'if-none-match']: previous?.etag ?? '*',
          },
        });
        // 409 = AWS conditional-write-in-progress; walk the same
        // read-remote-and-reconcile ladder as a lost 412 race.
        if (response.status !== 412 && response.status !== 409) {
          await requireOk(response, this.options.bucket, objectKey);
          this.outboundSide.persisted.set(objectKey, {
            json,
            etag: requireVersion(response, this.options.bucket, objectKey),
          });
          changed = true;
          break;
        }

        const remote = await this.readVersionedObject(objectKey);
        if (!remote) continue;
        if (remote.json === json) {
          this.outboundSide.persisted.set(objectKey, remote);
          break;
        }
        if (!previous || attempt === 1) {
          this.adoptRecord(objectKey, remote);
          throw new Error(`outbound mailbox changed concurrently: ${objectKey}`);
        }
        this.outboundSide.persisted.set(objectKey, remote);
      }
    }
    // Last, and only on a real change: without this the Host's own conditional
    // read answers 304 and the agent's reply waits for a reconcile listing.
    // The two stores share one protocol; this is the agent's half of it.
    if (changed) await this.bumpChangePointer('outbound', this.outboundSide);
    return changed;
  }

  private async materializeInboundAttachments(tables: InboundTables): Promise<void> {
    for (const message of tables.messages.records.values()) {
      let parsed: { attachments?: Array<Record<string, unknown>> };
      try {
        parsed = JSON.parse(message.content) as { attachments?: Array<Record<string, unknown>> };
      } catch {
        continue;
      }
      if (!Array.isArray(parsed.attachments)) continue;
      for (const att of parsed.attachments) {
        if (typeof att.localPath !== 'string' || typeof att.name !== 'string') continue;
        const parts = att.localPath.split('/');
        if (parts.length !== 3 || parts[0] !== 'inbox' || parts[1] !== message.id) continue;
        const targetDir = path.join(process.env.NANOCLAW_WORKSPACE_ROOT ?? process.cwd(), 'inbox', message.id);
        const targetPath = path.join(targetDir, parts[2]);
        if (fs.existsSync(targetPath)) continue;
        const objectKey = this.attachmentKey(message.id, parts[2]);
        const response = await this.client.fetch(this.objectUrl(objectKey));
        if (response.status === 404) continue;
        await requireOk(response, this.options.bucket, objectKey);
        await fs.promises.mkdir(targetDir, { recursive: true });
        await fs.promises.writeFile(targetPath, Buffer.from(await response.arrayBuffer()), { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      }
    }
  }

  private attachmentKey(messageId: string, filename: string): string {
    return `${this.sessionKey()}/attachments/${keySegment(messageId, 'message id')}/${keySegment(filename, 'attachment filename')}`;
  }

  /** Whether this side is provably unchanged since our last sync. */
  private async sideUnchanged<T>(side: 'inbound' | 'outbound', state: CachedSide<T>): Promise<boolean> {
    if (Date.now() - state.lastListedAtMs >= LISTING_RECONCILE_AFTER_MS) return false;
    try {
      const known = state.changeEtag;
      const response = await this.client.fetch(this.objectUrl(changePointerKey(this.sessionKey(), side)), {
        headers: changePointerReadHeaders(known),
      });
      if (response.status === 304) {
        return true;
      }
      await response.text().catch(() => '');
      state.changeEtag = response.ok ? response.headers.get('etag') : null;
      return false;
    } catch {
      state.changeEtag = null;
      return false;
    }
  }

  /** Rewrite this side's change pointer so the Host learns the side moved. */
  private async bumpChangePointer<T>(side: 'inbound' | 'outbound', state: CachedSide<T>): Promise<void> {
    const objectKey = changePointerKey(this.sessionKey(), side);
    try {
      const response = await this.client.fetch(this.objectUrl(objectKey), {
        method: 'PUT',
        body: changePointerBody(randomBytes(16).toString('hex')),
        headers: { 'content-type': 'application/json' },
      });
      await requireOk(response, this.options.bucket, objectKey);
      state.changeEtag = response.headers.get('etag');
      state.lastListedAtMs = Date.now();
    } catch {
      state.changeEtag = null;
    }
  }

  private async deleteObject(objectKey: string, etag: string): Promise<Response> {
    return this.client.fetch(this.objectUrl(objectKey), {
      method: 'DELETE',
      headers: { 'if-match': etag },
    });
  }

  private async adoptRemote(objectKey: string): Promise<void> {
    const remote = await this.readVersionedObject(objectKey);
    if (!remote) {
      this.outboundSide.persisted.delete(objectKey);
      return;
    }
    this.adoptRecord(objectKey, remote);
  }

  private adoptRecord(objectKey: string, record: StoredRecord): void {
    try {
      loadOutbound(this.outboundSide.tables, this.baseKey('outbound'), objectKey, record.json);
      this.outboundSide.persisted.set(objectKey, record);
    } catch (error) {
      this.reportBadObject(objectKey, record.etag, error);
      this.outboundSide.persisted.delete(objectKey);
      this.outboundSide.foreign.set(objectKey, record);
    }
  }

  private async readVersionedObject(objectKey: string): Promise<StoredRecord | undefined> {
    const response = await this.client.fetch(this.objectUrl(objectKey));
    if (response.status === 404) return undefined;
    await requireOk(response, this.options.bucket, objectKey);
    return {
      json: await readBodyCapped(response, this.options.bucket, objectKey),
      etag: requireVersion(response, this.options.bucket, objectKey),
    };
  }

  private async load<T>(
    sideName: MailboxSide,
    side: CachedSide<T>,
    make: () => T,
    copy: (from: T, to: T) => void,
    loadOne: (tables: T, baseKey: string, objectKey: string, json: string) => void,
    listed?: Array<{ key: string; etag: string }>,
  ): Promise<void> {
    const baseKey = this.baseKey(sideName);
    const objects = listed ?? (await this.list(baseKey));
    const previous = side.persisted;
    const previousForeign = side.foreign;
    const next = new Map<string, StoredRecord>();
    const foreign = new Map<string, StoredRecord>();
    // Parse into staging tables first and swap only on completion, so a bad
    // object can never leave the live cache cleared or half-populated. A bad
    // object's blast radius is itself: skipped, reported once, and left
    // untouched in S3 (never flushed or deleted) for later recovery.
    const staging = make();
    for (const { key: objectKey, etag } of objects) {
      const cached = previous.get(objectKey) ?? previousForeign.get(objectKey);
      let json: string;
      try {
        json = cached?.etag === etag ? cached.json : await this.readObject(objectKey);
      } catch (error) {
        if (!(error instanceof MailboxObjectTooLargeError)) throw error;
        this.reportBadObject(objectKey, etag, error);
        foreign.set(objectKey, { json: '', etag });
        continue;
      }
      try {
        loadOne(staging, baseKey, objectKey, json);
        next.set(objectKey, { json, etag });
      } catch (error) {
        this.reportBadObject(objectKey, etag, error);
        foreign.set(objectKey, { json, etag });
      }
    }
    if (sideName === 'inbound') await this.materializeInboundAttachments(staging as InboundTables);
    copy(staging, side.tables);
    side.persisted = next;
    side.foreign = foreign;
  }

  private reportBadObject(objectKey: string, etag: string, error: unknown): void {
    const reportKey = `${objectKey}\0${etag}`;
    if (this.reportedBadObjects.has(reportKey)) return;
    this.reportedBadObjects.add(reportKey);
    console.error(
      `[s3-mailbox] skipping unreadable mailbox object (left untouched in S3): ${objectKey}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  private sessionKey(): string {
    if (!this.sessionPrefix) throw new Error('S3 mailbox not started');
    return this.sessionPrefix;
  }

  private baseKey(side: MailboxSide): string {
    return `${this.sessionKey()}/${side}`;
  }

  private async list(prefix: string): Promise<Array<{ key: string; etag: string }>> {
    const records: Array<{ key: string; etag: string }> = [];
    let continuation: string | undefined;
    do {
      const query = new URLSearchParams({
        'list-type': '2',
        prefix: `${prefix}/`,
      });
      if (continuation) query.set('continuation-token', continuation);
      const response = await this.client.fetch(`${this.bucketUrl()}?${query}`);
      await requireOk(response, this.options.bucket, prefix);
      const xml = await response.text();
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const objectKey = xmlValue(match[1], 'Key');
        const etag = xmlValue(match[1], 'ETag');
        if (objectKey && etag) records.push({ key: objectKey, etag });
      }
      continuation = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? xmlValue(xml, 'NextContinuationToken') || undefined
        : undefined;
    } while (continuation);
    return records;
  }

  private async readObject(key: string): Promise<string> {
    const response = await this.client.fetch(this.objectUrl(key));
    await requireOk(response, this.options.bucket, key);
    return readBodyCapped(response, this.options.bucket, key);
  }

  private bucketUrl(): string {
    return `${this.options.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(this.options.bucket)}`;
  }

  private objectUrl(key: string): string {
    return `${this.bucketUrl()}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
}

async function readBodyCapped(response: Response, bucket: string, key: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_OBJECT_BYTES) {
    response.body?.cancel().catch(() => {});
    throw new MailboxObjectTooLargeError(
      `S3 mailbox object too large for s3://${bucket}/${key}: ${declared} bytes`,
    );
  }
  const text = await response.text();
  if (text.length > MAX_OBJECT_BYTES)
    throw new MailboxObjectTooLargeError(`S3 mailbox object too large for s3://${bucket}/${key}`);
  return text;
}

function table<K extends MailboxRecordKind>(name: string, recordType: K): RecordTable<K> {
  return { name, recordType, records: new Map() };
}

function makeInboundTables(): InboundTables {
  return {
    messages: table('messages', 'inbound'),
    deliveries: table('deliveries', 'delivery'),
    destinations: table('destinations', 'destination'),
    routing: table('routing', 'sessionRouting'),
  };
}

function makeOutboundTables(): OutboundTables {
  return {
    messages: table('messages', 'outbound'),
    acknowledgements: table('acknowledgements', 'processingAck'),
    state: table('state', 'state'),
    container: table('container', 'container'),
  };
}

function inboundData(side: CachedSide<InboundTables>): InboundData {
  return {
    messages: side.tables.messages.records,
    deliveries: side.tables.deliveries.records,
    destinations: side.tables.destinations.records,
    routing: side.tables.routing.records,
  };
}

function outboundData(side: CachedSide<OutboundTables>): OutboundData {
  return {
    messages: side.tables.messages.records,
    acknowledgements: side.tables.acknowledgements.records,
    state: side.tables.state.records,
    container: side.tables.container.records,
  };
}

function copyRecords<T>(from: Map<string, T>, to: Map<string, T>): void {
  to.clear();
  for (const [id, row] of from) to.set(id, row);
}

function copyInbound(from: InboundTables, to: InboundTables): void {
  copyRecords(from.messages.records, to.messages.records);
  copyRecords(from.deliveries.records, to.deliveries.records);
  copyRecords(from.destinations.records, to.destinations.records);
  copyRecords(from.routing.records, to.routing.records);
}

function copyOutbound(from: OutboundTables, to: OutboundTables): void {
  copyRecords(from.messages.records, to.messages.records);
  copyRecords(from.acknowledgements.records, to.acknowledgements.records);
  copyRecords(from.state.records, to.state.records);
  copyRecords(from.container.records, to.container.records);
}

function snapshotTable<K extends MailboxRecordKind>(
  records: Map<string, string>,
  entry: RecordTable<K>,
  baseKey: string,
): void {
  for (const row of entry.records.values()) {
    const id = recordKey(entry.recordType, row);
    records.set(`${baseKey}/${entry.name}/${recordKeySegment(id, 'record key')}.json`, encodeRecord(entry.recordType, row));
  }
}

function snapshotOutbound(tables: OutboundTables, baseKey: string): Map<string, string> {
  const records = new Map<string, string>();
  snapshotTable(records, tables.messages, baseKey);
  snapshotTable(records, tables.acknowledgements, baseKey);
  snapshotTable(records, tables.state, baseKey);
  snapshotTable(records, tables.container, baseKey);
  return records;
}

function loadTable<K extends MailboxRecordKind>(
  entry: RecordTable<K>,
  baseKey: string,
  objectKey: string,
  json: string,
): string {
  const row = decodeRecord(entry.recordType, json);
  const id = recordKey(entry.recordType, row);
  const expected = `${baseKey}/${entry.name}/${recordKeySegment(id, 'record key')}.json`;
  if (objectKey !== expected) throw new Error(`S3 mailbox key does not match record identity: ${objectKey}`);
  entry.records.set(id, row);
  return id;
}

function loadInbound(tables: InboundTables, baseKey: string, objectKey: string, json: string): void {
  const relative = objectKey.startsWith(`${baseKey}/`) ? objectKey.slice(baseKey.length + 1) : '';
  const name = relative.split('/', 1)[0];
  if (name === 'messages') return void loadTable(tables.messages, baseKey, objectKey, json);
  if (name === 'deliveries') return void loadTable(tables.deliveries, baseKey, objectKey, json);
  if (name === 'destinations') return void loadTable(tables.destinations, baseKey, objectKey, json);
  if (name === 'routing') return void loadTable(tables.routing, baseKey, objectKey, json);
  throw new Error(`unexpected object under S3 mailbox prefix: ${objectKey}`);
}

function loadOutbound(tables: OutboundTables, baseKey: string, objectKey: string, json: string): void {
  const relative = objectKey.startsWith(`${baseKey}/`) ? objectKey.slice(baseKey.length + 1) : '';
  const name = relative.split('/', 1)[0];
  if (name === 'messages') return void loadTable(tables.messages, baseKey, objectKey, json);
  if (name === 'acknowledgements') return void loadTable(tables.acknowledgements, baseKey, objectKey, json);
  if (name === 'state') return void loadTable(tables.state, baseKey, objectKey, json);
  if (name === 'container') return void loadTable(tables.container, baseKey, objectKey, json);
  throw new Error(`unexpected object under S3 mailbox prefix: ${objectKey}`);
}

function removeOutbound(tables: OutboundTables, baseKey: string, objectKey: string, json: string): void {
  const relative = objectKey.startsWith(`${baseKey}/`) ? objectKey.slice(baseKey.length + 1) : '';
  const name = relative.split('/', 1)[0];
  if (name === 'messages')
    return void tables.messages.records.delete(loadTable(tables.messages, baseKey, objectKey, json));
  if (name === 'acknowledgements')
    return void tables.acknowledgements.records.delete(loadTable(tables.acknowledgements, baseKey, objectKey, json));
  if (name === 'state') return void tables.state.records.delete(loadTable(tables.state, baseKey, objectKey, json));
  if (name === 'container')
    return void tables.container.records.delete(loadTable(tables.container, baseKey, objectKey, json));
  throw new Error(`unexpected object under S3 mailbox prefix: ${objectKey}`);
}

function sequenceValue(json: string, objectKey: string): number {
  const value = (JSON.parse(json) as { value?: unknown }).value;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`invalid S3 mailbox sequence: ${objectKey}`);
  return value as number;
}

function validateOptions(options: S3MailboxOptions): void {
  if (!options.bucket || options.bucket !== options.bucket.trim() || /[\\/]/.test(options.bucket))
    throw new Error('mailbox bucket must be a bucket name, not a path');
  const url = new URL(options.endpoint);
  if (url.protocol !== 'https:')
    throw new Error('mailbox runner S3 endpoint must use https');
  normalizePrefix(options.prefix ?? '');
}


function normalizePrefix(prefix: string): string {
  if (prefix.includes('\\')) throw new Error('mailbox prefix must use S3 forward slashes');
  const normalized = prefix.replace(/^\/+|\/+$/g, '');
  if (normalized && normalized.split('/').some((part) => !part || part === '.' || part === '..'))
    throw new Error('mailbox prefix must be canonical');
  return normalized;
}

function keySegment(value: string, name: string): string {
  if (!value) throw new Error(`mailbox ${name} must not be empty`);
  try {
    return encodeURIComponent(value).replace(/\./g, '%2E');
  } catch {
    throw new Error(`mailbox ${name} must be well-formed Unicode`);
  }
}

function recordKeySegment(value: string, name: string): string {
  keySegment(value, name);
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : `~${Buffer.from(value).toString('base64url')}`;
}

function requestCapability(value: unknown): string {
  const capability = (value as { capability?: unknown } | null)?.capability;
  if (typeof capability !== 'string' || !/^[a-f0-9]{64}$/.test(capability))
    throw new Error('invalid S3 request capability');
  return capability;
}

function xmlValue(xml: string, tag: string): string {
  const value = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml)?.[1] ?? '';
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function requireOk(response: Response, bucket: string, key: string): Promise<void> {
  if (response.ok) return;
  response.body?.cancel().catch(() => {});
  throw new Error(`S3 mailbox request failed for s3://${bucket}/${key}: ${response.status}`);
}

function requireVersion(response: Response, bucket: string, key: string): string {
  const version = response.headers.get('etag');
  if (!version) throw new Error(`S3 mailbox response missing ETag for s3://${bucket}/${key}`);
  return version;
}
