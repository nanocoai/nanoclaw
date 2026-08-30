/**
 * Attach wire protocol (sandbox-spec D15, D22).
 *
 * Asymmetric by design: the server→client direction is the raw PTY byte
 * stream (replay buffer, then live) so the client's render path is a pure
 * pipe to its TTY. Only the client→server direction is framed, because it
 * multiplexes keystrokes with control traffic (resize, detach).
 *
 * Frame layout: [1 byte type][4 bytes BE payload length][payload].
 */

export const FRAME_DATA = 0x00;
export const FRAME_RESIZE = 0x01;
export const FRAME_DETACH = 0x02;
/**
 * Client→server keepalive, empty payload. The server drops a client whose
 * last frame of ANY type is stale (attach-server.ts) — the only cover for a
 * wedged or orphaned client process holding the socket open, which no
 * socket-close event will ever report (term-audit: orphan-socket-sweep).
 *
 * Versioning, deliberately shim-free: FrameParser throws on unknown frame
 * types and the server drops a client on parse error, so an OLD server drops
 * a NEW pinging client exactly as a NEW server times out an old, never-
 * pinging client. Both directions are confined to the same one-time window —
 * client and server always run from the same mounted tree, so version skew
 * exists only across an in-place tree update while a previous life's client
 * is still attached. That client is dropped once and re-attaches on current
 * code; no backward-compat shims.
 */
export const FRAME_PING = 0x03;

/** Ctrl-] — the tmux-style detach key the attach client intercepts locally. */
export const DETACH_KEY = 0x1d;

/**
 * Keepalive cadence, shared by both jobs of the client's beat (attach-client:
 * the NUL down stdout, the FRAME_PING down the socket) and by the server's
 * sweep deadline — one knob, resolved from the same container env on both
 * ends, so the deadline math always agrees.
 *
 * 5s bounds transport-death detection at ~2 beats (~10s) client-side and
 * ~3 beats (~15s) server-side, replacing the ~30-60s lag of the old 30s
 * default (ISSUES #1 tail).
 */
export const DEFAULT_HEARTBEAT_MS = 5_000;

/** How many silent beats the server tolerates before sweeping a client. */
export const KEEPALIVE_DEADLINE_INTERVALS = 3;

/** NANOCLAW_ATTACH_HEARTBEAT_MS overrides the default; invalid or non-positive values are ignored. */
export function resolveHeartbeatMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = parseInt(env.NANOCLAW_ATTACH_HEARTBEAT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEARTBEAT_MS;
}

/** A corrupt stream shows up as a nonsense length; fail loudly, not with OOM. */
const MAX_PAYLOAD = 1024 * 1024;

const HEADER_LEN = 5;

export interface ResizePayload {
  cols: number;
  rows: number;
}

export type Frame =
  | { type: typeof FRAME_DATA; data: Buffer }
  | { type: typeof FRAME_RESIZE; resize: ResizePayload }
  | { type: typeof FRAME_DETACH }
  | { type: typeof FRAME_PING };

export function encodeData(data: Buffer | string): Buffer {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  return encode(FRAME_DATA, payload);
}

export function encodeResize(cols: number, rows: number): Buffer {
  return encode(FRAME_RESIZE, Buffer.from(JSON.stringify({ cols, rows }), 'utf8'));
}

export function encodeDetach(): Buffer {
  return encode(FRAME_DETACH, Buffer.alloc(0));
}

export function encodePing(): Buffer {
  return encode(FRAME_PING, Buffer.alloc(0));
}

function encode(type: number, payload: Buffer): Buffer {
  const frame = Buffer.alloc(HEADER_LEN + payload.length);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, HEADER_LEN);
  return frame;
}

/**
 * Incremental parser for the client→server stream. Push chunks as they
 * arrive; complete frames come back in order. Throws on a malformed stream
 * (unknown type, oversized payload, bad resize JSON) — the server treats
 * that as a broken client and drops the connection.
 */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    while (this.buffer.length >= HEADER_LEN) {
      const type = this.buffer.readUInt8(0);
      const len = this.buffer.readUInt32BE(1);
      if (type !== FRAME_DATA && type !== FRAME_RESIZE && type !== FRAME_DETACH && type !== FRAME_PING) {
        throw new Error(`attach protocol: unknown frame type 0x${type.toString(16)}`);
      }
      if (len > MAX_PAYLOAD) {
        throw new Error(`attach protocol: payload length ${len} exceeds ${MAX_PAYLOAD}`);
      }
      if (this.buffer.length < HEADER_LEN + len) break;
      const payload = this.buffer.subarray(HEADER_LEN, HEADER_LEN + len);
      this.buffer = this.buffer.subarray(HEADER_LEN + len);
      if (type === FRAME_DATA) {
        frames.push({ type: FRAME_DATA, data: Buffer.from(payload) });
      } else if (type === FRAME_RESIZE) {
        frames.push({ type: FRAME_RESIZE, resize: parseResize(payload) });
      } else if (type === FRAME_DETACH) {
        frames.push({ type: FRAME_DETACH });
      } else {
        frames.push({ type: FRAME_PING });
      }
    }
    return frames;
  }
}

function parseResize(payload: Buffer): ResizePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch (error) {
    throw new Error('attach protocol: resize payload is not JSON', { cause: error });
  }
  const { cols, rows } = parsed as ResizePayload;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    throw new Error(`attach protocol: bad resize ${payload.toString('utf8')}`);
  }
  return { cols, rows };
}

/**
 * Split a local keystroke chunk at the detach key. Everything before the
 * key still goes to the PTY (it was typed first); the key itself and
 * anything after it stays local — the client detaches.
 *
 * Paste-blind (0x1d anywhere splits) — the attach client uses the
 * paste-aware DetachKeyScanner below; this stays as the stateless core
 * semantic for single chunks outside a paste.
 */
export function splitAtDetachKey(chunk: Buffer): { data: Buffer; detach: boolean } {
  const at = chunk.indexOf(DETACH_KEY);
  if (at === -1) return { data: chunk, detach: false };
  return { data: chunk.subarray(0, at), detach: true };
}

// Bracketed-paste markers a terminal emits around a paste when the TUI has
// enabled DECSET 2004: ESC[200~ … ESC[201~. They share a 4-byte prefix and
// differ only at index 4.
const MARKER = [0x1b, 0x5b, 0x32, 0x30] as const;
const MARKER_START_BYTE = 0x30; // '0' → ESC[200~ (paste begins)
const MARKER_END_BYTE = 0x31; // '1' → ESC[201~ (paste ends)
const MARKER_FINAL = 0x7e; // '~'

/**
 * Paste-aware detach-key scanner (term-audit: paste-with-0x1d). The detach
 * key is only a detach OUTSIDE a bracketed-paste region: a pasted blob
 * containing a literal 0x1d must reach the TUI intact, not detach mid-paste
 * and eat the tail. Ctrl-] semantics are otherwise unchanged — outside a
 * paste it detaches and never reaches the TUI (tmux-style, documented).
 *
 * Deliberately forwards every byte immediately: only the detach DECISION is
 * stateful, so a partial marker at a chunk boundary delays nothing and can
 * never eat keystrokes. Marker state (including candidate progress) persists
 * across chunks — markers split anywhere still count.
 */
export class DetachKeyScanner {
  private inPaste = false;
  /** Bytes matched into a marker candidate so far (0..5). */
  private matched = 0;
  /** Which marker the candidate is, once byte 4 disambiguates. */
  private candidate: typeof MARKER_START_BYTE | typeof MARKER_END_BYTE | 0 = 0;

  /** splitAtDetachKey semantics, but 0x1d inside a paste region is data. */
  scan(chunk: Buffer): { data: Buffer; detach: boolean } {
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      this.step(b);
      // 0x1d never appears inside a marker, so marker state and the detach
      // decision cannot disagree about the same byte.
      if (b === DETACH_KEY && !this.inPaste) {
        return { data: chunk.subarray(0, i), detach: true };
      }
    }
    return { data: chunk, detach: false };
  }

  private step(b: number): void {
    if (this.tryMatch(b)) return;
    // Mismatch: reset, then the byte may itself start a fresh marker.
    this.matched = b === MARKER[0] ? 1 : 0;
    this.candidate = 0;
  }

  private tryMatch(b: number): boolean {
    if (this.matched < MARKER.length) {
      if (b !== MARKER[this.matched]) return false;
      this.matched++;
      return true;
    }
    if (this.matched === MARKER.length) {
      if (b !== MARKER_START_BYTE && b !== MARKER_END_BYTE) return false;
      this.candidate = b;
      this.matched++;
      return true;
    }
    // matched === 5: only the final '~' completes the marker.
    if (b !== MARKER_FINAL) return false;
    if (this.candidate === MARKER_START_BYTE) this.inPaste = true;
    else if (this.candidate === MARKER_END_BYTE) this.inPaste = false;
    this.matched = 0;
    this.candidate = 0;
    return true;
  }
}
