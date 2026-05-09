---
name: Jira Status Dashboard
description: Live TV dashboard for bynet-mind Jira projects, running via PM2 on port 5050
type: project
originSessionId: 1b5eb382-7076-46a1-abdf-c65680f215cb
---
Built a full-screen Jira status dashboard at `C:\Users\User\Documents\GitHub\nanoclaw\dashboard\`.

**URL:** `http://localhost:5050/jira` (local) or `http://192.168.1.10:5050/jira` (network)

**Files:**
- `dashboard/jira-board.html` — the TV dashboard (3-column: Blockers | In Progress | Milestones)
- `dashboard/server.mjs` — Express server with Jira API integration on port 5050
- `dashboard/pm2.config.cjs` — PM2 config with Jira credentials

**Jira connection:**
- URL: `https://bynet-ts.atlassian.net`
- Email: `shiranlm@bynet-ts.co.il`
- Project: `KAN:1` (MASHA, board ID 1)
- Credentials are in `pm2.config.cjs` env section (same as bynet-mind `.env`)

**Running as service via PM2:**
- `pm2 restart pm2.config.cjs --update-env` — restart with config changes
- `pm2 logs nanoclaw-dashboard` — view logs
- Auto-starts on Windows login via Startup folder bat file

**To add a new project:** add `KEY:boardId` to `JIRA_PROJECTS` in pm2.config.cjs, then restart.

**Pending:** Windows Firewall port 5050 needs to be opened as Admin:
`netsh advfirewall firewall add rule name="NanoClaw Dashboard" dir=in action=allow protocol=TCP localport=5050`

**Why:** Key information: `isLast`-based pagination in new Jira `/search/jql` API (no `total` field) — use agile board API `/rest/agile/1.0/board/{id}/issue` which returns `total`. Blockers detected via `status=BLOCKED OR labels=blocked`. Type detection (HW/SW/Integration) from labels, components, issuetype, and summary keywords.
