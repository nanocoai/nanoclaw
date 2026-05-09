---
name: bynet-mind startup instructions
description: How to start the bynet-mind Slack bot agent
type: reference
originSessionId: 1842bc5b-3769-4bf6-bb05-fba7f3fecb3e
---
When user says "להפעיל את האגנט של BYNET-MIND" or similar:

## Start the bot
```bash
cd C:\Users\User\Documents\GitHub\BYNET\bynet-mind
npm run dev
```
Wait for: "bynet-mind connected via Socket Mode"

## Check if already running
```bash
pm2 status
```

## Where to put documents for the bot's brain
```
C:\Users\User\Documents\GitHub\BYNET\bynet-mind\projects\masha\knowledge\
```
Drop any .md, .txt, or .pdf file there — the bot reads them automatically on every question.

Also edit:
```
C:\Users\User\Documents\GitHub\BYNET\bynet-mind\projects\masha\context.md
```
For permanent team/architecture info.

## Pending before full functionality
- Add Anthropic credits at console.anthropic.com/settings/billing
- Slack App: add scopes channels:history + users:read + event message.channels → Reinstall
- Invite @Bynet Mind to mang-prog-status channel
