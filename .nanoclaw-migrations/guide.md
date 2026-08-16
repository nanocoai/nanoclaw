# NanoClaw Migration Guide

Generated: 2026-05-08
Base: 934f063aff5c30e7b49ce58b53b41901d3472a3e
HEAD at generation: c32e5b81bb3534a6fa524543f53b6ed5a816eeca
Upstream: 6e9f35a646ad0042b5b3fdef8bc9a7718229ae04

---

## Applied Channels

These three channels were merged from qwibitai's v1 channel repos. In v2 upstream, the equivalents live in the `upstream/channels` branch and use a new Chat SDK adapter model. **Do not re-merge from the old v1 remotes.** Instead, follow the v2 channel skills to re-add each channel.

| Channel  | Old remote (v1 — do NOT reuse)                        | v2 approach                  |
|----------|-------------------------------------------------------|------------------------------|
| Discord  | https://github.com/qwibitai/nanoclaw-discord.git      | Run `/add-discord` skill     |
| Telegram | https://github.com/qwibitai/nanoclaw-telegram.git     | Run `/add-telegram` skill    |
| WhatsApp | https://github.com/qwibitai/nanoclaw-whatsapp.git     | Run `/add-whatsapp` skill    |

After upgrading, re-add each channel by following the corresponding v2 skill. The v2 skills copy channel adapters from `upstream/channels` and register them with the new adapter model.

---

## Required Environment Variables

After upgrade, ensure these env vars are set in `.env`:

```
DISCORD_BOT_TOKEN=<your Discord bot token>
TELEGRAM_BOT_TOKEN=<your Telegram bot token>
ASSISTANT_HAS_OWN_NUMBER=<true|false>  # WhatsApp: true if the bot has its own dedicated number
```

---

## Applied Skills (upstream skill branches)

None — no upstream `skill/*` branches were merged into this fork. All channel additions came from separate qwibitai channel repos (see Applied Channels above).

---

## Customizations

### 1. Per-group cursor sweep in main poll loop

**Intent:** When multiple channels (Discord, Telegram, WhatsApp) are active, a message from one channel can arrive in the DB with an older timestamp after another channel has already advanced the global `lastTimestamp` cursor past it. The global cursor then skips this message forever. The sweep catches these stragglers by checking each group's own per-group cursor after the main loop iteration completes.

**Files:** `src/index.ts`

**How to apply:**

> **Warning:** v2 has a completely different polling/routing architecture. The `startMessageLoop`, `getOrRecoverCursor`, `getMessagesSince`, and `enqueueMessageCheck` APIs may have changed significantly or been removed. Check the v2 `src/index.ts` before applying. If the architecture no longer has a per-group cursor concept, this fix may not be needed — v2 may handle this differently by design.

If the v2 poll loop still follows a similar pattern (global cursor + per-group state), locate the main message processing loop in `src/index.ts` and add the following two changes:

**Change 1** — inside the loop iteration, before the `if (messages.length > 0)` block, add a Set to track which groups were handled this iteration:

```typescript
// Track which groups were handled via the global cursor this iteration
const handledThisIter = new Set<string>();
```

**Change 2** — inside the `for (const [chatJid, groupMessages] of messagesByGroup)` loop, at the very top of the loop body (before the `const group = registeredGroups[chatJid]` line), add:

```typescript
handledThisIter.add(chatJid);
```

**Change 3** — after the entire `if (messages.length > 0) { ... }` block (but still inside the outer try block), add the per-group sweep:

```typescript
// Per-group cursor sweep: catch messages whose timestamps are older than
// the global lastTimestamp cursor (e.g. a Discord message stored late
// after Telegram already advanced the cursor past it).
for (const chatJid of jids) {
  if (handledThisIter.has(chatJid)) continue;
  const pending = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    1,
  );
  if (pending.length > 0) {
    queue.enqueueMessageCheck(chatJid);
    logger.debug(
      { chatJid },
      'Pending messages found via per-group cursor sweep',
    );
  }
}
```

The functions `getMessagesSince`, `getOrRecoverCursor`, `enqueueMessageCheck`, and the `jids` array must already be in scope at this point. If they are not present in the v2 codebase, ask the user whether this behavior is still needed before inventing replacements.

---

### 2. `getMessageContentById` DB helper

**Intent:** WhatsApp uses message IDs in quoted-reply and retry scenarios. The WhatsApp channel adapter needs to look up the text content of a previously stored message by its ID. This function adds that lookup to the DB layer.

**Files:** `src/db.ts`

**How to apply:**

> **Warning:** v2 uses a completely different DB schema (split into `inbound.db` / `outbound.db` per group, new table layouts). Check v2's `src/db.ts` (or equivalent) before applying. If the `messages` table still exists with `id`, `chat_jid`, and `content` columns, apply as-is. If the schema changed, adapt accordingly — the intent is just a lookup of message content by message ID and group JID.

If v2 still has a central `messages` table with those columns, add this function after `getLastBotMessageTimestamp` (or at a logical position near other message-query functions):

```typescript
export function getMessageContentById(
  id: string,
  chatJid: string,
): string | undefined {
  const row = db
    .prepare(`SELECT content FROM messages WHERE id = ? AND chat_jid = ?`)
    .get(id, chatJid) as { content: string } | undefined;
  return row?.content;
}
```

If v2 has moved to per-group DBs, this function needs to accept a `db` instance parameter instead of using the module-level singleton. Check how other DB functions in v2 work and follow the same pattern.

---

## Notes on the v1→v2 Upgrade

The v2 rewrite is a near-complete architectural change:

- **Package manager**: v2 uses `pnpm` instead of `npm`. Run `pnpm install` instead of `npm install`.
- **Channel adapters**: v2 uses a Chat SDK bridge model. Old `src/channels/*.ts` files are **not compatible** with v2. Re-add channels via their v2 skills.
- **DB schema**: v2 splits session state into per-group `inbound.db` / `outbound.db`. Central DB may still exist for host-side state.
- **Container runtime**: v2 uses Bun inside containers, not Node.
- **Setup**: v2 has an interactive `nanoclaw.sh` setup script and a new `setup/` directory with a completely different structure.
- **GitHub workflows** (`bump-version.yml`, `update-tokens.yml`): User is "not sure" whether these were intentionally removed. v2 upstream includes them — they will be restored on upgrade. No special handling needed.
