/**
 * Integration test for the agentmail channel's single reach-in: the
 * self-registration import in the `src/channels/index.ts` barrel. Importing the
 * barrel runs agentmail.ts's top-level `registerChannelAdapter('agentmail', …)`;
 * without the import the channel is silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './agentmail.js';` line is deleted, or the barrel fails to evaluate for
 * any reason (so the channel genuinely would not register), this goes red. A
 * structural check of the import line would falsely pass in that second case.
 *
 * Importing the barrel is safe: registration is a pure top-level call, and
 * agentmail.ts only constructs AgentMailClient inside the factory (invoked at
 * host startup, not at import) and only calls the AgentMail API inside
 * setup() (poll loop starts there too) — nothing network-bound happens here.
 * It does require the adapter package (`agentmail`) to be installed, which
 * holds in a composed install: the skill's `pnpm install` step runs before
 * this test — so this test also implicitly guards that dependency (an
 * unmocked import throws if the package is missing).
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('agentmail channel registration', () => {
  it('registers agentmail via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('agentmail');
  });
});
