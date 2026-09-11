import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CONTROL_CHANNEL,
  CONTROL_TYPES,
  DATA_TYPES,
  Mux,
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  validateFrame,
  type ChannelHandler,
  type Frame,
} from './mux.js';

interface FrameVectors {
  valid: { raw: string; frame: Frame }[];
  invalid: string[];
}
const vectors = JSON.parse(readFileSync(new URL('./frame-vectors.json', import.meta.url), 'utf8')) as FrameVectors;

describe('frame encode/decode', () => {
  it('decodes every pinned cell frame and re-encodes it losslessly', () => {
    for (const { raw, frame } of vectors.valid) {
      expect(decodeFrame(raw)).toEqual(frame);
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    }
  });

  it('drops every pinned invalid message, including the pre-cutover flat messages', () => {
    for (const raw of vectors.invalid) expect(decodeFrame(raw)).toBeNull();
  });

  it('rejects non-string raw input', () => {
    expect(decodeFrame(Buffer.from('{}'))).toBeNull();
    expect(decodeFrame(42)).toBeNull();
    expect(decodeFrame(undefined)).toBeNull();
  });

  it('validateFrame accepts every declared type on its channel class only', () => {
    expect(CONTROL_TYPES).toEqual(['hello', 'status', 'ping', 'pong', 'perks.changed', 'error']);
    expect(DATA_TYPES).toEqual(['open', 'data', 'end', 'error', 'close']);
    for (const t of CONTROL_TYPES) {
      expect(validateFrame({ v: 1, ch: CONTROL_CHANNEL, seq: 1, t })).toBe(true);
      if (t !== 'error') expect(validateFrame({ v: 1, ch: 9, seq: 1, t })).toBe(false);
    }
    for (const t of DATA_TYPES) {
      expect(validateFrame({ v: 1, ch: 9, seq: 1, t })).toBe(true);
      if (t !== 'error') expect(validateFrame({ v: 1, ch: CONTROL_CHANNEL, seq: 1, t })).toBe(false);
    }
  });
});

describe('Mux', () => {
  function makeMux(): { mux: Mux; raws: string[]; frames: Frame[]; log: ReturnType<typeof vi.fn> } {
    const raws: string[] = [];
    const frames: Frame[] = [];
    const log = vi.fn();
    const mux = new Mux((raw) => {
      raws.push(raw);
      const f = decodeFrame(raw);
      if (f) frames.push(f);
    }, log);
    return { mux, raws, frames, log };
  }

  it('stamps per-channel outbound seq starting at 1', () => {
    const { mux, frames } = makeMux();
    mux.send(0, 'hello', { leg: 'host', caps: ['perks'] });
    mux.send(0, 'ping');
    mux.send(4, 'error', { code: 'unsupported' });
    mux.send(4, 'close');
    expect(frames.map((f) => [f.ch, f.seq, f.t])).toEqual([
      [0, 1, 'hello'],
      [0, 2, 'ping'],
      [4, 1, 'error'],
      [4, 2, 'close'],
    ]);
    expect(frames[0]).toEqual({ v: PROTOCOL_VERSION, ch: 0, seq: 1, t: 'hello', leg: 'host', caps: ['perks'] });
  });

  it('always emits wire-valid frames (envelope wins over field collisions)', () => {
    const { mux, frames } = makeMux();
    mux.send(2, 'data', { v: 99, ch: 77, seq: 1234, t: 'error', b64: 'AA==' } as Record<string, unknown>);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ v: 1, ch: 2, seq: 1, t: 'data', b64: 'AA==' });
  });

  it('receive returns decoded frames, tolerates seq gaps, and drops invalid frames without their payload', () => {
    const { mux, log } = makeMux();
    const a = mux.receive(JSON.stringify({ v: 1, ch: 5, seq: 1, t: 'open', kind: 'perks' }));
    expect(a?.t).toBe('open');
    const b = mux.receive(JSON.stringify({ v: 1, ch: 5, seq: 5, t: 'close' }));
    expect(b?.t).toBe('close');
    expect(log).toHaveBeenCalledWith({ event: 'inbound_seq_gap', ch: 5, expected: 2, got: 5 });
    expect(mux.receive('nonsense')).toBeNull();
    expect(mux.receive(Buffer.from('binary'))).toBeNull();
    expect(mux.receive(JSON.stringify({ v: 1, ch: 0, seq: 1, t: 'open' }))).toBeNull();
    expect(log).toHaveBeenCalledWith({ event: 'dropped_invalid_frame', bytes: 8 });
    expect(log).toHaveBeenCalledWith({ event: 'dropped_invalid_frame', bytes: -1 });
    expect(JSON.stringify(log.mock.calls)).not.toContain('nonsense');
  });

  it('channel registry: open/handlerFor/close with a single teardown', () => {
    const { mux } = makeMux();
    let teardowns = 0;
    const handler: ChannelHandler = { onFrame: () => {}, onTeardown: () => teardowns++ };
    mux.openChannel(3, handler);
    expect(mux.handlerFor(3)).toBe(handler);
    mux.closeChannel(3);
    expect(mux.handlerFor(3)).toBeUndefined();
    mux.closeChannel(3);
    expect(teardowns).toBe(1);
  });

  it('reset tears down all channels and restarts seq counters', () => {
    const { mux, frames } = makeMux();
    const torn: number[] = [];
    mux.openChannel(1, { onFrame: () => {}, onTeardown: () => torn.push(1) });
    mux.openChannel(2, { onFrame: () => {}, onTeardown: () => torn.push(2) });
    mux.send(1, 'data', { b64: 'AA==' });
    mux.reset();
    expect(torn.sort()).toEqual([1, 2]);
    mux.send(1, 'data', { b64: 'AA==' });
    expect(frames[frames.length - 1].seq).toBe(1);
  });
});
