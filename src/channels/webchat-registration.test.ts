/**
 * Integration test for the webchat channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel runs webchat.ts's
 * top-level `registerChannelAdapter('webchat', …)`; without the import the channel is
 * silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel — red if `import './webchat.js';` is deleted or the
 * barrel fails to evaluate (so the channel genuinely would not register).
 *
 * webchat is a native adapter with no npm dependency (Node http builtin only); it
 * serves its own browser client. Importing the barrel is safe: registration is a pure
 * top-level call and webchat.ts opens its listener only inside setup() (run at host
 * startup), never at import.
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('webchat channel registration', () => {
  it('registers webchat via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('webchat');
  });
});
