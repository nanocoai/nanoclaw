/**
 * Frame protocol v1 for the cell link, ported from the remote-access module.
 *
 * Every WebSocket message is a single JSON text frame:
 *   { "v":1, "ch":<int>, "seq":<int>, "t":"<type>", ...fields }
 *
 * - ch 0 is the control channel: "hello", "status", "ping"/"pong",
 *   "perks.changed" and "error".
 * - ch > 0 are data channels, opened by the cell with "open" {kind, ...};
 *   "data", "end", "error" {code, msg} and "close" follow on the same ch.
 * - seq is per channel, per sender, starts at 1, increments by 1. Receivers
 *   tolerate gaps.
 *
 * Nothing in this file may log payload contents; envelope metadata only.
 */
export const PROTOCOL_VERSION = 1 as const;
export const CONTROL_CHANNEL = 0;
/** Frames from client legs are at most this long. */
export const MAX_CLIENT_FRAME_CHARS = 4096;
/** The cell may send larger frames (a snapshot), up to this long. */
export const MAX_CELL_FRAME_CHARS = 512_000;

/** Frame types valid on the control channel (ch 0). */
export const CONTROL_TYPES = ['hello', 'status', 'ping', 'pong', 'perks.changed', 'error'] as const;
/** Frame types valid on data channels (ch > 0). */
export const DATA_TYPES = ['open', 'data', 'end', 'error', 'close'] as const;

export interface Frame {
  v: typeof PROTOCOL_VERSION;
  ch: number;
  seq: number;
  t: string;
  [field: string]: unknown;
}

export type MuxLog = (event: { event: string; [field: string]: unknown }) => void;

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

/**
 * Per-connection multiplexer: outbound seq counters, inbound seq gap
 * tracking, and the registry of open data channels. One Mux per WebSocket;
 * throw it away (reset()) when the socket drops.
 */
export class Mux {
  private readonly outSeq = new Map<number, number>();
  private readonly inSeq = new Map<number, number>();
  private readonly channels = new Map<number, ChannelHandler>();

  constructor(
    private readonly sendRaw: (raw: string) => void,
    private readonly log: MuxLog = () => {},
  ) {}

  /** Send a frame on `ch`, stamping the next per-channel outbound seq. */
  send(ch: number, t: string, fields: Record<string, unknown> = {}): void {
    const seq = (this.outSeq.get(ch) ?? 0) + 1;
    this.outSeq.set(ch, seq);
    this.sendRaw(encodeFrame({ ...fields, v: PROTOCOL_VERSION, ch, seq, t }));
  }

  /**
   * Decode + seq-track one raw inbound message. Invalid frames are dropped
   * (logged without payload). Seq gaps are tolerated but logged.
   */
  receive(raw: unknown): Frame | null {
    const frame = decodeFrame(raw);
    if (frame === null) {
      this.log({ event: 'dropped_invalid_frame', bytes: typeof raw === 'string' ? raw.length : -1 });
      return null;
    }
    const last = this.inSeq.get(frame.ch) ?? 0;
    if (frame.seq !== last + 1)
      this.log({ event: 'inbound_seq_gap', ch: frame.ch, expected: last + 1, got: frame.seq });
    if (frame.seq > last) this.inSeq.set(frame.ch, frame.seq);
    return frame;
  }

  openChannel(ch: number, handler: ChannelHandler): void {
    this.channels.set(ch, handler);
  }

  handlerFor(ch: number): ChannelHandler | undefined {
    return this.channels.get(ch);
  }

  /** Remove + tear down one channel. Safe to call for unknown channels. */
  closeChannel(ch: number): void {
    const handler = this.channels.get(ch);
    this.channels.delete(ch);
    handler?.onTeardown();
  }

  /** Tear down every channel and forget all seq state (socket dropped). */
  reset(): void {
    for (const ch of [...this.channels.keys()]) this.closeChannel(ch);
    this.outSeq.clear();
    this.inSeq.clear();
  }
}
