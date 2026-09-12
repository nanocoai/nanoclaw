/**
 * The landing decision table and the landing around it, with the host's
 * sandbox verbs and the terminal hand-over faked.
 */
import { describe, expect, it, vi } from 'vitest';

import { decideLanding } from './landing-decision.js';
import { runLanding, type AttachTarget, type LandingIo, type SandboxVerbs } from './landing.js';
import type { DoorStream, DoorTarget } from './target-map.js';

const streamFor = (target: DoorTarget): DoorStream => ({ target, openedAt: '2026-09-11T12:00:00.000Z' });
const targetFor = (name: string): AttachTarget => ({ containerName: `ncl-${name}`, command: ['tmux', 'attach'] });

interface Fakes {
  io: LandingIo;
  out: string[];
  err: string[];
  sandboxes: SandboxVerbs;
  run: (target: AttachTarget) => Promise<number>;
}

function fakes(names: string[] = [], failAttach?: string): Fakes {
  const f: Fakes = {
    out: [],
    err: [],
    io: undefined as unknown as LandingIo,
    sandboxes: undefined as unknown as SandboxVerbs,
    run: vi.fn(async (_target: AttachTarget) => 7),
  };
  f.io = { write: (t) => f.out.push(t), fail: (t) => f.err.push(t) };
  f.sandboxes = {
    list: vi.fn(async () => ({ names, human: `SANDBOX\n${names.join('\n')}` })),
    attach: vi.fn(async (name: string) => {
      if (failAttach) throw new Error(failAttach);
      return targetFor(name);
    }),
    create: vi.fn(async (name: string) => targetFor(name)),
  };
  return f;
}

describe('decideLanding', () => {
  it.each([
    [undefined, ['alice'], 'refuse'],
    [{ account: 'alice', sandbox: 'demo' }, [], 'attach:demo'],
    [{ account: 'alice', sandbox: 'demo' }, ['alice', 'demo'], 'attach:demo'],
    [{ account: 'alice' }, ['alice'], 'attach:alice'],
    [{ account: 'alice' }, ['other'], 'new:alice'],
    [{ account: '' }, [], 'refuse'],
  ] as const)('%j with sandboxes %j → %s', (target, existing, expected) => {
    const decision = decideLanding(target && streamFor(target as DoorTarget), existing);
    expect(
      decision.verb === 'refuse' || decision.verb === 'list' ? decision.verb : `${decision.verb}:${decision.name}`,
    ).toBe(expected);
  });

  it('turns `ls`/`list` into a listing and refuses any other command with usage (exit 2)', () => {
    const stream = streamFor({ account: 'alice' });
    expect(decideLanding(stream, [], 'ls')).toEqual({ verb: 'list' });
    expect(decideLanding(stream, [], ' list ')).toEqual({ verb: 'list' });
    expect(decideLanding(stream, [], 'bash')).toMatchObject({ verb: 'refuse', code: 2 });
    expect(decideLanding(undefined, [], 'ls')).toMatchObject({ verb: 'refuse', code: 1 });
  });
});

describe('runLanding', () => {
  it('attaches a named sandbox target and hands the terminal over', async () => {
    const f = fakes();
    expect(await runLanding({ stream: streamFor({ account: 'alice', sandbox: 'demo' }), ...f })).toBe(7);
    expect(f.sandboxes.list).not.toHaveBeenCalled();
    expect(f.sandboxes.attach).toHaveBeenCalledWith('demo');
    expect(f.run).toHaveBeenCalledWith(targetFor('demo'));
    expect(f.out.join('')).toContain('Attaching to sandbox demo');
  });

  it('creates the account default sandbox on first use, attaches it afterwards', async () => {
    const first = fakes([]);
    expect(await runLanding({ stream: streamFor({ account: 'alice' }), ...first })).toBe(7);
    expect(first.sandboxes.create).toHaveBeenCalledWith('alice');
    expect(first.out.join('')).toContain('Creating sandbox alice');

    const again = fakes(['alice']);
    expect(await runLanding({ stream: streamFor({ account: 'alice' }), ...again })).toBe(7);
    expect(again.sandboxes.attach).toHaveBeenCalledWith('alice');
    expect(again.sandboxes.create).not.toHaveBeenCalled();
  });

  it('refuses a connection the host has no stream for, without touching the host', async () => {
    const f = fakes(['alice']);
    expect(await runLanding({ stream: undefined, ...f })).toBe(1);
    expect(f.err.join('')).toMatch(/no target/);
    expect(f.sandboxes.list).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it('lists for `ls` and refuses other commands with usage', async () => {
    const ls = fakes(['alice', 'demo']);
    expect(await runLanding({ stream: streamFor({ account: 'alice', sandbox: 'demo' }), command: 'ls', ...ls })).toBe(
      0,
    );
    expect(ls.out.join('')).toBe('SANDBOX\nalice\ndemo\n');
    expect(ls.run).not.toHaveBeenCalled();

    const other = fakes(['alice']);
    expect(await runLanding({ stream: streamFor({ account: 'alice' }), command: 'bash -i', ...other })).toBe(2);
    expect(other.err.join('')).toMatch(/usage/);
  });

  it('reports a vanished sandbox, other attach errors, and a listing failure', async () => {
    const gone = fakes([], "no sandbox 'gone' — create it");
    expect(await runLanding({ stream: streamFor({ account: 'alice', sandbox: 'gone' }), ...gone })).toBe(1);
    expect(gone.err.join('')).toBe('sandbox gone no longer exists\n');

    const cold = fakes([], 'container did not come up');
    expect(await runLanding({ stream: streamFor({ account: 'alice', sandbox: 'demo' }), ...cold })).toBe(1);
    expect(cold.err.join('')).toContain('container did not come up');

    const down = fakes();
    vi.mocked(down.sandboxes.list).mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await runLanding({ stream: streamFor({ account: 'alice' }), ...down })).toBe(1);
    expect(down.err.join('')).toMatch(/could not list.*ECONNREFUSED/);
  });
});
