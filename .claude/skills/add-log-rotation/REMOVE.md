# Remove /add-log-rotation

From the project root, as the same user that installed it:

```bash
bash .claude/skills/add-log-rotation/scripts/log-rotation.sh uninstall
```

This disables the timer and deletes the timer and service units, the logrotate config and the logrotate state file, then reloads systemd. It does not touch `logs/nanoclaw.log` or `logs/nanoclaw.error.log`.

Rotated archives stay in `logs/`. Delete them if the user does not want them:

```bash
rm -f logs/nanoclaw.log-*.gz logs/nanoclaw.error.log-*.gz
```

Run this before `nanoclaw.sh --uninstall` or before deleting the project folder. The uninstall script reads `setup/lib/install-slug.sh` from the project to find the timer's name.
