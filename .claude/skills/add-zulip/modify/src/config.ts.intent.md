# Intent: src/config.ts modifications

## What changed
Added four new configuration exports for Zulip channel support.

## Key sections
- **readEnvFile call**: Must include `ZULIP_SITE`, `ZULIP_BOT_EMAIL`, `ZULIP_BOT_API_KEY`, and `ZULIP_ONLY` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **ZULIP_SITE**: The base URL of the Zulip server (e.g. `https://yourorg.zulipchat.com`). Empty string disables the channel.
- **ZULIP_BOT_EMAIL**: The bot's email address (e.g. `andy-bot@yourorg.zulipchat.com`). Empty string disables the channel.
- **ZULIP_BOT_API_KEY**: The bot's API key from the Zulip developer settings. Empty string disables the channel.
- **ZULIP_ONLY**: Boolean flag — when `true`, disables WhatsApp channel creation.

## Invariants
- All existing config exports remain unchanged.
- New Zulip keys are added to the `readEnvFile` call alongside existing keys.
- New exports are appended at the end of the file under a `// Zulip configuration` comment.
- No existing behaviour is modified — Zulip config is additive only.
- Both `process.env` and `envConfig` are checked (same pattern as `ASSISTANT_NAME`).

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
