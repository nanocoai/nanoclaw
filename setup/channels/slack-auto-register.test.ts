/**
 * The Slack auto-provision registration — the default Slack experience.
 *
 * Registration is unconditional: pre-step for slack, companion skills
 * declared in prerequisite order, and the provisioning flow lazy-loaded
 * only when the wizard actually invokes the pre-step.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerSlackAutoProvision, SLACK_AGENTS_COMPANION_SKILLS } from './slack-auto-register.js';

afterEach(() => {
  vi.doUnmock('./slack-auto.js');
  vi.resetModules();
});

describe('registerSlackAutoProvision', () => {
  it('registers a slack pre-step that lazy-loads and delegates to the flow', async () => {
    const register = vi.fn();
    registerSlackAutoProvision(register, vi.fn());

    expect(register).toHaveBeenCalledTimes(1);
    const [channel, step] = register.mock.calls[0];
    expect(channel).toBe('slack');

    // The flow module is only reached through the pre-step's dynamic import.
    const maybeAutoProvisionSlack = vi.fn(async (name: string) => ({ bot_token: `xoxb-for-${name}` }));
    vi.doMock('./slack-auto.js', () => ({ maybeAutoProvisionSlack }));
    await expect(step('Nano')).resolves.toEqual({ bot_token: 'xoxb-for-Nano' });
    expect(maybeAutoProvisionSlack).toHaveBeenCalledExactlyOnceWith('Nano');
  });

  it('declares the agents companion skills in prerequisite order', () => {
    const registerCompanions = vi.fn();
    registerSlackAutoProvision(vi.fn(), registerCompanions);

    expect(registerCompanions).toHaveBeenCalledExactlyOnceWith('slack', SLACK_AGENTS_COMPANION_SKILLS);
    // The room admission policy is the flow's prerequisite — order is the API.
    expect(SLACK_AGENTS_COMPANION_SKILLS).toEqual(['slack-a2a-rooms', 'slack-agent-flow']);
  });
});

describe('companions registry wiring', () => {
  it('a fresh companions module carries the slack pre-step and companion list', async () => {
    vi.resetModules();
    const companions = await import('./companions.js');
    expect(companions.getChannelPreStep('slack')).toBeTypeOf('function');
    // Declared at wizard boot — a registration appended to the registry file
    // mid-run would be invisible to the already-imported module, so the whole
    // agents install rides on this boot-time declaration.
    expect(companions.getCompanionSkills('slack')).toEqual(['slack-a2a-rooms', 'slack-agent-flow']);
  });
});
