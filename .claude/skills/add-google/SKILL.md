---
name: add-google
description: Add Google Workspace integration to NanoClaw using gogcli. Covers Gmail, Calendar, Drive, Contacts, Tasks, Docs, Sheets, and more. Supports multiple Google accounts. Guides through GCP OAuth setup, gogcli installation, account authentication, and container rebuild.
---

# Add Google Workspace Integration

This skill sets up comprehensive Google Workspace access using [gogcli](https://github.com/steipete/gogcli). The `gog` CLI is already installed in the agent container — this skill configures authentication on the host so credentials are mounted into containers.

## Important: Headless / Ubuntu Notes

- This server is **Ubuntu on Hetzner**, not macOS. Use `systemctl --user` not `launchctl`.
- All `gog` commands need Homebrew in PATH: `eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"`
- All `gog` commands that access tokens need: `GOG_KEYRING_PASSWORD='...'` prefix
- The `gog auth add --manual` flow requires **interactive stdin** — Claude Code can't pipe redirect URLs because the state/nonce changes each invocation. Tell the user to run auth commands in a **separate SSH session**.

## Step 1: Check Existing Setup

```bash
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"
which gog 2>/dev/null && gog --version || echo "gogcli not installed on host"
ls ~/.config/gogcli/ 2>/dev/null || echo "No gogcli config found"
```

If `gog` is already installed and configured, skip to **Step 6: Test**.

## Step 2: Install gogcli on Host

```bash
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"
brew install steipete/tap/gogcli
```

If Homebrew is not installed:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"' >> ~/.bashrc
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"
```

Verify:

```bash
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)" && gog --version
```

## Step 3: Set Up GCP OAuth Credentials

**USER ACTION REQUIRED**

Guide the user through GCP console setup:

> 1. Open https://console.cloud.google.com
> 2. Create a new project (or select existing)
> 3. Name it something like "NanoClaw" and click **Create**
> 4. Enable APIs: Go to **APIs & Services > Library** and enable:
>    - Gmail API, Google Calendar API, Google Drive API, Google Tasks API, People API
>    - Optional: Google Docs API, Google Sheets API
> 5. Set up OAuth consent screen: **APIs & Services > OAuth consent screen**
>    - Choose **External**, fill in app name and email
>    - **Important**: Under **Test users**, add all email addresses that will be authenticated
> 6. Create credentials: **APIs & Services > Credentials > + CREATE CREDENTIALS > OAuth client ID**
>    - Application type: **Desktop app**
>    - Download the JSON file

### Multiple accounts with different GCP projects

If the user has accounts across different Google Workspace orgs, they may need **separate OAuth clients** (one per GCP project). Use the `--client` flag to store them under named clients:

```bash
# First/default client
gog auth credentials set /path/to/client_secret_default.json

# Additional clients with a name
gog auth credentials set /path/to/client_secret_other.json --client=othername
```

For a single GCP project with one OAuth client, just use:

```bash
gog auth credentials set /path/to/client_secret.json
```

## Step 4: Set Up File-Based Keyring

The file-based keyring allows gogcli to work in headless environments (like the Docker container).

```bash
gog auth keyring file
```

Tell the user:

> Choose a password for the keyring. This will be stored in your `.env` file so the container can decrypt tokens.

Note the password — you'll add it to `.env` in Step 7.

## Step 5: Add Google Accounts

**USER ACTION REQUIRED — must run in separate SSH session**

The `gog auth add --manual` command needs interactive stdin. Claude Code cannot do this because:
- The command generates a unique state/nonce each run
- The user must open the auth URL, authorize, then paste back the redirect URL
- Piping doesn't work since the state in the redirect URL must match the current run

Tell the user to run in a **separate SSH session**:

```bash
# Set up environment first
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"

# For accounts using the default OAuth client:
GOG_KEYRING_PASSWORD='<password>' gog auth add user@example.com --manual --services=all

# For accounts using a named OAuth client:
GOG_KEYRING_PASSWORD='<password>' gog auth add user@other.com --manual --services=all --client=othername
```

The flow:
1. Command prints an auth URL
2. User opens URL in browser, signs in, grants permissions
3. Browser redirects to `localhost:1` which won't load — that's expected
4. User copies the full URL from browser address bar and pastes it back into the terminal

If user gets **Error 400**: they need to add their email as a **test user** in the GCP OAuth consent screen.

After auth succeeds, set up aliases (can run from Claude Code):

```bash
GOG_KEYRING_PASSWORD='<password>' gog auth alias set <alias> <email>
```

There is no `gog auth default` command — the default account is controlled via the `GOG_ACCOUNT` env var in `.env`.

Verify all accounts:

```bash
GOG_KEYRING_PASSWORD='<password>' gog auth list
```

## Step 6: Test on Host

Test each account works:

```bash
GOG_KEYRING_PASSWORD='<password>' gog gmail labels list --account <email-or-alias>
```

For accounts on a named client, add `--client=<name>`:

```bash
GOG_KEYRING_PASSWORD='<password>' gog gmail labels list --account <email> --client=othername
```

If tests fail, check:
- `gog auth list` — account should show as authenticated
- Re-run `gog auth add <email> --manual` in SSH to re-authorize
- Ensure the email is added as a test user in GCP console

## Step 7: Configure Environment

Read the project `.env` file and append the gogcli environment variables:

```
GOG_KEYRING_BACKEND=file
GOG_KEYRING_PASSWORD=<the-keyring-password>
GOG_ACCOUNT=<default-email-or-alias>
```

Use the Edit tool to append to `.env`. Do NOT overwrite existing content.

The `container-runner.ts` already allowlists these three env vars and mounts `~/.config/gogcli/` read-write into the container.

## Step 8: Rebuild Container and Restart

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

## Step 9: Test in Container

Tell the user:

> Google Workspace integration is set up! Test it by sending a message in your WhatsApp main channel:
>
> - "What's on my calendar today?"
> - "Check my recent emails"
> - "List my Google Drive files"

---

## Troubleshooting

### Token refresh fails in container
- Ensure `~/.config/gogcli` is mounted read-write (check `container-runner.ts`)
- Verify `GOG_KEYRING_PASSWORD` and `GOG_KEYRING_BACKEND=file` are in `.env`

### "Account not found" errors
- Run `gog auth list` on host to verify accounts
- Check `GOG_ACCOUNT` in `.env` matches an authenticated account

### Error 400 during OAuth
- Add the email as a **test user** in GCP console: **APIs & Services > OAuth consent screen > Test users**

### Adding more accounts later
- Run `gog auth add <new-email> --manual --services=all` in SSH session
- Optionally: `gog auth alias set <alias> <new-email>`
- Restart NanoClaw — no rebuild needed (credentials are mounted)

### Removing an account
```bash
gog auth remove <email>
```

### Re-authorizing an account
```bash
gog auth add <email> --manual  # Re-runs OAuth flow (in SSH session)
```
