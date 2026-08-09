/**
 * Integration test for the signal channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel runs signal.ts's
 * top-level `registerChannelAdapter('signal', …)`; without the import the channel is
 * silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './signal.js';` line is deleted, or the barrel fails to evaluate for any
 * reason (so the channel genuinely would not register), this goes red. A structural
 * check of the import line would falsely pass in that second case.
 *
 * signal is a native adapter with no npm dependency (it drives the external signal-cli binary over a local TCP socket); it talks to signal-cli.
 * Importing the barrel is safe: registration is a pure top-level call and signal.ts
 * opens connections / spawns subprocesses only inside setup() (run at host startup),
 * never at import. There is no adapter package to guard here — this test guards the
 * one barrel reach-in (red if `import './signal.js';` is deleted or the barrel fails
 * to evaluate).
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('signal channel registration', () => {
  it('registers signal via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('signal');
  });
});
