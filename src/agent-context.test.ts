import { describe, it, expect, vi, beforeEach } from 'vitest';

const writeSessionMessage = vi.fn();
const getMessagingGroupByPlatform = vi.fn();
const findSession = vi.fn();

vi.mock('./session-manager.js', () => ({ writeSessionMessage }));
vi.mock('./db/messaging-groups.js', () => ({ getMessagingGroupByPlatform }));
vi.mock('./db/sessions.js', () => ({ findSession }));
vi.mock('./log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { recordAgentSent } = await import('./agent-context.js');

describe('recordAgentSent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMessagingGroupByPlatform.mockReturnValue({ id: 'mg-1' });
    findSession.mockReturnValue({ id: 'sess-1', agent_group_id: 'ag-1' });
  });

  it('mirrors the message into the session as context that does not wake the agent', () => {
    recordAgentSent('signal', '+15551234567', 'Your request was approved.');

    expect(writeSessionMessage).toHaveBeenCalledTimes(1);
    const [agentGroupId, sessionId, msg] = writeSessionMessage.mock.calls[0];
    expect(agentGroupId).toBe('ag-1');
    expect(sessionId).toBe('sess-1');
    expect(msg.kind).toBe('sent');
    // The load-bearing assertion: trigger 1 here would make the agent reply to
    // a message it never sent.
    expect(msg.trigger).toBe(0);
    expect(JSON.parse(msg.content).text).toBe('Your request was approved.');
  });

  it('is a no-op when the target has no messaging group', () => {
    getMessagingGroupByPlatform.mockReturnValue(undefined);
    recordAgentSent('signal', 'unknown', 'hello');
    expect(writeSessionMessage).not.toHaveBeenCalled();
  });

  it('is a no-op when no session exists for the target yet', () => {
    findSession.mockReturnValue(undefined);
    recordAgentSent('signal', '+15551234567', 'hello');
    expect(writeSessionMessage).not.toHaveBeenCalled();
  });

  it('never throws — a mirroring failure must not break the delivery it follows', () => {
    writeSessionMessage.mockImplementation(() => {
      throw new Error('db locked');
    });
    expect(() => recordAgentSent('signal', '+15551234567', 'hello')).not.toThrow();
  });

  it('ignores empty text', () => {
    recordAgentSent('signal', '+15551234567', '');
    expect(writeSessionMessage).not.toHaveBeenCalled();
  });
});
