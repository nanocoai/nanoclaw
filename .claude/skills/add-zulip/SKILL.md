# Add Zulip Channel

This skill adds Zulip support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

Uses the Zulip REST API directly (no extra npm dependency — Node.js 18+ built-in fetch).

**JID format:** `zl:<stream_name>/<topic>` — each stream+topic pair is a separate conversation.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `zulip` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Should Zulip replace WhatsApp or run alongside it?
- **Replace WhatsApp** — Zulip will be the only channel (sets ZULIP_ONLY=true)
- **Alongside** — Both Zulip and WhatsApp channels active

AskUserQuestion: Do you have a Zulip bot API key, or do you need to create one?

If they have credentials, collect all three now:
1. **Realm URL** — e.g. `https://yourorg.zulipchat.com` (Zulip Cloud) or your self-hosted server URL
2. **Bot email** — e.g. `andy-bot@yourorg.zulipchat.com`
3. **Bot API key** — from the Zulip developer settings

If they need to create a bot, proceed through Phase 3 first.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx -e "import { initSkillsSystem } from '/path/to/nanoclaw/skills-engine/migrate.ts'; initSkillsSystem();"
```

Or with the script:

```bash
npx tsx scripts/apply-skill.ts --init   # only if the script supports --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-zulip
```

This deterministically:
- Adds `src/channels/zulip.ts` (ZulipChannel class implementing the Channel interface)
- Adds `src/channels/zulip.test.ts` (unit tests with fetch mock)
- Three-way merges Zulip support into `src/index.ts` (channel creation, ZULIP_ONLY guard)
- Three-way merges Zulip config into `src/config.ts` (ZULIP_SITE, ZULIP_BOT_EMAIL, ZULIP_BOT_API_KEY, ZULIP_ONLY)
- Three-way merges updated routing tests into `src/routing.test.ts`
- Updates `.env.example` with the four Zulip variables
- Records the application in `.nanoclaw/state.yaml`

**No npm install** — the Zulip integration uses Node.js built-in `fetch`.

### Handle merge conflicts (if any)

If the apply reports merge conflicts in `src/index.ts`, this is expected when
combining Zulip with another channel skill (Discord, Telegram). Read:
- `modify/src/index.ts.intent.md` — exact resolution instructions with example code

The conflict is in the channel-creation block of `main()`. Resolve it by
combining the per-channel conditional blocks from each skill (see intent file).

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new Zulip tests) and the build must be clean before proceeding.

## Phase 3: Setup

### Create a Zulip bot (if needed)

Tell the user:

> To create a Zulip bot:
>
> 1. Go to **Personal Settings** (⚙ icon) > **Bots** tab > **Add a new bot**
> 2. Choose **Bot type: Generic bot**
> 3. Give it a name (e.g. "Andy") and username slug (e.g. `andy-bot`)
> 4. Click **Create bot** — copy the **API key** immediately
> 5. Note the **bot email** shown in the bot list (e.g. `andy-bot@yourorg.zulipchat.com`)
> 6. Note your **realm URL** shown in your browser address bar (e.g. `https://yourorg.zulipchat.com`)
>
> Next, subscribe the bot to the stream(s) you want it to respond in:
> 1. Open the stream settings (gear icon next to the stream name)
> 2. Go to the **Subscribers** tab
> 3. Search for and add your bot by name or email

Wait for the user to provide all three credentials.

### Configure environment

Add to `.env`:

```bash
ZULIP_SITE=<realm-url>           # e.g. https://yourorg.zulipchat.com
ZULIP_BOT_EMAIL=<bot-email>      # e.g. andy-bot@yourorg.zulipchat.com
ZULIP_BOT_API_KEY=<api-key>
```

If they chose to replace WhatsApp:

```bash
ZULIP_ONLY=true
```

Sync to container environment:

```bash
cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
```

Then restart the service:
- **macOS (launchd):** `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- **Linux (systemd):** `systemctl --user restart nanoclaw`

## Phase 4: Registration

### Get the channel JID

Tell the user:

> To get the JID for a Zulip stream+topic:
>
> 1. Go to the stream where you want the bot to respond
> 2. Start a new topic (or use an existing one)
> 3. @mention the bot and type `chatid`  — e.g. `@Andy chatid`
> 4. The bot will reply with the full JID:  `zl:<stream_name>/<topic>`
>
> **Example JID:** `zl:general/bot-requests`
>
> Note: the JID encodes the exact stream name and topic. If you rename the stream or
> topic, you will need to re-register with the new JID.

Wait for the user to provide the JID.

### Register the channel

For a main channel (responds to all messages, uses the `main` folder):

```bash
npx tsx setup/index.ts --step register -- \
  --jid "zl:<stream>/<topic>" \
  --name "<stream> > <topic>" \
  --trigger "@Andy" \
  --folder "main" \
  --no-trigger-required
```

For additional channels (trigger-only, separate agent folder):

```bash
npx tsx setup/index.ts --step register -- \
  --jid "zl:<stream>/<topic>" \
  --name "<stream> > <topic>" \
  --trigger "@Andy" \
  --folder "<folder-name>"
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered Zulip stream+topic:
> - For a main channel: any message will trigger the agent
> - For non-main channels: @mention the bot in the topic
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

1. Check that all three Zulip credentials are set in `.env` AND synced to `data/env/env`
2. Verify the bot is subscribed to the target stream (stream settings > Subscribers)
3. Check channel registration: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'zl:%'"`
4. For non-main channels: the message must @mention the bot to trigger the agent
5. Service is running: `systemctl --user status nanoclaw` (Linux) or `launchctl list | grep nanoclaw` (macOS)

### Bot connects but can't receive messages

If the bot connects (you see `Zulip bot: ...` in the logs) but never receives events:
1. Ensure the bot has been subscribed to the stream — it can only receive events for streams it is a member of
2. Check that `ZULIP_SITE` is the correct realm URL (not a sub-path)
3. Verify the API key belongs to the bot, not your personal account

### Event queue expiry

Zulip event queues expire after ~10 minutes of inactivity. NanoClaw automatically
re-registers the queue when it receives a `BAD_EVENT_QUEUE_ID` error, so this is
handled transparently. You may see a log line:
`Zulip event queue expired, re-registering`

### Merge conflict when applying alongside Discord or Telegram

When combining multiple channel skills, a merge conflict is expected in the
channel-creation block of `src/index.ts`. See `modify/src/index.ts.intent.md`
for the exact resolution instructions.

### Getting the stream JID without the chatid command

If the bot isn't running yet, you can construct the JID manually:
- Stream name: the exact name shown in the Zulip sidebar (case-sensitive)
- Topic: the exact topic name
- JID: `zl:<stream_name>/<topic>`

Example: stream "general", topic "bot-requests" → `zl:general/bot-requests`

## After Setup

The Zulip bot supports:
- Stream (channel) messages in registered stream+topic pairs
- @**Bot Name** and @_Bot Name_ (silent) mention translation to trigger format
- `chatid` command to discover registration JIDs interactively
- Typing indicators while the agent processes (requires the stream_id cache to be warm — populated on first received message)
- Message splitting for responses over 9 000 characters
- Automatic event queue re-registration on expiry
- All topics within a registered stream+topic are scoped to that specific topic — different topics are treated as separate conversations
