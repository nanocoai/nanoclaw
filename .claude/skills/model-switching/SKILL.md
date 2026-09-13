# Skill: Runtime Model Switching

Add a `/model` command that lets users switch Claude models at runtime via chat.

## What It Does

- `/model` — Show the current model
- `/model sonnet` — Switch to the latest Sonnet
- `/model opus 4.5` — Switch to a specific version
- `/model claude-opus-4-6` — Use a raw model ID

Switching models closes the active container and clears all sessions (resumed SDK sessions lock to their original model). The new model takes effect on the next message.

## Phase 1: Pre-flight

Check if this skill has already been applied:

```bash
grep -q 'MODEL_MAP' src/index.ts && echo "ALREADY APPLIED" || echo "NOT APPLIED"
```

If already applied, stop and tell the user.

## Phase 2: Apply Code Changes

This skill modifies 4 existing files. No new files or npm dependencies are needed.

Read each intent file in `modify/` for the exact changes. Apply them in this order:

### 2.1 `src/db.ts` — Model override persistence

Add two accessor functions that store the model override in the existing `router_state` table.

See: `modify/src/db.ts.intent.md`

### 2.2 `src/container-runner.ts` — Pass model to container

Add `model?: string` to the `ContainerInput` interface so the host can pass the selected model to the container.

See: `modify/src/container-runner.ts.intent.md`

### 2.3 `container/agent-runner/src/index.ts` — Use model in agent

Add `model?: string` to the agent-runner's `ContainerInput` interface, pass it to the SDK's `options.model`, and inject a `[SYSTEM: ...]` line into the prompt so the agent knows which model it's running on.

See: `modify/container/agent-runner/src/index.ts.intent.md`

### 2.4 `src/index.ts` — Command handling and interception

This is the largest change. Add:
- `MODEL_MAP` and `MODEL_LATEST` constants
- `resolveModelName()`, `friendlyModelName()`, `handleModelCommand()` functions
- Import `getModelOverride`, `setModelOverride`, `clearAllSessions` from `./db.js`
- Pass `model: getModelOverride()` when building `ContainerInput` in `runAgent()`
- Intercept `/model` in **both** `processGroupMessages()` and `startMessageLoop()`

See: `modify/src/index.ts.intent.md`

## Phase 3: Verify

1. Build the project:
   ```bash
   npm run build
   ```

2. Restart the service:
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
   launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
   ```

3. Send `/model` in your chat — it should reply with the current model.

4. Send `/model haiku` — it should confirm the switch.

5. Send a test message — the agent should respond using the new model.

## Troubleshooting

### Model ID not recognized

The model IDs in `MODEL_MAP` must match what the Claude CLI installed in the container actually supports. To check available models:

```bash
docker run --rm nanoclaw-agent grep -o 'claude-[a-z0-9-]*' /usr/local/bin/claude | sort -u
```

If a new model isn't listed, rebuild the container with `--no-cache` to pull a fresh CLI:

```bash
docker build --no-cache -t nanoclaw-agent container/
```

### Model doesn't actually change

Resumed SDK sessions lock to their original model. The `/model` command handles this by clearing all sessions (`clearAllSessions()`), but if you're seeing stale behavior:

1. Send `/new` to clear the session manually
2. Check that `handleModelCommand` calls both `queue.closeStdin()` AND `clearAllSessions()`

### Agent doesn't know its model

The agent can't introspect which model it's running on. The agent-runner injects a `[SYSTEM: You are running on model X]` line at the top of the prompt. If the agent reports the wrong model, check that `container/agent-runner/src/index.ts` is reading `containerInput.model` and prepending it.

## Document Updates

After applying, update `CLAUDE.md` to document the `/model` command under "Runtime Commands":

```markdown
## Runtime Commands

| Command | Purpose |
|---------|---------|
| `/model` | Show current model |
| `/model <name>` | Switch model: `haiku`, `sonnet`, `opus`, `sonnet 4.5`, or raw ID `claude-opus-4-6` |
```

Note: Model override is global (all groups), persisted in SQLite `router_state` table. Switching models clears all sessions.
