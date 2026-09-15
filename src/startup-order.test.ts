import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  adopted: false,
  releaseAdoption: undefined as (() => void) | undefined,
  routeInbound: vi.fn(),
  startChannels: vi.fn(),
  ready: vi.fn(),
}));
vi.mock('./backfill-container-configs.js', () => ({ backfillContainerConfigs: vi.fn() }));
vi.mock('./config.js', () => ({ CENTRAL_DB_PATH: ':memory:' }));
vi.mock('./circuit-breaker.js', () => ({ enforceStartupBackoff: vi.fn(), resetCircuitBreaker: vi.fn() }));
vi.mock('./upgrade-state.js', () => ({ enforceUpgradeTripwire: vi.fn() }));
vi.mock('./db/connection.js', () => ({ initDb: async () => ({ dialect: 'sqlite' }), closeDb: vi.fn() }));
vi.mock('./db/migrations/index.js', () => ({ runMigrations: vi.fn() }));
vi.mock('./drivers/index.js', () => ({ getSessionDriver: () => ({ ensureReady: vi.fn() }) }));
vi.mock('./container-runner.js', () => ({
  adoptRunningSessions: async () => {
    await new Promise<void>((resolve) => {
      state.releaseAdoption = resolve;
    });
    state.adopted = true;
  },
  abortGatewaySessionObservers: vi.fn(),
  resumeGatewaySessionAdmission: vi.fn(),
  stopGatewaySessionsForUnavailability: vi.fn(),
}));
vi.mock('./host-instance.js', () => ({ startHostInstanceLease: vi.fn(), stopHostInstanceLease: vi.fn() }));
vi.mock('./gateway-providers/index.js', () => ({ getGatewayProvider: () => ({}) }));
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
vi.mock('./host-sweep.js', () => ({ startHostSweep: vi.fn(), stopHostSweep: vi.fn() }));
vi.mock('./host-lifecycle.js', () => ({ startHostModules: vi.fn(), stopHostModules: vi.fn() }));
vi.mock('./router.js', () => ({ routeInbound: state.routeInbound }));
vi.mock('./response-registry.js', () => ({ getResponseHandlers: () => [] }));
vi.mock('./channels/index.js', () => ({}));
vi.mock('./modules/index.js', () => ({}));
vi.mock('./cli/commands/index.js', () => ({}));
vi.mock('./cli/delivery-action.js', () => ({}));
vi.mock('./cli/socket-server.js', () => ({ startCliServer: state.ready, stopCliServer: vi.fn() }));
vi.mock('./log.js', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), fatal: vi.fn() } }));
vi.mock('./channels/channel-registry.js', () => ({
  createChannelDeliveryAdapter: () => ({}),
  teardownChannelAdapters: vi.fn(),
  initChannelAdapters: state.startChannels,
}));

afterEach(() => vi.restoreAllMocks());

it('finishes adoption before a channel can route its first inbound message', async () => {
  vi.spyOn(process, 'on').mockReturnValue(process);
  state.routeInbound.mockImplementation(async () => {
    expect(state.adopted).toBe(true);
  });
  state.startChannels.mockImplementation(async (setup) => {
    setup({ channelType: 'fixture' }).onInbound('chat', null, {
      id: 'message',
      kind: 'text',
      content: 'hello',
      timestamp: new Date().toISOString(),
    });
  });
  await import('./index.js');
  await vi.waitFor(() => expect(state.releaseAdoption).toBeDefined());
  expect(state.startChannels).not.toHaveBeenCalled();
  state.releaseAdoption!();
  await vi.waitFor(() => expect(state.ready).toHaveBeenCalled());
  expect(state.routeInbound).toHaveBeenCalledOnce();
});
