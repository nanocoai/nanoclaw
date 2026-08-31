/**
 * The Slack auto-provision registration — the default Slack experience.
 *
 * Registration is unconditional: the Slack pre-step is present, while the
 * provisioning flow is lazy-loaded only when the wizard invokes it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getSkillCompanions } from '../skill-compositions.js';
import { registerSlackAutoProvision } from './slack-auto-register.js';

afterEach(() => {
  vi.doUnmock('./slack-auto.js');
  vi.resetModules();
});

describe('registerSlackAutoProvision', () => {
  it('registers a slack pre-step that lazy-loads and delegates to the flow', async () => {
    const register = vi.fn();
    registerSlackAutoProvision(register);

    expect(register).toHaveBeenCalledTimes(1);
    const [channel, step] = register.mock.calls[0];
    expect(channel).toBe('slack');

    // The flow module is only reached through the pre-step's dynamic import.
    const maybeAutoProvisionSlack = vi.fn(async (name: string) => ({ bot_token: `xoxb-for-${name}` }));
    vi.doMock('./slack-auto.js', () => ({ maybeAutoProvisionSlack }));
    await expect(step('Nano')).resolves.toEqual({ bot_token: 'xoxb-for-Nano' });
    expect(maybeAutoProvisionSlack).toHaveBeenCalledExactlyOnceWith('Nano');
  });

  it('the generic skill registry declares the agents companions in prerequisite order', () => {
    expect(getSkillCompanions('add-slack')).toEqual([
      { skill: 'slack-a2a-rooms', branch: 'channels' },
      { skill: 'slack-agent-flow', branch: 'channels' },
    ]);
  });
});

describe('channel pre-step registry wiring', () => {
  it('a fresh companions module carries the slack pre-step', async () => {
    vi.resetModules();
    const companions = await import('./companions.js');
    expect(companions.getChannelPreStep('slack')).toBeTypeOf('function');
  });
});
