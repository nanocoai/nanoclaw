/**
 * A small in-memory IMAP server and an imapflow-shaped client, for adapter
 * tests that mock `imapflow`. Test-only: nothing in production imports it.
 *
 * The point is fidelity where a looser mock would hide a bug:
 *
 * - UID sets follow RFC 9051 §6.4.8 / §9 (`sequence-set`): `*` is the highest
 *   UID in use, a range is unordered (`9:3` = `3:9`), so `N:*` with N above
 *   every UID still returns the highest message — the quirk the adapter's
 *   `msg.uid > lastUid` guard exists for. UIDs that are not in use are ignored.
 * - The mailbox lives on the server, not in a client: UIDVALIDITY, UIDNEXT,
 *   flags and expunges persist across reconnects and adapter restarts, and
 *   `renumber()` models a server that reassigned its UIDs.
 * - A dropped connection fails every later call on that client and emits
 *   `close`, as imapflow does — except `fetch` and `fetchOne`, which imapflow
 *   answers with nothing once its mailbox is closed (imap-flow.js 1.7.8:
 *   `fetch` returns before its first yield, `fetchOne` resolves `undefined`).
 *   `fail(op, n)` makes the next n calls of an op throw.
 * - imapflow must not be given another command while a `fetch` iterator is
 *   open: it serializes commands, so the second waits on the first and the
 *   loop deadlocks (imap-flow.js: "You can not run any IMAP commands in this
 *   loop"). Here such a command throws at once and is recorded in
 *   `protocolErrors`, so a test fails even where the adapter swallows it.
 * - Every call is written to `log`, for assertions like "no fetchOne for the
 *   oversized mail".
 */
import { EventEmitter } from 'events';

export type FakeImapOp = 'connect' | 'mailboxOpen' | 'fetch' | 'fetchOne' | 'messageFlagsAdd' | 'logout';

export interface FakeMessage {
  uid: number;
  source: Buffer;
  flags: Set<string>;
  internalDate: Date;
  /** RFC822.SIZE; the source length unless deliver() was told otherwise. */
  size: number;
}

export interface FakeLogEntry {
  client: number;
  op: FakeImapOp;
  args: unknown[];
  ok: boolean;
  /** fetch: the UIDs the set resolved to; fetchOne: the UID returned, or false. */
  result?: unknown;
  error?: string;
}

/** Where a test's `fail()` or `intercept()` hooks in. */
type Interceptor = (args: unknown[], client: FakeImapClient) => void;

const DEFAULT_INTERNAL_DATE = new Date('2026-10-24T09:00:00Z');

/**
 * Resolve an RFC 9051 sequence-set against the numbers in use (UIDs, or 1..n
 * for message sequence numbers). Returns the matching numbers in ascending
 * order. Throws on a malformed set, as a server answers BAD.
 */
export function resolveSequenceSet(set: string, inUse: readonly number[]): number[] {
  const sorted = [...inUse].sort((a, b) => a - b);
  const max = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
  if (typeof set !== 'string' || set.length === 0) throw new Error(`BAD sequence set: ${JSON.stringify(set)}`);
  const num = (s: string): number => {
    if (s === '*') return max;
    if (!/^[1-9][0-9]*$/.test(s)) throw new Error(`BAD sequence set: ${JSON.stringify(set)}`);
    const n = Number(s);
    if (n > 0xffffffff) throw new Error(`BAD sequence set: ${JSON.stringify(set)}`);
    return n;
  };
  const wanted = new Set<number>();
  for (const part of set.split(',')) {
    const bounds = part.split(':');
    if (bounds.length > 2) throw new Error(`BAD sequence set: ${JSON.stringify(set)}`);
    // `*` in an empty mailbox matches nothing (there is no largest number).
    if (sorted.length === 0) {
      bounds.forEach(num);
      continue;
    }
    const a = num(bounds[0]);
    const b = bounds.length === 2 ? num(bounds[1]) : a;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (const n of sorted) if (n >= lo && n <= hi) wanted.add(n);
  }
  return sorted.filter((n) => wanted.has(n));
}

export class FakeImapServer {
  uidValidity: bigint;
  uidNext = 1;
  readonly path = 'INBOX';
  readonly messages = new Map<number, FakeMessage>();
  readonly clients: FakeImapClient[] = [];
  readonly log: FakeLogEntry[] = [];
  /** Misuses of the client a real imapflow would deadlock or fail on; empty in a correct run. */
  readonly protocolErrors: string[] = [];
  private failures = new Map<
    FakeImapOp,
    Array<{ left: number; error: () => Error; when?: (args: unknown[]) => boolean }>
  >();
  private interceptors = new Map<FakeImapOp, Interceptor[]>();

  constructor(opts: { uidValidity?: number | bigint } = {}) {
    this.uidValidity = BigInt(opts.uidValidity ?? 1);
  }

  /** Clients that are connected, not logged out or dropped. */
  get live(): FakeImapClient[] {
    return this.clients.filter((c) => c.usable);
  }

  /** The newest client the adapter created. */
  get current(): FakeImapClient | undefined {
    return this.clients[this.clients.length - 1];
  }

  /**
   * A new mail in the mailbox, under the next UID. Clients with the mailbox
   * open hear `exists` (IDLE), unless `notify: false` — mail that arrived
   * while no one was listening, or a missed notification.
   */
  deliver(
    source: Buffer,
    opts: { internalDate?: Date; size?: number; flags?: string[]; notify?: boolean } = {},
  ): number {
    const uid = this.uidNext++;
    this.messages.set(uid, {
      uid,
      source,
      flags: new Set(opts.flags ?? []),
      internalDate: opts.internalDate ?? DEFAULT_INTERNAL_DATE,
      size: opts.size ?? source.length,
    });
    if (opts.notify !== false) this.notifyExists();
    return uid;
  }

  /** Remove a mail (deleted or moved by another client). UIDs are never reused. */
  expunge(uid: number): void {
    this.messages.delete(uid);
  }

  /**
   * The server reassigned its UIDs: a new UIDVALIDITY, the remaining mail
   * renumbered from 1 in its current order, and every connection dropped (a
   * client must reopen the mailbox to see the change). Returns the new validity.
   */
  renumber(opts: { uidValidity?: number | bigint } = {}): bigint {
    this.uidValidity = opts.uidValidity !== undefined ? BigInt(opts.uidValidity) : this.uidValidity + 1n;
    const kept = [...this.messages.values()].sort((a, b) => a.uid - b.uid);
    this.messages.clear();
    kept.forEach((m, i) => this.messages.set(i + 1, { ...m, uid: i + 1 }));
    this.uidNext = kept.length + 1;
    this.dropConnection();
    return this.uidValidity;
  }

  /** The connection is lost: every live client emits `error` (if given), then `close`. */
  dropConnection(opts: { error?: Error } = {}): void {
    for (const c of this.live) c.drop(opts.error);
  }

  /** Emit `exists` on every client with the mailbox open, as IDLE would. */
  notifyExists(): void {
    for (const c of this.live) if (c.mailbox) c.emitSoon('exists', { path: this.path, count: this.messages.size });
  }

  /**
   * The next `n` calls of `op` throw (optionally only calls `when` accepts —
   * it is passed the call's arguments). `n` may be Infinity.
   */
  fail(op: FakeImapOp, n = 1, opts: { error?: Error | (() => Error); when?: (args: unknown[]) => boolean } = {}): void {
    const error = () =>
      typeof opts.error === 'function'
        ? opts.error()
        : (opts.error ?? Object.assign(new Error(`${op} failed (injected)`), { code: 'FakeFailure' }));
    const list = this.failures.get(op) ?? [];
    list.push({ left: n, error, when: opts.when });
    this.failures.set(op, list);
  }

  clearFailures(): void {
    this.failures.clear();
  }

  /**
   * Run `fn` just before each call of `op` executes (after it is logged as
   * started). Use it to act at an exact point: drop the connection during the
   * second fetchOne, say. Returns a function that removes it.
   */
  intercept(op: FakeImapOp, fn: Interceptor): () => void {
    const list = this.interceptors.get(op) ?? [];
    list.push(fn);
    this.interceptors.set(op, list);
    return () => {
      const l = this.interceptors.get(op) ?? [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    };
  }

  /** Calls logged for `op` (successful ones only, unless `all`). */
  calls(op: FakeImapOp, opts: { all?: boolean } = {}): FakeLogEntry[] {
    return this.log.filter((e) => e.op === op && (opts.all || e.ok));
  }

  /** Flags set through messageFlagsAdd, in order: [uid, flags]. */
  flagsAdded(): Array<[number, string[]]> {
    return this.calls('messageFlagsAdd').flatMap((e) =>
      (e.result as number[]).map((uid) => [uid, e.args[1] as string[]] as [number, string[]]),
    );
  }

  // --- used by FakeImapClient ---

  /** @internal Runs interceptors and injected failures for one call. */
  before(op: FakeImapOp, args: unknown[], client: FakeImapClient): void {
    for (const fn of [...(this.interceptors.get(op) ?? [])]) fn(args, client);
    const list = this.failures.get(op);
    const hit = list?.find((f) => f.left > 0 && (!f.when || f.when(args)));
    if (hit) {
      hit.left--;
      throw hit.error();
    }
  }

  /** @internal UIDs in use, ascending. */
  uids(): number[] {
    return [...this.messages.keys()].sort((a, b) => a - b);
  }

  /** @internal Resolve a set in UID or sequence-number mode to UIDs. */
  resolve(range: string, byUid: boolean): number[] {
    const uids = this.uids();
    if (byUid) return resolveSequenceSet(range, uids);
    const seqs = resolveSequenceSet(
      range,
      uids.map((_, i) => i + 1),
    );
    return seqs.map((s) => uids[s - 1]);
  }
}

/** The subset of imapflow's ImapFlow the adapter uses, backed by a FakeImapServer. */
export class FakeImapClient extends EventEmitter {
  /** 1 for the server's first client, and so on (stable across module reloads). */
  readonly id: number;
  /** False before connect() and after logout()/close()/a drop. */
  usable = false;
  /** imapflow: false until a mailbox is open. */
  mailbox: false | { path: string; uidValidity: bigint; uidNext: number; exists: number } = false;
  /** `fetch` iterators started and not yet finished on this client. */
  private fetchesOpen = 0;

  constructor(
    readonly server: FakeImapServer,
    readonly opts: Record<string, unknown> = {},
  ) {
    super();
    this.id = server.clients.push(this);
  }

  /** @internal */
  emitSoon(event: string, payload?: unknown): void {
    queueMicrotask(() => this.emit(event, payload));
  }

  /** @internal The server side of a lost connection. */
  drop(error?: Error): void {
    if (!this.usable) return;
    this.usable = false;
    this.mailbox = false;
    // imapflow emits 'error' only to listeners; an unhandled one would throw.
    if (error && this.listenerCount('error') > 0) this.emit('error', error);
    this.emit('close');
  }

  /**
   * One command. `noMailbox` is what imapflow answers, without a command,
   * when no mailbox is open (fetch, fetchOne): checked as the call starts, so
   * an interceptor that drops the connection there models a drop just before
   * the command. A drop while the command is in flight is a `fail()` whose
   * error drops the connection.
   */
  private run<T>(op: FakeImapOp, args: unknown[], body: () => T, noMailbox?: () => T): T {
    const entry: FakeLogEntry = { client: this.id, op, args, ok: false };
    this.server.log.push(entry);
    try {
      if (this.fetchesOpen > 0) {
        const msg = `${op} issued while a fetch iterator is open on client ${this.id} (imapflow would deadlock)`;
        this.server.protocolErrors.push(msg);
        throw Object.assign(new Error(msg), { code: 'FakeDeadlock' });
      }
      if (noMailbox && !this.mailbox) {
        entry.ok = true;
        entry.result = 'no mailbox';
        return noMailbox();
      }
      if (op !== 'connect' && !this.usable) {
        throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
      }
      this.server.before(op, args, this);
      // An interceptor may have dropped this very connection.
      if (noMailbox && !this.mailbox) {
        entry.ok = true;
        entry.result = 'no mailbox';
        return noMailbox();
      }
      if (op !== 'connect' && !this.usable) {
        throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
      }
      const result = body();
      entry.ok = true;
      return result;
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async connect(): Promise<void> {
    this.run('connect', [], () => {
      if (this.usable) throw new Error('Already connected');
      this.usable = true;
    });
  }

  async mailboxOpen(path: string): Promise<NonNullable<FakeImapClient['mailbox']>> {
    return this.run('mailboxOpen', [path], () => {
      if (path.toUpperCase() !== this.server.path) throw new Error(`Mailbox doesn't exist: ${path}`);
      this.mailbox = {
        path: this.server.path,
        uidValidity: this.server.uidValidity,
        uidNext: this.server.uidNext,
        exists: this.server.messages.size,
      };
      return this.mailbox;
    });
  }

  /**
   * Lists messages in `range`. The set is resolved when the command starts; a
   * connection dropped while the caller iterates ends the iteration with an
   * error. With no mailbox open (never opened, or closed by a drop) it yields
   * nothing, as imapflow does. No other command may run on this client until
   * the iterator finishes.
   */
  async *fetch(
    range: string,
    query: { uid?: boolean; size?: boolean; flags?: boolean } = {},
    options: { uid?: boolean } = {},
  ): AsyncGenerator<{ seq: number; uid: number; size?: number; flags?: Set<string> }> {
    const uids = this.run(
      'fetch',
      [range, query, options],
      () => {
        const r = this.server.resolve(range, !!options.uid);
        this.server.log[this.server.log.length - 1].result = r;
        return r;
      },
      () => [] as number[],
    );
    const all = this.server.uids();
    this.fetchesOpen++;
    try {
      for (const uid of uids) {
        if (!this.usable) throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
        const m = this.server.messages.get(uid);
        if (!m) continue;
        yield {
          seq: all.indexOf(uid) + 1,
          uid,
          ...(query.size && { size: m.size }),
          ...(query.flags && { flags: new Set(m.flags) }),
        };
      }
    } finally {
      this.fetchesOpen--;
    }
  }

  async fetchOne(
    seq: string,
    query: { source?: boolean; headers?: boolean; internalDate?: boolean; size?: boolean } = {},
    options: { uid?: boolean } = {},
  ): Promise<
    | undefined
    | false
    | { seq: number; uid: number; source?: Buffer; headers?: Buffer; internalDate?: Date; size?: number }
  > {
    // imapflow: `undefined` with no mailbox open, `false` when nothing matched.
    return this.run(
      'fetchOne',
      [seq, query, options],
      () => {
        const uid = this.server.resolve(seq, !!options.uid)[0];
        const m = uid !== undefined ? this.server.messages.get(uid) : undefined;
        this.server.log[this.server.log.length - 1].result = m ? m.uid : false;
        if (!m) return false;
        return {
          seq: this.server.uids().indexOf(m.uid) + 1,
          uid: m.uid,
          ...(query.source && { source: m.source }),
          ...(query.headers && { headers: headerBlock(m.source) }),
          ...(query.internalDate && { internalDate: m.internalDate }),
          ...(query.size && { size: m.size }),
        };
      },
      () => undefined,
    );
  }

  async messageFlagsAdd(range: string, flags: string[], options: { uid?: boolean } = {}): Promise<boolean> {
    return this.run('messageFlagsAdd', [range, flags, options], () => {
      if (!this.mailbox) throw new Error('No mailbox open');
      const uids = this.server.resolve(range, !!options.uid);
      this.server.log[this.server.log.length - 1].result = uids;
      for (const uid of uids) for (const f of flags) this.server.messages.get(uid)?.flags.add(f);
      return uids.length > 0;
    });
  }

  async logout(): Promise<void> {
    this.run('logout', [], () => {
      this.usable = false;
      this.mailbox = false;
    });
    this.emit('close');
  }

  /** imapflow: close the socket at once, no LOGOUT; emits `close`. */
  close(): void {
    const was = this.usable;
    this.usable = false;
    this.mailbox = false;
    if (was) this.emit('close');
  }
}

/** BODY.PEEK[HEADER]: the header block, up to and including the blank line that ends it. */
export function headerBlock(source: Buffer): Buffer {
  const crlf = source.indexOf('\r\n\r\n');
  if (crlf >= 0) return source.subarray(0, crlf + 4);
  const lf = source.indexOf('\n\n');
  return lf >= 0 ? source.subarray(0, lf + 2) : source;
}
