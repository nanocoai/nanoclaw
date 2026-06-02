# NanoTalk Local App Launchers

This note records the local macOS launcher setup for the Roni, Cody, and NanoTalk Dock apps on Sawyer's Mac.

## App Bundle Locations

The Dock apps live outside the repo:

| App | Bundle path | Bundle ID | Executable |
|---|---|---|---|
| Roni | `/Users/songylee/Applications/NanoClaw Bots/Roni.app` | `com.nanoclaw.bots.roni` | `RoniApplet` |
| Cody | `/Users/songylee/Applications/NanoClaw Bots/Cody.app` | `com.nanoclaw.bots.cody` | `CodyApplet` |
| NanoTalk | `/Users/songylee/Applications/NanoClaw Bots/NanoTalk.app` | `com.nanoclaw.bots.nanotalk` | `NanoTalkApplet` |

The unique bundle IDs and executable names are important. If all three apps use the default AppleScript executable name `applet`, Dock and LaunchServices can confuse one launcher for another.

## Source Scripts

The editable AppleScript sources are kept in the repo:

- `scripts/macos-launchers/Roni.applescript`
- `scripts/macos-launchers/Cody.applescript`
- `scripts/macos-launchers/NanoTalk.applescript`

Compile them into the app bundles with:

```bash
osacompile -o '/Users/songylee/Applications/NanoClaw Bots/Roni.app/Contents/Resources/Scripts/main.scpt' scripts/macos-launchers/Roni.applescript
osacompile -o '/Users/songylee/Applications/NanoClaw Bots/Cody.app/Contents/Resources/Scripts/main.scpt' scripts/macos-launchers/Cody.applescript
osacompile -o '/Users/songylee/Applications/NanoClaw Bots/NanoTalk.app/Contents/Resources/Scripts/main.scpt' scripts/macos-launchers/NanoTalk.applescript

codesign --force --deep --sign - '/Users/songylee/Applications/NanoClaw Bots/Roni.app'
codesign --force --deep --sign - '/Users/songylee/Applications/NanoClaw Bots/Cody.app'
codesign --force --deep --sign - '/Users/songylee/Applications/NanoClaw Bots/NanoTalk.app'
```

After changing bundle metadata, refresh LaunchServices and Dock:

```bash
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f \
  '/Users/songylee/Applications/NanoClaw Bots/Roni.app' \
  '/Users/songylee/Applications/NanoClaw Bots/Cody.app' \
  '/Users/songylee/Applications/NanoClaw Bots/NanoTalk.app'

killall Dock
```

## Launcher Behavior

Roni opens or focuses:

```text
https://web.telegram.org/k/#@sawyer_nc_bot
```

Cody opens or focuses:

```text
https://web.telegram.org/k/#@sawyer_cody_bot
```

NanoTalk opens or focuses:

```text
http://127.0.0.1:4377
```

The launchers first try to reuse an existing Chrome app window. If no matching window is found, they create a new Chrome app window. They intentionally quit after launch/focus, so Dock running-indicator dots do not appear for these launcher apps. Chrome is the long-running process.

NanoTalk also starts the local dashboard server if needed:

```text
/opt/homebrew/opt/node@22/bin/node /Users/songylee/nanoclaw/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs /Users/songylee/nanoclaw/scripts/roni-cody-dashboard.ts
```

The health check uses `http://127.0.0.1:4377/` with a short timeout so the launcher does not hang on the slower dashboard API.

## NanoTalk Data Model

The dashboard is implemented in:

```text
scripts/roni-cody-dashboard.ts
```

It merges agent-to-agent messages from both local and remote NanoClaw data sources:

- Local source: `/Users/songylee/nanoclaw/data`
- Remote cache: `/Users/songylee/nanoclaw/data/nanotalk-cache/remote`
- Remote origin: `root@5.78.42.198:/opt/nanoclaw`

The important behavior is that Roni and Cody do not need to exist in the same `v2.db`. In the current setup, local data may contain Cody while the remote cache may contain Roni. The dashboard discovers Roni and Cody across all configured sources, then reads `agent` channel messages from each side's session DBs.

Quick API check:

```bash
curl -fsS http://127.0.0.1:4377/api/dashboard
```

Expected summary after the 2026-05-30 fix:

```text
total=74
roniToCody=36
codyToRoni=38
errors=Server:none | Local Mac:none
```

## Verification Commands

Check bundle metadata:

```bash
for app in Roni Cody NanoTalk; do
  /usr/libexec/PlistBuddy \
    -c 'Print :CFBundleIdentifier' \
    -c 'Print :CFBundleExecutable' \
    "/Users/songylee/Applications/NanoClaw Bots/$app.app/Contents/Info.plist"
done
```

Check launcher routing:

```bash
open '/Users/songylee/Applications/NanoClaw Bots/Roni.app'
sleep 5
osascript -e 'tell application "Google Chrome" to get URL of active tab of front window'

open '/Users/songylee/Applications/NanoClaw Bots/Cody.app'
sleep 5
osascript -e 'tell application "Google Chrome" to get URL of active tab of front window'
```

Expected URLs:

```text
https://web.telegram.org/k/#@sawyer_nc_bot
https://web.telegram.org/k/#@sawyer_cody_bot
```
