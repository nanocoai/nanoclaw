# Intent: src/config.ts modifications

## What changed
Added four new configuration exports for Nostr channel support.

## Key sections
- **readEnvFile call**: Must include `NOSTR_PRIVATE_KEY`, `NOSTR_USER_PUBKEY`, `NOSTR_RELAYS`, and `NOSTR_ONLY` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **NOSTR_PRIVATE_KEY**: Hex-encoded private key for the bot's Nostr identity. Read from `process.env` first, then `envConfig` fallback, defaults to empty string (channel disabled when empty)
- **NOSTR_USER_PUBKEY**: Hex-encoded public key of the user who will DM the bot. Used for sender validation and auto-registration. Defaults to empty string (multi-user mode when empty)
- **NOSTR_RELAYS**: Comma-separated list of relay WebSocket URLs. Parsed into string array. Defaults to `wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band`
- **NOSTR_ONLY**: Boolean flag from `process.env` or `envConfig`, when `true` disables WhatsApp channel creation

## Invariants
- All existing config exports remain unchanged
- New Nostr keys are added to the `readEnvFile` call alongside existing keys
- New exports are appended at the end of the file
- No existing behavior is modified — Nostr config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as `ASSISTANT_NAME`)

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, `CONTAINER_IMAGE`, `DATA_DIR`, `TIMEZONE`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
