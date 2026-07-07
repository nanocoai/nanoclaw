import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../public/style.css', import.meta.url)), 'utf8');

// Regression: the `hidden` attribute must override author `display` rules.
// `.detail-overlay` and `.cli-switcher` set `display:flex`, which beats the
// browser's default `[hidden]{display:none}` — without this reset a hidden
// overlay stays on top of the page and silently eats every click.
test('style.css forces [hidden] to display:none with !important', () => {
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

// Guard the premise: if these stop using display:flex the reset is less load-
// bearing, but this documents WHY the reset exists.
test('the overlays that motivated the reset still use display:flex', () => {
  assert.match(css, /\.detail-overlay\s*\{[^}]*display:\s*flex/);
});
