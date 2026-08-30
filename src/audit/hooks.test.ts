/**
 * Post-write hook contract: hooks observe the LOG (fire only after a
 * successful append, exported ⊆ written), failures are isolated everywhere,
 * and the lifecycle (init/maintain/shutdown) behaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  enabled: true,
  hostId: 'deployment-test-01',
  appendThrows: false,
  appended: [] as string[],
  stdout: [] as string[],
  appendGate: null as Promise<void> | null,
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-hooks-unused',
  };
});

vi.mock('./config.js', () => ({
  get AUDIT_ENABLED() {
    return state.enabled;
  },
  AUDIT_RETENTION_HOURS: 12,
  get AUDIT_HOST_ID() {
    return state.hostId;
  },
}));

vi.mock('./store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store.js')>();
  return {
    ...actual,
    appendAuditEvent: async (build: (seq: number) => import('./types.js').AuditEvent) => {
      if (state.appendThrows) throw new Error('disk full');
      if (state.appendGate) await state.appendGate;
      const event = build(state.appended.length + 1);
      const line = JSON.stringify(event);
      state.appended.push(line);
      return { event, line };
    },
  };
});

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('./stdout.js', () => ({
  auditStdout: { writeCanonical: (line: string) => state.stdout.push(line) },
}));
vi.mock('./pseudonym.js', () => ({
  pseudonymizeAuditInput: (input: { actor?: { type?: string } }) => input.actor?.type === 'human'
    ? { ...input, actor: { ...input.actor, id: `hmac:${'a'.repeat(64)}` } }
    : input,
}));

let hooks: typeof import('./hooks.js');
let emit: typeof import('./emit.js');
let log: (typeof import('../log.js'))['log'];

beforeEach(async () => {
  state.enabled = true;
  state.hostId = 'deployment-test-01';
  state.appendThrows = false;
  state.appended.length = 0;
  state.stdout.length = 0;
  state.appendGate = null;
  vi.resetModules(); // fresh hook registry per test
  hooks = await import('./hooks.js');
  emit = await import('./emit.js');
  emit.openAuditWriteAdmission();
  log = (await import('../log.js')).log;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

const EVENT_INPUT: import('./types.js').AuditEventInput = {
  eventType: 'ncl_action' as const,
  actor: { type: 'human' as const, id: 'host:test' },
  agentId: null,
  sessionId: null,
  dimensions: {
    transport: 'socket' as const,
    arg_names: [],
    action: 'groups.list',
    outcome: 'success' as const,
    resource_refs: ['agent_group'],
  },
};

describe('post-write notification', () => {
  it('calls a registered hook with the parsed event and the exact stored line', async () => {
    const seen: Array<{ event: import('./types.js').AuditEvent; line: string }> = [];
    hooks.registerAuditHook({ name: 'demo', onEvent: (event, line) => seen.push({ event, line }) });

    await emit.emitAuditEvent(EVENT_INPUT);

    expect(state.appended).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].line).toBe(state.appended[0]);
    expect(state.stdout).toEqual([state.appended[0]]);
    expect(JSON.parse(seen[0].line)).toEqual(seen[0].event);
    expect(seen[0].event.dimensions.action).toBe('groups.list');
  });

  it('does NOT call hooks when the local append fails — exported ⊆ written', async () => {
    const onEvent = vi.fn();
    hooks.registerAuditHook({ name: 'demo', onEvent });
    state.appendThrows = true;

    await expect(emit.emitAuditEvent(EVENT_INPUT)).resolves.toBeUndefined();
    expect(onEvent).not.toHaveBeenCalled();
    expect(state.stdout).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Audit append failed'), expect.anything());
  });

  it('waits for every accepted PostgreSQL write before shutdown completes', async () => {
    let release!: () => void;
    state.appendGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const accepted = emit.emitAuditEvent(EVENT_INPUT);
    let shutdownComplete = false;
    const shutdown = emit.closeAuditWriteAdmissionAndWait().then(() => {
      shutdownComplete = true;
    });
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);
    expect(emit.pendingAuditWritesForTest()).toBe(1);

    release();
    await accepted;
    await shutdown;
    expect(state.appended).toHaveLength(1);
    expect(state.stdout).toEqual(state.appended);
    expect(emit.pendingAuditWritesForTest()).toBe(0);
  });

  it('does NOT call hooks when audit is disabled', async () => {
    const onEvent = vi.fn();
    hooks.registerAuditHook({ name: 'demo', onEvent });
    state.enabled = false;

    await emit.emitAuditEvent(EVENT_INPUT);

    expect(state.appended).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it.each([
    { field: 'agentId', value: '' },
    { field: 'sessionId', value: '' },
  ])('rejects an empty $field before it can become durable poison', async ({ field, value }) => {
    const onEvent = vi.fn();
    hooks.registerAuditHook({ name: 'demo', onEvent });

    await emit.emitAuditEvent({ ...EVENT_INPUT, [field]: value });

    expect(state.appended).toHaveLength(0);
    expect(onEvent).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Audit append failed'), expect.anything());
  });

  it('accepts the deployed uppercase/dot/colon NANOCO_DEPLOYMENT_ID grammar', async () => {
    state.hostId = `Prod.EU:Host-${'x'.repeat(115)}`; // exactly 128 ASCII bytes

    await emit.emitAuditEvent(EVENT_INPUT);

    expect(state.appended).toHaveLength(1);
    expect(JSON.parse(state.appended[0]).host_id).toBe(state.hostId);
  });

  it.each(['', 'bad/host', `a${'x'.repeat(128)}`])('rejects unsupported host_id %j before append', async (hostId) => {
    state.hostId = hostId;

    await emit.emitAuditEvent(EVENT_INPUT);

    expect(state.appended).toHaveLength(0);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Audit append failed'), expect.anything());
  });

  it('isolates a throwing hook: the write survives, later hooks still run, the action proceeds', async () => {
    const second = vi.fn();
    hooks.registerAuditHook({
      name: 'broken',
      onEvent: () => {
        throw new Error('exporter exploded');
      },
    });
    hooks.registerAuditHook({ name: 'healthy', onEvent: second });

    await expect(emit.emitAuditEvent(EVENT_INPUT)).resolves.toBeUndefined();

    expect(state.appended).toHaveLength(1); // the log has the event regardless
    expect(second).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('Audit hook threw'),
      expect.objectContaining({ hook: 'broken', action: 'groups.list' }),
    );
  });
});

describe('lifecycle', () => {
  it('initAuditHooks isolates a failing reporting hook and names it in the log', () => {
    hooks.registerAuditHook({ name: 'ok', onEvent: () => {}, init: vi.fn() });
    hooks.registerAuditHook({
      name: 'bad-boot',
      onEvent: () => {},
      init: () => {
        throw new Error('no route to collector');
      },
    });

    expect(() => hooks.initAuditHooks()).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('initialization failed'),
      expect.objectContaining({ hook: 'bad-boot' }),
    );
  });

  it('defers init() until boot for a hook registered before initAuditHooks', () => {
    const init = vi.fn();
    hooks.registerAuditHook({ name: 'early', onEvent: () => {}, init });

    expect(init).not.toHaveBeenCalled(); // not yet — boot hasn't run
    hooks.initAuditHooks();
    expect(init).toHaveBeenCalledTimes(1); // exactly once, at boot
  });

  it('runs init() immediately for a hook registered after boot — import-order-insensitive', async () => {
    hooks.initAuditHooks(); // boot completes (no hooks yet)
    const init = vi.fn();
    const onEvent = vi.fn();

    hooks.registerAuditHook({ name: 'late', onEvent, init });

    // A module that loaded after the CLI adapter still gets its one-time init...
    expect(init).toHaveBeenCalledTimes(1);
    // ...and still receives events (onEvent already read the live array).
    await emit.emitAuditEvent(EVENT_INPUT);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('a late hook whose init throws is isolated and named', () => {
    hooks.initAuditHooks();

    expect(() =>
      hooks.registerAuditHook({
        name: 'late-bad',
        onEvent: () => {},
        init: () => {
          throw new Error('no route to collector');
        },
      }),
    ).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('initialization failed'),
      expect.objectContaining({ hook: 'late-bad' }),
    );
  });

  it('maintainAuditHooks calls every maintain and isolates throws', () => {
    const m1 = vi.fn(() => {
      throw new Error('flush failed');
    });
    const m2 = vi.fn();
    hooks.registerAuditHook({ name: 'a', onEvent: () => {}, maintain: m1 });
    hooks.registerAuditHook({ name: 'b', onEvent: () => {}, maintain: m2 });
    hooks.registerAuditHook({ name: 'c', onEvent: () => {} }); // no maintain — fine

    expect(() => hooks.maintainAuditHooks()).not.toThrow();
    expect(m1).toHaveBeenCalledTimes(1);
    expect(m2).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('maintenance failed'),
      expect.objectContaining({ hook: 'a' }),
    );
  });

  it('shutdownAuditHooks awaits async shutdowns and isolates throws', async () => {
    const order: string[] = [];
    hooks.registerAuditHook({
      name: 'a',
      onEvent: () => {},
      shutdown: async () => {
        await Promise.resolve();
        order.push('a');
      },
    });
    hooks.registerAuditHook({
      name: 'b',
      onEvent: () => {},
      shutdown: () => {
        throw new Error('handle already closed');
      },
    });
    hooks.registerAuditHook({
      name: 'c',
      onEvent: () => {},
      shutdown: () => {
        order.push('c');
      },
    });

    await hooks.shutdownAuditHooks();

    expect(order).toEqual(['a', 'c']);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('shutdown failed'),
      expect.objectContaining({ hook: 'b' }),
    );
  });

  it('maintainAudit skips hook maintenance when audit is disabled', async () => {
    const init = await import('./init.js');
    const maintain = vi.fn();
    hooks.registerAuditHook({ name: 'a', onEvent: () => {}, maintain });

    state.enabled = false;
    await init.maintainAudit();
    expect(maintain).not.toHaveBeenCalled();

    state.enabled = true;
    await init.maintainAudit();
    expect(maintain).toHaveBeenCalledTimes(1);
  });
});
