---
name: init-onecli
description: Install and initialize OneCLI Agent Vault. Migrates existing .env credentials to the vault. Use after /update-nanoclaw brings in OneCLI as a breaking change, or for first-time OneCLI setup.
---

# Initialize OneCLI Agent Vault

This skill installs OneCLI, configures the Agent Vault gateway, and migrates any existing `.env` credentials into it. Run this after `/update-nanoclaw` introduces OneCLI as a breaking change, or any time OneCLI needs to be set up from scratch.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. pasting a token).

## Phase 1: Pre-flight

### Check if OneCLI is already working

```bash
onecli version 2>/dev/null
```

If the command succeeds, OneCLI is installed, check for an Anthropic secret:

```bash
onecli secrets list
```

If an Anthropic secret exists, tell the user OneCLI is already configured and working. Use AskUserQuestion:

1. **Keep current setup** — description: "OneCLI is installed and has credentials configured. Nothing to do."
2. **Reconfigure** — description: "Start fresh — reinstall OneCLI and re-register credentials."

If they choose to keep, skip to Phase 5 (Verify). If they choose to reconfigure, continue.

### Check for native credential proxy

```bash
grep "credential-proxy" src/index.ts 2>/dev/null
```

If `startCredentialProxy` is imported, the native credential proxy skill is active. Tell the user: "You're currently using the native credential proxy (`.env`-based). This skill will switch you to OneCLI's Agent Vault, which adds per-agent policies and rate limits. Your `.env` credentials will be migrated to the vault."

Use AskUserQuestion:
1. **Continue** — description: "Switch to OneCLI Agent Vault."
2. **Cancel** — description: "Keep the native credential proxy."

If they cancel, stop.

### Check the codebase expects OneCLI

```bash
grep "@onecli-sh/sdk" package.json
```

If `@onecli-sh/sdk` is NOT in package.json, the codebase hasn't been updated to use OneCLI yet. Tell the user to run `/update-nanoclaw` first to get the OneCLI integration, then retry `/init-onecli`. Stop here.

## Phase 2: Install OneCLI

### Install the gateway and CLI

```bash
curl -fsSL onecli.sh/install | sh
curl -fsSL onecli.sh/cli/install | sh
```

Verify: `onecli version`

If the command is not found, the CLI was likely installed to `~/.local/bin/`. Add it to PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
grep -q '.local/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
grep -q '.local/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Re-verify with `onecli version`.

### Configure the CLI

Point the CLI at the local OneCLI instance, the ONECLI_URL was output from the install script above:

```bash
onecli config set api-host ${ONECLI_URL}
```

### Set ONECLI_URL in .env

```bash
grep -q 'ONECLI_URL' .env 2>/dev/null || echo 'ONECLI_URL=${ONECLI_URL}' >> .env
```

### Wait for gateway readiness

The gateway may take a moment to start after installation. Poll for up to 15 seconds:

```bash
for i in $(seq 1 15); do
  curl -sf ${ONECLI_URL}/health && break
  sleep 1
done
```

If it never becomes healthy, check if the gateway process is running:

```bash
ps aux | grep -i onecli | grep -v grep
```

If it's not running, try starting it manually: `onecli start`. If that fails, show the error and stop — the user needs to debug their OneCLI installation.

## Phase 3: Migrate existing credentials

### Scan .env for credentials to migrate

Read the `.env` file and look for these credential variables:

| .env variable | OneCLI secret type | Host pattern |
|---|---|---|
| `ANTHROPIC_API_KEY` | `anthropic` | `api.anthropic.com` |
| `CLAUDE_CODE_OAUTH_TOKEN` | `anthropic` | `api.anthropic.com` |
| `ANTHROPIC_AUTH_TOKEN` | `anthropic` | `api.anthropic.com` |

Read `.env`:

```bash
cat .env
```

Parse the file for any of the credential variables listed above.

### If credentials found in .env

For each credential found, migrate it to OneCLI:

**Anthropic API key** (`ANTHROPIC_API_KEY=sk-ant-...`):
```bash
onecli secrets create --name Anthropic --type anthropic --value <key> --host-pattern api.anthropic.com
```

**Claude OAuth token** (`CLAUDE_CODE_OAUTH_TOKEN=...` or `ANTHROPIC_AUTH_TOKEN=...`):
```bash
onecli secrets create --name Anthropic --type anthropic --value <token> --host-pattern api.anthropic.com
```

After successful migration, remove the credential lines from `.env`. Use the Edit tool to remove only the credential variable lines (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`). Keep all other `.env` entries intact (e.g. `ONECLI_URL`, `TELEGRAM_BOT_TOKEN`, channel tokens).

Verify the secret was registered:
```bash
onecli secrets list
```

Tell the user: "Migrated your Anthropic credentials from `.env` to the OneCLI Agent Vault. The raw keys have been removed from `.env` — they're now managed by OneCLI and will be injected at request time without entering containers."

### Offer to migrate other container-facing credentials

After handling Anthropic credentials (whether migrated or freshly registered), scan `.env` again for remaining credential variables that containers use for outbound API calls.

**Important:** Only migrate credentials that containers use via outbound HTTPS. Channel tokens (`TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `DISCORD_BOT_TOKEN`) are used by the NanoClaw host process to connect to messaging platforms — they must stay in `.env`.

Known container-facing credentials:

| .env variable | Secret name | Host pattern |
|---|---|---|
| `OPENAI_API_KEY` | `OpenAI` | `api.openai.com` |
| `PARALLEL_API_KEY` | `Parallel` | `api.parallel.ai` |

If any of these are found with non-empty values, present them to the user:

AskUserQuestion (multiSelect): "These credentials are used by container agents for outbound API calls. Moving them to the vault means agents never see the raw keys, and you can apply rate limits and policies."

- One option per credential found (e.g., "OPENAI_API_KEY" — description: "Used by voice transcription and other OpenAI integrations inside containers")
- **Skip — keep them in .env** — description: "Leave these in .env for now. You can move them later."

For each credential the user selects:

```bash
onecli secrets create --name <SecretName> --type api_key --value <value> --host-pattern <host>
```

If there are credential variables not in the table above that look container-facing (i.e. not a channel token), ask the user: "Is `<VARIABLE_NAME>` used by agents inside containers? If so, what API host does it authenticate against? (e.g., `api.example.com`)" — then migrate accordingly.

After migration, remove the migrated lines from `.env` using the Edit tool. Keep channel tokens and any credentials the user chose not to migrate.

Verify all secrets were registered:
```bash
onecli secrets list
```

### If no credentials found in .env

No migration needed. Proceed to register credentials fresh.

Check if OneCLI already has an Anthropic secret:
```bash
onecli secrets list
```

If an Anthropic secret already exists, skip to Phase 4.

Otherwise, register credentials using the same flow as `/setup`:

AskUserQuestion: Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

1. **Claude subscription (Pro/Max)** — description: "Uses your existing Claude Pro or Max subscription. You'll run `claude setup-token` in another terminal to get your token."
2. **Anthropic API key** — description: "Pay-per-use API key from console.anthropic.com."

#### Subscription path

Tell the user to run `claude setup-token` in another terminal and copy the token it outputs. Do NOT collect the token in chat.

Once they have the token, AskUserQuestion with two options:

1. **Dashboard** — description: "Best if you have a browser on this machine. Open ${ONECLI_URL} and add the secret in the UI. Use type 'anthropic' and paste your token as the value."
2. **CLI** — description: "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_TOKEN --host-pattern api.anthropic.com`"

#### API key path

Tell the user to get an API key from https://console.anthropic.com/settings/keys if they don't have one.

AskUserQuestion with two options:

1. **Dashboard** — description: "Best if you have a browser on this machine. Open ${ONECLI_URL} and add the secret in the UI."
2. **CLI** — description: "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_KEY --host-pattern api.anthropic.com`"

#### After either path

Ask them to let you know when done.

**If the user's response happens to contain a token or key** (starts with `sk-ant-` or looks like a token): handle it gracefully — run the `onecli secrets create` command with that value on their behalf.

**After user confirms:** verify with `onecli secrets list` that an Anthropic secret exists. If not, ask again.

## Phase 4: Build and restart

```bash
pnpm run build
```

If build fails, diagnose and fix. Common issue: `@onecli-sh/sdk` not installed — run `pnpm install` first.

Restart the service.

Run from your NanoClaw project root:

- macOS (launchd): `launchctl kickstart -k gui/$(id -u)/"$(. setup/lib/install-slug.sh && launchd_label)"`
- Linux (systemd): `systemctl --user restart "$(. setup/lib/install-slug.sh && systemd_unit)"`
- WSL/manual: stop and re-run `bash start-nanoclaw.sh`

## Phase 5: Verify

Check logs for successful OneCLI integration:

```bash
tail -30 logs/nanoclaw.log | grep -i "onecli\|gateway"
```

Expected: `OneCLI gateway config applied` messages when containers start.

If the service is running and a channel is configured, tell the user to send a test message to verify the agent responds.

Tell the user:
- OneCLI Agent Vault is now managing credentials
- Agents never see raw API keys — credentials are injected at the gateway level
- To manage secrets: `onecli secrets list`, or open ${ONECLI_URL}
- To add rate limits or policies: `onecli rules create --help`

## Granting secrets to agents (safe merge)

`set-secrets` **replaces** the agent's entire secret list — it never appends. Always read the current list first and merge before calling it. This pattern is canonical across all skills that assign secrets:

```bash
AGENT_ID=$(onecli agents list | jq -r '.data[] | select(.identifier=="<agentGroupId>") | .id')
CURRENT=$(onecli agents secrets --id "$AGENT_ID" | jq -r '[.data[]] | join(",")')
MERGED=$(printf '%s' "$CURRENT,<new-secret-id>" | tr ',' '\n' | sort -u | paste -sd ',' -)
onecli agents set-secrets --id "$AGENT_ID" --secret-ids "$MERGED"
onecli agents secrets --id "$AGENT_ID"
```

- `<agentGroupId>` — the `agentGroupId` field in `groups/<folder>/container.json`
- `<new-secret-id>` — the `id` from `onecli secrets list`
- Multiple new secrets: append them comma-separated before the `printf` step

### git over HTTPS

OneCLI's proxy injects credentials proactively — `injections_applied=1` appears in `docker logs onecli` even when git sends no auth header. However, OneCLI sets `SSL_CERT_FILE` for Node/Python/Deno but not `GIT_SSL_CAINFO`. Without it, git rejects the OneCLI MITM certificate.

**Auth format matters**: GitHub's git smart HTTP protocol (`github.com`) requires `Basic` auth, not `Bearer`. GitHub's REST API (`api.github.com`) accepts `Bearer`. These must be configured as separate secrets with different formats — see `/add-github` for the full setup.

If an agent uses `git` or `gh`, add to `data/v2-sessions/<agent-group-id>/.claude-shared/settings.json`:

```json
"GIT_SSL_CAINFO": "/tmp/onecli-combined-ca.pem",
"GIT_TERMINAL_PROMPT": "0",
"GIT_CONFIG_COUNT": "1",
"GIT_CONFIG_KEY_0": "credential.helper",
"GIT_CONFIG_VALUE_0": "",
"GH_TOKEN": "ghp_onecli_proxy_replaces_this"
```

**Debugging injection**: `docker logs onecli 2>&1 | grep "github.com"` shows every request with `injections_applied=N` and the HTTP status. If `injections_applied=1` but status is still 401, the injected credential value is wrong or uses the wrong auth format for that endpoint.

## Troubleshooting

**"OneCLI gateway not reachable" in logs:** The gateway isn't running. Check with `curl -sf ${ONECLI_URL}/health`. Start it with `onecli start` if needed.

**Container gets no credentials:** Verify `ONECLI_URL` is set in `.env` and the gateway has an Anthropic secret (`onecli secrets list`).

**Old .env credentials still present:** This skill should have removed them. Double-check `.env` for `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_AUTH_TOKEN` and remove them manually if still present.

**Port 10254 already in use:** Another OneCLI instance may be running. Check with `lsof -i :10254` and kill the old process, or configure a different port.
