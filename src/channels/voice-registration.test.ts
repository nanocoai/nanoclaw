/**
 * Integration test for the Live Voice channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel runs voice.ts's
 * top-level `registerChannelAdapter('voice', …)`; without the import the channel is
 * silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. If the `import './voice.js';` line is deleted, or
 * the barrel fails to evaluate for any reason, this goes red. A structural check of
 * the import line would falsely pass in that second case.
 *
 * gpt-live is a native adapter with no client library: it uses Node's built-in
 * `fetch` and WebSocket against OpenAI's Live API. Registration is a pure top-level
 * call; the adapter reads `.env`, registers HTTP routes and opens sockets only inside
 * its factory and setup(), never at import.
 */
import { describe, expect, it } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('Live Voice channel registration', () => {
  it('registers voice via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('voice');
  });
});
