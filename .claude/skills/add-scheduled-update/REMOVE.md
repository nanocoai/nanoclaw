# Remove Scheduled Update

Every step is idempotent — safe to re-run. Run from the NanoClaw project root.

## 1. Find the scheduler name

```bash
NAME="$(pnpm exec tsx .claude/skills/add-scheduled-update/scripts/scheduled-update.ts label)"
echo "$NAME"
```

## 2. Stop and delete the scheduler

macOS:

```bash
launchctl bootout "gui/$(id -u)/com.$NAME" 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.$NAME.plist
```

Linux:

```bash
systemctl --user disable --now "$NAME.timer" 2>/dev/null || true
rm -f ~/.config/systemd/user/$NAME.timer ~/.config/systemd/user/$NAME.service
systemctl --user daemon-reload
```

If the units were installed system-wide, run the same commands with `sudo systemctl` against
`/etc/systemd/system/`. Leave `loginctl enable-linger` as it is unless the operator enabled it only
for this skill; then run `loginctl disable-linger "$USER"`.

## 3. Delete the config, lock, and logs

```bash
rm -f .nanoclaw/scheduled-update.json \
      logs/scheduled-update.lock \
      logs/scheduled-update.log \
      logs/scheduled-update.agent.log \
      logs/scheduled-update.last.json \
      logs/scheduled-update.launchd.log
```

Update transactions created by scheduled runs belong to the update controller, not this skill.
Their backup branches, tags, and snapshots stay; prune them through `/update-nanoclaw`.

If a reporter task was set up only to announce scheduled updates, cancel it with
`bin/ncl tasks cancel --id <series id>`.
