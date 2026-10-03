---
name: add-scheduled-update
description: Run /update-nanoclaw unattended on a schedule from the host, via a launchd job (macOS) or a systemd user timer (Linux). A host-side runner takes a lock, applies a dirty-tree policy, skips the run when upstream has nothing new, drives the update controller through a headless coding-agent CLI (Claude Code, Codex, or OpenCode) under a timeout, rolls back or abandons anything left half-done, and can wake a NanoClaw task to report the outcome. Use when the operator wants NanoClaw to keep itself updated overnight.
---

# Add Scheduled Update

Runs the `/update-nanoclaw` transaction on a schedule, with nobody at the keyboard.

The runner lives in this skill's folder (`${CLAUDE_SKILL_DIR}/scripts/scheduled-update.ts`) and
runs on the **host**, not inside an agent container. A container cannot perform the update: cutover
stops and restarts the service through launchd or systemd, rebuilds the agent image through Docker,
and drains every agent container of this install, including the one that would be running it.

Each run:

1. Takes an exclusive lock (`logs/scheduled-update.lock`). A second run exits immediately; a lock
   left by a dead process is taken over.
2. Stops with `blocked` if an earlier update transaction is still open (conflict, prepared,
   validated, or cutover). It never races an operator's interactive update.
3. Applies the dirty-tree policy: `refuse` (default) reports the uncommitted files and stops;
   `commit` commits them and re-stamps the upgrade marker so the host still starts.
4. Fetches the official upstream remote and stops with `up-to-date` when nothing is pending. No
   agent runs and no tokens are spent.
5. Runs the chosen coding-agent CLI headlessly with a prompt to follow
   `.claude/skills/update-nanoclaw/SKILL.md` end to end. The agent drives
   `scripts/update-nanoclaw.ts`; the runner does not reimplement it.
6. Kills the agent's whole process group when the timeout expires.
7. Settles the transaction the run started. If the agent left it open, the runner calls the
   controller: `rollback` when cutover had already snapshotted the live install, `abandon` when it
   had not. The live install ends every run on the new version or the old one.
8. Probes the service with `bin/ncl groups list`, writes `logs/scheduled-update.last.json`, and
   optionally appends the outcome to a NanoClaw task's run log and fires that task.

Statuses: `up-to-date`, `updated`, `rolled-back`, `abandoned`, `blocked`, `failed`.

## Phase 1: Pre-flight

Run everything from the NanoClaw project root on the host.

### Service mode

The update controller restarts NanoClaw through the service manager it detects. This skill
supports installs whose NanoClaw service runs under launchd (macOS) or user-level systemd (Linux).
For a system-level systemd service, see Troubleshooting. An install started by hand (`pnpm dev`,
nohup) is not supported: the controller refuses cutover while an unmanaged host is running.

### Upstream remote

The runner uses the same remote the update skill uses: `upstream`, or `origin` when `origin` is
`nanocoai/nanoclaw`. It never adds a remote. Check:

```bash
git remote -v
```

If neither exists, run `/update-nanoclaw` interactively once first. It adds `upstream`.

### Coding-agent CLI

Detect which supported CLIs are installed:

```bash
for cli in claude codex opencode; do command -v "$cli" >/dev/null && echo "$cli: $(command -v "$cli")"; done
```

The chosen CLI must already be authenticated for non-interactive use by the user the schedule runs
as (its own login or its own config file). Do not put API keys in the launchd plist or systemd
unit. Confirm it runs headlessly, for example `claude -p "reply with ok"`, `codex exec "reply with
ok"`, or `opencode run "reply with ok"`.

Each CLI runs with its permission prompts bypassed, because nobody is there to answer them:

| CLI | Invocation |
|-----|------------|
| `claude` | `claude -p <prompt> --permission-mode bypassPermissions [--model <model>]` |
| `codex` | `codex exec --dangerously-bypass-approvals-and-sandbox [-m <model>] <prompt>` |
| `opencode` | `opencode run --auto [-m <provider/model>] <prompt>` |

Tell the operator this plainly before continuing: the scheduled agent can run any command as their
user, the same as an interactive `/update-nanoclaw` session with every prompt approved.

## Phase 2: Choose settings

Ask the operator for each value:

- **Schedule**: when to run. Default: daily at 04:00 local time. Pick a quiet time; cutover stops
  agent containers mid-turn.
- **Agent CLI**: `claude`, `codex`, or `opencode`, from the installed ones.
- **Model**: optional. Leave unset to use the CLI's own default. When set, it is passed verbatim to
  the CLI's model flag. Pick a model strong enough to resolve merge conflicts and follow a long
  skill.
- **Timeout**: minutes before the agent is killed. Default: 120. Validation runs the full host test
  suite and can rebuild the agent image, so do not go much lower.
- **Dirty tree**: `refuse` (default) or `commit`. Explain: `refuse` skips the run and reports the
  uncommitted files; `commit` stages everything not ignored by `.gitignore` into one commit before
  updating. Only choose `commit` when uncommitted edits in this checkout are always meant to be
  kept.
- **Reporter task**: optional. A NanoClaw scheduled task to wake after each run. List candidates
  with `bin/ncl tasks list`. The runner appends a one-line summary to that task's run log
  (`bin/ncl tasks append-log`), then fires it once (`bin/ncl tasks run`), so the task can read the
  line and tell the operator. Record its series id and, if needed to disambiguate, its agent
  group id.

## Phase 3: Write the config

Write `.nanoclaw/scheduled-update.json` (git-ignored). Include only the keys the operator set;
omitted keys take the defaults above:

```json
{
  "agent": "claude",
  "model": "<model, or omit this key>",
  "timeoutMinutes": 120,
  "dirtyTree": "refuse",
  "reporterTask": "<series id, or omit this key>",
  "reporterGroup": "<agent group id, or omit this key>"
}
```

Changing a setting later only means editing this file; the scheduler does not need reinstalling.

## Phase 4: Install the scheduler

Collect the values the unit files need:

```bash
PROJECT_ROOT="$(pwd -P)"
RUNNER="${CLAUDE_SKILL_DIR}/scripts/scheduled-update.ts"
NAME="$(pnpm exec tsx "$RUNNER" label)"
PNPM="$(command -v pnpm)"
AGENT_CLI="$(command -v <chosen-cli>)"
RUN_PATH="$(printf '%s\n' "$(dirname "$PNPM")" "$(dirname "$(command -v node)")" \
  "$(dirname "$(command -v git)")" "$(dirname "$(command -v docker)")" "$(dirname "$AGENT_CLI")" \
  /usr/local/bin /usr/bin /bin /usr/sbin /sbin | awk '!seen[$0]++' | paste -sd: -)"
echo "$PROJECT_ROOT $RUNNER $NAME $PNPM $HOME $RUN_PATH"
```

`RUNNER` must resolve inside `$PROJECT_ROOT/.claude/skills/`. Substitute the printed values for the
`{…}` placeholders below.

### macOS (launchd)

Write `~/Library/LaunchAgents/com.{NAME}.plist`. For the default schedule use `Hour` 4, `Minute` 0.
For a weekly run, add a `Weekday` key (0 = Sunday) to `StartCalendarInterval`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.{NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{PNPM}</string>
        <string>exec</string>
        <string>tsx</string>
        <string>{RUNNER}</string>
        <string>run</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{PROJECT_ROOT}</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>{HOUR}</integer>
        <key>Minute</key>
        <integer>{MINUTE}</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{RUN_PATH}</string>
        <key>HOME</key>
        <string>{HOME}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>{PROJECT_ROOT}/logs/scheduled-update.launchd.log</string>
    <key>StandardErrorPath</key>
    <string>{PROJECT_ROOT}/logs/scheduled-update.launchd.log</string>
</dict>
</plist>
```

Load it, replacing any earlier copy:

```bash
launchctl bootout "gui/$(id -u)/com.$NAME" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.$NAME.plist
```

### Linux (systemd user timer)

Write `~/.config/systemd/user/{NAME}.service`:

```ini
[Unit]
Description=NanoClaw scheduled update

[Service]
Type=oneshot
WorkingDirectory={PROJECT_ROOT}
Environment=PATH={RUN_PATH}
ExecStart={PNPM} exec tsx {RUNNER} run
TimeoutStartSec=infinity
```

The runner enforces its own timeout, so systemd's is disabled.

Write `~/.config/systemd/user/{NAME}.timer`. For the default schedule use
`OnCalendar=*-*-* 04:00:00`; for weekly, for example `OnCalendar=Sun *-*-* 04:00:00`:

```ini
[Unit]
Description=NanoClaw scheduled update timer

[Timer]
OnCalendar={ON_CALENDAR}
Persistent=true

[Install]
WantedBy=timers.target
```

Enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now "$NAME.timer"
loginctl enable-linger "$USER"
```

`enable-linger` lets the timer fire while the operator is logged out.

## Phase 5: Verify

Run the shipped tests. They drive the runner against real git repositories and read transaction
state through the real update controller (`loadState`), so they fail if the controller's state
layout drifts:

```bash
pnpm exec vitest run "${CLAUDE_SKILL_DIR}/scripts"
```

Then trigger one run now instead of waiting for the schedule:

```bash
launchctl kickstart "gui/$(id -u)/com.$NAME"   # macOS
systemctl --user start "$NAME.service"         # Linux (blocks until the run ends)
```

When `logs/scheduled-update.lock` is gone, read the result:

```bash
cat logs/scheduled-update.last.json
```

`up-to-date` or `blocked` with a clear reason proves the wiring. When upstream has pending commits,
this verification run performs a real update; tell the operator before triggering it. Show the
operator the result and where to watch future runs.

## Operating it

| What | Where |
|------|-------|
| Last outcome | `logs/scheduled-update.last.json` |
| Runner events, one line each | `logs/scheduled-update.log` |
| Last agent transcript | `logs/scheduled-update.agent.log` |
| Scheduler stdout/stderr (macOS) | `logs/scheduled-update.launchd.log` |
| Scheduler stdout/stderr (Linux) | `journalctl --user -u $NAME.service` |

After an `updated` run the transaction's backup branch, tag, and mutable-state snapshot are kept, as
with an interactive update. Roll back with
`pnpm exec tsx scripts/update-nanoclaw.ts rollback --id <transaction id>` (the id is in the result
file). The scheduled run never prunes old transactions; prune them with `/update-nanoclaw` when
convenient.

To change the schedule, edit the plist or timer and repeat the load/enable step. To remove
everything, follow [REMOVE.md](REMOVE.md).

## Troubleshooting

**`blocked: update transaction … is in phase …`.** An earlier update, interactive or scheduled,
is still open. Finish or abandon it through `/update-nanoclaw`; the next scheduled run proceeds.

**`blocked: working tree has uncommitted changes`.** The `refuse` policy did its job. Commit or
discard the listed files, or switch `dirtyTree` to `commit`.

**`failed: … without starting an update`.** The agent never prepared a transaction. Read
`logs/scheduled-update.agent.log`: usually the CLI is not on `PATH` inside the job, is not logged
in for non-interactive use, or rejected the model name. Rebuild `RUN_PATH` from Phase 4 if a tool
moved.

**Timeouts.** A run that times out is settled like any other: rolled back after cutover began,
abandoned before. If validation is legitimately slow, raise `timeoutMinutes`.

**`serviceHealthy: false`.** `bin/ncl groups list` failed after the run. Check the NanoClaw service
first (`launchctl print gui/$(id -u)/<service label>` or `systemctl --user status <service unit>`),
then `pnpm exec tsx scripts/update-nanoclaw.ts status --id <transaction id>`.

**Commit policy fails.** The pre-update commit needs a git identity (`git config user.name` and
`user.email`) visible to the scheduled job, and it runs the repository's commit hooks. If a hook
rewrites files, the run fails with `still dirty after the pre-update commit` instead of updating on
top of an unexpected tree.

**System-level systemd service.** When NanoClaw runs as a system unit, install the service and timer
under `/etc/systemd/system/` with `User=<the NanoClaw user>` and manage them with `sudo systemctl`
instead of `systemctl --user`. The runner then needs the same privileges the controller uses to
restart that unit.
