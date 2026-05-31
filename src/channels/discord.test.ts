import { describe, it, expect, vi } from 'vitest';

// Mock the heavy imports so loading discord.ts (which self-registers at import
// time) has no side effects — we only exercise the pure helper.
vi.mock('@chat-adapter/discord', () => ({ createDiscordAdapter: vi.fn() }));
vi.mock('./chat-sdk-bridge.js', () => ({ createChatSdkBridge: vi.fn() }));
vi.mock('./channel-registry.js', () => ({ registerChannelAdapter: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

import { unwrapMarkdownLinks } from './discord.js';

describe('unwrapMarkdownLinks', () => {
  it('collapses a self-referential link to the bare URL', () => {
    expect(unwrapMarkdownLinks('[https://a.com/x](https://a.com/x)')).toBe('https://a.com/x');
  });

  it('keeps a descriptive label as "text (url)"', () => {
    expect(unwrapMarkdownLinks('[원글 열기](https://a.com/x)')).toBe('원글 열기 (https://a.com/x)');
  });

  it('unwraps image syntax ![alt](url) too', () => {
    expect(unwrapMarkdownLinks('![photo](https://a.com/p.jpg)')).toBe('photo (https://a.com/p.jpg)');
  });

  it('strips angle brackets used to suppress embeds', () => {
    expect(unwrapMarkdownLinks('[x](<https://a.com/x>)')).toBe('x (https://a.com/x)');
  });

  it('handles multiple links in one string', () => {
    expect(unwrapMarkdownLinks('see [a](https://a.com) and [https://b.com](https://b.com)')).toBe(
      'see a (https://a.com) and https://b.com',
    );
  });

  it('leaves raw URLs and plain text untouched', () => {
    expect(unwrapMarkdownLinks('visit https://a.com now')).toBe('visit https://a.com now');
  });

  it('ignores non-http link targets (relative paths, anchors)', () => {
    expect(unwrapMarkdownLinks('[home](/index) and [top](#a)')).toBe('[home](/index) and [top](#a)');
  });

  it('unwraps a realistic rental-alert line', () => {
    const card = '🔗 원글: [https://francezone.com/bbs/x](https://francezone.com/bbs/x)';
    expect(unwrapMarkdownLinks(card)).toBe('🔗 원글: https://francezone.com/bbs/x');
  });
});
