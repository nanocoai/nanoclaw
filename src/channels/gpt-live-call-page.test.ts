import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { callPageHtml, UI_SOURCE_HASH } from './gpt-live-call-page.js';

describe('voice call page (generated)', () => {
  it('is one self-contained document: React root, no external scripts or stylesheets', () => {
    const html = callPageHtml();
    expect(html).toContain('<div id="root"></div>');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/);
    expect(html).not.toMatch(/https?:\/\/fonts\.googleapis\.com/);
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

  it('keeps replacement patterns in the config literal', () => {
    const plain = callPageHtml();
    for (const brand of ["$'", '$&', '$$', '$`']) {
      const html = callPageHtml({ brand });
      expect(html.length).toBeLessThan(plain.length + 200);
      expect(html).toContain(JSON.stringify(brand));
      expect(html).not.toContain('<!--VOICE_UI_CONFIG-->');
    }
  });

  it('keeps the hangup keepalive so a closing tab still reaches the host', () => {
    expect(callPageHtml()).toMatch(/keepalive\s*:\s*(true|!0)/);
  });

  it('was generated from the ui/ sources in this tree', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const uiRoot = path.resolve(here, '../../.claude/skills/add-voice/ui');
    if (!existsSync(path.join(uiRoot, 'source-files.json'))) return; // Installed payloads do not need the maintainer build tree.
    const inputs = JSON.parse(readFileSync(path.join(uiRoot, 'source-files.json'), 'utf8')) as string[];
    const files = ['source-files.json', ...inputs].sort();
    const hash = createHash('sha256');
    for (const rel of files) {
      hash.update(rel + '\0');
      hash.update(readFileSync(path.join(uiRoot, rel)));
      hash.update('\0');
    }
    expect(UI_SOURCE_HASH).toBe(hash.digest('hex'));
  });
});
