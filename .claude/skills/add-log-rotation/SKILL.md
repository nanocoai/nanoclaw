---
name: add-log-rotation
description: Rotate NanoClaw's host logs (logs/nanoclaw.log and logs/nanoclaw.error.log) with logrotate on a systemd timer, so they stop growing without limit. No root needed for a user-level install, no service restart. Linux with systemd only. Use when the logs folder is getting large, when setting up a long-running server, or when the user asks for log rotation.
---

# Add log rotation

The NanoClaw service appends to `logs/nanoclaw.log` and `logs/nanoclaw.error.log` for as long as it runs. This skill rotates both files: an hourly systemd timer runs `logrotate`, which rotates a file once a day or as soon as it passes 50 MB, keeps 14 gzipped archives per file, and truncates in place (`copytruncate`). The service keeps writing to the same file, so it is never restarted or signalled.

Everything is named after this install's service unit (`nanoclaw-v2-<slug>`, from `setup/lib/install-slug.sh`), so each NanoClaw copy on a machine gets its own timer:

| What              | Where                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| Timer and service | `~/.config/systemd/user/nanoclaw-v2-<slug>-logrotate.{timer,service}` (root installs: `/etc/systemd/system/`) |
| logrotate config  | `~/.config/nanoclaw/nanoclaw-v2-<slug>-logrotate.conf`                                                        |
| logrotate state   | `~/.local/state/nanoclaw/nanoclaw-v2-<slug>-logrotate.status`                                                 |
| Archives          | `logs/nanoclaw.log-YYYYMMDD-HHMMSS.gz`, `logs/nanoclaw.error.log-YYYYMMDD-HHMMSS.gz`                          |

## Requirements

Linux with systemd, the same setup `setup/service.ts` uses for the service itself, and `logrotate`:

```bash
command -v logrotate || ls /usr/sbin/logrotate
```

If neither prints a path, install it (`sudo apt install logrotate` or `sudo dnf install logrotate`). On macOS, or on Linux without systemd (the nohup fallback), stop here and tell the user this skill does not support their platform.

## Install

Run as the user the NanoClaw service runs as (root only if the service is a system unit), from the project root:

```bash
bash .claude/skills/add-log-rotation/scripts/log-rotation.sh install
```

It writes the config, checks it with a `logrotate --debug` dry run, and only then writes and enables the timer. Running it again rewrites the same files, so it is also the way to repair or refresh an install. The last lines it prints list the timer with its next run time.

## Check it

```bash
bash .claude/skills/add-log-rotation/scripts/log-rotation.sh status
pnpm exec vitest run .claude/skills/add-log-rotation
```

`status` shows the timer and the last run. The test confirms that the files the config rotates are the ones the service unit appends to, that the timer is named after the install's unit, and, where `logrotate` is installed, that a writer in append mode keeps going after a rotation.

To rotate right away instead of waiting for the next hourly check, start the service by hand, then look for a `.gz` archive in `logs/`:

```bash
systemctl --user start "$(bash -c 'source setup/lib/install-slug.sh; systemd_unit')-logrotate.service"
ls logs/
```

A file is only rotated once it is a day old or over 50 MB, so a fresh install may show no archive yet. That is expected.

## Change the schedule

Edit `rotate`, `maxsize` or `daily` in `.claude/skills/add-log-rotation/scripts/log-rotation.sh` (`render_conf`), then run `install` again.

## Troubleshooting

- **`no systemd user manager is reachable from this shell`**: the shell has no user systemd session, which happens with `su`, `sudo -u`, or a cron job. Log in as that user directly (SSH or a console), or run `loginctl enable-linger <user>` once and retry.
- **`logrotate rejected the generated config`**: the dry-run output above that message names the problem. Nothing was changed.
- **No archives after several days**: run `journalctl --user -u nanoclaw-v2-<slug>-logrotate.service -n 20` to see logrotate's own messages.

Remove with [REMOVE.md](REMOVE.md).
