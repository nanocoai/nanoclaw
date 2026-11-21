import { afterEach, expect, it, vi } from 'vitest';

// Reuse startup-order.test.ts's isolated entry-point seam: index itself runs,
// but every external runtime adapter and side-effect barrel is replaced.
const state = vi.hoisted(() => ({
  running: undefined as (() => void) | undefined,
  stopped: undefined as (() => void) | undefined,
  exited: undefined as (() => void) | undefined,
  stopGate: undefined as Promise<void> | undefined,
  stopSweep: vi.fn(),
  stopCli: vi.fn(),
  teardown: vi.fn(),
  closeDb: vi.fn(),
  fatal: vi.fn(),
}));
vi.mock('./backfill-container-configs.js', () => ({ backfillContainerConfigs: vi.fn() }));
vi.mock('./config.js', () => ({ CENTRAL_DB_PATH: ':memory:' }));
vi.mock('./circuit-breaker.js', () => ({ enforceStartupBackoff: vi.fn(), resetCircuitBreaker: vi.fn() }));
vi.mock('./upgrade-state.js', () => ({ enforceUpgradeTripwire: vi.fn() }));
vi.mock('./db/connection.js', () => ({ initDb: async () => ({ dialect: 'sqlite' }), closeDb: state.closeDb }));
vi.mock('./db/migrations/index.js', () => ({ runMigrations: vi.fn() }));
vi.mock('./drivers/index.js', () => ({ getSessionDriver: () => ({ ensureReady: vi.fn() }) }));
vi.mock('./container-runner.js', () => ({
  adoptRunningSessions: vi.fn(),
  abortGatewaySessionObservers: vi.fn(),
  refreshStaleGroupImages: vi.fn(async () => {}),
  resumeGatewaySessionAdmission: vi.fn(),
  stopGatewaySessionsForUnavailability: vi.fn(),
}));
vi.mock('./host-instance.js', () => ({ startHostInstanceLease: vi.fn(), stopHostInstanceLease: vi.fn() }));
vi.mock('./gateway-providers/index.js', () => ({ getGatewayProvider: () => ({}), resetGatewayProvider: vi.fn() }));
vi.mock('./gateway-availability.js', () => ({ startGatewayAvailabilityMonitor: vi.fn() }));
vi.mock('./gateway-approval-coordinator.js', () => ({
  startGatewayApprovalCoordinator: vi.fn(),
  stopGatewayApprovalCoordinator: vi.fn(),
}));
vi.mock('./delivery.js', () => ({
  startActiveDeliveryPoll: vi.fn(),
  startSweepDeliveryPoll: vi.fn(),
  setDeliveryAdapter: vi.fn(),
  stopDeliveryPolls: vi.fn(),
}));
vi.mock('./host-sweep.js', () => ({ startHostSweep: vi.fn(), stopHostSweep: state.stopSweep }));
vi.mock('./host-lifecycle.js', () => ({ startHostModules: vi.fn(), stopHostModules: vi.fn() }));
vi.mock('./router.js', () => ({ routeInbound: vi.fn() }));
vi.mock('./response-registry.js', () => ({ dispatchResponse: vi.fn() }));
vi.mock('./channels/index.js', () => ({}));
vi.mock('./modules/index.js', () => ({}));
vi.mock('./cli/commands/index.js', () => ({}));
vi.mock('./cli/delivery-action.js', () => ({}));
vi.mock('./cli/socket-server.js', () => ({ startCliServer: vi.fn(), stopCliServer: state.stopCli }));
vi.mock('./log.js', () => ({
  log: {
    info: vi.fn((message: string) => {
      if (message === 'NanoClaw running') state.running?.();
    }),
    error: vi.fn(),
    warn: vi.fn(),
    fatal: state.fatal,
  },
}));
vi.mock('./channels/channel-registry.js', () => ({
  createChannelDeliveryAdapter: () => ({}),
  teardownChannelAdapters: state.teardown,
  initChannelAdapters: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

it('awaits host-sweep drain in the real SIGTERM handler before teardown and DB close', async () => {
  const handlers = new Map<string, () => void>();
  // Do not register actual process handlers or permit a real process exit.
  vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => void) => {
    handlers.set(event, handler);
    return process;
  }) as typeof process.on);
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
    state.exited?.();
  }) as typeof process.exit);
  const running = new Promise<void>((resolve) => {
    state.running = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    state.stopped = resolve;
  });
  const exited = new Promise<void>((resolve) => {
    state.exited = resolve;
  });
  let release!: () => void;
  state.stopGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.stopSweep.mockImplementation(() => {
    state.stopped?.();
    return state.stopGate;
  });
  let signalled = false;
  try {
    await import('./index.js');
    await running;
    expect(state.fatal).not.toHaveBeenCalled();
    expect(handlers.has('SIGINT')).toBe(true);
    expect(handlers.has('SIGTERM')).toBe(true);
    signalled = true;
    handlers.get('SIGTERM')!();
    await stopped;
    // One event-loop turn drains the shutdown continuation if it forgot await.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(state.stopSweep).toHaveBeenCalledOnce();
    expect(state.stopCli).not.toHaveBeenCalled();
    expect(state.teardown).not.toHaveBeenCalled();
    expect(state.closeDb).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    release();
    await exited;
    expect(state.stopCli).toHaveBeenCalledOnce();
    expect(state.teardown).toHaveBeenCalledOnce();
    expect(state.closeDb).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  } finally {
    release();
    // Even a failing pre-release assertion must settle the real shutdown.
    if (signalled) await exited;
    state.running = state.stopped = state.exited = undefined;
    state.stopGate = undefined;
  }
});
