import { describe, expect, it } from 'vitest';

import { namespacedPlatformId } from './platform-id.js';

describe('namespacedPlatformId', () => {
  it('adds the channel prefix for Chat SDK adapters with a bare id', () => {
    expect(namespacedPlatformId('telegram', '123456')).toBe('telegram:123456');
    expect(namespacedPlatformId('discord', 'guild:chan')).toBe('discord:guild:chan');
  });

  it('leaves an already-prefixed id alone', () => {
    expect(namespacedPlatformId('telegram', 'telegram:123456')).toBe('telegram:123456');
    expect(namespacedPlatformId('slack', 'slack:T01:C02')).toBe('slack:T01:C02');
  });

  it('does not prefix native ID shapes (Signal, WhatsApp, iMessage)', () => {
    expect(namespacedPlatformId('whatsapp', '15551234567@s.whatsapp.net')).toBe('15551234567@s.whatsapp.net');
    expect(namespacedPlatformId('imessage', 'user@example.com')).toBe('user@example.com');
    expect(namespacedPlatformId('signal', '+15551234567')).toBe('+15551234567');
    expect(namespacedPlatformId('signal', 'group:abc123')).toBe('group:abc123');
  });

  it('does not prefix CLI ids — the adapter emits the bare value', () => {
    expect(namespacedPlatformId('cli', 'local')).toBe('local');
  });
});
