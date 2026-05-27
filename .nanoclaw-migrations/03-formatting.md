# 03 — Telegram HTML formatting via upstream-PR-ready skill

> ✅ **VERIFIED** against v2 skill conventions on 2026-05-27 (`origin/main:.claude/skills/{add-telegram,init-onecli,use-native-credential-proxy}`).
>
> User direction 2026-05-27: «не просто напишем скилл, а прям строго подойдем к его написанию, чтобы потом сделать PR для него».

## Decision

Build a new skill **`/use-telegram-html`** to upstream-quality standards from day one — full SKILL.md / REMOVE.md / VERIFY.md set, idempotent, with troubleshooting and removal sections, following v2's existing skill conventions. After it works locally, submit upstream PR.

## v2 skill conventions (template observed)

From auditing `add-telegram`, `use-native-credential-proxy`, `init-onecli`:

| File | Purpose | Style |
|---|---|---|
| `SKILL.md` | Main instructions for the agent applying the skill | Frontmatter (`name`, `description`), Phase 1 Pre-flight (idempotent checks), Phase 2 Apply, Phase 3 Setup (user input), Phase 4 Verify, Troubleshooting, Removal pointer |
| `REMOVE.md` | Reverse the install | Numbered short steps, concise |
| `VERIFY.md` | Quick smoke test | 1-2 paragraphs, single action |

Patterns enforced:
- **Every Phase 1 step is idempotent** — skill can be re-run safely
- Inline `AskUserQuestion: …` directives for any choices
- Specific bash commands, exact grep patterns
- Tells user when prerequisites are missing (e.g. "Run /add-telegram first") rather than silently failing
- Removal section in SKILL.md OR REMOVE.md file (both styles exist; we use both for clarity)

## What the skill does

Layers on `/add-telegram`. Replaces the legacy-Markdown sanitizer wiring with a direct-fetch HTML sender, restoring full HTML support (`<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`, `<tg-spoiler>`).

Implementation strategy is **bypass-not-modify**: we don't modify `@chat-adapter/telegram` (locked at npm, hardcoded `parse_mode=Markdown`). We wrap its `sendMessage` with a fetch directly against `https://api.telegram.org/bot${token}/sendMessage` carrying `parse_mode: 'HTML'`. The fetch pattern already exists in v2 for pairing confirmations (`origin/channels:src/channels/telegram.ts:97`).

## Skill files (proposed final shape)

### `.claude/skills/use-telegram-html/SKILL.md`

```markdown
---
name: use-telegram-html
description: Switch Telegram channel to HTML parse mode. Bypasses the @chat-adapter/telegram hardcoded Markdown by overriding sendMessage with a direct fetch to api.telegram.org carrying parse_mode=HTML. Restores full HTML tag support (<b>, <i>, <u>, <s>, <code>, <pre>, <a>, <blockquote>, <tg-spoiler>) — significantly richer than legacy Markdown. Requires /add-telegram to be applied first.
---

# Use Telegram HTML Parse Mode

This skill switches the Telegram channel from the upstream-default legacy
Markdown (with sanitizer workaround) to native HTML parse mode. Pattern
mirrors `/use-local-whisper` overriding `/add-voice-transcription`:
layer on top of the base channel skill, change specific outbound behavior.

## Phase 1: Pre-flight

### Check if `/add-telegram` is applied

  grep -q "createChatSdkBridge" src/channels/telegram.ts 2>/dev/null

If the file or symbol is missing, tell the user to run `/add-telegram`
first, then retry. Stop.

### Check if this skill is already applied

  grep -q "USE-TELEGRAM-HTML" src/channels/telegram.ts 2>/dev/null

If the sentinel is present, skill is applied. Skip to Phase 3 (Verify).

### Verify the sanitizer files are at expected paths (sanity)

  test -f src/channels/telegram-markdown-sanitize.ts
  test -f src/channels/telegram-markdown-sanitize.test.ts

If missing, the upstream layout has changed since this skill was written.
Tell the user and stop — manual investigation needed.

## Phase 2: Apply

### 2.1 Remove the sanitizer import + usage

In `src/channels/telegram.ts`, delete this import line:

  import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';

And remove the bridge-config line (inside the `createChatSdkBridge`
call, ~line 212 upstream):

  transformOutboundText: sanitizeTelegramLegacyMarkdown,

### 2.2 Delete sanitizer source files

  rm src/channels/telegram-markdown-sanitize.ts
  rm src/channels/telegram-markdown-sanitize.test.ts

### 2.3 Insert the HTML sender helper

Above the `registerChannelAdapter('telegram', …)` call in
`src/channels/telegram.ts`, insert:

  // USE-TELEGRAM-HTML: outbound bypass of @chat-adapter/telegram's
  // hardcoded parse_mode=Markdown. Sends with parse_mode=HTML; on
  // parse-failure response, retries as plain text so the message
  // still delivers. Drop this once @chat-adapter/telegram exposes a
  // parse_mode knob (see vercel/chat PR #367).
  async function sendHtml(
    token: string,
    chatId: string,
    text: string,
  ): Promise<void> {
    const body = { chat_id: chatId, text, parse_mode: 'HTML' };
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      log.warn('Telegram HTML send failed; falling back to plain text', {
        status: res.status,
      });
      const plain = { chat_id: chatId, text };
      await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(plain),
        },
      );
    }
  }

### 2.4 Override `sendMessage` on the wrapped adapter

Inside the existing `const wrapped: ChannelAdapter = { … }` literal,
add (or replace) a `sendMessage` field. Place it after `resolveChannelName`
and before `setup`:

  // USE-TELEGRAM-HTML: route outbound through direct HTML fetch
  async sendMessage(platformId: string, _threadId: string | null, text: string) {
    const chatId = platformId.split(':').slice(1).join(':');
    if (!chatId) return;
    const MAX = 4000;
    for (let i = 0; i < text.length; i += MAX) {
      await sendHtml(token, chatId, text.slice(i, i + MAX));
    }
  },

(`threadId` is unused because the v2 adapter sets `supportsThreads: false`.
If a future skill turns threads on, add `message_thread_id` to `sendHtml`'s
body.)

### 2.5 Update per-channel formatting block

For each group folder under `groups/` whose name starts with `telegram_`,
replace any existing Telegram formatting block in `CLAUDE.local.md` with
the HTML reference. If no block exists, append it.

The replacement block:

  ## Telegram formatting (HTML)

  This channel renders Telegram HTML. Supported tags:
  - `<b>bold</b>` and `<strong>bold</strong>`
  - `<i>italic</i>` and `<em>italic</em>`
  - `<u>underline</u>`
  - `<s>strikethrough</s>`
  - `<code>inline code</code>`
  - `<pre>code block</pre>` (optionally `<pre><code class="language-python">…</code></pre>`)
  - `<a href="https://example.com">link text</a>`
  - `<blockquote>quote</blockquote>`
  - `<tg-spoiler>hidden</tg-spoiler>`

  When including user-supplied text (names, quoted messages, web content)
  in your reply, escape these three characters:
  - `<` → `&lt;`
  - `>` → `&gt;`
  - `&` → `&amp;`

  Do NOT use Markdown (`**bold**`, `# headings`, `[text](url)`).
  Standalone URLs are auto-linked by Telegram if not wrapped in `<a>`.

### 2.6 Rebuild

  pnpm run build
  pnpm exec vitest run src/channels/telegram.test.ts 2>/dev/null || true

(If the upstream test file for telegram exists, run it. It should pass —
our changes are additive and only affect outbound, not the inbound /
pairing paths covered by tests.)

## Phase 3: Verify

Send a Telegram message to your bot. Reply with content exercising at
least: `<b>`, `<i>`, `<a href>`, `<code>`, `<blockquote>`. Confirm each
renders, not as literal tags.

Then send a message that quotes user-input containing `<`, `>`, `&`
(e.g. `<script>` or `2 < 3 & 4 > 1`) — confirm the agent escapes them
(via CLAUDE.local.md instructions) and the message still delivers.

## Troubleshooting

**HTML tags show as literal text in Telegram**
The fetch succeeded but parse_mode wasn't honored. Likely your fork's
`sendHtml` is not being called and the Chat SDK adapter sent the message
instead. Verify: `grep -n "USE-TELEGRAM-HTML" src/channels/telegram.ts`
should show two sentinel comments. If only one, the `sendMessage`
override wasn't placed inside the right object — check Phase 2.4.

**Message delivered but log shows "HTML send failed; falling back to plain text"**
The agent produced invalid HTML — usually mismatched tags or unescaped
`<` in user content. Tighten the CLAUDE.local.md instructions and/or
have the agent self-correct via the fallback. The fallback is a safety
net, not the steady state.

**`registerChannelAdapter` errors after apply**
The wrapped adapter literal got malformed. Read `src/channels/telegram.ts`
around the `wrapped` const — ensure `sendMessage` is a proper method
inside the object, with matching braces.

## Removal

See `REMOVE.md`.
```

### `.claude/skills/use-telegram-html/REMOVE.md`

```markdown
# Remove use-telegram-html

Restores the upstream-default Markdown sanitizer path.

1. Re-add the sanitizer files (from upstream):

       git show origin/channels:src/channels/telegram-markdown-sanitize.ts \
         > src/channels/telegram-markdown-sanitize.ts
       git show origin/channels:src/channels/telegram-markdown-sanitize.test.ts \
         > src/channels/telegram-markdown-sanitize.test.ts

2. In `src/channels/telegram.ts`:
   - Restore `import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';`
   - Restore `transformOutboundText: sanitizeTelegramLegacyMarkdown,` in the `createChatSdkBridge` call
   - Delete the `sendHtml` helper function (search for `USE-TELEGRAM-HTML` sentinel)
   - Delete the `sendMessage` override on the `wrapped` adapter (also `USE-TELEGRAM-HTML` sentinel)

3. In each `groups/telegram_*/CLAUDE.local.md`, revert the formatting
   block to Markdown form (see `/add-telegram` for the canonical block).

4. Rebuild:

       pnpm run build
```

### `.claude/skills/use-telegram-html/VERIFY.md`

```markdown
# Verify use-telegram-html

Send a Telegram message to your bot. Ask the agent to reply with a sample
that uses bold, italic, inline code, a link, and a blockquote. Each
should render as formatted text in Telegram (not literal `<b>` etc.).

Then ask the agent to quote a string containing `<` and `>`. The reply
should include `&lt;` / `&gt;` escapes inline and still render correctly.
```

## Open-source/PR plan

After local verification, prepare the upstream PR:

### Where it lands

Skill directory in upstream: `.claude/skills/use-telegram-html/` — alongside the other layer-on-top skills (`use-local-whisper`, `use-native-credential-proxy`).

### PR description draft

- **Title**: `feat(skills): add /use-telegram-html — bypass legacy Markdown parse mode`
- **Body**:
  - Problem: `@chat-adapter/telegram` hardcodes `parse_mode=Markdown` (acknowledged by the existing `telegram-markdown-sanitize.ts` workaround header)
  - Solution: layer skill that bypasses the Chat SDK outbound by direct fetch with `parse_mode=HTML`. Removes the sanitizer; adds the HTML sender + override; updates CLAUDE.local.md instructions
  - Why a skill, not a default: users on legacy Markdown still want the sanitizer; some don't want HTML at all; new behavior should be opt-in
  - Reference: original v1 fork used HTML via raw `grammy` adapter; this skill restores that capability in v2 layout
  - When to retire: once vercel/chat ships parse_mode knob (see PR #367), the skill collapses to a config flag — at which point we can either drop it or rewrite it to set the flag
- **Files added**: `.claude/skills/use-telegram-html/SKILL.md`, `REMOVE.md`, `VERIFY.md`
- **Files removed by skill on apply**: `src/channels/telegram-markdown-sanitize.ts`, `src/channels/telegram-markdown-sanitize.test.ts` (only when the user applies the skill — not removed in the PR itself)
- **No upstream `src/` changes** — pure skill addition

### Tests

The skill itself is not unit-testable (it modifies a file in-place via instructions to the model). What we can test:
- A snapshot test on the resulting `telegram.ts` shape — apply the skill in a sandbox, assert the file diffs against a stored expected diff. v2 has no precedent for this kind of skill-snapshot test, so we don't introduce it.
- A manual VERIFY.md walkthrough — already specified.

### Risk to upstream

- Skill writes to `src/channels/telegram.ts` — touches a file owned by `/add-telegram`. Future updates to `add-telegram` might collide. Mitigation: the sentinel comments (`USE-TELEGRAM-HTML`) make subsequent re-apply detectable, and `REMOVE.md` is the canonical revert path.
- The fetch URL is hardcoded to `api.telegram.org` — same as upstream's `sendPairingConfirmation` (line 97), so no new external dependency.

## How to apply (Stage 2.7)

1. Stage 2.5 done (`/add-telegram` applied, pairing complete)
2. Create the three files (`SKILL.md`, `REMOVE.md`, `VERIFY.md`) in `.claude/skills/use-telegram-html/` in our fork
3. Activate skill: `/use-telegram-html`
4. Skill walks through preflight (verifies `/add-telegram` applied), apply (patches files, deletes sanitizer), verify
5. Manual VERIFY.md walkthrough on a live Telegram chat
6. If successful: commit the skill files in our fork
7. Open upstream PR with title/body above

## What changed from the prior draft

- Was: rough sketch of a custom override
- Now: full skill spec at the same quality bar as `use-native-credential-proxy` and `init-onecli`. Phase structure, idempotency checks, sentinel comments for re-apply detection, troubleshooting, separate REMOVE.md / VERIFY.md files, and an explicit upstream-PR plan.
