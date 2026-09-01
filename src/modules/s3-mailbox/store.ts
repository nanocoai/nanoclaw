import { AwsClient } from 'aws4fetch';
import { randomBytes } from 'node:crypto';

import { deriveAttachmentName } from '../../attachment-naming.js';
import { isSafeAttachmentName } from '../../attachment-safety.js';
import { log } from '../../log.js';
import {
  LISTING_RECONCILE_AFTER_MS,
  changePointerBody,
  changePointerKey,
  changePointerReadHeaders,
} from './wire.js';
import { createInboundMailbox, createOutboundMailbox, type InboundData, type OutboundData } from './operations.js';
import type { AgentMailbox, MailboxSession, MailboxSessionKey } from '../../mailbox/types.js';
import { createDirectOutboundRecord, parseMailboxRecord } from '../../mailbox/model.js';
import type { MailboxRecordByKind, MailboxRecordKind } from '../../mailbox/model.js';

type MailboxSide = 'inbound' | 'outbound';

export interface S3MailboxOptions {
  bucket: string;
  prefix?: string;
  endpoint: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  runnerEndpoint?: string;
  initialCapability?: string;
  delegatedListPrefix?: string;
}

export interface SignedFetch {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

interface StoredRecord {
  json: string;
  etag: string;
}

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
  flushQueue: Promise<void>;
  /** ETag of this side's change pointer when we last synced, or null when unknown. */
  changeEtag: string | null;
  /** When this side last listed for real. 0 = never. */
  lastListedAtMs: number;
}

/** Ceiling for a single mailbox object — the host must never buffer a container-written multi-GB body. */
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const S3_FORMAT_VERSION = 1;


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

export class MailboxVersionConflictError extends Error {
  constructor(bucket: string, key: string) {
    super(`mailbox changed before commit: s3://${bucket}/${key}`);
    this.name = 'MailboxVersionConflictError';
  }
}

class MailboxObjectTooLargeError extends Error {}

export class S3AgentMailbox implements AgentMailbox {
  private readonly inboundCache = new Map<string, CachedSide<InboundTables>>();
  private readonly outboundCache = new Map<string, CachedSide<OutboundTables>>();
  private readonly sessions = new Map<string, Promise<void>>();
  private readonly capabilities = new Map<string, Promise<string>>();
  private readonly resolvedCapabilities = new Map<string, string>();
  private readonly prepared = new Set<string>();
  private readonly reportedBadObjects = new Set<string>();
  private readonly client: SignedFetch;

  constructor(
    private readonly options: S3MailboxOptions,
    client?: SignedFetch,
  ) {
    validateOptions(options);
    if (client) {
      this.client = client;
    } else {
      if (!options.accessKeyId || !options.secretAccessKey) {
        throw new Error('direct S3 mailbox transport requires explicit credentials');
      }
      this.client = new AwsClient({
        service: 's3',
        region: options.region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        sessionToken: options.sessionToken,
      });
    }
  }

  async exists(key: MailboxSessionKey): Promise<boolean> {
    return (await this.findCapability(key)) !== undefined;
  }

  prepare(key: MailboxSessionKey): void {
    this.prepared.add(this.cacheKey(key));
  }

  async destroy(key: MailboxSessionKey): Promise<void> {
    const cacheKey = this.cacheKey(key);
    await this.sessions.get(cacheKey);

    const sessionRoot = this.sessionRootKey(key);
    for (const { key: objectKey, etag } of await this.list(sessionRoot)) {
      const response = await this.deleteObject(objectKey, etag);
      if (response.status === 412 || response.status === 409)
        throw new MailboxVersionConflictError(this.options.bucket, objectKey);
      if (response.status !== 404) await requireOk(response, this.options.bucket, objectKey);
    }

    const controlKey = this.controlKey(key);
    const control = await this.client.fetch(this.objectUrl(controlKey));
    if (control.status !== 404) {
      await requireOk(control, this.options.bucket, controlKey);
      const response = await this.deleteObject(controlKey, requireVersion(control, this.options.bucket, controlKey));
      if (response.status === 412 || response.status === 409)
        throw new MailboxVersionConflictError(this.options.bucket, controlKey);
      if (response.status !== 404) await requireOk(response, this.options.bucket, controlKey);
    }
    this.clearSessionCache(cacheKey, sessionRoot);
  }

  async runnerContext(key: MailboxSessionKey): Promise<unknown> {
    return { capability: await this.resolveCapability(key) };
  }

  async runnerEnvironment(_key: MailboxSessionKey): Promise<Record<string, string>> {
    return {
      NANOCLAW_MAILBOX_S3_ENDPOINT: this.options.runnerEndpoint ?? this.options.endpoint,
      NANOCLAW_MAILBOX_S3_BUCKET: this.options.bucket,
      NANOCLAW_MAILBOX_S3_PREFIX: this.options.prefix ?? '',
      NANOCLAW_MAILBOX_S3_REGION: this.options.region,
    };
  }

  async stageInboundAttachments(key: MailboxSessionKey, messageId: string, contentStr: string): Promise<string> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(contentStr);
    } catch {
      return contentStr;
    }
    const attachments = parsed.attachments as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(attachments) || !isSafeAttachmentName(messageId)) return contentStr;

    await this.resolveCapability(key);
    let changed = false;
    for (const att of attachments) {
      if (typeof att.data !== 'string') continue;
      const rawName = deriveAttachmentName(att);
      const filename = isSafeAttachmentName(rawName) ? rawName : `attachment-${Date.now()}`;
      const objectKey = this.attachmentKey(key, messageId, filename);
      const response = await this.client.fetch(this.objectUrl(objectKey), {
        method: 'PUT',
        body: Buffer.from(att.data, 'base64'),
        headers: {
          'content-type': typeof att.mimeType === 'string' ? att.mimeType : 'application/octet-stream',
          'if-none-match': '*',
        },
      });
      if (response.status !== 412 && response.status !== 409) await requireOk(response, this.options.bucket, objectKey);
      att.name = filename;
      att.localPath = `inbox/${messageId}/${filename}`;
      delete att.data;
      changed = true;
    }
    return changed ? JSON.stringify(parsed) : contentStr;
  }

  async session<T>(key: MailboxSessionKey, action: (mailbox: MailboxSession) => T | Promise<T>): Promise<T> {
    const cacheKey = this.cacheKey(key);
    const capability = this.prepared.has(cacheKey)
      ? await this.resolveCapability(key)
      : await this.findCapability(key);
    if (!capability) throw new Error('S3 mailbox does not exist');
    const queueKey = `${key.agentGroupId}\0${key.sessionId}`;
    const previous = this.sessions.get(queueKey) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => (release = resolve));
    const queued = previous.then(() => turn);
    this.sessions.set(queueKey, queued);
    await previous;

    try {
      const inboundSide = this.inboundState(key);
      const outboundSide = this.outboundState(key);
      await Promise.all([
        this.refreshSide(key, 'inbound', inboundSide, snapshotInbound, makeInboundTables, copyInbound, loadInbound),
        this.refreshSide(
          key,
          'outbound',
          outboundSide,
          snapshotOutbound,
          makeOutboundTables,
          copyOutbound,
          loadOutbound,
        ),
      ]);
      const inbound = inboundData(inboundSide);
      const outbound = outboundData(outboundSide);
      const flushInbound = () => this.flushSide(key, 'inbound', inboundSide, snapshotInbound);
      const flushOutbound = () => this.flushSide(key, 'outbound', outboundSide, snapshotOutbound);
      const inboundMailbox = createInboundMailbox(inbound, () => this.allocateSequence(key, inbound, outbound));
      const result = await action({
        ...inboundMailbox,
        ...createOutboundMailbox(outbound, async (message) => {
          if (outbound.messages.has(message.id)) return;
          const sequence = await this.allocateSequence(key, inbound, outbound);
          outbound.messages.set(message.id, createDirectOutboundRecord(message, sequence, new Date().toISOString()));
          await flushOutbound();
        }),
        // Seam contract: the three async writes must be durable when their own
        // promise resolves — callers wake containers on the strength of them.
        insertMessage: async (message) => {
          await inboundMailbox.insertMessage(message);
          await flushInbound();
        },
        insertTask: async (task) => {
          await inboundMailbox.insertTask(task);
          await flushInbound();
        },
      });
      await Promise.all([flushInbound(), flushOutbound()]);
      return result;
    } catch (error) {
      const cacheKey = this.cacheKey(key);
      this.inboundCache.delete(cacheKey);
      this.outboundCache.delete(cacheKey);
      throw error;
    } finally {
      release();
      if (this.sessions.get(queueKey) === queued) this.sessions.delete(queueKey);
    }
  }

  private async allocateSequence(
    key: MailboxSessionKey,
    inbound: InboundData,
    outbound: OutboundData,
  ): Promise<number> {
    const objectKey = this.sequenceKey(key);
    const localMax = Math.max(
      ...[...inbound.messages.values(), ...outbound.messages.values()].map(({ sequence }) => sequence ?? 0),
      0,
    );
    for (;;) {
      const current = await this.client.fetch(this.objectUrl(objectKey));
      let value = localMax;
      let etag: string | undefined;
      if (current.status !== 404) {
        await requireOk(current, this.options.bucket, objectKey);
        value = Math.max(
          value,
          sequenceValue(await readBodyCapped(current, this.options.bucket, objectKey), objectKey),
        );
        etag = requireVersion(current, this.options.bucket, objectKey);
      }
      const next = value < 2 ? 2 : value + 2 - (value % 2);
      const response = await this.client.fetch(this.objectUrl(objectKey), {
        method: 'PUT',
        body: JSON.stringify({ value: next }),
        headers: {
          'content-type': 'application/json',
          [etag ? 'if-match' : 'if-none-match']: etag ?? '*',
        },
      });
      // 412 = lost the CAS race; 409 = AWS "conditional request conflict"
      // (another conditional write in flight on the same key). Both retriable —
      // this is the hottest shared key, so real S3 hits 409 routinely.
      if (response.status === 412 || response.status === 409) continue;
      await requireOk(response, this.options.bucket, objectKey);
      return next;
    }
  }

  private async refreshSide<T>(
    key: MailboxSessionKey,
    sideName: MailboxSide,
    state: CachedSide<T>,
    snapshot: (tables: T, baseKey: string) => Map<string, string>,
    make: () => T,
    copy: (from: T, to: T) => void,
    loadOne: (tables: T, baseKey: string, objectKey: string, json: string) => void,
  ): Promise<void> {
    await state.flushQueue;
    const baseKey = this.baseKey(key, sideName);
    assertClean(snapshot(state.tables, baseKey), state.persisted, sideName);
    // Ask the cheap question first. A side that has not been written since we
    // last synced answers 304 and costs one small conditional GET instead of a
    // full listing — which is the overwhelming majority of refreshes.
    if (await this.sideUnchanged(key, sideName, state)) return;
    const listed = await this.list(baseKey);
    state.lastListedAtMs = Date.now();
    if (
      listed.length === state.persisted.size + state.foreign.size &&
      listed.every(
        ({ key: objectKey, etag }) =>
          state.persisted.get(objectKey)?.etag === etag || state.foreign.get(objectKey)?.etag === etag,
      )
    )
      return;

    // Parse into staging tables and swap only on completion. A bad object's
    // blast radius is itself: skipped, reported once, and tracked as foreign
    // so the flush diff never deletes or overwrites it — a routing, delivery,
    // or sweep session must not wedge (or destroy data) because one record
    // was written by a newer model version or tampered with.
    const next = new Map<string, StoredRecord>();
    const foreign = new Map<string, StoredRecord>();
    const staging = make();
    for (const { key: objectKey, etag } of listed) {
      const cached = state.persisted.get(objectKey) ?? state.foreign.get(objectKey);
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
    copy(staging, state.tables);
    state.persisted = next;
    state.foreign = foreign;
  }

  private reportBadObject(objectKey: string, etag: string, error: unknown): void {
    const reportKey = `${objectKey}\0${etag}`;
    if (this.reportedBadObjects.has(reportKey)) return;
    this.reportedBadObjects.add(reportKey);
    log.error('Skipping unreadable mailbox object — left untouched in S3', {
      objectKey,
      err: error,
    });
  }

  private async flushSide<T>(
    key: MailboxSessionKey,
    sideName: MailboxSide,
    state: CachedSide<T>,
    snapshot: (tables: T, baseKey: string) => Map<string, string>,
  ): Promise<void> {
    state.flushQueue = state.flushQueue
      .catch(() => {})
      .then(async () => {
        const current = snapshot(state.tables, this.baseKey(key, sideName));
        let mutated = false;
        for (const [objectKey, previous] of state.persisted) {
          if (current.has(objectKey)) continue;
          const response = await this.deleteObject(objectKey, previous.etag);
          if (response.status === 412 || response.status === 409)
            throw new MailboxVersionConflictError(this.options.bucket, objectKey);
          if (response.status !== 404) await requireOk(response, this.options.bucket, objectKey);
          state.persisted.delete(objectKey);
          mutated = true;
        }

        for (const [objectKey, json] of current) {
          const previous = state.persisted.get(objectKey);
          if (previous?.json === json) continue;
          const response = await this.client.fetch(this.objectUrl(objectKey), {
            method: 'PUT',
            body: json,
            headers: {
              'content-type': 'application/json',
              [previous ? 'if-match' : 'if-none-match']: previous?.etag ?? '*',
            },
          });
          if (response.status === 412 || response.status === 409)
            throw new MailboxVersionConflictError(this.options.bucket, objectKey);
          await requireOk(response, this.options.bucket, objectKey);
          state.persisted.set(objectKey, {
            json,
            etag: requireVersion(response, this.options.bucket, objectKey),
          });
          mutated = true;
        }

        // Last, and only when the side actually moved: a pointer bumped before
        // the objects land would advertise a state that is not there yet, and
        // a pointer bumped on an empty flush would cost every reader a listing
        // for nothing.
        if (mutated) await this.bumpChangePointer(key, sideName, state);
      });
    await state.flushQueue;
  }

  private async deleteObject(objectKey: string, etag: string): Promise<Response> {
    // ponytail: LocalStack proof mode uses unconditional deletes; restore If-Match when its S3 emulator supports it.
    return this.client.fetch(this.objectUrl(objectKey), {
      method: 'DELETE',
      headers: isLocalStackProof(this.options) ? undefined : { 'if-match': etag },
    });
  }

  private inboundState(key: MailboxSessionKey): CachedSide<InboundTables> {
    const cacheKey = this.cacheKey(key);
    let state = this.inboundCache.get(cacheKey);
    if (!state) {
      state = {
        tables: makeInboundTables(),
        persisted: new Map(),
        foreign: new Map(),
        flushQueue: Promise.resolve(),
        changeEtag: null,
        lastListedAtMs: 0,
      };
      this.inboundCache.set(cacheKey, state);
    }
    return state;
  }

  private outboundState(key: MailboxSessionKey): CachedSide<OutboundTables> {
    const cacheKey = this.cacheKey(key);
    let state = this.outboundCache.get(cacheKey);
    if (!state) {
      state = {
        tables: makeOutboundTables(),
        persisted: new Map(),
        foreign: new Map(),
        flushQueue: Promise.resolve(),
        changeEtag: null,
        lastListedAtMs: 0,
      };
      this.outboundCache.set(cacheKey, state);
    }
    return state;
  }

  private cacheKey(key: MailboxSessionKey): string {
    return `${key.agentGroupId}\0${key.sessionId}`;
  }

  private sessionKey(key: MailboxSessionKey): string {
    const capability = this.resolvedCapabilities.get(this.cacheKey(key));
    if (!capability) throw new Error('S3 request capability was not resolved');
    return this.sessionKeyFor(key, capability);
  }

  private sessionKeyFor(key: MailboxSessionKey, capability: string): string {
    return `${this.sessionRootKey(key)}/capabilities/${capability}`;
  }

  private sessionRootKey(key: MailboxSessionKey): string {
    return [
      normalizePrefix(this.options.prefix ?? ''),
      'v2',
      'agent-groups',
      keySegment(key.agentGroupId, 'agentGroupId'),
      'sessions',
      keySegment(key.sessionId, 'sessionId'),
    ]
      .filter(Boolean)
      .join('/');
  }

  private controlKey(key: MailboxSessionKey): string {
    return [
      normalizePrefix(this.options.prefix ?? ''),
      'v2',
      'control',
      'agent-groups',
      keySegment(key.agentGroupId, 'agentGroupId'),
      'sessions',
      `${keySegment(key.sessionId, 'sessionId')}.json`,
    ]
      .filter(Boolean)
      .join('/');
  }

  private clearSessionCache(cacheKey: string, sessionKey?: string): void {
    this.inboundCache.delete(cacheKey);
    this.outboundCache.delete(cacheKey);
    this.sessions.delete(cacheKey);
    this.capabilities.delete(cacheKey);
    this.resolvedCapabilities.delete(cacheKey);
    this.prepared.delete(cacheKey);
    if (sessionKey)
      for (const reported of this.reportedBadObjects)
        if (reported.startsWith(`${sessionKey}/`)) this.reportedBadObjects.delete(reported);
  }

  private resolveCapability(key: MailboxSessionKey): Promise<string> {
    const cacheKey = `${key.agentGroupId}\0${key.sessionId}`;
    let pending = this.capabilities.get(cacheKey);
    if (!pending) {
      pending = this.loadCapability(key)
        .then((capability) => {
          this.resolvedCapabilities.set(cacheKey, capability);
          return capability;
        })
        .catch((error) => {
          this.capabilities.delete(cacheKey);
          throw error;
        });
      this.capabilities.set(cacheKey, pending);
    }
    return pending;
  }

  private async findCapability(key: MailboxSessionKey): Promise<string | undefined> {
    const cacheKey = this.cacheKey(key);
    const resolved = this.resolvedCapabilities.get(cacheKey);
    if (resolved) return resolved;
    const objectKey = this.controlKey(key);
    const current = await this.client.fetch(this.objectUrl(objectKey));
    if (current.status === 404) return undefined;
    await requireOk(current, this.options.bucket, objectKey);
    const capability = parseCapability(
      await readBodyCapped(current, this.options.bucket, objectKey),
      objectKey,
    );
    this.resolvedCapabilities.set(cacheKey, capability);
    return capability;
  }

  private async loadCapability(key: MailboxSessionKey): Promise<string> {
    const objectKey = this.controlKey(key);
    for (;;) {
      const current = await this.client.fetch(this.objectUrl(objectKey));
      if (current.status !== 404) {
        await requireOk(current, this.options.bucket, objectKey);
        return parseCapability(await readBodyCapped(current, this.options.bucket, objectKey), objectKey);
      }
      const capability = this.options.initialCapability ?? randomBytes(32).toString('hex');
      const created = await this.client.fetch(this.objectUrl(objectKey), {
        method: 'PUT',
        body: JSON.stringify({ capability }),
        headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      });
      if (created.status === 412 || created.status === 409) continue;
      await requireOk(created, this.options.bucket, objectKey);
      return capability;
    }
  }

  private baseKey(key: MailboxSessionKey, side: MailboxSide): string {
    return `${this.sessionKey(key)}/${side}`;
  }

  private sequenceKey(key: MailboxSessionKey): string {
    return `${this.sessionKey(key)}/meta/sequence.json`;
  }

  private attachmentKey(key: MailboxSessionKey, messageId: string, filename: string): string {
    return `${this.sessionKey(key)}/attachments/${keySegment(messageId, 'message id')}/${keySegment(filename, 'attachment filename')}`;
  }

  /**
   * Whether this side is provably unchanged since our last sync.
   *
   * The pointer carries no mailbox data — only a token that every flush
   * rewrites — so a reader can learn "nothing happened here" without listing
   * the prefix. Returning false is always safe: it costs a listing, which is
   * what every refresh used to do unconditionally.
   */
  private async sideUnchanged<T>(
    key: MailboxSessionKey,
    sideName: MailboxSide,
    state: CachedSide<T>,
  ): Promise<boolean> {
    if (Date.now() - state.lastListedAtMs >= LISTING_RECONCILE_AFTER_MS) return false;
    try {
      const known = state.changeEtag;
      const response = await this.client.fetch(this.objectUrl(changePointerKey(this.sessionKey(key), sideName)), {
        headers: changePointerReadHeaders(known),
      });
      if (response.status === 304) {
        return true;
      }
      // Any other answer means "list": a rewritten pointer (200), a mailbox
      // that has never flushed (404), or anything unexpected. Read the body so
      // the connection is reusable, and remember the version we just saw.
      await response.text().catch(() => '');
      state.changeEtag = response.ok ? response.headers.get('etag') : null;
      return false;
    } catch {
      // The pointer is an optimisation; a failure to read it must never fail a
      // refresh. Fall back to the listing that was always correct.
      state.changeEtag = null;
      return false;
    }
  }

  /** Rewrite this side's change pointer so readers learn the side moved. */
  private async bumpChangePointer<T>(
    key: MailboxSessionKey,
    sideName: MailboxSide,
    state: CachedSide<T>,
  ): Promise<void> {
    const objectKey = changePointerKey(this.sessionKey(key), sideName);
    try {
      // Unconditional on purpose: two writers racing must both be allowed to
      // land, and either outcome changes the ETag, which is the whole signal.
      const response = await this.client.fetch(this.objectUrl(objectKey), {
        method: 'PUT',
        body: changePointerBody(randomBytes(16).toString('hex')),
        headers: { 'content-type': 'application/json' },
      });
      await requireOk(response, this.options.bucket, objectKey);
      state.changeEtag = response.headers.get('etag');
      state.lastListedAtMs = Date.now();
    } catch {
      // A pointer we failed to bump reads as "unchanged" to other readers
      // until their reconcile listing. Dropping our own cached version keeps
      // THIS writer honest on its next refresh.
      state.changeEtag = null;
    }
  }

  private async list(prefix: string): Promise<Array<{ key: string; etag: string }>> {
    const records: Array<{ key: string; etag: string }> = [];
    const requestedPrefix = `${prefix}/`;
    const listPrefix = `${this.options.delegatedListPrefix ?? prefix}/`;
    let continuation: string | undefined;
    do {
      const query = new URLSearchParams({
        'list-type': '2',
        prefix: listPrefix,
      });
      if (continuation) query.set('continuation-token', continuation);
      const response = await this.client.fetch(`${this.bucketUrl()}?${query}`);
      await requireOk(response, this.options.bucket, prefix);
      const xml = await response.text();
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const objectKey = xmlValue(match[1], 'Key');
        const etag = xmlValue(match[1], 'ETag');
        if (objectKey && etag && objectKey.startsWith(requestedPrefix)) {
          records.push({ key: objectKey, etag });
        }
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
    transaction: (fn) => runInboundTransaction(side.tables, fn),
  };
}

function outboundData(side: CachedSide<OutboundTables>): OutboundData {
  return {
    messages: side.tables.messages.records,
    acknowledgements: side.tables.acknowledgements.records,
    state: side.tables.state.records,
    container: side.tables.container.records,
    transaction: (fn) => runOutboundTransaction(side.tables, fn),
  };
}

function copyInbound(from: InboundTables, to: InboundTables): void {
  restoreMap(to.messages.records, from.messages.records);
  restoreMap(to.deliveries.records, from.deliveries.records);
  restoreMap(to.destinations.records, from.destinations.records);
  restoreMap(to.routing.records, from.routing.records);
}

function copyOutbound(from: OutboundTables, to: OutboundTables): void {
  restoreMap(to.messages.records, from.messages.records);
  restoreMap(to.acknowledgements.records, from.acknowledgements.records);
  restoreMap(to.state.records, from.state.records);
  restoreMap(to.container.records, from.container.records);
}

function restoreMap<T>(target: Map<string, T>, source: Map<string, T>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function runInboundTransaction<T>(tables: InboundTables, fn: () => T): T {
  const before = {
    messages: new Map(tables.messages.records),
    deliveries: new Map(tables.deliveries.records),
    destinations: new Map(tables.destinations.records),
    routing: new Map(tables.routing.records),
  };
  try {
    return fn();
  } catch (error) {
    restoreMap(tables.messages.records, before.messages);
    restoreMap(tables.deliveries.records, before.deliveries);
    restoreMap(tables.destinations.records, before.destinations);
    restoreMap(tables.routing.records, before.routing);
    throw error;
  }
}

function runOutboundTransaction<T>(tables: OutboundTables, fn: () => T): T {
  const before = {
    messages: new Map(tables.messages.records),
    acknowledgements: new Map(tables.acknowledgements.records),
    state: new Map(tables.state.records),
    container: new Map(tables.container.records),
  };
  try {
    return fn();
  } catch (error) {
    restoreMap(tables.messages.records, before.messages);
    restoreMap(tables.acknowledgements.records, before.acknowledgements);
    restoreMap(tables.state.records, before.state);
    restoreMap(tables.container.records, before.container);
    throw error;
  }
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

function snapshotInbound(tables: InboundTables, baseKey: string): Map<string, string> {
  const records = new Map<string, string>();
  snapshotTable(records, tables.messages, baseKey);
  snapshotTable(records, tables.deliveries, baseKey);
  snapshotTable(records, tables.destinations, baseKey);
  snapshotTable(records, tables.routing, baseKey);
  return records;
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
): void {
  const row = decodeRecord(entry.recordType, json);
  const id = recordKey(entry.recordType, row);
  const expected = `${baseKey}/${entry.name}/${recordKeySegment(id, 'record key')}.json`;
  if (objectKey !== expected) throw new Error(`S3 mailbox key does not match record identity: ${objectKey}`);
  entry.records.set(id, row);
}

function loadInbound(tables: InboundTables, baseKey: string, objectKey: string, json: string): void {
  const relative = objectKey.startsWith(`${baseKey}/`) ? objectKey.slice(baseKey.length + 1) : '';
  const name = relative.split('/', 1)[0];
  if (name === 'messages') return loadTable(tables.messages, baseKey, objectKey, json);
  if (name === 'deliveries') return loadTable(tables.deliveries, baseKey, objectKey, json);
  if (name === 'destinations') return loadTable(tables.destinations, baseKey, objectKey, json);
  if (name === 'routing') return loadTable(tables.routing, baseKey, objectKey, json);
  throw new Error(`unexpected object under S3 mailbox prefix: ${objectKey}`);
}

function loadOutbound(tables: OutboundTables, baseKey: string, objectKey: string, json: string): void {
  const relative = objectKey.startsWith(`${baseKey}/`) ? objectKey.slice(baseKey.length + 1) : '';
  const name = relative.split('/', 1)[0];
  if (name === 'messages') return loadTable(tables.messages, baseKey, objectKey, json);
  if (name === 'acknowledgements') return loadTable(tables.acknowledgements, baseKey, objectKey, json);
  if (name === 'state') return loadTable(tables.state, baseKey, objectKey, json);
  if (name === 'container') return loadTable(tables.container, baseKey, objectKey, json);
  throw new Error(`unexpected object under S3 mailbox prefix: ${objectKey}`);
}

function assertClean(current: Map<string, string>, persisted: Map<string, StoredRecord>, side: MailboxSide): void {
  const clean =
    current.size === persisted.size && [...current].every(([key, json]) => persisted.get(key)?.json === json);
  if (!clean) throw new Error(`refusing to refresh dirty ${side} mailbox before it is flushed`);
}

function sequenceValue(json: string, objectKey: string): number {
  const value = (JSON.parse(json) as { value?: unknown }).value;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`invalid S3 mailbox sequence: ${objectKey}`);
  return value as number;
}

function parseCapability(json: string, objectKey: string): string {
  const capability = (JSON.parse(json) as { capability?: unknown }).capability;
  if (typeof capability !== 'string' || !/^[a-f0-9]{64}$/.test(capability))
    throw new Error(`invalid S3 request capability: ${objectKey}`);
  return capability;
}

function validateOptions(options: S3MailboxOptions): void {
  if (!options.bucket || options.bucket !== options.bucket.trim() || /[\\/]/.test(options.bucket))
    throw new Error('mailbox bucket must be a bucket name, not a path');
  const url = new URL(options.endpoint);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('mailbox S3 endpoint must use http or https');
  // The built-in test identity is LocalStack-only. Real S3 endpoints are
  // https; fail closed at composition instead of signing garbage and
  // surfacing opaque 403s at runtime.
  if (url.protocol === 'https:' && options.accessKeyId === 'test' && options.secretAccessKey === 'test')
    throw new Error(
      `mailbox S3 endpoint ${url.origin} requires real credentials: the built-in test identity only works against a plain-http LocalStack endpoint`,
    );
  if (options.initialCapability !== undefined && !/^[a-f0-9]{64}$/.test(options.initialCapability))
    throw new Error('initial S3 request capability must be a 256-bit lowercase hex value');
  const delegatedListPrefix = normalizePrefix(options.delegatedListPrefix ?? '');
  const mailboxPrefix = normalizePrefix(options.prefix ?? '');
  if (delegatedListPrefix && delegatedListPrefix !== `${mailboxPrefix}/v2/agent-groups`)
    throw new Error('delegated S3 list prefix must be the mailbox agent-group root');
  normalizePrefix(options.prefix ?? '');
}

function isLocalStackProof(options: S3MailboxOptions): boolean {
  return (
    new URL(options.endpoint).protocol === 'http:' &&
    options.accessKeyId === 'test' &&
    options.secretAccessKey === 'test'
  );
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
