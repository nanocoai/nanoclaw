# Remove macOS Menu Bar Status Indicator

Every step is idempotent — safe to re-run.

## 1. Unload the launchd service

Compute the install slug to find the correct plist:

```bash
INSTALL_SLUG=$(echo -n "$(pwd)" | shasum | cut -c1-8)
launchctl bootout gui/$(id -u)/com.nanoclaw-v2-${INSTALL_SLUG}.statusbar 2>/dev/null \
  || launchctl unload ~/Library/LaunchAgents/com.nanoclaw-v2-${INSTALL_SLUG}.statusbar.plist 2>/dev/null \
  || true
```

## 2. Delete the produced files

```bash
INSTALL_SLUG=$(echo -n "$(pwd)" | shasum | cut -c1-8)
rm -f ~/Library/LaunchAgents/com.nanoclaw-v2-${INSTALL_SLUG}.statusbar.plist \
      dist/statusbar \
      logs/statusbar.log \
      logs/statusbar.error.log
```

The menu bar icon disappears once the service is unloaded.
