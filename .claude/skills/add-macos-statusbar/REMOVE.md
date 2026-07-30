# Remove macOS Menu Bar Status Indicator

Every step is idempotent — safe to re-run.

## 1. Unload the launchd service

```bash
launchctl bootout gui/$(id -u)/com.nanoclaw.statusbar 2>/dev/null \
  || launchctl unload ~/Library/LaunchAgents/com.nanoclaw.statusbar.plist 2>/dev/null \
  || true
```

## 2. Delete the produced files

```bash
rm -f ~/Library/LaunchAgents/com.nanoclaw.statusbar.plist \
      dist/statusbar \
      logs/statusbar.log \
      logs/statusbar.error.log
```

The menu bar icon disappears once the service is unloaded.
