# ThymAIos — NanoClaw Bot Settings

## Configuration Summary
| Setting | Value |
|---|---|
| Assistant name | ThymAIos |
| Runtime | Apple Container (v0.10.0) |
| Channel | WhatsApp |
| Bot WhatsApp number | 14042754687 |
| Trigger | Any message (no prefix needed) |
| Service | launchd (auto-starts on login) |

## Useful Commands
```bash
# Watch live logs
tail -f logs/nanoclaw.log

# Restart the service
launchctl stop nanoclaw && launchctl start nanoclaw

# Update NanoClaw
git pull upstream main && npm install
```

## How to use
Send a WhatsApp message to **+1 404 275 4687** from your personal phone and ThymAIos will respond.

## Project location
`nanoclaw-app/` folder inside your "Set up my Agentic workspace" folder.

---
*Set up on 22 March 2026*
