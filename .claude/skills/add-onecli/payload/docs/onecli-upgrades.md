# Upgrading the OneCLI gateway

NanoClaw talks to the OneCLI gateway (credential vault + egress proxy) through `@onecli-sh/sdk`. The gateway is an external component with its own release line, so NanoClaw pins the **sanctioned gateway version** in the OneCLI skill's [`.claude/skills/add-onecli/versions.json`](../.claude/skills/add-onecli/versions.json) under `onecli-gateway` (not the `versions.json` at the project root). When an update moves that pin, the gateway must be upgraded — this doc is the migration path. It is written to be handed to a coding agent verbatim: detect → upgrade → verify → rollback.

There is deliberately **no runtime version check, and setup does not migrate the gateway for you**: the gateway is a separate out-of-band component, and the migrator is your coding agent running `/update-nanoclaw`. The update does not detect a pin move on its own. From 2026.10.0 on, release notes that move the `onecli-gateway` pin carry a `[BREAKING]` line, which stops the update until this doc has been followed; earlier pin moves were not marked, so an older gateway can lag behind its pin. The Detect step below shows whether yours does. (Setup detects a pre-`/v1` gateway and points at this doc, but never upgrades it.) Run the steps below verbatim.

**Supported version: exactly the pin (today 1.45.0).** This integration attaches secrets to agents through the agent grants API, which OneCLI added in 1.44; on an older gateway those commands fail with `404`. OneCLI 2.x is a rewrite and is not supported. Never upgrade past the pin, and never rerun the upstream installer (`curl … onecli.sh/install | sh`) without `ONECLI_VERSION` set to the pin: without it, the installer installs the newest release. Rerunning `/add-onecli` does not fix a wrong version either, because setup reuses any healthy gateway without checking which version it runs.

## 1. Detect

Find out what is running and what is required:

```bash
env_get() { grep -E "^[[:space:]]*$1[[:space:]]*=" .env | cut -d= -f2- | tr -d " \t\r\"'" | grep -v '^$' | tail -1; }
grep -q "onecli" src/gateway-providers/installed.ts && echo "OneCLI registered" || echo "OneCLI not registered"
GWP=$(env_get NANOCLAW_GATEWAY_PROVIDER | tr 'A-Z' 'a-z'); echo "provider: ${GWP:-unset}"
GW=$(env_get ONECLI_URL); echo "ONECLI_URL: ${GW:-none}"   # the address NanoClaw uses
cat .claude/skills/add-onecli/versions.json         # the sanctioned pin (onecli-gateway)
docker inspect -f '{{.Config.Image}} {{.Image}}' "${ONECLI_GATEWAY_CONTAINER:-onecli}"   # running tag + image ID (local gateway); a `:latest` tag says nothing about the version
curl -s "$GW/api/health"                            # liveness check; an old gateway may say "unknown" for `version`
curl -s -o /dev/null -w '%{http_code}' "$GW/v1/health"
```

This doc applies only when OneCLI is registered and the provider is unset or `onecli`; otherwise (for example `iron-proxy`, or OneCLI not registered) **stop: it does not apply**, even if a leftover `ONECLI_URL` is still in `.env`. If your service sets `ONECLI_URL` in its own environment instead of `.env`, use that value for `GW`. If the running tag is `:latest`, note the image ID: it is what you roll back to. Use `ONECLI_URL` rather than `127.0.0.1`: on Linux a local gateway listens on the Docker bridge (for example `http://172.17.0.1:10254`), and for a remote gateway it is the remote host. (`NANOCLAW_ONECLI_API_HOST` is a setup-time override only, not persisted to `.env`.) If your gateway container is not named `onecli`, export `ONECLI_GATEWAY_CONTAINER=<name>` first: the commands in this doc and its checks read it. If the last command prints `404`, the server predates the `/v1` API that `@onecli-sh/sdk` 2.x requires — every SDK call will fail with 404s that look transient but are permanent.

Why gateways fall behind: the OneCLI installer's docker-compose tracks the `latest` image tag, but Docker never re-pulls a tag — the server freezes at whatever `latest` meant on install day.

## 2. Upgrade

The gateway runs as a Docker service in `~/.onecli`. Upgrade just that container to the pinned `onecli-gateway` version — vault data lives in named Docker volumes and survives. This upgrades only the gateway; the CLI binary is pinned separately (see below).

**Local gateway (the common case).** Run these on the gateway's host; for a **remote gateway**, run them on that host (NanoClaw can't reach it over SSH).

**Every NanoClaw install that shares this gateway** must run code that attaches credentials with grants (this version or later) before the gateway moves to 1.44 or later: older code expects agents in `all` mode, so its new groups would get no credentials at all.

**First, if the gateway runs 1.43 or older and the pin is 1.44 or later, check what the move deletes.** Do this before anything below writes the pin. On its first start a 1.44+ gateway converts the project once:

- Each `all`-mode agent gets an explicit grant for **every** secret in the vault at that moment. Agents already in `selective` mode keep their list.
- Every custom project **network rule and behavioral rule** (one with a non-empty `conditions` list) is **deleted**, including `block` rules: an agent a rule kept away from a host now receives that host's secret. So are **block and approval rules on a secret**: an `all`-mode agent gets a plain grant for it. **Rate limits on allow rules** are dropped, and a **`block` project default is reset to `allow`**.
- `onecli agents set-secrets`, `onecli agents secrets` and `onecli agents set-secret-mode` answer `410 Gone` afterwards. Use `onecli agents grants list|attach-secret|detach-secret`.

The check needs CLI 2.6 or later for `policy rules`: install the `onecli-cli` pin first ([below](#the-cli-binary-onecli-cli-pin)); it works against the old gateway. Run it from the NanoClaw checkout, with `GW` set as in the Detect step (it only reads the gateway's API; if NanoClaw's `.env` sets `ONECLI_PROJECT_ID`, also `export ONECLI_PROJECT=<that id>`). It reads the draft (what the conversion folds) and the published rules, and exits non-zero when it finds something the conversion deletes or changes, when the draft has unpublished changes (the conversion publishes the draft), or when it cannot read the policy:

```bash
GW="$GW" sh .claude/skills/add-onecli/scripts/pre-upgrade-check.sh
```

The conversion runs for every project on the gateway. A local gateway has one; if yours has more, run the check once per project with `ONECLI_PROJECT=<project id>` in front.

A gateway older than 1.42 has no policy API, so this check stops. You can tell by its `/api/health` version: below 1.42, `unknown` (OneCLI 1.24 to 1.38), or none at all. If it holds a Dial key, delete that first with the Dial check below and `--delete`: on such a gateway the check deletes the key, since its rules cannot be read and moving the gateway can open Dial. Then move the gateway to 1.42.0: follow step 2 below with 1.42.0 in place of the pin, through `docker compose up -d`. On its first start 1.42 moves the old rules into its policy. Then start this guide again from the Detect step, and re-run `/add-dial-tool` once the gateway runs the pin.

If it stops with findings, do not upgrade yet: after the upgrade, access can only be narrowed by detaching secrets from agents, so anything a rule, a rate limit or a `block` default enforced is gone. Note what each finding protects, and upgrade only once you accept that or have a replacement.

Then, on every upgrade, check whether the Dial key must go before you pull. An earlier `/add-dial-tool` kept unchosen agents away from Dial with a `block` rule (`Dial: blocked agents`, one of the findings above); the conversion deletes it and would give the key to every agent that rule kept away, and Dial spends money and reaches real people. The check reads only and asks the gateway at `$GW`, like the check above, and like it runs once per project (`ONECLI_PROJECT=<project id>` in front). A Dial key is every secret the gateway would inject on `api.getdial.ai`, whatever its name. It prints `keep` and why when there is none, or when the gateway has already converted (1.44 or later), where grants decide; there it relies on the post-upgrade check having printed `OK`, since OneCLI no longer shows project rules. On 1.42 or 1.43 it prints `delete` only when the conversion would remove something that keeps agents away from Dial today: a rule on `api.getdial.ai` or on a Dial key, or a `block` default. It also prints `delete` whenever the old pre-1.42 rules may decide, since those cannot be read in full: on a gateway older than 1.42, with `POLICY_ENFORCE_V2` off, or when it cannot show that the local gateway container (`ONECLI_GATEWAY_CONTAINER`, default `onecli`) is the gateway at `$GW`. For a remote gateway, copy the script to the gateway's host and run it there with `GW` set to the gateway's local address, as for the post-upgrade check. It stops when it cannot tell, for example when a 1.44 or later gateway still has agents in `all` mode, and before deleting a Dial key that is an organization secret, which only the OneCLI console can delete.

```bash
GW="$GW" sh .claude/skills/add-onecli/scripts/dial-key-check.sh
```

If it prints `keep`, do not delete the Dial key: that takes Dial from every agent that holds it, on every install that shares the gateway, until each one re-runs `/add-dial-tool`. If it stops, do not upgrade yet. If it prints `delete`, delete the key with the same script, which checks again and deletes only the keys that check names:

```bash
GW="$GW" sh .claude/skills/add-onecli/scripts/dial-key-check.sh --delete
```

No agent can use Dial until you re-run `/add-dial-tool` after the upgrade, a few minutes later: it recreates the key from the host's Dial sign-in and attaches it only to the agents you choose. On a gateway shared with another install, that install loses Dial too until it re-runs `/add-dial-tool`.

If the gateway already converted while `Dial: blocked agents` was in place, the agents that rule kept away now hold every Dial key. Re-run `/add-dial-tool` now, on every install that shares the gateway: it detaches its own key (`Dial API`) from the agent groups you do not choose. It leaves alone any other key for `api.getdial.ai`, and every agent that is not one of an install's groups, OneCLI's default agent included (`isDefault: true` in `onecli agents list --max 0`). Check which agents hold a Dial key with `onecli agents grants list --id <agent-id>`, and detach it from any agent that should not have it with `onecli agents grants detach-secret --id <agent-id> --secret-id <dial-secret-id>`.

Write the pin to `~/.onecli/.env`, which Docker Compose reads on every later `docker compose` command. A version given only on the command line is gone after that command, so the next plain `docker compose up` falls back to an older saved value or to `latest`. This keeps the file's other settings and its permissions, and the temporary copy is private to you. The command stops without touching the file when the value is empty or not a version:

```bash
cd ~/.onecli && (umask 077 && P=<onecli-gateway pin from .claude/skills/add-onecli/versions.json> && { printf '%s\n' "$P" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+' || { echo "Not saved: '$P' is not a version like 1.42.0" >&2; exit 1; }; } && touch .env && { grep -v '^[[:space:]]*ONECLI_VERSION[[:space:]]*=' .env; echo "ONECLI_VERSION=$P"; } > .env.new && cat .env.new > .env && rm .env.new)
```

Check that the compose file actually uses that value. Installers from older lines wrote the tag as a literal (`image: ghcr.io/onecli/onecli:1.36.0`); then `docker compose` re-pulls the *old* tag, prints `Pulled` / `Running`, and the gateway never moves (found by [#3500](https://github.com/nanocoai/nanoclaw/pull/3500)). `env -u` keeps a stray `ONECLI_VERSION` in your shell from overriding the file:

```bash
cd ~/.onecli && env -u ONECLI_VERSION docker compose config --images | grep onecli/onecli
```

This must print `ghcr.io/onecli/onecli:<pin>`. Do not pull or restart until it does: an empty or missing `ONECLI_VERSION` makes the stock compose file use `latest`, which is newer than the pin. If it shows any other tag, edit the `onecli` service in `~/.onecli/docker-compose.yml` once so it reads the variable, then run the check again:

```yaml
    image: ghcr.io/onecli/onecli:${ONECLI_VERSION:-<onecli-gateway pin from .claude/skills/add-onecli/versions.json>}
```

Back up the gateway database before you pull or restart. A newer gateway can migrate it, and going back to the pin does not undo that:

```bash
cd ~/.onecli && (umask 077 && F=~/onecli-db-backup-$(date +%Y%m%d-%H%M%S).sql && docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$F.part" && grep -q 'PostgreSQL database dump complete' "$F.part" && mv "$F.part" "$F" || { rm -f "$F.part"; echo "Backup failed, nothing saved" >&2; exit 1; }; ls -l "$F")
```

It prints the new file only when the dump is complete. If the dump fails or stops early, it says so and leaves no file behind; a leftover file ending in `.part` is not a backup. Only you can read the file. `postgres` is the database service in the stock compose file; use your service's name if it differs. Restoring it was tested once, from 1.45.0 back to 1.42.0: loaded with `psql` into a new, empty database, it brought the gateway back without the startup error and with its stored secret. The restore command is under [Rollback](#4-rollback). Stored secrets are encrypted with a key kept outside the database. By default it is the `secret-encryption-key` file in the `app-data` volume; if you set `SECRET_ENCRYPTION_KEY` yourself, it is wherever you set it. Either way, the dump alone does not recover secrets without that key.

Then pull and restart:

```bash
cd ~/.onecli && env -u ONECLI_VERSION docker compose pull onecli && env -u ONECLI_VERSION docker compose up -d
```

Then check the conversion, and that the gateway still injects credentials, before you call the upgrade done. The conversion's log line appears a few seconds after `/v1/health` answers, so wait, then run this where the gateway container runs. For a local gateway that is this host, from the NanoClaw checkout; for a remote gateway, copy `.claude/skills/add-onecli/scripts/post-upgrade-check.sh` to the gateway host and run it there (it needs docker, curl, jq and the onecli CLI; when the gateway uses an API token, sign that CLI in first: pipe ONECLI_API_KEY from NanoClaw's .env into `onecli auth login >/dev/null 2>&1 && echo signed in || echo 'sign-in failed' >&2`, which reads it from stdin). If the gateway container is not named `onecli`, put `ONECLI_GATEWAY_CONTAINER=<name>` in front:

```bash
GW="$GW" sh .claude/skills/add-onecli/scripts/post-upgrade-check.sh
```

It reads only this boot's `grant-conversion` line and requires `0 failed`, `0 preempted` and `0 verify-failed` (a failed verification can make the gateway deny every request while the line still says `0 failed`), then checks that no agent is still in `all` mode. Continue only once it prints `OK`; the upgrade is done only after the agent reply at the end of Verify. It reads only the current boot's line: the gateway logs one on every start, and a later start converts whatever an earlier one left. If you run it long after the upgrade, restart the gateway once first (`cd ~/.onecli && env -u ONECLI_VERSION docker compose restart onecli`), wait a few seconds, then run it. Existing agents keep what the conversion gave them. From now on an agent receives only the secrets attached to it: NanoClaw attaches a group's model credential (the one its provider setup saved) on every spawn, and nothing else. A tool secret or app connection reaches a new group only when you attach it, through the skill that added it or with `onecli agents grants attach-secret`.

**If a gateway newer than the pin has started, even briefly:** it can migrate its database, and going back to the pin does not undo that. Put the gateway back on the pin (step 2), then check `docker logs "${ONECLI_GATEWAY_CONTAINER:-onecli}" 2>&1 | grep -iE 'migrat|error'`. Access rules and approvals were not checked in testing. If you see a database error, restore a backup taken before the newer version ran (the one from step 2, if you took it in time). There is no other tested repair, so otherwise [open an issue](https://github.com/nanocoai/nanoclaw/issues) with the log lines.

## 3. Verify

Host-side health is necessary but **not sufficient**:

```bash
curl -s "$GW/v1/health"     # must return {"status":"ok",...}; GW from the Detect step
```

**Confirm the pinned version is the one running.** Health alone cannot tell an upgraded gateway from one that never moved:

```bash
docker inspect -f '{{.Config.Image}}' "${ONECLI_GATEWAY_CONTAINER:-onecli}"    # gateway host: must print ghcr.io/onecli/onecli:<pin>
curl -s "$GW/api/health"                        # its "version" must be the pin
```

If the tag is not the pin, go back to step 2: the pin is not saved, or the compose file does not use it. If `version` reports anything other than the pin, including `unknown`, put the gateway on the pin (step 2). The grants check that tool skills run before they save a key (`check-grants-gateway.sh`) also refuses a gateway that reports `unknown`. From a NanoClaw host that only reaches a remote gateway, the `version` field is the only check.

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

Then confirm that an agent still answers. A real reply is the check that the gateway injects credentials: the model call works only when the gateway attaches the group's key and the vendor accepts it. Use an agent whose model needs a key held in OneCLI (Claude, Codex, Cursor, or OpenCode with a hosted backend); a reply from a group on a keyless endpoint proves nothing.

```bash
pnpm run chat "Reply with the single word ok"
```

It must print the agent's reply (exit 0). If it could not reach the NanoClaw host (exit 2), start the service and run it again. No reply (exit 3) or the runner's failure notice (exit 4) means the upgrade is not done: check the gateway's log (`docker logs "${ONECLI_GATEWAY_CONTAINER:-onecli}"`) and the post-upgrade check above. If no agent is wired to the terminal channel, send one message to any agent from your chat app instead and wait for a real answer, not a failure notice.

If a new group fails while existing ones answer, NanoClaw may have no recorded key for its provider. It matches an older install's key once, and only by the name setup saves (`Anthropic` for Claude, `Codex` or `openai` for Codex): a key saved under another name is not used, and the NanoClaw log names it. Run that provider's login again (`pnpm exec tsx setup/index.ts --step gateway-auth claude`, or `codex`) so it records the key, then try the new group again.

Once the service is back, if `/add-tavily-tool` is installed, re-run its Phase 5: the upgrade block it wrote into each group earlier has no attach step, so a group that upgraded to a paid key would drop the keyless header and end up with no key.

## 4. Rollback

Save the old version in `~/.onecli/.env` the same way as in step 2, so a later restart does not undo the rollback, then restart and check the running tag. The command accepts only a version or `rollback`; if it refuses, nothing restarts. The last line printed must end in `:<old-version>`:

```bash
cd ~/.onecli && (umask 077 && P=<old-version> && { printf '%s\n' "$P" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+|rollback' || { echo "Not saved: '$P' is not a version or rollback" >&2; exit 1; }; } && touch .env && { grep -v '^[[:space:]]*ONECLI_VERSION[[:space:]]*=' .env; echo "ONECLI_VERSION=$P"; } > .env.new && cat .env.new > .env && rm .env.new) && env -u ONECLI_VERSION docker compose up -d && docker inspect -f '{{.Config.Image}}' "${ONECLI_GATEWAY_CONTAINER:-onecli}"
```

If the old gateway ran `:latest`, `latest` now means a different image. Give the image ID you noted in the Detect step a tag first (`docker tag <image-id> ghcr.io/onecli/onecli:rollback`) and use `rollback` as `<old-version>`.

If the NanoClaw update itself is being rolled back, also pin `@onecli-sh/sdk` back to its previous version in `package.json` and run `pnpm install`. Stored secrets survive in both directions. Access settings may not: grants and policies changed on the newer gateway are not carried back, so check that agents still get their credentials after a rollback.

**Rolling back from 1.44 or later to 1.43 or older needs the backup from step 2; restoring it is the only supported rollback.** The upgrade migrates the database in ways the old gateway cannot read: without the backup, it starts with a `policy_rule_identities.agent_group_id does not exist` error, and every agent the upgrade converted is left in `selective` mode with an empty secret list, so it gets no credentials. Switching agents back to `all` mode without it (`onecli agents set-secret-mode`) brings back credential injection only: the deleted rules stay deleted, policy stays broken, and an agent that was `selective` before the upgrade would receive every matching secret, so it is not supported.

After saving the old version above, restore the backup into a new, empty database. This replaces the gateway's database: anything changed since the backup is lost. Put the backup's path in `F`; the command stops before touching anything if the file is missing or empty:

```bash
cd ~/.onecli && (F=<backup file from step 2> && [ -s "$F" ] || { echo "Not restored: '$F' is not a backup file" >&2; exit 1; }; docker compose stop onecli && docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"' && docker compose exec -T postgres sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$POSTGRES_DB"' < "$F" && env -u ONECLI_VERSION docker compose up -d)
```

Tested from 1.45.0 back to 1.42.0: the gateway came back without the startup error, with its agents in `all` mode, its secrets, and its rules. An agent group created after the backup gets a fresh `all`-mode agent on its next spawn.

## The CLI binary (`onecli-cli` pin)

The `onecli` host CLI is pinned the same way, under `onecli-cli` in `.claude/skills/add-onecli/versions.json`. Setup installs exactly that version by direct release download — it never resolves "latest". When an update moves this pin, replace the binary with the pinned release:

```bash
onecli version                                              # detect: what is installed
V=<onecli-cli pin from .claude/skills/add-onecli/versions.json>
OS=$(uname -s | tr '[:upper:]' '[:lower:]')                 # darwin | linux
ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')   # amd64 | arm64
curl -fsSL -o /tmp/onecli.tgz \
  "https://github.com/onecli/onecli-cli/releases/download/v${V}/onecli_${V}_${OS}_${ARCH}.tar.gz"
tar -xzf /tmp/onecli.tgz -C /tmp
install -m 0755 /tmp/onecli "$(command -v onecli || echo ~/.local/bin/onecli)"
onecli version                                              # verify: must match the onecli-cli pin
```

To roll back, run the same block after reverting `.claude/skills/add-onecli/versions.json` (or checking out the previous NanoClaw version). The CLI is stateless — vault data lives in the gateway, so swapping the binary in either direction loses nothing.

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

OneCLI 1.42.0's ChatGPT login stub carries the fixed account id
`onecli-managed`. Codex 0.156.0 and later look that id up in the login's
workspace list before any model request, so the provider replaces it with the
workspace id OneCLI recorded when the login was saved (secret metadata, read
from `/v1/secrets`). Tokens in the stub stay placeholders. The workspace id is
an identifier, not a credential, and the agent can read it. If OneCLI cannot
serve the metadata, the spawn stops like a failed configuration fetch. If the
vault holds several ChatGPT logins, or one without a recorded id, the stub
keeps the fixed id and the provider logs a warning. To fix that, delete the
extra or stale login (`onecli secrets list`, then `onecli secrets delete --id
<id>`) and sign in again with
`pnpm exec tsx setup/index.ts --step provider-auth codex`. If that step says
the account is already connected, another OpenAI secret (such as an API key) is
still stored; delete it too. The new login has a new secret ID: grant it to
each agent that had the old one, as described under Provider credentials in the
add-onecli skill.
