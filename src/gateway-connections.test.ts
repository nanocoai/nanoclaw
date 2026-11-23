import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connect: vi.fn(), group: vi.fn() }));
vi.mock('./db/agent-groups.js', () => ({ getAgentGroup: mocks.group }));
vi.mock('./gateway-providers/index.js', () => ({
  resetGatewayProvider: vi.fn(),
  getGatewayProvider: () => ({ connections: { connect: mocks.connect } }),
}));
import { connectGatewayAccount } from './gateway-connections.js';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.group.mockResolvedValue({ id: 'group' });
  mocks.connect.mockResolvedValue({
    status: 'action_required',
    action: 'operator_console',
    connect_url: 'http://127.0.0.1:10257/console/secrets',
    message: 'Configure the account in the gateway',
  });
});
describe('generic gateway account handoff', () => {
  it.each(['api.github.com', 'gmail.googleapis.com', 'api.unlisted-service.test'])(
    'delegates without a per-site table: %s',
    async (host) => {
      const result = await connectGatewayAccount('group', host);
      expect(mocks.connect).toHaveBeenCalledWith({ agentGroupId: 'group', host });
      expect(result.status).toBe('action_required');
      expect(result).not.toHaveProperty('connected');
    },
  );
  it.each(['https://api.github.com', 'api.github.com/path', 'user:token@api.github.com', '*.github.com'])(
    'rejects invalid destinations: %s',
    async (host) => {
      await expect(connectGatewayAccount('group', host)).rejects.toThrow();
      expect(mocks.connect).not.toHaveBeenCalled();
    },
  );
  it('rejects unknown groups before consulting the gateway', async () => {
    mocks.group.mockResolvedValue(undefined);
    await expect(connectGatewayAccount('missing', 'api.github.com')).rejects.toThrow('not found');
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each(['javascript:alert(1)', 'http://external.test/connect', 'https://user:secret@example.test'])(
    'rejects unsafe handoff URLs: %s',
    async (connect_url) => {
      mocks.connect.mockResolvedValue({ status: 'action_required', action: 'oauth', connect_url, message: 'Connect' });
      await expect(connectGatewayAccount('group', 'api.github.com')).rejects.toThrow();
    },
  );
  it('does not expose extra adapter fields', async () => {
    mocks.connect.mockResolvedValue({
      status: 'action_required',
      action: 'oauth',
      connect_url: 'https://example.test/connect',
      message: 'Connect',
      secret: 'never return',
    });
    expect(await connectGatewayAccount('group', 'api.github.com')).not.toHaveProperty('secret');
  });
});
