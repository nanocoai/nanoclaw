# NanoClaw Migration Guide

Generated: 2026-04-24
Base (common ancestor with upstream): `a81e1651` (upstream v1.2.53, 2026-04-18)
HEAD at generation: `c18a9be`
Upstream HEAD: `8d85222` (v2.0.13)

---

## Migration Plan

**Tier 3** — 433 upstream commits in 6 days, full v1→v2 architectural rewrite (providers abstraction, module system, DB migrations, channel registry rewrite, agent-runner modularization).

Because upstream rewrote nearly every source file, the strategy is:

1. **Check out clean v2.0.13 in a worktree.** Do NOT attempt patch-level merges of user changes — file structure has changed.
2. **Reapply each skill branch from upstream**, since upstream skills have been updated for v2 architecture.
3. **Reapply user-authored customizations by intent** (not by diff) against the new codebase.
4. **Validate incrementally**: first after skill merges, again after each customization theme.
5. **Manually port the Apple Pages skill** — it is not upstream, it lives only on local branch `skill/add-pages`. The code will need a small rewrite to fit v2's MCP-tools module system.

**Risk areas (where v2 diverges most):**
- `src/channels/` — registry rewritten, `channel-registry.ts` + `adapter.ts` are new
- `container/agent-runner/src/` — split into `mcp-tools/{core,interactive,scheduling,self-mod,agents}.ts` and provider abstraction
- `src/db/` — migration system added; custom DB touches must use migrations
- `src/modules/` — new module directory for approvals, permissions, scheduling, self-mod

**Ordering:**
1. Safety net (backup branch + tag)
2. Worktree from `upstream/main`
3. Reapply skills (in dependency order: container runtime → credential proxy → channels → tools)
4. Reapply environment config (.env, plist)
5. Reapply user customizations (Telegram swarm, Gmail From-name, Apple Pages, persona)
6. Validate (`npm install && npm run build && npm test`)
7. Live-test with symlinked data directories
8. Swap into main tree, restart service

---

## Applied Skills

All skills are upstream-tracked **except `add-pages`** (local-only).

Reapply by merging the upstream branch into the worktree:

| Skill | Upstream branch | Notes |
|-------|-----------------|-------|
| add-compact | `skill/compact` | Session /compact command |
| add-gmail | `skill/add-gmail` or `skill/add-gmail-tool` | See "Gmail tool + channel mode" below |
| add-gmail-tool | `skill/add-gmail-tool` | New in v2 — OneCLI-native Gmail MCP |
| add-image-vision | `skill/add-image-vision` | WhatsApp image → Claude multimodal. **In use for Telegram** — see customization below. |
| add-karpathy-llm-wiki | `skill/wiki` | |
| add-ollama-tool | `skill/ollama-tool` | |
| add-pdf-reader | `skill/pdf-reader` | poppler-utils |
| add-telegram | `skill/add-telegram` / `skill/telegram` | |
| add-telegram-swarm | `skill/add-telegram-swarm` | Agent-teams bot pool |
| add-voice-transcription | `skill/voice-transcription` | OpenAI Whisper |
| channel-formatting | `skill/channel-formatting` | |
| convert-to-apple-container | `skill/apple-container` | Docker → Apple Container |
| use-local-whisper | `skill/use-local-whisper` | Requires voice-transcription first |
| use-native-credential-proxy | `skill/native-credential-proxy` | Alternative to OneCLI |

**Not merged (explicitly deferred or removed):**
- **WhatsApp** — user has explicitly **removed** the channel (commit `0e0bc48 feat: remove WhatsApp channel`). Do NOT merge `skill/add-whatsapp` during upgrade.

**Custom skill (no upstream branch):**
- **add-pages** — exists only on local `skill/add-pages` branch. See "Apple Pages integration" below for reapply steps.

---

## Skill Interactions

1. **`use-native-credential-proxy` + `convert-to-apple-container`** — the Apple Container skill requires `CREDENTIAL_PROXY_HOST` env var; the native-credential-proxy skill is what runs on that host/port. Together they mean:
   - `.env` MUST contain `CREDENTIAL_PROXY_HOST=0.0.0.0` (not the default `192.168.64.1` — that IP only exists inside the Apple Container VM, not on the host).
   - `CREDENTIAL_PROXY_PORT=3002` (3001 default conflicts with something on this host).
   - Regression tests exist in `src/container-runtime.test.ts` that require `CREDENTIAL_PROXY_HOST` to be set or they fail to import — this is by design.

2. **`add-telegram` + `add-telegram-swarm`** — swarm extends the base Telegram channel with a bot pool. Both must be applied; swarm after telegram.

3. **`add-image-vision`** — this skill is nominally for WhatsApp, but the user ported it to Telegram (commit `fab3142 feat: add Telegram image vision support`). After applying `skill/add-image-vision`, additional code in the Telegram channel file is needed (see customization below).

4. **Gmail dual-mode** — user has Gmail configured as **both a channel** (receives inbound email as messages) **and a tool** (agent can call `send_email` MCP tool). V2 may have split these into separate skills (`skill/add-gmail` vs `skill/add-gmail-tool`); apply both.

---

## Customizations

### Persona: trigger word "@Eva"

**Intent:** Assistant is called "Eva" (not the default "Andy").

**Files:** `.env`

**How to apply:** Set `ASSISTANT_NAME=Eva` in `.env`. V2 should honor this the same way as v1 via `ASSISTANT_NAME` env lookup in config.

---

### Telegram swarm bot pool

**Intent:** 4 named sub-agent bots are available to Telegram-main — agents can send messages as a named sender (researcher, scheduler, etc.) and Telegram routes it through the right bot identity.

**Files:** `.env`, launchd plist

**How to apply:** In `.env`: `TELEGRAM_BOT_POOL=token1,token2,token3,token4` (4 bot tokens, comma-separated). The `add-telegram-swarm` skill handles the rest. Plist duplicates this env var — keep in sync.

---

### Telegram image vision

**Intent:** Photos sent to the Telegram group are downloaded, resized if needed, and included as multimodal image blocks in the Claude request so the agent can "see" them.

**Files:** `src/channels/telegram.ts` (or v2 equivalent), `container/agent-runner/src/index.ts`

**How to apply:**
1. Apply `skill/add-image-vision` first — it provides the resizing/multimodal pipeline.
2. In the Telegram channel file, when receiving a photo:
   - Download the largest `photo_size` via `getFile` API to `groups/<folder>/attachments/photo_<messageId>.<ext>`.
   - Store in the message as `[Photo] (/workspace/group/attachments/photo_123.jpg)` inline reference.
3. The existing `IMAGE_REF_RE` regex in `container-runner.ts` (v1) picks these up. In v2 the same parsing logic needs to live wherever multimodal content blocks are assembled for the provider call.
4. Supported media types must be the Anthropic SDK literal union: `'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'`.

**Sample v1 code (porting reference — may need adaptation to v2 module structure):**

```typescript
const IMAGE_REF_RE = /\[Photo\] \((\/workspace\/group\/attachments\/[^)]+)\)/g;
const imageAttachments: Array<{ path: string; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }> = [];
for (const msg of missedMessages) {
  let match;
  while ((match = IMAGE_REF_RE.exec(msg.content)) !== null) {
    const filePath = match[1];
    const ext = filePath.split('.').pop()?.toLowerCase() || 'jpg';
    const mediaType =
      ext === 'png' ? 'image/png'
      : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp'
      : 'image/jpeg';
    imageAttachments.push({ path: filePath, mediaType });
  }
}
```

---

### Telegram reply / quoted-message context

**Intent:** When a user replies to an earlier Telegram message, the agent sees the quoted content as context, not just the new reply.

**Files:** `src/channels/telegram.ts`, DB schema

**How to apply:**
1. When processing a Telegram message with `reply_to_message`, capture:
   - `reply_to_message_id`
   - `reply_to_content` (text of the quoted message)
   - `reply_to_sender`
2. Persist these fields on the `messages` table. In v2 this needs a DB migration under `src/db/migrations/`.
3. When formatting the prompt for the agent, prepend: `[Reply to <sender>: "<quoted content>"]` before the new message content.

---

### Telegram "file too big" graceful handling

**Intent:** Telegram rejects files >20MB via `getFile`. Instead of crashing, log and continue.

**Files:** Telegram download helper

**How to apply:** Catch the error from `getFile`, check for `file is too big` substring, log a warning, and skip the attachment (don't throw). Agent still gets the text of the message.

---

### WhatsApp channel REMOVED

**Intent:** User doesn't use WhatsApp. The WhatsApp channel code, auth flow, and dependencies were removed (commit `0e0bc48`).

**Files:** Don't merge `skill/add-whatsapp`. Don't install `@whiskeysockets/baileys`.

**How to apply:** Simply **skip** applying the add-whatsapp skill during upgrade. Verify that after all skill merges, `package.json` does not include baileys and `src/channels/whatsapp.ts` does not exist.

---

### Gmail: tool mode (send_email MCP)

**Intent:** Agent can call `send_email(to, subject, body)` to compose and send an email from the Mac mini's Gmail account. Works for main group only.

**Files:** `src/channels/gmail.ts` (send logic), agent-runner MCP tool registration, `src/ipc.ts` (IPC handler)

**How to apply:**
1. Apply `skill/add-gmail-tool` if upstream has it; otherwise ensure the Gmail channel exposes a `sendEmail` method and an MCP tool registers `send_email`.
2. IPC handler must verify `isMain` before dispatching.
3. The **From-header customization** below applies here.

---

### Gmail: custom From-name "MBT Assistent"

**Intent:** Outgoing emails appear as `MBT Assistent <email@domain>` rather than just `<email@domain>`.

**Files:** `src/channels/gmail.ts` (or v2 equivalent)

**How to apply:** In both `sendMessage` (reply to inbound) and `sendEmail` (tool mode), build the `From:` header as:

```
From: MBT Assistent <${this.userEmail}>
```

There are two occurrences in v1 (reply path + tool path). Both must be updated.

---

### Apple Container runtime + credential proxy binding

**Intent:** NanoClaw runs inside Apple Container (not Docker) for native macOS sandboxing.

**Files:** `.env`, launchd plist, whatever v2 equivalent of `src/container-runtime.ts` is.

**How to apply:**
1. Apply `skill/apple-container` (or v2 equivalent).
2. `.env` must have `CREDENTIAL_PROXY_HOST=0.0.0.0` (NOT `192.168.64.1` — that IP only exists inside the container VM, not on the host).
3. `.env` must have `CREDENTIAL_PROXY_PORT=3002` (3001 is taken by something else on this machine).
4. launchd plist `EnvironmentVariables` must mirror both values.
5. **Container memory must be at least 2GB** (default 1GB OOMs with Chromium during browser tasks). Whatever config file controls the container image's memory allocation — grep for `1024` or memory settings in container build scripts — change to `2048`.
6. Memory unit suffix: on Apple Container use `M`/`G` without `B` suffix (`2G` not `2GB`) — commit `5a1ef6e` was a bug fix for this.

---

### Native credential proxy (not OneCLI)

**Intent:** Credentials live in `.env`; a local proxy injects them into container API calls. OneCLI Agent Vault is NOT used.

**Files:** `src/credential-proxy.ts` equivalent in v2

**How to apply:**
1. Apply `skill/native-credential-proxy` in the upgrade worktree.
2. Do NOT run `/init-onecli` during or after the upgrade.
3. `CLAUDE_CODE_OAUTH_TOKEN` stays in `.env`.
4. If v2 has a provider abstraction that defaults to OneCLI, switch to the "native" or "env" provider in whatever provider config file exists.

---

### Gmail channel registration for send_email IPC

**Intent:** The Gmail channel must be registered in the channel registry even when Gmail is only used in tool mode — otherwise the IPC handler can't look it up by name to call `sendEmail`.

**Files:** `src/channels/index.ts` / `channel-registry.ts`

**How to apply:** In the channel registration barrel, ensure Gmail is always imported and self-registers, regardless of whether Gmail is set up as an inbound channel. If the v2 design uses a separate registry for tool-only channels, Gmail must appear there.

---

### Session command: empty imageAttachments (bug fix)

**Intent:** When a session slash-command runs, it must pass an empty `imageAttachments: []` array to `runAgent` — passing undefined caused a crash in v1.

**Files:** `src/session-commands.ts` or v2 equivalent

**How to apply:** In the session-command runner, when calling into the agent invocation, pass `[]` explicitly for image attachments. Commit `a40c6fb` in v1 is the reference.

---

### Credential proxy double-start fix

**Intent:** The credential proxy was being started twice in `src/index.ts` (leftover from a merge). Only start once.

**Files:** `src/index.ts` or wherever v2 starts the proxy

**How to apply:** Ensure `startCredentialProxy(...)` is called exactly once during startup. Commit `c87e562` fixed a duplicate. Watch for this pattern if conflicts arise.

---

## Apple Pages integration (custom skill — no upstream branch)

**Intent:** 11 MCP tools that let the agent create, edit, format, and export `.pages` documents on the host macOS machine via `osascript`. Sandboxed per group to `groups/<folder>/pages/`. Works in all registered groups.

**Files to recreate in v2:**
- `src/pages.ts` — host-side osascript wrapper (currently ~470 lines)
- `src/pages.test.ts` — 19 unit tests
- `src/ipc.ts` — `handlePagesIpc` handler for `pages_*` messages (add to v2's IPC dispatch, wherever it lives)
- Agent-runner MCP tool registrations — in v2 this goes in one of `container/agent-runner/src/mcp-tools/*.ts`
- `.claude/skills/add-pages/SKILL.md` — install guide

**Full source of the working v1 version lives on branch `skill/add-pages`** (local-only, not upstream). The commit `c439a48` is the latest (includes all three bugfixes: spawn-for-stdin, valid AppleScript emission, style-before-overrides).

**Key implementation details for reapplying against v2:**

1. **Path sandboxing** — every file path must go through `resolveGroupFolderPath(<folder>)` + validated filename pattern `/^[A-Za-z0-9 _()\-.]{1,128}$/` + no leading dot + path-traversal check. Group-scoped to `groups/<folder>/pages/`.

2. **osascript invocation** — MUST use `spawn('osascript', ['-'])` + `stdin.end(script)`. Do NOT use `execFile` async with an `input` option — that silently drops the script (bug we already hit).

3. **AppleScript generation rules** (learned the hard way):
   - Do NOT use `set properties of X to with properties {...}` — `with properties` only applies to `make new` verbs.
   - Do NOT use `paragraph style "X" of newDoc` as a reference form — not valid in Pages.
   - Instead: one `set <property> of <paraRef> to <value>` line per property, each wrapped in `try ... end try`.
   - **Ordering matters**: apply `paragraph style` FIRST, then font/size/color/bold/italic/underline/alignment — because setting a paragraph style resets all formatting on that paragraph.

4. **MCP tools to register** (11 total):
   - `pages_create`, `pages_open`, `pages_save`, `pages_close`
   - `pages_get_text`, `pages_insert_text`, `pages_replace_text`
   - `pages_format_paragraph`
   - `pages_export_pdf`
   - `pages_list`, `pages_delete`

5. **Request/response pattern** — IPC uses request-id-based responses:
   - Agent writes `pages_*` IPC message with `requestId` field.
   - Host handler writes result to `groups/<folder>/pages/.responses/<requestId>.json`.
   - Agent polls that path for up to 60s (120s for `pages_export_pdf`).
   - The `.responses` directory is under the group-folder mount so the agent container can read it directly without shared filesystem.

6. **Authorization** — all registered groups can use Pages (sandboxed per group). This is different from `send_email` which is main-only, because Pages can't escape its group folder.

7. **macOS requirements**:
   - Automation permission in System Settings → Privacy & Security → Automation → Terminal/launchd → Pages (must be ticked)
   - Pages.app installed
   - osascript available (built-in on macOS)

**Migration approach for Pages:**
- After `upstream/main` + all skill merges succeed in the worktree, `git checkout skill/add-pages -- src/pages.ts src/pages.test.ts .claude/skills/add-pages/` as a starting point.
- Adapt `src/ipc.ts` insertion to wherever v2's IPC dispatcher lives (search for where `send_email` or similar host-IPC types are routed).
- Adapt the MCP tool registrations: in v1 they lived at the bottom of `container/agent-runner/src/ipc-mcp-stdio.ts` before `register_group`. In v2 they should go in a new module file, e.g. `container/agent-runner/src/mcp-tools/pages.ts`, following the pattern of the other split tool files.
- Pattern-match on how `send_email` is registered in v2 and mirror that structure for `pages_*`.
- Run the 19 unit tests — they mock `spawn`, so they should pass without any osascript actually running.

---

## CLAUDE.md files

**Intent:** The global + main-group CLAUDE.md files contain the assistant persona, instructions, and group-management patterns. These are user content, not code.

**Files:** `groups/global/CLAUDE.md`, `groups/main/CLAUDE.md`

**How to apply:** Copy both files verbatim from the main tree into the upgraded worktree. Do NOT let the upgrade overwrite them with upstream defaults — they contain custom instructions (MBT context, channel formatting rules, task-script patterns).

---

## Data directories

**Do NOT touch:**
- `groups/<any>/` — user content, chat history, custom memories
- `store/` — SQLite database with messages, tasks, group registrations
- `data/ipc/` — live IPC state
- `.env` — credentials

**DB migrations caveat:** v2 introduces a formal migration system under `src/db/migrations/`. The first run against the existing database will apply migrations `001-initial` through `013-approval-render-metadata`. This is mostly additive (new tables/columns for approvals, permissions, etc.) but **back up `store/` before first v2 start**:

```bash
cp -r /Users/eva/nanoclaw/store /Users/eva/nanoclaw/store.pre-v2-backup
```

If migrations go wrong, stop the service, `rm -rf store && mv store.pre-v2-backup store`, roll back via the backup tag from step 2.1.

---

## Post-upgrade validation checklist

After swapping the worktree into main and restarting:

- [ ] Service starts cleanly (no EADDRINUSE, no EADDRNOTAVAIL — both hit during this session)
- [ ] `launchctl list | grep nanoclaw` shows a PID (not `-`)
- [ ] Telegram main group receives messages; `@Eva` trigger works
- [ ] Telegram swarm — send a message that should provoke a sub-agent reply, verify it comes from the right bot identity
- [ ] Gmail inbound — an email arrives and becomes a message
- [ ] Gmail outbound — agent can send via `send_email` tool, From-header says "MBT Assistent"
- [ ] Pages — `pages_create` → `pages_export_pdf` end-to-end produces a PDF with correct formatting (title, bold, color)
- [ ] PDF export works end-to-end via PDF reader on inbound email attachments
- [ ] Container memory is 2GB (spawn a browser-using task, verify no OOM)
- [ ] Credential proxy listens on `0.0.0.0:3002`

---

## Rollback procedure

The backup tag created at Phase 2.1 is the canonical rollback point:

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
cd /Users/eva/nanoclaw
git reset --hard <backup-tag-name>
rm -rf store && mv store.pre-v2-backup store   # if DB migrations were applied
npm install && npm run build
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```
