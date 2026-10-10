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

## 3. Remove the OneCLI credential, then the Dial policy

Deleting the secret is what revokes access for every agent, so it goes first
and the policy only goes once every Dial secret is gone (the script refuses
otherwise: the block is what keeps unchosen agents away from a key that is
injected for every `all`-mode agent). Per-agent secret lists are not edited
(`set-secrets` would switch an `all`-mode agent to `selective` and cut it off
from its other secrets). The policy rules this skill keeps (`Dial: blocked
agents`, and any `Dial: blocked for <group>` rule a legacy block was migrated
to) are deleted through the policy API and the policy is published; an
operator's own rules on `api.getdial.ai` stay. Publishing applies the whole
policy draft, so finish or discard any edit left open in the OneCLI console
first:

```bash
for id in $(onecli secrets list | jq -r '.data[] | select(.name | test("(?i)dial")) | .id'); do onecli secrets delete --id "$id" || exit 1; done && pnpm exec tsx .claude/skills/add-dial-tool/scripts/dial-policy.ts remove
```

On an OneCLI gateway older than 1.42 the policy API is not enforced and the
script fails; the skill then scoped Dial with legacy rules, which go like this:

```bash
for id in $(onecli rules list | jq -r '.data[] | select(.hostPattern=="api.getdial.ai" and .action=="block" and (.name | startswith("Dial: blocked for "))) | .id'); do onecli rules delete --id "$id" || echo "could not delete rule $id: remove it in the OneCLI console"; done
```

## 4. Rebuild and restart the agents

Rebuild the image so it matches the manifest, then restart every group so the
agents respawn without the CLI (each comes back on its next message):

```bash
./container/build.sh
ncl groups list --json | jq -r '.data[].id' | while read -r gid; do ncl groups restart --id "$gid"; done
```

The Dial account, its numbers, and the host `dial` CLI are managed by Dial, not
NanoClaw — `npm uninstall -g @getdial/cli` on the host if you no longer want it.
