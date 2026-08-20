import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../public/style.css', import.meta.url)), 'utf8');
const app = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');

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

// The Agents overview is the one page whose markup is hand-built rather than
// derived from row keys, so a class renamed on one side of the app.js/style.css
// pair silently produces an unstyled page. Both sides must name all of these.
const OVERVIEW_CLASSES = [
  'ov-cards', 'ov-card', 'ov-head', 'ov-name', 'ov-folder',
  'ov-fields', 'ov-field', 'ov-chans', 'badge-status', 'page-title',
];

test('overview markup and stylesheet agree on their class names', () => {
  for (const cls of OVERVIEW_CLASSES) {
    assert.ok(app.includes(cls), `app.js no longer emits .${cls} — update OVERVIEW_CLASSES or the stylesheet`);
    assert.ok(new RegExp(`\\.${cls}[\\s,.:{>]`).test(css), `style.css has no rule for .${cls}`);
  }
});

// The card data comes from public/overview.js; app.js must read the field names
// that module actually produces.
test('the overview renderer reads the fields buildOverview emits', () => {
  const overview = readFileSync(fileURLToPath(new URL('../public/overview.js', import.meta.url)), 'utf8');
  for (const field of ['messagesIn', 'messagesOut', 'lastActive', 'cliScope', 'mcpServers', 'badges', 'container']) {
    assert.ok(overview.includes(field), `buildOverview no longer emits ${field}`);
    assert.ok(app.includes(field), `app.js no longer renders ${field}`);
  }
});
