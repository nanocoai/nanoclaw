/**
 * Integration test for the line channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel runs line.ts's
 * top-level `registerChannelAdapter('line', …)`; without the import the channel is
 * silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './line.js';` line is deleted, or the barrel fails to evaluate for any
 * reason (so the channel genuinely would not register), this goes red. A structural
 * check of the import line would falsely pass in that second case.
 *
 * line is a native adapter with zero npm dependencies (node `crypto`/`http` plus
 * global `fetch` against the LINE Messaging API), so there is no adapter package
 * to guard here. Importing the barrel is safe: registration is a pure top-level
 * call; the factory returns null when LINE credentials are absent, and the webhook
 * route is registered only inside setup() (run at host startup), never at import.
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('line channel registration', () => {
  it('registers line via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('line');
  });
});
