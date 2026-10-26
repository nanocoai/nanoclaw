---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install NanoClaw, configure it, or go through first-time setup. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Tell the user to run `bash nanoclaw.sh` in their terminal. That script handles the full end-to-end setup; this skill's job is to point them at it and help them recover from common stumbles.

## What `bash nanoclaw.sh` does

The setup script runs through the following phases in order:

1. **Dependencies:** installs the OS-level packages NanoClaw needs (Docker / Podman, `jq`, `curl`, `python3`).
2. **Container image:** pulls (or builds, on first run) the NanoClaw agent container image.
3. **OneCLI vault:** initialises the OneCLI Agent Vault for credentials. See `.claude/skills/init-onecli/SKILL.md` for the vault details.
4. **Anthropic credential:** prompts for an `ANTHROPIC_API_KEY` and stores it in the vault.
5. **Service:** starts the NanoClaw host process and binds it to the local port (see `init-onecli/SKILL.md` for the port).
6. **First agent:** registers an example agent so the user has something runnable after setup.
7. **Channels (optional):** prompts the user to wire up Telegram / Slack / Discord if they want a chat-driven interface.

## When the script stops partway through

If `nanoclaw.sh` errors out mid-run, it offers **Claude-assisted recovery inline**: the script writes a `setup-state.json` snapshot, and re-running `bash nanoclaw.sh` resumes from the last successful phase. Common failure points and their resolutions:

- **Phase 1 (dependencies):** the script reports the package manager it could not invoke. Install the missing tool manually and re-run.
- **Phase 2 (container image):** image pull/build failed. Check Docker / Podman is running with `docker ps` (or `podman ps`) and re-run.
- **Phase 3 (vault):** vault initialisation failed. Delete `~/.nanoclaw/vault` and re-run; the script will recreate it.
- **Phase 4 (Anthropic credential):** invalid API key. Generate a new key at https://console.anthropic.com/settings/keys and re-run.

## After setup completes

Verify the service is running:

```
curl -s localhost:$NANOCLAW_PORT/health
```

If you get a JSON `{"status":"ok"}` response, setup is done and you can move on to adding more agents or channels.
