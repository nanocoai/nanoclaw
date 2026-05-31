import { describe, expect, it } from 'vitest';

import { namespacedPlatformId } from './platform-id.js';

describe('namespacedPlatformId', () => {
  it('prefixes bare ids with the channel key (legacy)', () => {
    expect(namespacedPlatformId('telegram', '123456')).toBe('telegram:123456');
    expect(namespacedPlatformId('discord', 'abc')).toBe('discord:abc');
  });

  it('leaves already-prefixed ids alone when prefix matches channel key', () => {
    expect(namespacedPlatformId('telegram', 'telegram:123456')).toBe('telegram:123456');
    expect(namespacedPlatformId('discord', 'discord:guild:chan')).toBe('discord:guild:chan');
  });

  it('trusts any <prefix>:<id> shape — channel key may differ from sdk-emitted prefix', () => {
    // When one chat-sdk adapter is registered under multiple channel keys
    // (e.g. a second Telegram bot under channel `telegram-2`), the sdk still
    // emits `telegram:<id>`. The function must not double-prefix it into
    // `telegram-2:telegram:<id>`.
    expect(namespacedPlatformId('telegram-2', 'telegram:123456')).toBe('telegram:123456');
  });

  it('passes WhatsApp / iMessage JIDs through unchanged', () => {
    expect(namespacedPlatformId('whatsapp', '15551234567@s.whatsapp.net')).toBe('15551234567@s.whatsapp.net');
    expect(namespacedPlatformId('imessage', 'someone@example.com')).toBe('someone@example.com');
  });

  it('passes Signal phone numbers and group ids through unchanged', () => {
    expect(namespacedPlatformId('signal', '+15551234567')).toBe('+15551234567');
    expect(namespacedPlatformId('signal', 'group:abc123')).toBe('group:abc123');
  });

  it('leaves DeltaChat numeric ids unprefixed', () => {
    expect(namespacedPlatformId('deltachat', '12')).toBe('12');
  });
});
