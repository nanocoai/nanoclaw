# Intent: src/config.ts modifications

## What changed
Added five new configuration exports for Webhook channel support.

## Key sections
- **readEnvFile call**: Must include `WEBHOOK_PORT`, `WEBHOOK_HOST`, `WEBHOOK_TOKEN`, `WEBHOOK_CONNECTOR_URL`, and `WEBHOOK_ONLY` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **WEBHOOK_PORT**: Numeric port, defaults to `18794`
- **WEBHOOK_HOST**: Host bind address, defaults to `127.0.0.1`
- **WEBHOOK_TOKEN**: Optional bearer token for route auth, defaults to empty string
- **WEBHOOK_CONNECTOR_URL**: Connector forward URL for outbound sends, defaults to `http://127.0.0.1:19400/v1/outbound`
- **WEBHOOK_ONLY**: Boolean flag from `process.env` or `envConfig`, when `true` disables WhatsApp channel creation

## Invariants
- All existing config exports remain unchanged
- New webhook keys are added to the `readEnvFile` call alongside existing keys
- New exports are appended at the end of the file
- No existing behavior is modified — webhook config is additive only
- Both `process.env` and `envConfig` are checked

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
