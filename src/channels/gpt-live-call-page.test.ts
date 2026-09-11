import { describe, expect, it } from 'vitest';

import { callPageHtml } from './gpt-live-call-page.js';

describe('voice call page (generated)', () => {
  it('is one self-contained document with the React root and no external scripts', () => {
    const html = callPageHtml();
    expect(html).toContain('<div id="root"></div>');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"[^>]+href="(?!https:\/\/fonts\.googleapis\.com)/);
  });

  it('injects the host config where the placeholder sat, defaulting to an empty object', () => {
    expect(callPageHtml()).toContain('<script>window.__VOICE_UI__={}</script>');
    expect(callPageHtml()).not.toContain('<!--VOICE_UI_CONFIG-->');
    const html = callPageHtml({ skin: 'te', colorway: 'rabbit', presence: 'bars', brand: 'Casa line' });
    expect(html).toContain('"colorway":"rabbit"');
    expect(html).toContain('"brand":"Casa line"');
  });

  it('cannot be broken out of the inline script by the config text', () => {
    const html = callPageHtml({ brand: '</script><img src=x onerror=alert(1)>' });
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script>');
  });

  it('keeps the hangup keepalive so a closing tab still reaches the host', () => {
    expect(callPageHtml()).toMatch(/keepalive\s*:\s*(true|!0)/);
  });
});
