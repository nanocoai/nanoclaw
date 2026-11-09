import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  attached: false,
  internal: true,
  /** Thrown by the network's Internal inspect, as execFileSync throws. */
  inspectError: undefined as Error | undefined,
  access: { endpoint: 'gateway.internal', target: { kind: 'runtime' as const, identity: 'fixture-gateway' } },
  execFileSync: vi.fn(),
}));

// Partial mock on purpose. A whole-module replacement here is green on trunk
// and red on every real install: the gateway barrel pulls the installed
// provider in, and a provider that imports any other `child_process` export
// (execFile, spawn) then finds it missing.
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFileSync: state.execFileSync,
}));
vi.mock('./config.js', () => ({ EGRESS_LOCKDOWN: true, EGRESS_NETWORK: 'fixture-egress' }));
vi.mock('./container-runtime.js', () => ({ CONTAINER_RUNTIME_BIN: 'docker' }));
// Every level, for the same reason the child_process mock is partial: the
// gateway barrel imports the installed provider, whose module-scope work can
// log at any level.
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { ensureEgressNetwork } from './egress-lockdown.js';

describe('gateway egress attachment', () => {
  beforeEach(() => {
    state.attached = false;
    state.internal = true;
    state.inspectError = undefined;
    state.access = { endpoint: 'gateway.internal', target: { kind: 'runtime', identity: 'fixture-gateway' } };
    state.execFileSync.mockReset().mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === 'network' && args[1] === 'connect') state.attached = true;
      if (args.includes('{{.Internal}}')) {
        if (state.inspectError) throw state.inspectError;
        return String(state.internal);
      }
      if (args.includes('--format')) return state.attached ? 'fixture-gateway ' : '';
      return '';
    });
  });

  it('attaches the selected provider target under its declared endpoint', () => {
    expect(ensureEgressNetwork(state.access)).toBe(true);
    expect(state.execFileSync).toHaveBeenCalledWith(
      'docker',
      ['network', 'connect', '--alias', 'gateway.internal', 'fixture-egress', 'fixture-gateway'],
      expect.objectContaining({ timeout: 15000 }),
    );
  });

  it('fails closed when the selected target cannot join the locked network', () => {
    expect(() => ensureEgressNetwork({ endpoint: 'gateway.internal', target: { kind: 'host' } })).toThrow(
      "target 'host' cannot join",
    );
    expect(state.execFileSync).not.toHaveBeenCalled();
  });

  it('creates the egress network when the inspect says it does not exist', () => {
    state.inspectError = Object.assign(new Error('Command failed'), {
      stderr: 'Error response from daemon: network fixture-egress not found\n',
    });

    expect(ensureEgressNetwork(state.access)).toBe(true);
    expect(state.execFileSync).toHaveBeenCalledWith(
      'docker',
      ['network', 'create', '--internal', 'fixture-egress'],
      expect.anything(),
    );
  });

  it('names a failed inspect instead of trying to create the network', () => {
    state.inspectError = Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' });

    expect(() => ensureEgressNetwork(state.access)).toThrow('"fixture-egress" network could not be inspected');
    expect(state.execFileSync).not.toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['create']),
      expect.anything(),
    );
  });

  it('fails closed when the egress network exists but is not internal', () => {
    state.internal = false;

    expect(() => ensureEgressNetwork(state.access)).toThrow('"fixture-egress" network is not internal');
    expect(state.execFileSync).not.toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['connect']),
      expect.anything(),
    );
  });
});

it('heals a recreated gateway after restoring the adopted session network intent', () => {
  state.execFileSync.mockImplementation((_bin: string, args: string[]) => {
    if (args[0] === 'network' && args[1] === 'connect') state.attached = true;
    if (args.includes('{{.Internal}}')) return String(state.internal);
    if (args.includes('--format')) return state.attached ? 'fixture-gateway ' : '';
    return '';
  });
  state.attached = false;
  state.internal = true;
  ensureEgressNetwork(state.access);
  state.attached = false;
  state.execFileSync.mockClear();
  expect(ensureEgressNetwork()).toBe(true);
  expect(state.execFileSync).toHaveBeenCalledWith(
    'docker',
    ['network', 'connect', '--alias', 'gateway.internal', 'fixture-egress', 'fixture-gateway'],
    expect.anything(),
  );
});
