/**
 * Integration test for the webex-poll channel's single reach-in: the
 * self-registration import in the `src/channels/index.ts` barrel. Importing
 * the barrel runs webex-poll.ts's top-level `registerChannelAdapter('webex-poll', …)`;
 * without the import the channel is silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './webex-poll.js';` line is deleted, or the barrel fails to evaluate for any
 * reason (so the channel genuinely would not register), this goes red. A structural
 * check of the import line would falsely pass in that second case.
 *
 * webex-poll is a native adapter (no Chat SDK bridge): webex-poll.ts consumes the
 * host's built-in fetch API and no extra npm packages, so this test has no external
 * dependency to guard beyond the adapter source itself.
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('webex-poll channel registration', () => {
  it('registers webex-poll via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('webex-poll');
  });
});
