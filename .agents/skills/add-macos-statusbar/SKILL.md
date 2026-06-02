---
name: add-macos-statusbar
description: Add a macOS menu bar status indicator for NanoClaw. Shows a bolt icon with a green/red dot indicating whether NanoClaw is running, with Start, Stop, and Restart controls. macOS only.
---

# Add macOS Menu Bar Status Indicator

Adds a persistent menu bar icon that shows NanoClaw's running status and lets the user
start, stop, or restart the service — similar to how Docker Desktop appears in the menu bar.

**macOS only.** Requires Xcode Command Line Tools (`swiftc`).

## Phase 1: Pre-flight

### Check platform

If not on macOS, stop and tell the user:

> This skill is macOS only. The menu bar status indicator uses AppKit and requires `swiftc` (Xcode Command Line Tools).

### Check for swiftc

```bash
which swiftc
```

If not found, tell the user:

> Xcode Command Line Tools are required. Install them by running:
>
> ```bash
> xcode-select --install
> ```
>
> Then re-run `/add-macos-statusbar`.

### Check if already installed

```bash
launchctl list | grep com.nanoclaw.statusbar
```

If it returns a PID (not `-`), tell the user it's already installed and skip to Phase 3 (Verify).

## Phase 2: Compile and Install

### Compile the Swift binary

The source lives in the skill directory. Compile it into `dist/`:

```bash
mkdir -p dist
swiftc -O -o dist/statusbar "${CLAUDE_SKILL_DIR}/add/src/statusbar.swift"
```

This produces a small native binary at `dist/statusbar`.

On macOS Sequoia or later, clear the quarantine attribute so the binary can run:

```bash
xattr -cr dist/statusbar
```

### Create the launchd plist

Determine the absolute project root and home directory:

```bash
pwd
echo $HOME
```

Create `~/Library/LaunchAgents/com.nanoclaw.statusbar.plist`, substituting the actual values
for `{PROJECT_ROOT}` and `{HOME}`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.statusbar</string>
    <key>ProgramArguments</key>
    <array>
        <string>{PROJECT_ROOT}/dist/statusbar</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>{HOME}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>{PROJECT_ROOT}/logs/statusbar.log</string>
    <key>StandardErrorPath</key>
    <string>{PROJECT_ROOT}/logs/statusbar.error.log</string>
</dict>
</plist>
```

### Load the service

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.statusbar.plist
```

## Phase 3: Verify

```bash
launchctl list | grep com.nanoclaw.statusbar
```

The first column should show a PID (not `-`).

Tell the user:

> The bolt icon should now appear in your macOS menu bar. Click it to see NanoClaw's status and control the service.
>
> - **Green dot** — NanoClaw is running
> - **Red dot** — NanoClaw is stopped
>
> Use **Restart** after making code changes, and **View Logs** to open the log file directly.

## Removal

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.statusbar.plist
rm ~/Library/LaunchAgents/com.nanoclaw.statusbar.plist
rm dist/statusbar
```
