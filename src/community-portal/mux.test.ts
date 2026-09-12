import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CONTROL_CHANNEL,
  CONTROL_TYPES,
  DATA_TYPES,
  MAX_CLIENT_FRAME_CHARS,
  MAX_SSH_FRAME_CHARS,
  Mux,
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  frameAllowance,
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

  it('pins the ssh channel frames: open with its target, data, credit, end, close, and the control renew pair', () => {
    const types = vectors.valid.map(({ frame }) => `${frame.ch === CONTROL_CHANNEL ? 'control' : 'data'}:${frame.t}`);
    for (const t of [
      'data:open',
      'data:data',
      'data:credit',
      'data:end',
      'data:close',
      'control:renew',
      'control:renewed',
    ])
      expect(types).toContain(t);
    const open = vectors.valid.find(({ frame }) => frame.t === 'open' && frame.kind === 'ssh')?.frame;
    expect(open).toMatchObject({
      stream: expect.stringMatching(/^[\w-]{22}$/),
      target: { account: expect.any(String) },
      source: { ip: expect.any(String), port: expect.any(Number) },
      ticket: expect.any(String),
    });
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
    expect(CONTROL_TYPES).toEqual(['hello', 'status', 'ping', 'pong', 'renew', 'renewed', 'perks.changed', 'error']);
    expect(DATA_TYPES).toEqual(['open', 'data', 'credit', 'end', 'error', 'close']);
    for (const t of CONTROL_TYPES) {
      expect(validateFrame({ v: 1, ch: CONTROL_CHANNEL, seq: 1, t })).toBe(true);
      if (t !== 'error') expect(validateFrame({ v: 1, ch: 9, seq: 1, t })).toBe(false);
    }
    for (const t of DATA_TYPES) {
      expect(validateFrame({ v: 1, ch: 9, seq: 1, t })).toBe(true);
      if (t !== 'error') expect(validateFrame({ v: 1, ch: CONTROL_CHANNEL, seq: 1, t })).toBe(false);
    }
  });

  it('allows 24 000 characters on an ssh channel and 4096 everywhere else', () => {
    expect(frameAllowance('ssh')).toBe(MAX_SSH_FRAME_CHARS);
    expect(frameAllowance('perks')).toBe(MAX_CLIENT_FRAME_CHARS);
    expect(frameAllowance(undefined)).toBe(MAX_CLIENT_FRAME_CHARS);
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
  const idle: ChannelHandler = { onFrame: () => {}, onTeardown: () => {} };
  /** A `pad` that makes the frame exactly `total` characters once the envelope is stamped. */
  const padTo = (ch: number, seq: number, t: string, total: number): string =>
    'x'.repeat(total - encodeFrame({ v: 1, ch, seq, t, pad: '' }).length);

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

  it('sends a 16 KiB chunk on an ssh channel and refuses that frame on any other channel', () => {
    const { mux, raws, log } = makeMux();
    mux.openChannel(1, idle, 'perks');
    mux.openChannel(2, idle, 'ssh');
    expect(mux.allowance(0)).toBe(4096);
    expect(mux.allowance(1)).toBe(4096);
    expect(mux.allowance(2)).toBe(24_000);
    expect(mux.allowance(9)).toBe(4096);
    const chunk = Buffer.alloc(16_384, 7).toString('base64');
    expect(mux.send(2, 'data', { off: 0, b64: chunk })).toBe(true);
    expect(raws.at(-1)?.length).toBeLessThanOrEqual(24_000);
    expect(mux.send(1, 'data', { off: 0, b64: chunk })).toBe(false);
    expect(mux.send(0, 'hello', { pad: chunk })).toBe(false);
    expect(raws).toHaveLength(1);
    const chunkFrame = encodeFrame({ off: 0, b64: chunk, v: 1, ch: 1, seq: 1, t: 'data' }).length;
    expect(chunkFrame).toBeGreaterThan(21_848);
    expect(log).toHaveBeenCalledWith({
      event: 'dropped_oversize_frame',
      ch: 1,
      t: 'data',
      chars: chunkFrame,
      allowance: 4096,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(chunk.slice(0, 32));
    // The boundaries are inclusive.
    expect(mux.send(2, 'data', { pad: padTo(2, 2, 'data', 24_000) })).toBe(true);
    expect(mux.send(2, 'data', { pad: padTo(2, 3, 'data', 24_001) })).toBe(false);
    expect(mux.send(1, 'close', { pad: padTo(1, 2, 'close', 4096) })).toBe(true);
    expect(mux.send(1, 'close', { pad: padTo(1, 3, 'close', 4097) })).toBe(false);
    expect(mux.send(0, 'ping', { pad: padTo(0, 2, 'ping', 4096) })).toBe(true);
    expect(mux.send(0, 'ping', { pad: padTo(0, 3, 'ping', 4097) })).toBe(false);
    expect(raws.map((raw) => raw.length)).toEqual([chunkFrame, 24_000, 4096, 4096]);
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

  it('receive holds inbound ssh channel frames to their allowance and lets the cell send big perks frames', () => {
    const { mux, log } = makeMux();
    mux.openChannel(1, idle, 'perks');
    mux.openChannel(2, idle, 'ssh');
    const big = 'x'.repeat(30_000);
    expect(mux.receive(JSON.stringify({ v: 1, ch: 1, seq: 1, t: 'data', snapshot: big }))?.t).toBe('data');
    const raw = JSON.stringify({ v: 1, ch: 2, seq: 1, t: 'data', off: 0, b64: big });
    expect(mux.receive(raw)).toBeNull();
    expect(log).toHaveBeenCalledWith({
      event: 'dropped_oversize_frame',
      ch: 2,
      t: 'data',
      chars: raw.length,
      allowance: 24_000,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('xxxx');
    const chunk = Buffer.alloc(16_384, 7).toString('base64');
    expect(mux.receive(JSON.stringify({ v: 1, ch: 2, seq: 1, t: 'data', off: 0, b64: chunk }))?.t).toBe('data');
  });

  it('channel registry: open/handlerFor/close with a single teardown, kinds and counts', () => {
    const { mux } = makeMux();
    let teardowns = 0;
    const handler: ChannelHandler = { onFrame: () => {}, onTeardown: () => teardowns++ };
    mux.openChannel(3, handler);
    expect(mux.handlerFor(3)).toBe(handler);
    expect(mux.kindOf(3)).toBeUndefined();
    mux.openChannel(4, idle, 'ssh');
    mux.openChannel(6, idle, 'ssh');
    mux.openChannel(5, idle, 'perks');
    expect(mux.channelsOfKind('ssh')).toEqual([4, 6]);
    expect(mux.channelsOfKind('perks')).toEqual([5]);
    mux.closeChannel(3);
    expect(mux.handlerFor(3)).toBeUndefined();
    mux.closeChannel(3);
    expect(teardowns).toBe(1);
    mux.closeChannel(4);
    expect(mux.channelsOfKind('ssh')).toEqual([6]);
  });

  it('reset tears down all channels and restarts seq counters', () => {
    const { mux, frames } = makeMux();
    const torn: number[] = [];
    mux.openChannel(1, { onFrame: () => {}, onTeardown: () => torn.push(1) });
    mux.openChannel(2, { onFrame: () => {}, onTeardown: () => torn.push(2) }, 'ssh');
    mux.send(1, 'data', { b64: 'AA==' });
    mux.reset();
    expect(torn.sort()).toEqual([1, 2]);
    expect(mux.channelsOfKind('ssh')).toEqual([]);
    mux.send(1, 'data', { b64: 'AA==' });
    expect(frames[frames.length - 1].seq).toBe(1);
  });
});
