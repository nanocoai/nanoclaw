# ThymAIos — NanoClaw Bot Settings

## Configuration Summary
| Setting | Value |
|---|---|
| Assistant name | ThymAIos |
| Runtime | Apple Container (v0.10.0) |
| Channel | WhatsApp |
| Bot WhatsApp number | 14042754687 |
| Trigger | Any message (no prefix needed) |
| Service | launchd — ⚠️ **currently disabled** (see "Service disabled" below) |

## Useful Commands
```bash
# Watch live logs
tail -f logs/nanoclaw.log

# Restart the service
launchctl stop nanoclaw && launchctl start nanoclaw

# Update NanoClaw
git pull upstream main && npm install
```

## Service disabled (21 June 2026)

The launchd service was **disabled** on 21 June 2026: the WhatsApp session was
logged out (error 401), so the process crash-looped — restarting every ~10s and
bloating `logs/nanoclaw.log` to 484 MB. The loop was stopped, the log truncated,
and the service disabled so it won't auto-start until WhatsApp is re-authenticated.

### To bring it back
```bash
# 1. Re-authenticate WhatsApp (re-scan the QR / pairing code)
npm run auth                                                    # or run /setup

# 2. Re-enable + start the service (a disabled service can't load until enabled)
launchctl enable gui/$(id -u)/com.nanoclaw
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist

# 3. Verify it's running with a STABLE pid
launchctl list | grep nanoclaw    # "<pid> 0 com.nanoclaw" = running
tail -n 15 logs/nanoclaw.log      # should show a healthy WhatsApp connection
```

### Check service status anytime
```bash
launchctl list | grep nanoclaw    # "12345 0 com.nanoclaw" = running · "- 0 …" = stopped · (nothing) = not loaded
pgrep -fl dist/index.js           # run twice ~5s apart: same pid = healthy · changing pid = crash-looping
```

### To stop / disable again
```bash
launchctl bootout  gui/$(id -u)/com.nanoclaw    # stop now
launchctl disable  gui/$(id -u)/com.nanoclaw    # prevent auto-start on login/reboot
```

## How to use
Send a WhatsApp message to **+1 404 275 4687** from your personal phone and ThymAIos will respond.

## Project location
`nanoclaw-app/` folder inside your "Set up my Agentic workspace" folder.

---
*Set up on 22 March 2026*
