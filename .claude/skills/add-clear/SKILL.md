---
name: add-clear
description: Add a /clear command that compacts conversation history by summarizing and resetting context. Preserves critical information (names, decisions, preferences, open tasks) in a synthetic summary message while clearing the full history from SQLite and resetting the Claude Agent SDK session.
---

# Add /clear Command

This skill adds a `/clear` command to NanoClaw. When a user sends `/clear` in any group, the conversation history is summarized via a direct Anthropic API call, the SQLite messages table is atomically cleared and replaced with the summary, and the Claude Agent SDK session directory is reset — so the next message starts fresh but the agent retains essential context.

## Design Principles

- **Direct API call, no container** — Summarization happens on the host, not in a spawned container. Faster and simpler.
- **Atomic or nothing** — If the API call fails, nothing is cleared. If the DB transaction fails, the session directory is not touched. No partial state.
- **Last 500 messages** — Caps the summarization input to prevent context window overflow on long conversations.
- **Minimal surface area** — Touches 4 files, adds no background processes, no new IPC handlers, no new directories.
- **Extension-friendly** — Leaves a clearly marked hook for `/add-memory-system` integration.

---

## Implementation

Execute all steps in order.

---

### Step 1: Add `@anthropic-ai/sdk` to `package.json`

Check `package.json` dependencies. If `@anthropic-ai/sdk` is already present, skip this step.

If not present, add it to the `dependencies` section:

```json
"@anthropic-ai/sdk": "^0.32.1"
```

Then run:

```bash
npm install
```

---

### Step 2: Add `SUMMARIZATION_MODEL` to `src/config.ts`

Read `src/config.ts`. Find the `TIMEZONE` export. After it, add:

```typescript
// Model used for conversation summarization (/clear command)
export const SUMMARIZATION_MODEL = 'claude-3-5-sonnet-20241022';
```

---

### Step 3: Add DB functions to `src/db.ts`

Read `src/db.ts`. Find the section just before the `// --- JSON migration ---` comment. Insert these three functions there:

```typescript
// --- Clear command ---

/**
 * Get ALL messages for a group including bot messages.
 * Unlike getMessagesSince, this includes bot responses.
 * Used for conversation summarization in /clear command.
 */
export function getAllMessagesForGroup(chatJid: string): NewMessage[] {
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
    FROM messages
    WHERE chat_jid = ?
    ORDER BY timestamp
  `;
  return db.prepare(sql).all(chatJid) as NewMessage[];
}

/**
 * Get count of user messages for a group (for feedback in confirmation message).
 */
export function getMessageCount(chatJid: string): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) as count FROM messages WHERE chat_jid = ? AND is_bot_message = 0',
    )
    .get(chatJid) as { count: number } | undefined;
  return row?.count ?? 0;
}

/**
 * Clear all messages for a group and replace with a single summary message.
 * Runs in a transaction — either both operations succeed or neither does.
 */
export function clearAndSummarizeMessages(
  chatJid: string,
  summary: string,
  lastTimestamp: string,
): void {
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid);

    const syntheticId = `clear-${Date.now()}`;
    db.prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      syntheticId,
      chatJid,
      ASSISTANT_NAME,
      ASSISTANT_NAME,
      `[Conversation cleared]\n\n${summary}`,
      lastTimestamp,
      0,
      1,
    );
  });

  transaction();
}
```

---

### Step 4: Update `src/index.ts`

Read `src/index.ts` in full before making any changes.

**4a. Add `@anthropic-ai/sdk` import**

Find the imports block at the top of the file. Add:

```typescript
import Anthropic from '@anthropic-ai/sdk';
```

**4b. Update the config import**

Find the existing import from `./config.js`. Add `SUMMARIZATION_MODEL` to it:

```typescript
import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  SUMMARIZATION_MODEL,
  TRIGGER_PATTERN,
} from './config.js';
```

**4c. Update the db import**

Find the existing import from `./db.js`. Add the three new functions:

```typescript
import {
  // ... existing imports ...
  clearAndSummarizeMessages,
  getAllMessagesForGroup,
  getMessageCount,
} from './db.js';
```

**4d. Declare the Anthropic client**

Find the module-level variable declarations (where `sessions`, `registeredGroups`, `lastAgentTimestamp` are declared). Add the client declaration alongside them:

```typescript
let anthropic: Anthropic;
```

**4e. Initialize the Anthropic client in `main()`**

Read the `main()` function. Find the line that calls `initDatabase()`. After it, add:

```typescript
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  logger.error('ANTHROPIC_API_KEY not found in environment');
  process.exit(1);
}
anthropic = new Anthropic({ apiKey });
```

**4f. Add `handleClearCommand()` at module scope**

Find `processGroupMessages()`. Insert this function immediately before it:

```typescript
/**
 * Handle /clear command: summarize conversation, clear SQLite messages,
 * and reset the Claude Agent SDK session directory.
 * Atomic: if any step fails, nothing is cleared.
 */
async function handleClearCommand(
  chatJid: string,
  group: RegisteredGroup,
  channel: Channel,
  clearCommandTimestamp: string,
): Promise<void> {
  try {
    const allMessages = getAllMessagesForGroup(chatJid);

    if (allMessages.length === 0) {
      await channel.sendMessage(chatJid, 'Nothing to clear yet — no messages in this conversation.');
      // Advance cursor to prevent reprocessing /clear command
      lastAgentTimestamp[chatJid] = clearCommandTimestamp;
      saveState();
      return;
    }

    const messageCount = getMessageCount(chatJid);
    const recentMessages = allMessages.slice(-500);
    const lastTimestamp = allMessages[allMessages.length - 1].timestamp;

    let formattedMessages = formatMessages(recentMessages);

    // Progressive truncation to prevent token limit errors
    const MAX_CHARS = 150000;  // ~37.5k tokens at 4 chars/token, well under 200k limit
    let messagesToSummarize = recentMessages;
    while (formattedMessages.length > MAX_CHARS && messagesToSummarize.length > 10) {
      // Reduce by 25% each iteration
      messagesToSummarize = messagesToSummarize.slice(-Math.floor(messagesToSummarize.length * 0.75));
      formattedMessages = formatMessages(messagesToSummarize);
    }

    // Hard cap if still too large
    if (formattedMessages.length > MAX_CHARS) {
      formattedMessages = formattedMessages.slice(0, MAX_CHARS) + '\n[Truncated due to length]';
    }

    logger.info(
      {
        group: group.folder,
        total: allMessages.length,
        summarizing: messagesToSummarize.length,
        chars: formattedMessages.length,
      },
      'Executing /clear command',
    );

    await channel.setTyping?.(chatJid, true);

    // Summarize via direct API call — no container needed
    const response = await anthropic.messages.create({
      model: SUMMARIZATION_MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Summarize this conversation. Preserve important context: names, preferences, decisions, open tasks, and key facts. Be concise but complete.\n\n${formattedMessages}`,
        },
      ],
    });

    const summary = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
      .trim();

    if (!summary) {
      throw new Error('Empty summary returned from API');
    }

    // EXTENSION POINT: if /add-memory-system is installed, write summary to daily log here
    // Example: await writeToMemoryDaily(group.folder, summary, new Date());

    // 1. Reset SDK session FIRST
    // (if DB fails after this, user can safely retry /clear)
    const sessionDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
    if (fs.existsSync(sessionDir)) {
      const settingsPath = path.join(sessionDir, 'settings.json');
      const settingsBackup = fs.existsSync(settingsPath)
        ? fs.readFileSync(settingsPath, 'utf-8')
        : null;

      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.mkdirSync(sessionDir, { recursive: true });
        if (settingsBackup) {
          fs.writeFileSync(settingsPath, settingsBackup);
        }
      } catch (fsErr) {
        logger.error({ group: group.folder, fsErr }, 'Session directory cleanup failed — aborting clear');
        throw new Error(`Session cleanup failed: ${fsErr instanceof Error ? fsErr.message : String(fsErr)}. Nothing was cleared.`);
      }
    }

    // 2. Clear DB atomically (if this fails, session is already reset but DB intact — retry is safe)
    clearAndSummarizeMessages(chatJid, summary, lastTimestamp);

    // 3. Clear in-memory session reference and persist to DB
    sessions[group.folder] = '';
    setSession(group.folder, '');

    // Reset message cursor to last timestamp so the loop doesn't reprocess old messages
    lastAgentTimestamp[chatJid] = lastTimestamp;
    saveState();

    await channel.setTyping?.(chatJid, false);

    const confirmation = `✓ Cleared ${messageCount} message${messageCount === 1 ? '' : 's'}. Here's what I kept:\n\n${summary}`;
    await channel.sendMessage(chatJid, confirmation);

    logger.info({ group: group.folder }, '/clear command completed successfully');
  } catch (err) {
    await channel.setTyping?.(chatJid, false);
    logger.error({ group: group.folder, err }, '/clear command failed');
    await channel.sendMessage(
      chatJid,
      `❌ Failed to clear conversation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
```

**4g. Detect `/clear` inside `processGroupMessages()`**

Read `processGroupMessages()`. Find the lines that retrieve `missedMessages` and check if the array is empty. Immediately after the empty check (before the trigger pattern check or `runAgent()` call), add:

```typescript
// Detect /clear command
const clearCommand = missedMessages.find((m) => m.content.trim() === '/clear');
if (clearCommand) {
  // Permission check: only bot owner can clear
  if (!clearCommand.is_from_me) {
    await channel.sendMessage(chatJid, '❌ Only the bot owner can use /clear.');
    lastAgentTimestamp[chatJid] = clearCommand.timestamp;
    saveState();
    return true;
  }

  // Check if conversation was JUST cleared (deduplicates queued /clear commands)
  const allMessages = getAllMessagesForGroup(chatJid);
  if (allMessages.length === 1 && allMessages[0].content.startsWith('[Conversation cleared]')) {
    // Already cleared, likely a queued duplicate /clear
    await channel.sendMessage(chatJid, 'Conversation was just cleared.');
    lastAgentTimestamp[chatJid] = clearCommand.timestamp;
    saveState();
    return true;
  }

  // Execute clear - cursor advances INSIDE handleClearCommand on success only
  await handleClearCommand(chatJid, group, channel, clearCommand.timestamp);
  return true;
}
```

---

## Verification

Tell the user:

> `/clear` is installed. To verify:
>
> **Basic flow:**
> 1. Send a few messages in any group
> 2. Send `/clear`
> 3. You should receive a confirmation with a summary and message count
> 4. Send another message — the agent should respond as if starting fresh, but aware of the summary
>
> **Check SQLite directly:**
> ```bash
> sqlite3 store/messages.db "SELECT content FROM messages WHERE chat_jid = 'YOUR_JID';"
> ```
> Should show exactly one row starting with `[Conversation cleared]`
>
> **Edge cases:**
> - Send `/clear` in an empty conversation → should reply "Nothing to clear yet"
> - Send `/clear` mid-conversation with 10,000+ messages → only last 500 summarized, should still complete
>
> **Check logs:**
> ```bash
> tail -f logs/nanoclaw.log | grep -i clear
> ```

---

## What This Changes

| File | Change |
|------|--------|
| `package.json` | Add `@anthropic-ai/sdk` dependency |
| `src/config.ts` | Add `SUMMARIZATION_MODEL` constant |
| `src/db.ts` | Add `getAllMessagesForGroup()`, `getMessageCount()`, `clearAndSummarizeMessages()` |
| `src/index.ts` | Add Anthropic client, `handleClearCommand()`, `/clear` detection in `processGroupMessages()` |
| `data/sessions/{folder}/.claude/` | Cleared on `/clear` (except `settings.json`) |

## Future Considerations

- **Automatic compaction** — trigger `/clear` automatically when message count crosses a threshold (e.g. 2000 messages), without user intervention
- **`/clear --hard`** — skip summarization entirely, just wipe (for when you want a true fresh start)
- **Memory system integration** — if `/add-memory-system` is installed, the summary is also written to `memory/daily/YYYY-MM-DD.md` via the extension point in `handleClearCommand()`
