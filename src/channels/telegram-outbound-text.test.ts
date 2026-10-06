import { createTelegramAdapter } from '@chat-adapter/telegram';
import { describe, expect, it } from 'vitest';

import { patchUnderscoreLinkRendering } from './telegram.js';

function renderer(): (md: string) => string {
  const adapter = createTelegramAdapter({ botToken: '1:test', mode: 'polling' });
  patchUnderscoreLinkRendering(adapter);
  const converter = (adapter as unknown as { formatConverter: { renderPostable(m: { markdown: string }): string } })
    .formatConverter;
  return (md) => converter.renderPostable({ markdown: md });
}

describe('Telegram underscore-link rendering', () => {
  const render = renderer();

  it('renders an underscore email as escaped text, not an unescaped mailto link', () => {
    const out = render('• *Email:* sent from first_last@example.com at 8:54pm.\n• *Memory:* updated.');
    expect(out).not.toContain('mailto:');
    expect(out).toContain('first\\_last@example\\.com');
    // Every unescaped italic marker must pair up.
    expect((out.match(/(?<!\\)_/g) ?? []).length % 2).toBe(0);
  });

  it('handles explicit mailto links with an underscore', () => {
    expect(render('write [Team](mailto:team_inbox@example.com)')).toBe('write Team');
  });

  it('leaves links without an underscore as links', () => {
    expect(render('mail someone@example.com')).toContain('(mailto:someone@example.com)');
    expect(render('[docs](https://example.com/a-b)')).toBe('[docs](https://example.com/a-b)');
  });

  it('renders a bare URL with an underscore as escaped text', () => {
    const out = render(
      'Open this:\n\nhttp://10.0.0.1:10254/p/x/connections?connect=google-calendar&agent_name=olivia\n\nThen tell me.',
    );
    expect(out).not.toContain('](');
    expect(out).toContain('agent\\_name\\=olivia');
  });

  it('keeps the label of a labelled link with an underscore and shows its URL', () => {
    expect(render('[docs](https://example.com/a_b)')).toBe('docs \\(https://example\\.com/a\\_b\\)');
  });
});
