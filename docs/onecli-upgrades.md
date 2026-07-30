# Upgrading the OneCLI gateway

NanoClaw talks to the OneCLI gateway (credential vault + egress proxy) through `@onecli-sh/sdk`. The gateway is an external component with its own release line, so NanoClaw pins the **sanctioned gateway version** in [`versions.json`](../versions.json) under `onecli-gateway`. When an update moves that pin, the gateway must be upgraded — this doc is the migration path. It is written to be handed to a coding agent verbatim: detect → upgrade → verify → rollback.

There is deliberately **no runtime version check, and setup does not migrate the gateway for you**: the gateway is a separate out-of-band component, and the migrator is your coding agent running `/update-nanoclaw` — it diffs `versions.json` across the update and routes you here when the `onecli-gateway` pin moved. (Setup detects a pre-`/v1` gateway and points at this doc, but never upgrades it.) Run the steps below verbatim.

## 1. Detect

Find out what is running and what is required:

```bash
cat versions.json                                   # the sanctioned pin
curl -s http://127.0.0.1:10254/api/health           # liveness check; `version` field is typically "unknown", not the gateway version
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:10254/v1/health
```

If the last command prints `404`, the server predates the `/v1` API that `@onecli-sh/sdk` 2.x requires — every SDK call will fail with 404s that look transient but are permanent. If your gateway is remote, substitute its host for `127.0.0.1` (it's `ONECLI_URL` in `.env`; `NANOCLAW_ONECLI_API_HOST` is a setup-time override only, not persisted to `.env`).

Why gateways fall behind: the OneCLI installer's docker-compose tracks the `latest` image tag, but Docker never re-pulls a tag — the server freezes at whatever `latest` meant on install day.

## 2. Upgrade

The gateway runs as a Docker service in `~/.onecli`. Upgrade just that container to the pinned `onecli-gateway` version — vault data lives in named Docker volumes and survives. This upgrades only the gateway; the CLI binary is pinned separately (see below).

**Local gateway (the common case):**

```bash
cd ~/.onecli && ONECLI_VERSION=<onecli-gateway pin from versions.json> docker compose pull onecli && docker compose up -d
```

**Remote gateway** — run the same command on the gateway's host (NanoClaw can't reach it over SSH).

## 3. Verify

Host-side health is necessary but **not sufficient**:

```bash
curl -s http://127.0.0.1:10254/v1/health     # must return {"status":"ok",...}
```

**Verify the bind interface (container reachability).** Agent containers reach the gateway over the docker bridge (`host.docker.internal` → e.g. `172.17.0.1`), so a server bound only to `127.0.0.1` boots clean host-side while every credentialed call from containers dies at the proxy:

```bash
docker run --rm --add-host=host.docker.internal:host-gateway \
  curlimages/curl -s -o /dev/null -w '%{http_code}' http://host.docker.internal:10254/v1/health
```

This must print `200`. If it can't connect while the host-side check passed, set the bind address in `~/.onecli/.env` to the docker-bridge IP (or `0.0.0.0` on a host with a closed firewall) and `cd ~/.onecli && docker compose up -d`. Symptom if skipped: host log clean, agents fail all API calls.

Finally, restart the NanoClaw service (per-install names — derive with `setup/lib/install-slug.sh`):

```bash
# macOS
source setup/lib/install-slug.sh && launchctl kickstart -k gui/$(id -u)/$(launchd_label)
# Linux
source setup/lib/install-slug.sh && systemctl --user restart $(systemd_unit)
```

## 4. Rollback

```bash
cd ~/.onecli && ONECLI_VERSION=<old-version> docker compose up -d
```

If the NanoClaw update itself is being rolled back, also pin `@onecli-sh/sdk` back to its previous version in `package.json` and run `pnpm install`. Vault data is unaffected in both directions.

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
