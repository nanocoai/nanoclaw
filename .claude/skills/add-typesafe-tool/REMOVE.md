# Remove TypeSafe Tool

Reverses `/add-typesafe-tool`. Every step is idempotent: safe to re-run, and
safe when only partially installed (skip any step whose target is already
absent). An agent whose skills call `typesafe-judge` keeps those skills but
loses the judgments they depend on; remove or restamp it separately.

## 1. Remove the container skill

`container/skills/` is a read-only mount; each group's symlink to it is pruned
on the next spawn:

```bash
rm -rf container/skills/typesafe-judge
```

## 2. Remove the guard test

```bash
rm -f src/typesafe-manifest.test.ts
```

## 3. Remove the gateway credential

Deleting the `api.typesafe.ai` secret from the OneCLI vault revokes access for every
agent (only secrets for that exact host are touched). Per-agent secret lists
are left alone (`set-secrets` would switch an `all`-mode agent to
`selective` and cut it off from its other secrets):

```bash
for id in $(onecli secrets list | jq -r '.data[] | select(.hostPattern=="api.typesafe.ai") | .id'); do onecli secrets delete --id "$id"; done
```

Remove the spend-ceiling rule this skill created (matched by its exact name,
so an operator's own rules on the host stay):

```bash
for id in $(onecli rules list | jq -r '.data[] | select(.name=="TypeSafe: spend ceiling") | .id'); do onecli rules delete --id "$id"; done
```

## 4. Restart the agents

Restart every group so the agents respawn without the skill (each comes back
on its next message):

```bash
ncl groups list --json | jq -r '.data[].id' | while read -r gid; do ncl groups restart --id "$gid"; done
```

The TypeSafe account and key are managed in the TypeSafe console, not by
NanoClaw; revoke the key there if it is no longer needed.
