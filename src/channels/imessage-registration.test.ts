/**
 * Integration test for the imessage channel's barrel reach-in: the
 * self-registration import in `src/channels/index.ts`. Importing the barrel
 * runs imessage.ts's top-level `registerChannelAdapter('imessage', …)`;
 * without the import the channel is silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the
 * registry actually contains the channel. It goes red if the
 * `import './imessage.js';` line is deleted or drifts, or if the barrel
 * fails to evaluate (so the channel genuinely would not register).
 *
 * It requires NO npm dependency: registration is a pure top-level call.
 * Neither backend's package loads at module import — the hosted `spectrum-ts`
 * only via a runtime dynamic import inside setup(), and the local
 * `chat-adapter-imessage` only via a dynamic import inside the factory's local
 * branch (never at module load). That's what lets the barrel evaluate before
 * /add-imessage has installed either SDK.
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('imessage channel registration', () => {
  it('registers imessage via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('imessage');
  });
});
