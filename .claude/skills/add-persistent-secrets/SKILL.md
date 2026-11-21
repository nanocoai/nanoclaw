---
name: add-persistent-secrets
description: Add a persistent secrets directory to agent containers so GPG keys, gopass stores, and other credentials survive container restarts. Without this, any secrets initialised inside a container (GPG keypair, cloned password store) are lost every time the container exits. Triggers on "persistent secrets", "gpg keys lost", "gopass lost", "secrets persist", "gopass persist", "keep secrets".
---

# Add Persistent Secrets Mount

Agent containers are ephemeral (`--rm`). Any state created inside the container —
GPG keys, a gopass store, SSH keys — is lost on every restart. This skill adds a
**persistent secrets directory** that survives container restarts, isolated per group.

## What this adds

A new volume mount is added to every container invocation:

| Host path | Container path |
|-----------|----------------|
| `data/secrets/{group.folder}/` | `/workspace/secrets/` |

Additionally:

- `GNUPGHOME` is set to `/workspace/secrets/.gnupg` in the container
  environment, so GPG keys created inside the container are written to the
  persistent volume automatically.
- `gopass` (if installed in the image) should be initialised with its store at
  `/workspace/secrets/store/` — this is explained in the verification step.

The host directory is created on first container start and lives alongside the
existing `data/sessions/` directory. It is never mounted read-only and is never
shared across groups.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `add-persistent-secrets` is in `applied_skills`,
this skill is already applied. Confirm with the user and stop.

## Phase 2: Apply Code Changes

### Step 1: Add the secrets mount in `src/container-runner.ts`

Read `src/container-runner.ts`.

Find the block that creates and mounts the IPC directory (search for
`resolveGroupIpcPath`). **After** that block, add the persistent secrets mount:

```typescript
// Persistent secrets directory — survives container restarts.
// Used for GPG keys, gopass stores, SSH keys, etc.
// Never shared across groups; created on first run.
const secretsDir = path.join(DATA_DIR, 'secrets', group.folder);
fs.mkdirSync(secretsDir, { recursive: true });
mounts.push({
  hostPath: secretsDir,
  containerPath: '/workspace/secrets',
  readonly: false,
});
```

Also set `GNUPGHOME` in the container args. Read `buildContainerArgs`. Find
where `TZ` is pushed:

```typescript
args.push('-e', `TZ=${TIMEZONE}`);
```

Directly after that line, add:

```typescript
args.push('-e', 'GNUPGHOME=/workspace/secrets/.gnupg');
```

### Step 2: Create the gnupg directory in the entrypoint

Read `container/Dockerfile`. Find the `RUN printf ...` line that creates
`/app/entrypoint.sh`. The current content is:

```
#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n
```

Prepend the following lines **before** `cat > /tmp/input.json`:

```bash
mkdir -p "$GNUPGHOME" && chmod 700 "$GNUPGHOME"\n
```

So the entrypoint printf becomes:

```
#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\nmkdir -p "$GNUPGHOME" && chmod 700 "$GNUPGHOME"\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n
```

The `chmod 700` is required by GPG — it refuses to use a keyring directory
with looser permissions.

## Phase 3: Build and Restart

```bash
npm run build
CONTAINER_RUNTIME=${CONTAINER_RUNTIME:-docker} ./container/build.sh
```

Restart the service:

```bash
# Linux
systemctl --user restart nanoclaw
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

### Confirm the mount appears in container logs

After sending a message that triggers the agent, check:

```bash
grep "secrets" logs/nanoclaw.log | tail -5
```

Or check the container mount configuration in debug mode:

```bash
LOG_LEVEL=debug grep "Container mount configuration" logs/nanoclaw.log | tail -1
```

### Initialise gopass inside the container (one-time)

The secrets directory is now persistent, but gopass still needs to be
initialised once. Ask the agent (via the group chat):

> Initialise gopass. Use `/workspace/secrets/store` as the root store path and
> create a new GPG key for this agent. Store all gopass config under
> `/workspace/secrets/`.

The agent will:
1. Generate a GPG keypair (stored in `$GNUPGHOME` = `/workspace/secrets/.gnupg`)
2. Run `gopass init --store /workspace/secrets/store <key-fingerprint>`

On subsequent container restarts both the GPG key and the gopass store will
be present at `/workspace/secrets/`.

### Confirm persistence across restarts

```bash
# Stop the running container
podman ps --filter name=nanoclaw | grep -v NAMES | awk '{print $NF}' | xargs -r podman stop

# Start a fresh one by sending any message
# Then verify the secrets dir exists on the host:
ls -la data/secrets/
```

## Architecture Notes

- `data/secrets/` is in `.gitignore` — secrets are never committed
- The directory is created with default permissions (restricted to the running
  user) — no world-readable secrets on the host
- `GNUPGHOME` is set as a container environment variable, not baked into the
  image, so the same image works with or without this skill applied
- The `chmod 700` on `$GNUPGHOME` runs at container startup, before the agent
  process starts — GPG will not complain about insecure keyring directories

## Troubleshooting

**GPG still complains about permissions after restart:**

The secrets directory was created by a previous container run as a different
uid. Fix with:

```bash
chmod 700 data/secrets/<group-folder>/.gnupg
```

**gopass can't find its config after restart:**

Ensure gopass was initialised with an explicit `--store` path pointing to
`/workspace/secrets/store`. If it was initialised with the default path
(`~/.local/share/gopass/stores/root`), that path is inside the container
and is lost on restart. Re-initialise.

**Secrets directory not appearing in `data/`:**

The mount is created lazily on first container start. Trigger a container
run by sending a message to the agent.

## Uninstalling

To remove the persistent secrets mount:

1. Remove the `secretsDir` mount block from `src/container-runner.ts`
2. Remove the `GNUPGHOME` env var line from `buildContainerArgs`
3. Revert the entrypoint change in `container/Dockerfile`
4. Rebuild: `npm run build && ./container/build.sh`
5. Restart the service
6. Optionally delete `data/secrets/` (this permanently deletes all stored keys)
