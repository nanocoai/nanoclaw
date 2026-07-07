import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, mdToHtml } from '../public/md.js';

// ---- escaping -------------------------------------------------------------

test('escapeHtml: neutralizes all HTML metacharacters', () => {
  assert.equal(escapeHtml(`<script>"&'`), '&lt;script&gt;&quot;&amp;&#39;');
});

test('mdToHtml: raw HTML in source is escaped, never passed through', () => {
  const html = mdToHtml('a <script>alert(1)</script> b');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

// ---- the security-sensitive part: links -----------------------------------

test('mdToHtml: link href comes from the URL, label from the text', () => {
  const html = mdToHtml('see [the docs](https://example.com/x)');
  assert.match(html, /<a href="https:\/\/example\.com\/x" target="_blank" rel="noopener noreferrer">the docs<\/a>/);
});

test('mdToHtml: javascript: smuggled in link TEXT stays inert (never an href)', () => {
  const html = mdToHtml('[javascript:alert(1)](https://safe.com)');
  // href is the safe URL; the js string is only visible label text
  assert.match(html, /href="https:\/\/safe\.com"/);
  assert.ok(!/href="javascript:/i.test(html));
});

test('mdToHtml: a non-http(s) URL is not turned into a link', () => {
  // javascript:/data: never match the (https?:...) capture, so the literal
  // (escaped) markdown is left as-is — no anchor, no executable href.
  const html = mdToHtml('[click](javascript:alert(1))');
  assert.ok(!/<a /.test(html));
  assert.ok(!/href="javascript:/i.test(html));
});

test('mdToHtml: an attribute-breakout attempt in the URL cannot escape the href', () => {
  // The double-quote is escaped to &quot; before the regex runs, so it can never
  // close an attribute. (Here the URL also has a space, so no anchor even forms.)
  // The security property: no REAL attribute (with a literal quote) is injected.
  const html = mdToHtml('[x](https://a" onmouseover="alert(1))');
  assert.ok(!/<a/.test(html), 'malformed link must not produce an anchor');
  assert.ok(!/onmouseover="/.test(html), 'no real (unescaped-quote) attribute injected');
});

test('mdToHtml: an escaped quote inside a matched URL stays inside the href, inert', () => {
  // Even when a URL matches, any " in it is already &quot; (an entity), which
  // does not terminate an HTML attribute value — so no breakout.
  const html = mdToHtml('[x](https://a"onmouseover=alert)');
  assert.ok(!/onmouseover="/.test(html));
  if (/<a/.test(html)) assert.match(html, /href="https:\/\/a&quot;onmouseover=alert"/);
});

// ---- basic rendering sanity ----------------------------------------------

test('mdToHtml: headings, code fences, lists render', () => {
  const html = mdToHtml('# Title\n\n```\ncode\n```\n\n- a\n- b');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<pre class="code"><code>code<\/code><\/pre>/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
});
