---
name: add-dropbox
description: Add Dropbox integration to NanoClaw using rclone. Enables file listing, upload, download, and sharing from the agent container. Guides through Dropbox API app creation, rclone configuration, and container rebuild.
---

# Add Dropbox Integration

This skill sets up Dropbox access using [rclone](https://rclone.org/). The `rclone` CLI is already installed in the agent container — this skill configures authentication on the host so credentials are mounted into containers.

## Important: Headless / Ubuntu Notes

- This server is **Ubuntu on Hetzner**, not macOS. Use `systemctl --user` not `launchctl`.
- The `rclone config` flow requires **interactive stdin** — Claude Code can't handle this. Tell the user to run config commands in a **separate SSH session**.

## Step 1: Check Existing Setup

```bash
which rclone 2>/dev/null && rclone --version | head -1 || echo "rclone not installed on host"
ls ~/.config/rclone/rclone.conf 2>/dev/null && echo "Config exists" || echo "No rclone config found"
```

If `rclone` is already installed and a Dropbox remote is configured, skip to **Step 5: Test**.

## Step 2: Install rclone on Host

```bash
curl https://rclone.org/install.sh | sudo bash
```

Or via package manager:

```bash
sudo apt install rclone
```

Verify:

```bash
rclone --version | head -1
```

## Step 3: Create Dropbox API App

**USER ACTION REQUIRED**

Guide the user through Dropbox app creation:

> 1. Open https://www.dropbox.com/developers/apps
> 2. Click **Create app**
> 3. Choose **Scoped access**
> 4. Choose **Full Dropbox** access
> 5. Name it something like "NanoClaw-rclone"
> 6. Click **Create app**
> 7. On the app settings page, note the **App key** and **App secret**
> 8. Under **Permissions** tab, enable the scopes you need:
>    - `files.metadata.read`, `files.metadata.write`
>    - `files.content.read`, `files.content.write`
>    - `sharing.read`, `sharing.write`
> 9. Click **Submit** to save permissions

## Step 4: Configure rclone

**USER ACTION REQUIRED — must run in separate SSH session**

The `rclone config` command needs interactive stdin. Claude Code cannot do this because:
- The command walks through a multi-step interactive wizard
- The user must paste the app key/secret and authorize via browser

Tell the user to run in a **separate SSH session**:

```bash
rclone config
```

The flow:
1. Choose `n` for new remote
2. Name it `dropbox`
3. Choose `dropbox` as the storage type
4. Enter the **App key** from Step 3
5. Enter the **App secret** from Step 3
6. Choose the default for advanced config (No)
7. For headless auth, choose `N` for auto config
8. rclone prints an auth URL — open in browser, authorize, copy the token code
9. Paste the token code back into the terminal
10. Confirm with `y`

After configuration, verify the config file exists:

```bash
ls -la ~/.config/rclone/rclone.conf
```

## Step 5: Test on Host

```bash
rclone lsd dropbox: 2>&1 | head -20
rclone ls dropbox: --max-depth 1 2>&1 | head -20
```

If tests fail, check:
- `rclone listremotes` — should show `dropbox:`
- Re-run `rclone config` in SSH to reconfigure
- Ensure the Dropbox app has the correct permissions enabled

## Step 6: Rebuild Container and Restart

```bash
cd container && ./build.sh
cd .. && npm run build
```

Restart the service (Ubuntu systemd):

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user restart nanoclaw
sleep 2 && systemctl --user status nanoclaw
```

## Step 7: Test in Container

Tell the user:

> Dropbox integration is set up! Test it by sending a message in your WhatsApp main channel:
>
> - "List my Dropbox files"
> - "What's in my Dropbox?"
> - "Download file.txt from my Dropbox"

---

## Troubleshooting

### Token refresh fails in container
- Ensure `~/.config/rclone` is mounted read-write (check `container-runner.ts`)
- Run `rclone about dropbox:` on host to verify auth works

### "Failed to create file system" errors
- Run `rclone listremotes` on host — should show `dropbox:`
- Re-run `rclone config` in SSH session to reconfigure

### Permission errors
- Go to https://www.dropbox.com/developers/apps, open your app
- Check the **Permissions** tab — ensure required scopes are enabled
- Re-authorize: `rclone config reconnect dropbox:`

### Re-authorizing
```bash
rclone config reconnect dropbox:  # Run in SSH session
```
No rebuild needed — credentials are mounted.
