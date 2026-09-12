/**
 * Frame protocol v1 for the cell link, ported from the remote-access module.
 *
 * Every WebSocket message is a single JSON text frame:
 *   { "v":1, "ch":<int>, "seq":<int>, "t":"<type>", ...fields }
 *
 * - ch 0 is the control channel: "hello", "status", "ping"/"pong",
 *   "renew"/"renewed", "perks.changed" and "error".
 * - ch > 0 are data channels, opened by the cell with "open" {kind, ...};
 *   "data", "credit", "end", "error" {code, msg} and "close" follow on the
 *   same ch.
 * - seq is per channel, per sender, starts at 1, increments by 1. Receivers
 *   tolerate gaps.
 *
 * Frames a client leg sends are at most 4096 characters, except on an open
 * `ssh` channel, where a 16 KiB chunk needs room: 24 000 characters. The mux
 * knows each open channel's kind and refuses (logs and drops) anything the
 * cell would close the socket for.
 *
 * Nothing in this file may log payload contents; envelope metadata only.
 */
export const PROTOCOL_VERSION = 1 as const;
export const CONTROL_CHANNEL = 0;
/** Frames from client legs are at most this long. */
export const MAX_CLIENT_FRAME_CHARS = 4096;
/** Frames on one of the socket's open `ssh` channels may be this long instead. */
export const MAX_SSH_FRAME_CHARS = 24_000;
/** The cell may send larger frames (a snapshot), up to this long. */
export const MAX_CELL_FRAME_CHARS = 512_000;
/** The channel kind that carries one relayed terminal stream. */
export const SSH_KIND = 'ssh';

/** Frame types valid on the control channel (ch 0). */
export const CONTROL_TYPES = ['hello', 'status', 'ping', 'pong', 'renew', 'renewed', 'perks.changed', 'error'] as const;
/** Frame types valid on data channels (ch > 0). */
export const DATA_TYPES = ['open', 'data', 'credit', 'end', 'error', 'close'] as const;

export interface Frame {
  v: typeof PROTOCOL_VERSION;
  ch: number;
  seq: number;
  t: string;
  [field: string]: unknown;
}

export type MuxLog = (event: { event: string; [field: string]: unknown }) => void;

/** How long a client frame may be on a channel of `kind` (`undefined`: the control channel). */
export function frameAllowance(kind: string | undefined): number {
  return kind === SSH_KIND ? MAX_SSH_FRAME_CHARS : MAX_CLIENT_FRAME_CHARS;
}

/** Serialize a frame to the single-JSON-text wire form. */
export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

/**
 * Structural validation of a decoded value against protocol v1: the envelope
 * (v/ch/seq/t) and that the type is legal for the channel class.
 */
export function validateFrame(value: unknown): value is Frame {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const f = value as Record<string, unknown>;
  if (f.v !== PROTOCOL_VERSION) return false;
  if (typeof f.ch !== 'number' || !Number.isInteger(f.ch) || f.ch < 0) return false;
  if (typeof f.seq !== 'number' || !Number.isInteger(f.seq) || f.seq < 1) return false;
  if (typeof f.t !== 'string' || f.t.length === 0) return false;
  const allowed: readonly string[] = f.ch === CONTROL_CHANNEL ? CONTROL_TYPES : DATA_TYPES;
  return allowed.includes(f.t);
}

/** Parse one raw WS message. Returns null (never throws) on anything invalid. */
export function decodeFrame(raw: unknown): Frame | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (_error) {
    return null;
  }
  return validateFrame(parsed) ? parsed : null;
}

/** A live data channel's frame consumer. */
export interface ChannelHandler {
  /** Inbound frame addressed to this channel (never "open"; dispatch handles that). */
  onFrame(frame: Frame): void;
  /** Channel torn down: "close" frame, error, or connection reset. Must be idempotent-safe. */
  onTeardown(): void;
}

interface Channel {
  handler: ChannelHandler;
  kind?: string;
}

/**
 * Per-connection multiplexer: outbound seq counters, inbound seq gap
 * tracking, and the registry of open data channels with their kinds. One Mux
 * per WebSocket; throw it away (reset()) when the socket drops.
 */
export class Mux {
  private readonly outSeq = new Map<number, number>();
  private readonly inSeq = new Map<number, number>();
  private readonly channels = new Map<number, Channel>();

  constructor(
    private readonly sendRaw: (raw: string) => void,
    private readonly log: MuxLog = () => {},
  ) {}

  /**
   * Send a frame on `ch`, stamping the next per-channel outbound seq. A frame
   * longer than the channel's allowance is dropped and logged instead of sent
   * (the cell would close the socket 4009); returns whether it went out.
   */
  send(ch: number, t: string, fields: Record<string, unknown> = {}): boolean {
    const seq = (this.outSeq.get(ch) ?? 0) + 1;
    this.outSeq.set(ch, seq);
    const raw = encodeFrame({ ...fields, v: PROTOCOL_VERSION, ch, seq, t });
    const allowance = this.allowance(ch);
    if (raw.length > allowance) {
      this.log({ event: 'dropped_oversize_frame', ch, t, chars: raw.length, allowance });
      return false;
    }
    this.sendRaw(raw);
    return true;
  }

  /**
   * Decode + seq-track one raw inbound message. Invalid frames are dropped
   * (logged without payload), as is a frame on an `ssh` channel longer than
   * that kind's allowance. Seq gaps are tolerated but logged.
   */
  receive(raw: unknown): Frame | null {
    const frame = decodeFrame(raw);
    if (frame === null) {
      this.log({ event: 'dropped_invalid_frame', bytes: typeof raw === 'string' ? raw.length : -1 });
      return null;
    }
    const chars = (raw as string).length;
    if (frame.ch !== CONTROL_CHANNEL && this.kindOf(frame.ch) === SSH_KIND && chars > MAX_SSH_FRAME_CHARS) {
      this.log({ event: 'dropped_oversize_frame', ch: frame.ch, t: frame.t, chars, allowance: MAX_SSH_FRAME_CHARS });
      return null;
    }
    const last = this.inSeq.get(frame.ch) ?? 0;
    if (frame.seq !== last + 1)
      this.log({ event: 'inbound_seq_gap', ch: frame.ch, expected: last + 1, got: frame.seq });
    if (frame.seq > last) this.inSeq.set(frame.ch, frame.seq);
    return frame;
  }

  /** Register a data channel the cell opened; `kind` decides its frame allowance. */
  openChannel(ch: number, handler: ChannelHandler, kind?: string): void {
    this.channels.set(ch, { handler, ...(kind === undefined ? {} : { kind }) });
  }

  handlerFor(ch: number): ChannelHandler | undefined {
    return this.channels.get(ch)?.handler;
  }

  kindOf(ch: number): string | undefined {
    return this.channels.get(ch)?.kind;
  }

  /** The open channels of one kind, in opening order. */
  channelsOfKind(kind: string): number[] {
    return [...this.channels].filter(([, channel]) => channel.kind === kind).map(([ch]) => ch);
  }

  /** The longest frame this end may send on `ch`. */
  allowance(ch: number): number {
    return ch === CONTROL_CHANNEL ? MAX_CLIENT_FRAME_CHARS : frameAllowance(this.kindOf(ch));
  }

  /** Remove + tear down one channel. Safe to call for unknown channels. */
  closeChannel(ch: number): void {
    const channel = this.channels.get(ch);
    this.channels.delete(ch);
    channel?.handler.onTeardown();
  }

  /** Tear down every channel and forget all seq state (socket dropped). */
  reset(): void {
    for (const ch of [...this.channels.keys()]) this.closeChannel(ch);
    this.outSeq.clear();
    this.inSeq.clear();
  }
}
