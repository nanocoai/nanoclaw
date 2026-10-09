# Remove: system-digest

Reverses everything `/system-digest` installs.

## Linux (systemd)

```bash
systemctl --user disable --now nanoclaw-snapshot.timer
rm ~/.config/systemd/user/nanoclaw-snapshot.timer
rm ~/.config/systemd/user/nanoclaw-snapshot.service
systemctl --user daemon-reload
```

## macOS (launchd)

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.snapshot.plist
rm ~/Library/LaunchAgents/com.nanoclaw.snapshot.plist
```

## Snapshot state

```bash
rm -f data/system-digest.json
```

## Script

If `scripts/system-digest.ts` was copied in by this skill (i.e. it did not exist before install):

```bash
rm scripts/system-digest.ts
```

If you customized the script after install, review before deleting.
