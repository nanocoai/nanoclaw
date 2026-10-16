# Intent: src/config.ts

## What changed
Added MEM0_BRIDGE_URL and MEM0_USER_ID configuration exports for the mem0 memory bridge.

## Key sections
- **Import/env**: Added 'MEM0_BRIDGE_URL' and 'MEM0_USER_ID' to readEnvFile call
- **New exports**: MEM0_BRIDGE_URL (default: http://localhost:8095) and MEM0_USER_ID (default: ASSISTANT_NAME lowercased)

## Invariants
- All existing exports remain unchanged
- readEnvFile call order preserved
- No existing configuration removed

## Must-keep
- All existing config exports (ASSISTANT_NAME, POLL_INTERVAL, etc.)
- TRIGGER_PATTERN regex
- TIMEZONE, ANTHROPIC_MODEL, DISCORD_* configs
