/**
 * Integration test for the proton-mail channel's single reach-in: the
 * self-registration import in the `src/channels/index.ts` barrel. Importing the
 * barrel runs proton-mail.ts's top-level `registerChannelAdapter('proton-mail', …)`;
 * without the import the channel is silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. If the `import './proton-mail.js';` line is
 * deleted, or the barrel fails to evaluate for any reason, this goes red.
 *
 * proton-mail is a native adapter (no Chat SDK bridge). Importing the barrel is
 * safe: registration is a pure top-level call and the adapter opens IMAP/SMTP
 * connections only inside setup(), never at import. It does require the mail
 * packages (`imapflow`, `mailparser`, `nodemailer`) to be installed — an
 * unmocked import throws if any is missing, so this also guards the dependency.
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('proton-mail channel registration', () => {
  it('registers proton-mail via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('proton-mail');
  });
});
