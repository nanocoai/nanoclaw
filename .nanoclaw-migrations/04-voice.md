# 04 — Voice transcription (Groq Whisper)

> ✅ **VERIFIED** against v2 source on 2026-05-27. Voice transcription is genuinely missing from v2 main (only present in unmerged Signal commit `53513db`). Attachment flow audited via `origin/channels:src/channels/telegram.ts:218`, `origin/main:src/channels/chat-sdk-bridge.ts:123-141`, `origin/main:src/session-manager.ts`, `origin/main:container/agent-runner/src/formatter.ts`.

## Decision

Bash script in `groups/telegram_main/scripts/transcribe_voice.sh`. Agent calls it via its Bash tool when it sees a voice attachment. Same shape as v1.

## Verified attachment flow in v2

When a Telegram voice message arrives:

1. **`origin/channels:src/channels/telegram.ts:218`** — adapter delegates to `createChatSdkBridge`
2. **`origin/main:src/channels/chat-sdk-bridge.ts:123-141`** — downloads attachment via `att.fetchData()`, stores base64 in `entry.data`
3. **`origin/main:src/session-manager.ts:extractAttachmentFiles`** (~line 160) — decodes base64, writes to disk at `sessionDir/inbox/<messageId>/<filename>`
4. **`origin/main:src/container-runner.ts`** (~line 85) — mounts session dir; file becomes container-visible at `/workspace/inbox/<messageId>/<filename>`
5. **`origin/main:container/agent-runner/src/formatter.ts:formatAttachments`** (~line 272) — surfaces it to the agent as `[<type>: <name> — saved to /workspace/<localPath>]`

Container path is **`/workspace/inbox/<messageId>/<filename>`**, NOT `/workspace/group/attachments/...` like v1.

## Verified: no inbound transformation hook

`origin/main:src/channels/chat-sdk-bridge.ts` exposes exactly two hooks:
- `extractReplyContext` (line 30) — used by Telegram
- `transformOutboundText` (line 35) — used by Telegram for the markdown sanitizer

**No `transformInboundAttachment` hook exists.** Building host-side transcription means a new feature PR, not a migration step. Out of scope here.

## Why a per-group script is the right v2 answer

- v2 already treats `groups/<folder>/scripts/` as the canonical place for per-group capabilities (Bybit/Valtrex scripts use it — see [05-business-logic.md](05-business-logic.md))
- Agent has Bash tool access; one tool call = transcription
- No new core code, no skill to fork (none exists), no upstream PR needed
- Pattern matches v1 — preserves user's "функционал максимально близко к телу" intent for capabilities

## How to apply (Stage 4.1)

### 1. Copy the script and its Groq config

```bash
mkdir -p groups/telegram_main/scripts
cp /tmp/nanoclaw-state/groups/telegram_main/scripts/transcribe_voice.sh \
   groups/telegram_main/scripts/
chmod +x groups/telegram_main/scripts/transcribe_voice.sh

# Groq API key. v1 put it at config/groq.json — keep that location, it's
# inside the per-group folder which is r/w mounted into the container.
mkdir -p groups/telegram_main/config
cp /tmp/nanoclaw-state/groups/telegram_main/config/groq.json \
   groups/telegram_main/config/groq.json
```

(No need to move the Groq key to `.env`. The group folder is mounted into the container; the script reads the key from its own `config/groq.json` next to it. Same as v1, no env-passthrough complexity.)

### 2. Verify the script's path assumptions still hold

The v1 script likely hardcodes a path like `/workspace/group/attachments/...`. Update it for the v2 path. The script will be invoked as:

```bash
bash scripts/transcribe_voice.sh /workspace/inbox/<message-id>/<filename>
```

Open the script, find any hardcoded prefix like `attachments/` or `/workspace/group/...` — replace with whatever path the agent will actually pass, or make it accept absolute path and Just Work.

### 3. Teach the agent how to use it

Append to `groups/telegram_main/CLAUDE.local.md` (the per-group instructions file in v2 — see [03-formatting.md](03-formatting.md) and [07-data-restore.md](07-data-restore.md) for the rename):

```markdown
## Voice transcription

When you receive a Telegram message with a voice attachment, you'll see it
formatted in your context as:

  [voice: <name> — saved to /workspace/inbox/<messageId>/<filename>]

To transcribe it, run from `/workspace/group/`:

  bash scripts/transcribe_voice.sh /workspace/inbox/<messageId>/<filename>

It prints the transcript to stdout. Use the transcript as the user's intent
and reply normally.

If the script errors (network, key invalid), apologize briefly to the user
and ask them to retype.
```

### 4. Verify on a real voice note

Send a voice message via Telegram. Agent should call the script, read transcript, respond.

## What we drop from v1

Nothing — script + per-group config carry over 1:1. Only the path the script reads changes from `/workspace/group/attachments/<file>` to `/workspace/inbox/<msgid>/<file>`. One-line script edit.

## Reference for future automatic transcription

If we ever want host-side automatic transcription (no agent round-trip), the precedent is **Signal channel** in commit `53513db` (unmerged on origin/main). It implements voice transcription using either `WHISPER_BIN` (local whisper.cpp) or `OPENAI_API_KEY`. That's a feature PR to revive later — not a migration step.
