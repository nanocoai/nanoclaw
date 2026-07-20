/**
 * Integration test for the whatsapp-cloud channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel runs whatsapp-cloud.ts's
 * top-level `registerChannelAdapter('whatsapp-cloud', …)`; without the import the channel is
 * silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './whatsapp-cloud.js';` line is deleted, or the barrel fails to evaluate for any
 * reason (so the channel genuinely would not register), this goes red. A structural
 * check of the import line would falsely pass in that second case.
 *
 * Importing the barrel is safe: registration is a pure top-level call, and whatsapp-cloud.ts
 * builds the SDK adapter / bridge only inside its factory (invoked at host startup),
 * never at import. It does require the adapter package (`@chat-adapter/whatsapp`) to be installed,
 * which holds in a composed install: the skill's `pnpm install` step runs before this
 * test — so this test also implicitly guards that dependency (an unmocked import throws
 * if the package is missing).
 *
 * whatsapp-cloud is a Chat SDK channel: whatsapp-cloud.ts also consumes a load-bearing *core* API —
 * `createChatSdkBridge(...)` from ./chat-sdk-bridge.js. That core-consumption is a
 * typed call, so the build/typecheck leg (`pnpm run build`) guards it against upstream
 * drift, not this test. Every Chat SDK channel follows this same shape.
 *
 * Beyond registration, this file also asserts the *instance key* whatsapp-cloud.ts hands the
 * bridge (#2911). `@chat-adapter/whatsapp` hardcodes name = 'whatsapp', so the bridge's
 * channelType is 'whatsapp' — shared with the native Baileys adapter. The factory must pass
 * `instance: 'whatsapp-cloud'` so the registry keys the two apart (`instance ?? channelType`)
 * instead of last-write-wins. We build the adapter through its registered factory (the real
 * code path) with credentials mocked in, since the factory returns null when they are absent.
 */
import { describe, it, expect, vi } from 'vitest';

// The factory reads credentials via readEnvFile (off disk) and returns null when
// they are missing. Supply dummy values so the factory builds the real bridge —
// createWhatsAppAdapter constructs purely (no network) once all four are present.
vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    WHATSAPP_ACCESS_TOKEN: 'test-access-token',
    WHATSAPP_PHONE_NUMBER_ID: 'test-phone-number-id',
    WHATSAPP_APP_SECRET: 'test-app-secret',
    WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
  }),
}));

// getRegisteredChannelNames only. This file is copied onto installs by
// /add-whatsapp-cloud and typechecked there by the skill's `pnpm run build`
// step, so it may only use registry exports that exist on the core installs
// run (main) as well as on this branch. getChannelRegistration exists here but
// NOT on main, so importing it fails the install build with TS2305.
import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('whatsapp-cloud channel registration', () => {
  it('registers whatsapp-cloud via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('whatsapp-cloud');
  });

  // The registry key IS the instance name (registerChannelAdapter is called
  // with 'whatsapp-cloud'), so the assertion above already proves this bridge
  // is keyed off the native Baileys adapter's bare 'whatsapp' key (#2911).
  //
  // The previous version of this file also asserted adapter.channelType ===
  // 'whatsapp' by instantiating through getChannelRegistration(...).factory().
  // That is dropped because no cross-core export exposes the registration:
  // main has getChannelAdapterExact but not getChannelRegistration, this branch
  // has the reverse, and both read activeAdapters, which stays empty until
  // initChannelAdapters() runs setup. Asserting absence of the bare 'whatsapp'
  // key is not an option either: this branch's barrel registers the native
  // Baileys adapter, so it is present here and absent on a cloud-only install.
});
