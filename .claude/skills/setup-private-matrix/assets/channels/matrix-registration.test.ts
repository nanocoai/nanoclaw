/**
 * Integration test for the matrix channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel runs matrix.ts's
 * top-level `registerChannelAdapter('matrix', …)`; without the import the channel is
 * silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './matrix.js';` line is deleted, or the barrel fails to evaluate for any
 * reason (so the channel genuinely would not register), this goes red.
 *
 * matrix is a NATIVE adapter (no Chat SDK bridge): it implements ChannelAdapter
 * directly and depends on `matrix-bot-sdk` (which pulls the native crypto binding
 * `@matrix-org/matrix-sdk-crypto-nodejs`). Importing the barrel is safe: registration
 * is a pure top-level call and matrix.ts builds the SDK client only inside setup()
 * (run at host startup), never at import. An unmocked import would still throw if the
 * package were missing, so this test also implicitly guards that dependency.
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('matrix channel registration', () => {
  it('registers matrix via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('matrix');
  });
});
