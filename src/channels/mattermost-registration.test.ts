/**
 * Integration test for the mattermost channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel runs mattermost.ts's
 * top-level `registerChannelAdapter('mattermost', …)`; without the import the channel is
 * silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './mattermost.js';` line is deleted, or the barrel fails to evaluate for any
 * reason (so the channel genuinely would not register), this goes red. A structural
 * check of the import line would falsely pass in that second case.
 *
 * Importing the barrel is safe: registration is a pure top-level call, and mattermost.ts
 * builds the SDK adapter / bridge only inside its factory (invoked at host startup),
 * never at import. The adapter implementation is vendored beside the channel module, so importing
 * the barrel does not depend on an independently published Mattermost package.
 *
 * Note on the Chat SDK family: mattermost.ts also consumes a load-bearing *core* API —
 * `createChatSdkBridge(...)` from ./chat-sdk-bridge.js — with a specific options
 * shape. That core-consumption is a typed call, so the build/typecheck leg
 * (`pnpm run build`) guards it against upstream drift, not this test. Every Chat SDK
 * channel (discord, telegram, teams, gchat, webex, …) follows this same shape:
 * swap the channel name below and the adapter implementation in the build.
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('mattermost channel registration', () => {
  it('registers mattermost via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('mattermost');
  });
});
