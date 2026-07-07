import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockIsContainerRunning = vi.fn<(id: string) => boolean>();
const mockKillContainer = vi.fn<(id: string, reason: string, onExit?: () => void) => void>();
const mockWakeContainer = vi.fn();
vi.mock('./container-runner.js', () => ({
  isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(args[0] as string),
  killContainer: (...args: unknown[]) =>
    mockKillContainer(args[0] as string, args[1] as string, args[2] as (() => void) | undefined),
  wakeContainer: (...args: unknown[]) => mockWakeContainer(...args),
}));

const mockGetSessionsByAgentGroup = vi.fn();
const mockGetSession = vi.fn();
vi.mock('./db/sessions.js', () => ({
  getSessionsByAgentGroup: (...args: unknown[]) => mockGetSessionsByAgentGroup(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

const mockWriteSessionMessage = vi.fn();
vi.mock('./session-manager.js', () => ({
  writeSessionMessage: (...args: unknown[]) => mockWriteSessionMessage(...args),
  openInboundDb: () => ({}),
}));

const mockCountDueMessages = vi.fn((..._args: unknown[]) => 0);
vi.mock('./db/session-db.js', () => ({
  countDueMessages: (...args: unknown[]) => mockCountDueMessages(...args),
}));

import { restartAgentGroupContainers } from './container-restart.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Helpers ---

function makeSession(id: string, agentGroupId: string, status = 'active') {
  return { id, agent_group_id: agentGroupId, status };
}

// --- Tests ---

describe('restartAgentGroupContainers', () => {
  it('skips sessions without a running container', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1'), makeSession('s2', 'g1')]);
    mockIsContainerRunning.mockReturnValue(false);

    const count = restartAgentGroupContainers('g1', 'test');

    expect(count).toBe(0);
    expect(mockKillContainer).not.toHaveBeenCalled();
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
  });

  it('skips non-active sessions', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1', 'closed')]);
    mockIsContainerRunning.mockReturnValue(true);

    const count = restartAgentGroupContainers('g1', 'test');

    expect(count).toBe(0);
    expect(mockKillContainer).not.toHaveBeenCalled();
  });

  it('kills running containers and returns count', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1'), makeSession('s2', 'g1')]);
    mockIsContainerRunning.mockImplementation((id) => id === 's1');

    const count = restartAgentGroupContainers('g1', 'test');

    expect(count).toBe(1);
    expect(mockKillContainer).toHaveBeenCalledTimes(1);
    expect(mockKillContainer).toHaveBeenCalledWith('s1', 'test', undefined);
  });

  it('does not write wake message when wakeMessage is omitted', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);

    restartAgentGroupContainers('g1', 'test');

    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
    expect(mockKillContainer).toHaveBeenCalledWith('s1', 'test', undefined);
  });

  it('writes on_wake message and passes onExit callback when wakeMessage is provided', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);

    restartAgentGroupContainers('g1', 'test', 'Resuming.');

    // Should write an on-wake message
    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(1);
    const [agentGroupId, sessionId, msg] = mockWriteSessionMessage.mock.calls[0];
    expect(agentGroupId).toBe('g1');
    expect(sessionId).toBe('s1');
    expect(msg.onWake).toBe(1);
    expect(JSON.parse(msg.content).text).toBe('Resuming.');

    // Should pass an onExit callback to killContainer
    expect(mockKillContainer).toHaveBeenCalledTimes(1);
    const onExit = mockKillContainer.mock.calls[0][2];
    expect(typeof onExit).toBe('function');
  });

  it('onExit callback calls wakeContainer with refreshed session', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);
    const freshSession = makeSession('s1', 'g1');
    mockGetSession.mockReturnValue(freshSession);

    restartAgentGroupContainers('g1', 'test', 'Resuming.');

    // Simulate container exit by calling the onExit callback
    const onExit = mockKillContainer.mock.calls[0][2] as () => void;
    onExit();

    expect(mockGetSession).toHaveBeenCalledWith('s1');
    expect(mockWakeContainer).toHaveBeenCalledWith(freshSession);
  });

  it('onExit callback does not wake if session no longer exists', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);
    mockGetSession.mockReturnValue(undefined);

    restartAgentGroupContainers('g1', 'test', 'Resuming.');

    const onExit = mockKillContainer.mock.calls[0][2] as () => void;
    onExit();

    expect(mockWakeContainer).not.toHaveBeenCalled();
  });

  it('handles multiple running sessions with wake message', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1'), makeSession('s2', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);

    const count = restartAgentGroupContainers('g1', 'test', 'Config updated.');

    expect(count).toBe(2);
    expect(mockKillContainer).toHaveBeenCalledTimes(2);
    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(2);

    // Each session gets its own on-wake message
    expect(mockWriteSessionMessage.mock.calls[0][1]).toBe('s1');
    expect(mockWriteSessionMessage.mock.calls[1][1]).toBe('s2');
  });

  it('wakes even without a wake message when in-flight messages are pending', () => {
    // A provider switch mid-conversation kills a container holding claimed
    // messages — without an immediate respawn those messages stay dark until
    // the next inbound or a slow sweep backoff.
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'ag1')]);
    mockIsContainerRunning.mockReturnValue(true);
    mockCountDueMessages.mockReturnValue(2);

    restartAgentGroupContainers('ag1', 'provider switch');

    const onExit = mockKillContainer.mock.calls[0][2] as () => void;
    expect(typeof onExit).toBe('function');
    mockGetSession.mockReturnValue(makeSession('s1', 'ag1'));
    onExit();
    expect(mockWakeContainer).toHaveBeenCalled();
  });
});
