---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install NanoClaw, configure it, or go through first-time setup. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Tell the user to run `bash nanoclaw.sh` in their terminal. That script handles the full end-to-end setup — dependencies, container image, OneCLI vault, Anthropic credential, service, first agent, and optional channel wiring.

If they hit an error partway through, the script offers Claude-assisted recovery inline and resumes from where it stopped.
