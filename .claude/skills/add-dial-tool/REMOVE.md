# Remove Dial Tool

Reverses `/add-dial-tool`. Every step is idempotent — safe to re-run, and safe
when only partially installed (skip any step whose target is already absent).
Removes the **tool** only — it does not touch the Dial **channel** (`/add-dial`).

## 1. Remove the CLI from the agent image manifest

Delete the `@getdial/cli` entry from `container/cli-tools.json`, keeping the
top-level array valid:

```bash
tmp=$(mktemp) && jq 'map(select(.name != "@getdial/cli"))' container/cli-tools.json > "$tmp" && mv "$tmp" container/cli-tools.json
```

## 2. Remove the container skill

`container/skills/` is a read-only mount; the per-group `.claude-shared/skills/`
symlink to it is pruned automatically on the next spawn:

```bash
rm -rf container/skills/dial-cli
```

## 3. Remove the OneCLI credential

Deleting the Dial secret revokes it for every agent, because its grants go with
it; no agent's other grants are touched. On a gateway shared with another
install, that install loses Dial too. This deletes every Dial secret the skill
wrote (a name containing "dial", scoped to `api.getdial.ai`). It runs in a
subshell, so a failure stops it without closing your shell:

```bash
(
L=$(onecli secrets list --max 0) && [ -n "$(printf '%s' "$L" | tr -d '[:space:]')" ] && ids=$(printf '%s' "$L" | jq -r '(if type == "array" then . elif (type == "object") and ((.data | type) == "array") then .data else error("not a secret list") end)[] | select(.hostPattern == "api.getdial.ai" and (.name | test("(?i)dial"))) | .id') || { echo "could not read the OneCLI secrets; nothing deleted" >&2; exit 1; }; for id in $(printf '%s' "$ids"); do onecli secrets delete --id "$id" || exit 1; done
)
```

An earlier version of this skill kept unchosen agents away with an OneCLI policy
rule named `Dial: blocked agents`. The gateway's 1.44 conversion deleted it, so
nothing is left to remove on the pinned gateway.

## 4. Rebuild and restart the agents

Rebuild the image so it matches the manifest, then restart every group so the
agents respawn without the CLI (each comes back on its next message):

```bash
./container/build.sh
ncl groups list --json --limit 100000 | jq -r '.data[].id' | while read -r gid; do ncl groups restart --id "$gid"; done
```

The Dial account, its numbers, and the host `dial` CLI are managed by Dial, not
NanoClaw — `npm uninstall -g @getdial/cli` on the host if you no longer want it.
