---
name: add-clawmetry
description: Add ClawMetry — a read-only local web dashboard that auto-detects NanoClaw's per-session SQLite store and shows transcripts, message activity, and session history at localhost:8900, alongside 20+ other agent runtimes (Claude Code, Codex, Cursor, ...). One pip install, no NanoClaw source changes, nothing leaves the machine by default.
---

# /add-clawmetry — session dashboard for NanoClaw

[ClawMetry](https://github.com/vivekchand/clawmetry) is a local web dashboard
for AI agent runtimes ([NanoClaw guide](https://clawmetry.com/runtimes/nanoclaw)).
It ships a read-only NanoClaw adapter: it finds the per-session SQLite files
under `data/v2-sessions/` on its own and shows transcripts, per-session message
counts, and session history in a browser UI. If other runtimes run on the same
machine (Claude Code, Codex, Cursor, ...), they appear in the same dashboard
with a runtime switcher.

This complements NanoClaw's AI-native approach rather than replacing it: you
still ask Claude Code "why isn't the scheduler running?", but when you want to
*read* a session, scan activity across agents, or check what ran overnight, a
dashboard is faster than asking.

## What it does and does not do

- **Read-only by construction.** The adapter only reads the session store. It
  never writes to NanoClaw's files, patches no source, adds no dependency to
  this repo, and wires into nothing.
- **Local by default.** The dashboard binds localhost. Nothing leaves the
  machine unless you explicitly enable cloud sync (`clawmetry connect`), which
  is end-to-end encrypted (AES-256-GCM, key stays on your machine).
- **Honest about NanoClaw's data.** NanoClaw does not write token costs to
  disk, so ClawMetry shows transcripts and message activity for it, not spend.
- **Pricing note.** The open-source app includes OpenClaw and NemoClaw
  observability free; the NanoClaw adapter (like the other runtimes) needs a
  ClawMetry Cloud account or self-hosted Pro license after the trial. If that
  is not what you want, `/add-dashboard` and `/add-clidash` are the
  self-contained alternatives in this repo.

## Steps

### 1. Install and run

```bash
pip install clawmetry
clawmetry
```

The dashboard opens at `http://localhost:8900`. NanoClaw is auto-detected; no
flags or config needed when running from the machine that hosts NanoClaw.

If NanoClaw runs somewhere non-standard, point ClawMetry at the checkout:

```bash
clawmetry --workspace /path/to/nanoclaw
```

### 2. Verify

Open `http://localhost:8900`, pick **NanoClaw** in the runtime switcher, and
confirm your sessions are listed. The Transcripts tab shows the chat history
read from `data/v2-sessions/`.

### 3. Optional: query it from Claude Code

The dashboard exposes local JSON APIs the agent can read when you ask about
session activity:

| Endpoint | Returns |
|---|---|
| `http://localhost:8900/api/overview` | summary of sessions and health |
| `http://localhost:8900/api/sessions` | session list with metadata |
| `http://localhost:8900/api/transcript/<id>` | one session's transcript |

## Troubleshooting

- **NanoClaw not detected** — run `clawmetry --workspace <nanoclaw-dir>` so the
  adapter can find `data/v2-sessions/`.
- **Port 8900 taken** — `clawmetry --port 8901`.
- **No costs shown for NanoClaw** — expected; NanoClaw does not persist token
  costs, and ClawMetry does not invent numbers it cannot read.

Removal is a single uninstall; see [REMOVE.md](REMOVE.md).
