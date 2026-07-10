/**
 * Integration test for the imessage-cloud channel's barrel reach-in: the
 * self-registration import in `src/channels/index.ts`. Importing the barrel
 * runs imessage-cloud.ts's top-level `registerChannelAdapter('imessage-cloud', …)`;
 * without the import the channel is silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the
 * registry actually contains the channel. It goes red if the
 * `import './imessage-cloud.js';` line is deleted or drifts, or if the barrel
 * fails to evaluate (so the channel genuinely would not register).
 *
 * It requires NO npm dependency: registration is a pure top-level call, and
 * imessage-cloud.ts loads `spectrum-ts` only via a runtime dynamic import inside
 * setup() (never at module load). That's what lets the barrel evaluate before
 * /add-imessage-cloud has installed the SDK.
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('imessage-cloud channel registration', () => {
  it('registers imessage-cloud via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('imessage-cloud');
  });
});
