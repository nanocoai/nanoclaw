---
name: bynet-mind project
description: Slack bot for Bynet org management — automation + AI agent with memory
type: project
originSessionId: 1842bc5b-3769-4bf6-bb05-fba7f3fecb3e
---
Slack bot for Bynet organizational project management.
Full context: `C:\Users\User\Documents\GitHub\BYNET\bynet-mind\STATUS.md`

**Why:** Replace slow Jira bot with fast Slack slash commands + AI agent that knows the project.

**How to apply:** When user asks about bynet-mind, read STATUS.md first. Project is in `C:\Users\User\Documents\GitHub\BYNET\bynet-mind`.

## What's built
- `/block` — BLOCKED transition + optional "blocks:" Jira link
- `/unblock` — back to In Progress
- `/task` — create Jira issue (title, desc, priority, assignee, due date)
- `/report` — manual weekly report trigger
- Weekly report at 9:00 AM — 5 sections: Blocked, Overdue, Milestones, In Progress, Completed
- `@Bynet Mind` — AI agent (Claude Haiku): reads context.md + knowledge/ + memory/summary.md + live Jira
- Message logger — saves all channel messages to projects/masha/logs/YYYY-MM-DD.jsonl
- Daily summary at 17:00 — Claude summarizes day → managers channel + appends to memory/summary.md

## Key facts
- Socket Mode (no tunnel needed)
- Jira Cloud: bynet-ts.atlassian.net, project KAN, board 1
- BLOCKED transition id=4, In Progress=21, Done=31, To Do=11
- Slack channels: proj-masha=C0AUF7SG09X, mang-prog-status=C0AVDT8KD1S
- PM2 config: ecosystem.config.cjs
- GitHub: github.com/Bynet-testing-system/bynet-mind (user: shiramlm)
- Model: claude-haiku-4-5-20251001 (~$7/month for team of 7)
- dotenv uses override:true (via src/load-env.ts) — .env always wins over system env vars

## Team (MASHA project)
Shiran (SW Engineer), Shmoulik (PM), Alex (Integrator), Yaniv (Systems Engineer), Vimal (Board Designer), Alexei (SW Engineer, drivers)

## Knowledge structure per project
projects/masha/
  context.md       — static team/architecture info (edit manually)
  knowledge/       — drop .md/.txt files here, bot reads them all
  logs/            — auto-generated daily message logs
  memory/summary.md — auto-generated accumulated summaries

## Still needs (Slack App settings)
- Add scopes: channels:history, users:read
- Add event: message.channels
- Reinstall app
- Invite bot to mang-prog-status (/invite @Bynet Mind)
- Add Anthropic credits: console.anthropic.com/settings/billing

## Running
- Dev: `npm run dev` in C:\Users\User\Documents\GitHub\BYNET\bynet-mind
- Production: PM2 (ecosystem.config.cjs) — needs pm2 startup for auto-boot on Windows
