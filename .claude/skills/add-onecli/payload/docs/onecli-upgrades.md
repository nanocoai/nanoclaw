# Upgrading the OneCLI gateway

NanoClaw talks to the OneCLI gateway (credential vault + egress proxy) through `@onecli-sh/sdk`. The gateway is an external component with its own release line, so NanoClaw pins the **sanctioned gateway version** in the OneCLI skill's [`versions.json`](../.claude/skills/add-onecli/versions.json) under `onecli-gateway` (not the `versions.json` at the project root). When an update moves that pin, the gateway must be upgraded — this doc is the migration path. It is written to be handed to a coding agent verbatim: detect → upgrade → verify → rollback.

There is deliberately **no runtime version check, and setup does not migrate the gateway for you**: the gateway is a separate out-of-band component, and the migrator is your coding agent running `/update-nanoclaw`. The update does not detect a pin move on its own. From 2026.10.0 on, release notes that move the `onecli-gateway` pin carry a `[BREAKING]` line, which stops the update until this doc has been followed; earlier pin moves were not marked, so an older gateway can lag behind its pin. The Detect step below shows whether yours does. (Setup detects a pre-`/v1` gateway and points at this doc, but never upgrades it.) Run the steps below verbatim.

**Supported version: exactly the pin (today 1.42.0).** OneCLI 1.43 and later remove the agent secret-assignment API this integration uses (`onecli agents set-secrets`), so 1.43+ is not supported for now. Never upgrade past the pin, and never rerun the upstream installer (`curl … onecli.sh/install | sh`) without `ONECLI_VERSION` set to the pin: without it, the installer installs the newest release. Rerunning `/add-onecli` does not fix a wrong version either, because setup reuses any healthy gateway without checking which version it runs.

## 1. Detect

Find out what is running and what is required:

```bash
env_get() { grep -E "^[[:space:]]*$1[[:space:]]*=" .env | cut -d= -f2- | tr -d " \t\r\"'" | grep -v '^$' | tail -1; }
grep -q "onecli" src/gateway-providers/installed.ts && echo "OneCLI registered" || echo "OneCLI not registered"
GWP=$(env_get NANOCLAW_GATEWAY_PROVIDER | tr 'A-Z' 'a-z'); echo "provider: ${GWP:-unset}"
GW=$(env_get ONECLI_URL); echo "ONECLI_URL: ${GW:-none}"   # the address NanoClaw uses
cat .claude/skills/add-onecli/versions.json         # the sanctioned pin (onecli-gateway)
docker inspect -f '{{.Config.Image}} {{.Image}}' onecli   # running tag + image ID (local gateway)
curl -s "$GW/api/health"                            # liveness check; its `version` field may say "unknown"
curl -s -o /dev/null -w '%{http_code}' "$GW/v1/health"
```

This doc applies only when OneCLI is registered and the provider is unset or `onecli`; otherwise (for example `iron-proxy`, or OneCLI not registered) **stop: it does not apply**, even if a leftover `ONECLI_URL` is still in `.env`. If your service sets `ONECLI_URL` in its own environment instead of `.env`, use that value for `GW`. If the running tag is `:latest`, note the image ID: it is what you roll back to. Use `ONECLI_URL` rather than `127.0.0.1`: on Linux a local gateway listens on the Docker bridge (for example `http://172.17.0.1:10254`), and for a remote gateway it is the remote host. (`NANOCLAW_ONECLI_API_HOST` is a setup-time override only, not persisted to `.env`.) If the last command prints `404`, the server predates the `/v1` API that `@onecli-sh/sdk` 2.x requires — every SDK call will fail with 404s that look transient but are permanent.

Why gateways fall behind: the OneCLI installer's docker-compose tracks the `latest` image tag, but Docker never re-pulls a tag — the server freezes at whatever `latest` meant on install day.

## 2. Upgrade

The gateway runs as a Docker service in `~/.onecli`. Upgrade just that container to the pinned `onecli-gateway` version — vault data lives in named Docker volumes and survives. This upgrades only the gateway; the CLI binary is pinned separately (see below).

**Local gateway (the common case).** Run these on the gateway's host; for a **remote gateway**, run them on that host (NanoClaw can't reach it over SSH).

Write the pin to `~/.onecli/.env`, which Docker Compose reads on every later `docker compose` command. A version given only on the command line is gone after that command, so the next plain `docker compose up` falls back to an older saved value or to `latest`. This keeps the file's other settings and its permissions, and the temporary copy is private to you:

```bash
cd ~/.onecli && (umask 077 && P=<onecli-gateway pin from versions.json> && touch .env && { grep -v '^[[:space:]]*ONECLI_VERSION[[:space:]]*=' .env; echo "ONECLI_VERSION=$P"; } > .env.new && cat .env.new > .env && rm .env.new)
```

Check that the compose file actually uses that value. Installers from older lines wrote the tag as a literal (`image: ghcr.io/onecli/onecli:1.36.0`); then `docker compose` re-pulls the *old* tag, prints `Pulled` / `Running`, and the gateway never moves (found by [#3500](https://github.com/nanocoai/nanoclaw/pull/3500)). `env -u` keeps a stray `ONECLI_VERSION` in your shell from overriding the file:

```bash
cd ~/.onecli && env -u ONECLI_VERSION docker compose config --images | grep onecli/onecli
```

This must print `ghcr.io/onecli/onecli:<pin>`. If it shows any other tag, edit the `onecli` service in `~/.onecli/docker-compose.yml` once so it reads the variable, then run the check again:

```yaml
    image: ghcr.io/onecli/onecli:${ONECLI_VERSION:-<onecli-gateway pin from versions.json>}
```

Then pull and restart:

```bash
cd ~/.onecli && env -u ONECLI_VERSION docker compose pull onecli && env -u ONECLI_VERSION docker compose up -d
```

## 3. Verify

Host-side health is necessary but **not sufficient**:

```bash
curl -s "$GW/v1/health"     # must return {"status":"ok",...}; GW from the Detect step
```

**Confirm the pinned version is the one running.** Health alone cannot tell an upgraded gateway from one that never moved:

```bash
docker inspect -f '{{.Config.Image}}' onecli    # gateway host: must print ghcr.io/onecli/onecli:<pin>
curl -s "$GW/api/health"                        # its "version" must be the pin, or "unknown"
```

If the tag is not the pin, go back to step 2: the pin is not saved, or the compose file does not use it. If `version` reports 1.43 or later, this gateway is not supported; roll back to the pin (step 4). From a NanoClaw host that only reaches a remote gateway, the `version` field is the only check; it says `unknown` on some builds, so then check the tag on the gateway host.

**Verify the bind interface (container reachability).** Agent containers reach the gateway over the docker bridge (`host.docker.internal` → e.g. `172.17.0.1`), so a server bound only to `127.0.0.1` boots clean host-side while every credentialed call from containers dies at the proxy:

```bash
docker run --rm --add-host=host.docker.internal:host-gateway \
  curlimages/curl -s -o /dev/null -w '%{http_code}' http://host.docker.internal:10254/v1/health
```

This must print `200`. If it can't connect while the host-side check passed, set the bind address in `~/.onecli/.env` to the docker-bridge IP (or `0.0.0.0` on a host with a closed firewall) and `cd ~/.onecli && env -u ONECLI_VERSION docker compose up -d`. Symptom if skipped: host log clean, agents fail all API calls.

Finally, restart the NanoClaw service (per-install names — derive with `setup/lib/install-slug.sh`):

```bash
# macOS
source setup/lib/install-slug.sh && launchctl kickstart -k gui/$(id -u)/$(launchd_label)
# Linux
source setup/lib/install-slug.sh && systemctl --user restart $(systemd_unit)
```

## 4. Rollback

Save the old version in `~/.onecli/.env` the same way as in step 2, so a later restart does not undo the rollback, then restart and check the running tag:

```bash
cd ~/.onecli && (umask 077 && P=<old-version> && touch .env && { grep -v '^[[:space:]]*ONECLI_VERSION[[:space:]]*=' .env; echo "ONECLI_VERSION=$P"; } > .env.new && cat .env.new > .env && rm .env.new)
cd ~/.onecli && env -u ONECLI_VERSION docker compose up -d && docker inspect -f '{{.Config.Image}}' onecli   # must end in :<old-version>
```

If the old gateway ran `:latest`, `latest` now means a different image. Give the image ID you noted in the Detect step a tag first (`docker tag <image-id> ghcr.io/onecli/onecli:rollback`) and use `rollback` as `<old-version>`.

If the NanoClaw update itself is being rolled back, also pin `@onecli-sh/sdk` back to its previous version in `package.json` and run `pnpm install`. Stored secrets survive in both directions. Access settings may not: grants and policies changed on the newer gateway are not carried back, so check that agents still get their credentials after a rollback.

## The CLI binary (`onecli-cli` pin)

The `onecli` host CLI is pinned the same way, under `onecli-cli` in `versions.json`. Setup installs exactly that version by direct release download — it never resolves "latest". When an update moves this pin, replace the binary with the pinned release:

```bash
onecli --version                                            # detect: what is installed
V=<onecli-cli pin from versions.json>
OS=$(uname -s | tr '[:upper:]' '[:lower:]')                 # darwin | linux
ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')   # amd64 | arm64
curl -fsSL -o /tmp/onecli.tgz \
  "https://github.com/onecli/onecli-cli/releases/download/v${V}/onecli_${V}_${OS}_${ARCH}.tar.gz"
tar -xzf /tmp/onecli.tgz -C /tmp
install -m 0755 /tmp/onecli "$(command -v onecli || echo ~/.local/bin/onecli)"
onecli --version                                            # verify: must match versions.json
```

To roll back, run the same block after reverting `versions.json` (or checking out the previous NanoClaw version). The CLI is stateless — vault data lives in the gateway, so swapping the binary in either direction loses nothing.

## Certificate and credential-stub files

The OneCLI provider fetches fresh typed container configuration on every spawn
and stages its CA, optional combined system trust bundle, and credential stubs
under `data/onecli/`. It mounts individual files read-only; the directory stays
private to the host user (mode `0700`), and credential stubs use mode `0600`.
The SDK's shared temporary paths are not used, so clearing `/tmp` or restarting
WSL does not remove the bind sources. Existing temporary files or directories
are left untouched.

Files are named by kind and content hash. Unchanged configuration reuses the
same files; a rotated CA or stub gets a new path so existing sessions retain
their original bytes. Old versions are retained because another session may
still mount them. Do not remove these files while agent containers are running.
An unexpected file type, owner, permissions, or content stops the spawn instead
of replacing existing data. A gateway fetch or staging failure also stops the
spawn; the provider never falls back to a cached credential configuration.
