---
name: add-nostr
description: Add Nostr as a channel for encrypted DMs via NIP-17/NIP-44/NIP-59. Can replace WhatsApp entirely or run alongside it.
---

# Add Nostr Channel

This skill adds Nostr encrypted DM support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `nostr` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

1. **Mode**: Replace WhatsApp or add alongside it?
   - Replace → will set `NOSTR_ONLY=true`
   - Alongside → both channels active (default)

2. **Do they already have a Nostr private key (nsec/hex)?** If yes, collect it now. If no, we'll generate one in Phase 3.

3. **What is the user's Nostr pubkey (npub/hex)?** This is the pubkey the bot should accept DMs from. Required for sender validation.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

Or call `initSkillsSystem()` from `skills-engine/migrate.ts`.

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-nostr
```

This deterministically:
- Adds `src/channels/nostr.ts` (NostrChannel class implementing Channel interface)
- Adds `src/channels/nostr.test.ts` (39 unit tests)
- Three-way merges Nostr support into `src/index.ts` (multi-channel support, findChannel routing)
- Three-way merges Nostr config into `src/config.ts` (NOSTR_PRIVATE_KEY, NOSTR_USER_PUBKEY, NOSTR_RELAYS, NOSTR_ONLY exports)
- Three-way merges updated routing tests into `src/routing.test.ts`
- Installs the `nostr-tools` npm dependency
- Updates `.env.example` with Nostr environment variables
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new nostr tests) and build must be clean before proceeding.

## Phase 3: Setup

### Generate or convert the bot's private key

If the user doesn't have a key, generate one (after `npm install`):

```bash
npx tsx -e "import {generateSecretKey} from 'nostr-tools/pure';import {bytesToHex} from '@noble/hashes/utils.js';console.log(bytesToHex(generateSecretKey()))"
```

This prints a 64-character hex private key.

**If the user provides an nsec (NIP-19 encoded private key)**, convert to hex:

```bash
npx tsx -e "import {nip19} from 'nostr-tools';const {data}=nip19.decode('<their-nsec>');import {bytesToHex} from '@noble/hashes/utils.js';console.log(bytesToHex(data as Uint8Array))"
```

### Convert user's npub to hex

If the user provides an npub (NIP-19 encoded pubkey), convert to hex:

```bash
npx tsx -e "import {nip19} from 'nostr-tools';console.log(nip19.decode('<their-npub>').data)"
```

If they provide a raw hex pubkey (64 characters), use it directly.

### Configure environment

Add to `.env`:

```bash
NOSTR_PRIVATE_KEY=<64-char-hex-private-key>
NOSTR_USER_PUBKEY=<64-char-hex-pubkey-of-the-user>
```

Optional — custom relays (comma-separated, defaults to `wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band`):

```bash
NOSTR_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band
```

If they chose to replace WhatsApp:

```bash
NOSTR_ONLY=true
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Registration

### Register the Nostr chat

The chat JID for a Nostr user is `nostr:<hex-pubkey>`. Use the user's hex pubkey from Phase 3.

For a main chat (responds to all messages, uses the `main` folder):

```typescript
registerGroup("nostr:<user-hex-pubkey>", {
  name: "nostr-dm",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

Note: If `NOSTR_USER_PUBKEY` is configured, the bot automatically emits chat metadata on connect, so the chat will appear in the orchestrator's discovery list. But explicit registration is still needed so the bot actually delivers messages to the agent.

## Phase 5: Verify

### Test the connection

Tell the user:

> Open any Nostr client that supports NIP-17 encrypted DMs (e.g., Damus, Amethyst, Primal, Coracle, 0xchat) and send a DM to the bot's pubkey.
>
> The bot's pubkey is printed in the logs on startup:
> ```
> Nostr bot pubkey: <hex-pubkey>
> ```
>
> You can convert this to npub for easy sharing:
> ```bash
> npx tsx -e "import {nip19} from 'nostr-tools';console.log(nip19.npubEncode('<hex-pubkey>'))"
> ```
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

Look for:
- `Nostr channel connected` — successful startup
- `Nostr DM stored` — message received and delivered
- `Nostr DM sent` — reply sent successfully

## Troubleshooting

### Bot not responding

1. Check `NOSTR_PRIVATE_KEY` is set in `.env` AND synced to `data/env/env`
2. Check chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'nostr:%'"`
3. Service is running: `launchctl list | grep nanoclaw`
4. Check logs for `Nostr channel connected` — if missing, the key may be invalid

### "Nostr DM from unexpected sender"

This means `NOSTR_USER_PUBKEY` is set and the incoming DM is from a different pubkey. Either:
- The user is DMing from a different account than expected
- `NOSTR_USER_PUBKEY` is wrong — verify with: `npx tsx -e "import {nip19} from 'nostr-tools';console.log(nip19.decode('<user-npub>').data)"`

### "Message from unregistered Nostr chat"

The chat JID hasn't been registered. Register it:
- The JID format is `nostr:<sender-hex-pubkey>` — check the log line for the exact JID

### Relay connection failures

- Verify relays are reachable: `curl -s -o /dev/null -w "%{http_code}" <relay-url>` (expect 400 — relays reject HTTP, but this confirms the server is up)
- Try different relays in `NOSTR_RELAYS`
- Check if your network blocks WebSocket connections

### nsec vs hex confusion

- **nsec**: NIP-19 encoded private key, starts with `nsec1`. Convert to hex before putting in `.env`
- **npub**: NIP-19 encoded public key, starts with `npub1`. Convert to hex for `NOSTR_USER_PUBKEY`
- **hex**: 64-character hexadecimal string. This is what NanoClaw expects in `.env`

The conversion commands are in Phase 3 above.
