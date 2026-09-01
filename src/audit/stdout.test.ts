import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { AuditStdoutSink } from './stdout.js';

class FakeOutput extends EventEmitter {
  readonly writes: string[] = [];
  blocked = false;
  fail = false;

  write(value: string): boolean {
    if (this.fail) throw new Error('EPIPE');
    this.writes.push(value);
    return !this.blocked;
  }
}

describe('Host audit stdout copy', () => {
  it('writes one exact canonical record and queues bounded work behind backpressure', () => {
    const output = new FakeOutput();
    const warnings = { write: vi.fn(() => true) };
    const sink = new AuditStdoutSink(output, warnings);
    output.blocked = true;

    sink.writeCanonical('{"seq":1}');
    sink.writeCanonical('{"seq":2}');
    expect(output.writes).toEqual(['{"seq":1}\n']);

    output.blocked = false;
    output.emit('drain');
    expect(output.writes).toEqual(['{"seq":1}\n', '{"seq":2}\n']);
    expect(warnings.write).not.toHaveBeenCalled();
  });

  it('drops and warns without throwing when stdout fails', () => {
    const output = new FakeOutput();
    const warnings = { write: vi.fn(() => true) };
    const sink = new AuditStdoutSink(output, warnings);
    output.fail = true;

    expect(() => sink.writeCanonical('{"seq":1}')).not.toThrow();
    expect(warnings.write).toHaveBeenCalledWith(expect.stringContaining('stdout copy failed'));
  });

  it('bounds queued records and warns when backpressure exhausts the queue', () => {
    const output = new FakeOutput();
    const warnings = { write: vi.fn(() => true) };
    const sink = new AuditStdoutSink(output, warnings);
    output.blocked = true;

    for (let seq = 1; seq <= 514; seq++) sink.writeCanonical(`{"seq":${seq}}`);
    expect(output.writes).toHaveLength(1);
    expect(warnings.write).toHaveBeenCalledWith(expect.stringContaining('stdout copies dropped'));

    output.blocked = false;
    output.emit('drain');
    expect(output.writes).toHaveLength(513);
  });

  it('counts and warns for records still queued at shutdown', () => {
    const output = new FakeOutput();
    const warnings = { write: vi.fn(() => true) };
    const sink = new AuditStdoutSink(output, warnings);
    output.blocked = true;

    sink.writeCanonical('{"seq":1}');
    sink.writeCanonical('{"seq":2}');
    sink.shutdown();

    expect(output.writes).toEqual(['{"seq":1}\n']);
    expect(warnings.write).toHaveBeenCalledWith(expect.stringContaining('stdout copies dropped: 1'));
    sink.writeCanonical('{"seq":3}');
    expect(output.writes).toEqual(['{"seq":1}\n']);
  });
});
