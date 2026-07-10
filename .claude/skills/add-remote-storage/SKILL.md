---
name: add-remote-storage
description: Mount remote storage (WebDAV/Nextcloud/ownCloud, or S3-compatible like AWS S3, Cloudflare R2, MinIO, Backblaze B2) into NanoClaw agent containers via rclone + systemd, and assign it to agent groups. Triggers on "remote storage", "nextcloud", "webdav", "s3", "minio", "r2", "bucket", "mount remote files", "cloud storage", "give agents access to my files".
---

# Add Remote Storage

Mount remote storage (a WebDAV share or an S3-compatible bucket) on the host via rclone + systemd, allowlist it, and assign it to agent groups. Agents in assigned groups see the files at `/workspace/extra/<name>/` inside their container.

**Linux with systemd only.** rclone FUSE mounts on macOS require macFUSE and launchd units, which this skill does not cover — check `uname` first and stop with a clear message on non-Linux hosts.

Remote storage has three layers, configured in this order:

1. **Host mount** — a systemd service running `rclone mount` at `/mnt/nanoclaw/<name>`
2. **Allowlist** — the mount root added to `~/.config/nanoclaw/mount-allowlist.json` (the same file `/manage-mounts` owns)
3. **Group assignment** — an `additional_mounts` entry in the group's container config, via `ncl groups config add-mount`

## Use AskUserQuestion

For every step that requires operator input, use the `AskUserQuestion` tool with structured options so the operator can navigate choices with their cursor. Only fall back to free-text when the input is inherently open-ended (URLs, paths, names). One question at a time.

## Setup Flow

### Step 1: Storage Type

Use AskUserQuestion:

- **question:** "What type of remote storage do you want to mount?"
- **header:** "Storage"
- **options:**
  - label: "WebDAV", description: "Nextcloud, ownCloud, or any WebDAV server"
  - label: "S3-compatible", description: "AWS S3, Cloudflare R2, MinIO, Backblaze B2, Wasabi, …"
  - label: "Other rclone backend", description: "SFTP, FTP, … — same flow, pick the type in rclone config (SFTP key auth is set up there too)"

Only Steps 2 and 6 differ per backend; everything else is identical.

Out of scope, and what to say if asked:

- **OAuth-based consumer clouds** (Dropbox, Google Drive, OneDrive): rclone requires a browser-based `rclone authorize` handshake, which needs its own flow — not covered here.
- **NAS shares (SMB/NFS)**: no rclone needed — mount them natively (fstab), then add the path with `/manage-mounts` and assign it with `ncl groups config add-mount`.

### Step 2: Endpoint

**For WebDAV**, use AskUserQuestion:

- **question:** "What's the full WebDAV endpoint URL?"
- **header:** "URL"
- **options:**
  - label: "Nextcloud", description: "https://your-server.com/remote.php/webdav"
  - label: "ownCloud", description: "https://your-server.com/remote.php/dav/files/USERNAME"
  - label: "Other WebDAV", description: "I'll provide the full WebDAV URL"

Based on their selection, ask for the actual URL. Validate it starts with `https://` and contains a path component. If the operator gives an `http://` URL, warn that WebDAV basic-auth credentials and file contents would cross the network in cleartext, and use AskUserQuestion:

- **question:** "That URL is plain HTTP — credentials and files would be sent unencrypted. Proceed anyway?"
- **header:** "Insecure"
- **options:**
  - label: "Use HTTPS instead (Recommended)", description: "I'll provide an https:// URL"
  - label: "Proceed with HTTP", description: "Trusted network only (e.g., LAN or VPN-only server)"

**For S3-compatible**, use AskUserQuestion:

- **question:** "Which S3 provider?"
- **header:** "Provider"
- **options:**
  - label: "AWS S3", description: "I'll provide the region"
  - label: "Cloudflare R2", description: "I'll provide the account endpoint URL"
  - label: "MinIO / self-hosted", description: "I'll provide the endpoint URL"
  - label: "Other", description: "Backblaze B2, Wasabi, DigitalOcean Spaces, …"

Then collect what the provider needs: **bucket name** (always), plus **region** (AWS) or **endpoint URL** (R2, MinIO, and most others). Validate an endpoint URL starts with `https://`; for an `http://` endpoint, apply the same insecure-endpoint confirmation as the WebDAV step (cleartext credentials and content — trusted networks only).

### Step 3: Remote Path

**For WebDAV**, use AskUserQuestion (free-text expected via "Other"):

- **question:** "What remote path do you want to mount? (folder path relative to the WebDAV root)"
- **header:** "Path"
- **options:**
  - label: "Root (/)", description: "Mount the entire WebDAV root"
  - label: "Custom path", description: "I'll specify a subfolder path (e.g., /Projects/team-docs)"

**For S3-compatible**, the remote path is `{bucket}` or `{bucket}/{prefix}` — ask whether to mount the whole bucket or a prefix within it.

### Step 4: Mount Name

Use AskUserQuestion (free-text expected via "Other"):

- **question:** "Pick a name for this mount (lowercase, numbers, hyphens only)"
- **header:** "Name"
- **options:**
  - label: "Auto-generate", description: "Derive the name from the last segment of the remote path"
  - label: "Custom name", description: "I'll type a name"

Validate: `/^[a-z0-9][a-z0-9-]*$/`

Check the name is not already in use:

```bash
systemctl list-units --all 'nanoclaw-mount-*'
rclone listremotes
```

If `nanoclaw-mount-{name}.service` or the rclone remote `nanoclaw-{name}:` already exists, ask whether to reconfigure the existing mount or pick a different name.

### Step 5: Dependencies

Check for required tools (no user interaction needed unless something is missing):

```bash
command -v rclone && command -v fusermount3 || echo "MISSING"
```

If anything is missing, use AskUserQuestion:

- **question:** "Missing dependencies: {list}. Install them now?"
- **header:** "Dependencies"
- **options:**
  - label: "Install (Recommended)", description: "Run: sudo apt install -y rclone fuse3"
  - label: "Skip", description: "I'll install them manually later"

Also check that `/etc/fuse.conf` enables `user_allow_other` — without it the container runtime cannot access the FUSE mount:

```bash
grep -q '^user_allow_other' /etc/fuse.conf 2>/dev/null || echo "MISSING"
```

If missing, ask before fixing:

```bash
sudo sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf
grep -q '^user_allow_other' /etc/fuse.conf || echo 'user_allow_other' | sudo tee -a /etc/fuse.conf
```

### Step 6: Configure the rclone Remote (Credentials)

**CRITICAL SAFETY RULES:**

- NEVER ask for a username or password in the conversation
- NEVER display credential values
- Credential entry happens only in the operator's own terminal, via the `!` prefix

The rclone remote must be named `nanoclaw-{name}` (matching the mount name).

**For WebDAV**, tell the operator:

> I need rclone configured with your server credentials.
> Please run this in your terminal to create the remote interactively:
>
> `! rclone config`
>
> Create a new remote with:
> - **Name:** `nanoclaw-{name}`
> - **Type:** `webdav`
> - **URL:** `{url}`
> - **Vendor:** choose your server type
> - **User/Pass:** enter when prompted (use a Nextcloud **App Password** if applicable)

**For S3-compatible**, tell the operator:

> I need rclone configured with your S3 credentials.
> Please run this in your terminal to create the remote interactively:
>
> `! rclone config`
>
> Create a new remote with:
> - **Name:** `nanoclaw-{name}`
> - **Type:** `s3`
> - **Provider:** `{provider}`
> - **Access Key ID / Secret Access Key:** enter when prompted
> - **Region:** `{region}` (AWS) or **Endpoint:** `{endpoint}` (R2, MinIO, others)
>
> Use scoped, least-privilege credentials — an IAM user or API token limited
> to this bucket (read-only if agents will never write).

Then use AskUserQuestion:

- **question:** "Have you finished configuring the rclone remote?"
- **header:** "rclone"
- **options:**
  - label: "Yes, it's configured", description: "Verify the remote and continue"
  - label: "I need help", description: "Show me more detailed instructions"

After confirmation, verify the remote works:

```bash
rclone lsd nanoclaw-{name}:{remotePath} 2>&1; echo "EXIT:$?"
```

If `EXIT:0`, continue. Otherwise suggest checking credentials/URL and retry.

### Step 7: Create the Host Mount (systemd)

The mount runs as the **operator's own user**, not root. rclone holds the remote's credentials for the lifetime of the mount, and the agent container runs as the host user's uid — so a root-owned mount presents every file as `root` to the agent. Mounting as the operator keeps both sides on the same uid and keeps the credentials out of a root process.

Resolve the operator's identity and substitute it into `{user}` / `{group}` / `{home}`:

```bash
id -un; id -gn; echo $HOME
```

Create the mount point and install the service. The `chown` is required: `fusermount` refuses to mount unless the mounting user owns the mount point.

```bash
sudo mkdir -p /mnt/nanoclaw/{name}
sudo chown {user}:{group} /mnt/nanoclaw/{name}

sudo tee /etc/systemd/system/nanoclaw-mount-{name}.service > /dev/null <<EOF
[Unit]
Description=NanoClaw remote storage: {name}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=notify
SuccessExitStatus=143
User={user}
Group={group}
ExecStart=/usr/bin/rclone mount nanoclaw-{name}:{remotePath} /mnt/nanoclaw/{name} \
  --config {home}/.config/rclone/rclone.conf \
  --cache-dir {home}/.cache/rclone \
  --vfs-cache-mode full \
  --vfs-cache-max-age 1h \
  --allow-other \
  --log-level INFO
ExecStop=/usr/bin/fusermount3 -u /mnt/nanoclaw/{name}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now nanoclaw-mount-{name}.service
```

Why each non-obvious directive is there:

- **`User=` / `Group=`** — see above. `--allow-other` still applies and is what lets the container runtime (which resolves bind mounts as root) traverse the FUSE mount. Without it, container spawns fail even though the operator can list the mount fine.
- **`SuccessExitStatus=143`** — rclone traps `SIGTERM`, logs `Exiting...`, and exits `143` (`128+15`). systemd would otherwise record every clean stop as `Failed with result 'exit-code'`. Cosmetic, but it makes a genuinely failing mount hard to spot in `journalctl`.
- **`--config` / `--cache-dir`** — absolute, so the paths cannot drift. systemd populates `$HOME` when `User=` is set, so rclone would find both by itself; pinning them means a future `Environment=` or a pre-v240 systemd can't silently relocate the cache. (A unit with *no* `User=` runs as root with `$HOME` unset, and rclone falls back to `$TMPDIR/rclone` — the reason root-era mounts leave a stray `/tmp/rclone`.)
- **`--vfs-cache-mode full`** — required for random-access writes on S3-style object stores, and already covers WebDAV. The unit is otherwise backend-agnostic.

Verify — the mount must report the operator's uid, not `0`:

```bash
systemctl is-active nanoclaw-mount-{name}.service
mount | grep /mnt/nanoclaw/{name}      # expect user_id=<operator uid>,allow_other
ls /mnt/nanoclaw/{name}
```

If the service fails to start, check `journalctl -u nanoclaw-mount-{name}.service -n 20` — the usual causes are bad credentials (redo Step 6), a missing `user_allow_other` (redo Step 5), or a mount point still owned by `root` (redo the `chown` above).

### Step 8: Add to the Mount Allowlist

Container mounts are gated by `~/.config/nanoclaw/mount-allowlist.json`. Read the current file:

```bash
cat ~/.config/nanoclaw/mount-allowlist.json 2>/dev/null || echo "No mount allowlist configured"
```

Ask whether any group should ever be allowed to **write** to this storage (`allowReadWrite` at the root level is the ceiling; per-group read-only is set in Step 9):

- **question:** "Should agents ever be able to write to this storage, or is it strictly read-only?"
- **header:** "Access"
- **options:**
  - label: "Allow writes", description: "Groups you assign read-write access can modify remote files"
  - label: "Read-only (safer)", description: "All groups get read-only, regardless of assignment"

Merge a new entry into `allowedRoots`, **preserving all existing entries and keys**, and write the full document back through the sanctioned write path:

```bash
pnpm exec tsx setup/index.ts --step mounts --force -- --json '{"allowedRoots":[...existing roots..., {"path":"/mnt/nanoclaw/{name}","allowReadWrite":{true|false},"description":"Remote storage: {name}"}],"blockedPatterns":[...existing...]}'
```

### Step 9: Assign to Agent Groups

List the agent groups:

```bash
ncl groups list
```

Use AskUserQuestion with multiSelect:

- **question:** "Which agent groups should have access to mount '{name}'?"
- **header:** "Groups"
- **multiSelect:** true
- **options:** populate from `ncl groups list` (up to 4; "Other" covers the rest)

If writes were allowed in Step 8, ask per selected group:

- **question:** "What access level for group '{groupName}'?"
- **header:** "Access"
- **options:**
  - label: "Read-only (Recommended)", description: "Group can only read files"
  - label: "Read-write", description: "Group can read and write files"

Then assign each group (add `--readonly` for read-only access):

```bash
ncl groups config add-mount --id {group-id} --host-path /mnt/nanoclaw/{name} --container-path {name} [--readonly]
```

Read-write takes effect only when **both** the allowlist root has `allowReadWrite: true` and the assignment omits `--readonly`; otherwise the mount is silently read-only.

The allowlist and container config are read when a container is spawned, so new mounts apply to newly spawned containers automatically. For a group with a running container, restart just that group:

```bash
ncl groups restart --id {group-id}
```

### Step 10: Confirm

Report the result:

> Remote storage "{name}" configured:
> - **Host mount:** `/mnt/nanoclaw/{name}/` (systemd unit `nanoclaw-mount-{name}.service`, enabled, active)
> - **Remote:** {type} {url} {remotePath}
> - **Allowlist:** `/mnt/nanoclaw/{name}` added ({read-only|writes allowed})
> - **Groups:** {list with access levels}
>
> The mount persists across reboots. Agents in assigned groups see it at `/workspace/extra/{name}/`.
>
> Tip: add a `CLAUDE.md` file to the remote folder to give agents context about its contents.

## Managing Existing Mounts

### List mounts and assignments

```bash
systemctl list-units --all 'nanoclaw-mount-*'
cat ~/.config/nanoclaw/mount-allowlist.json
ncl groups config get --id {group-id}   # additional_mounts shows per-group assignments
```

### Test connectivity

```bash
rclone lsd nanoclaw-{name}:{remotePath} 2>&1; echo "EXIT:$?"
```

If `EXIT:0`, show the listing. Otherwise suggest checking credentials and network, and `journalctl -u nanoclaw-mount-{name}.service -n 20`.

### Unassign from a group

```bash
ncl groups config remove-mount --id {group-id} --host-path /mnt/nanoclaw/{name}
ncl groups restart --id {group-id}   # only if the group has a running container
```

### Update credentials

**Never ask for credentials in conversation.** Tell the operator:

> Run in your terminal to update the rclone remote interactively:
>
> `! rclone config`
>
> Edit the `nanoclaw-{name}` remote and update the credentials.

Then restart the mount:

```bash
sudo systemctl restart nanoclaw-mount-{name}.service
```

⚠️ Restarting a mount invalidates the FUSE handle that **already-running containers** hold through their bind mount — they keep a stale reference rather than picking up the new one. After any restart, kill the containers of every group assigned to this mount so they respawn against the fresh mount:

```bash
docker ps --format '{{.Names}}' | grep '^nanoclaw-v2-<group-folder>-'   # then: docker kill <name>
```

The same applies to `REMOVE.md` teardown and to changing `User=` on an existing unit.

### Remove a mount

Follow [REMOVE.md](REMOVE.md).

## Encryption

What is and isn't encrypted with this setup — share these facts when the operator asks about privacy or security:

- **In transit:** encrypted whenever the endpoint is HTTPS (Step 2 enforces this unless the operator explicitly accepts an HTTP endpoint on a trusted network).
- **At rest on the remote:** whatever the provider does — S3 providers typically encrypt server-side; Nextcloud server-side encryption is an optional admin feature. In all cases the storage provider can read the content.
- **On this host:** two places hold unencrypted data. The VFS cache (`--vfs-cache-mode full`) keeps plaintext copies of recently accessed files under the operator's rclone cache directory (`{home}/.cache/rclone`, pinned by `--cache-dir` in Step 7) for up to `--vfs-cache-max-age`. And `~/.config/rclone/rclone.conf` stores credentials *obscured, not encrypted* — rclone's obscuring is reversible, so treat file permissions (0600) and least-privilege credentials as the real protection. rclone's config-file encryption exists but requires a password at mount time, which breaks unattended boot mounts — do not enable it for mounts managed by this skill.
- **The mount itself is not permission-checked.** rclone mounts without `default_permissions`, so the kernel does not enforce the ownership and mode bits it displays — with `--allow-other`, any local user can read and write the mount regardless of what `ls -l` shows. The mount's uid governs what the *remote* sees, not who may touch it locally. If the host has untrusted local users, add `--default-permissions` to `ExecStart` (and confirm the agent uid still has the access it needs).

**End-to-end encryption (advanced):** to keep the provider from ever seeing plaintext, wrap the remote in rclone's `crypt` backend: in `rclone config` (operator's terminal, as in Step 6) create the base remote as `nanoclaw-{name}-base`, then a second remote `nanoclaw-{name}` of type `crypt` with `remote = nanoclaw-{name}-base:{remotePath}` — the remote path is baked into the crypt remote. Because of that, one substitution applies everywhere: any command that references `nanoclaw-{name}:{remotePath}` (the Step 6 verification, the Step 7 unit's `ExecStart`, connectivity tests) uses `nanoclaw-{name}:` instead — appending `{remotePath}` again would apply the path twice. The allowlist and group-assignment steps are unaffected. Two caveats to state: the crypt keys live in the same rclone.conf, so this protects against the provider, not against host compromise; and remotely stored data is only readable through rclone with those keys (the provider's own web UI shows ciphertext). Note that Nextcloud's built-in end-to-end-encrypted folders are not accessible over WebDAV at all — `crypt` is the way to get E2E with this skill.

## Testing

This skill's apply consists of operator actions with no source footprint — a systemd unit, an allowlist file outside the repo, and container-config rows written through `ncl` — so there is no in-tree line whose deletion an integration test could catch, and none ships with the skill. The `ncl groups config add-mount` / `remove-mount` verbs it drives are covered by `src/cli/resources/groups.test.ts`.
