# Remove Vercel

Every step is idempotent — safe to re-run. Steps delete the files and config the apply created.

## 1. Remove the container skill

Delete the copied container skill and its per-group session copies:

```bash
rm -rf container/skills/vercel-cli
for session_dir in data/v2-sessions/ag-*; do
  rm -rf "$session_dir/.claude-shared/skills/vercel-cli"
done
```

## 2. Remove the dependency guard test

```bash
rm -f src/vercel-dockerfile.test.ts
```

## 3. Remove the OneCLI credential

Delete the Vercel secret and strip its id from every agent's assigned list. `set-secrets` replaces the whole list, so read, filter, and write back per agent:

```bash
VERCEL_SECRET_ID=$(onecli secrets list | jq -r '.data[] | select(.name | test("(?i)vercel")) | .id' | head -1)
if [ -n "$VERCEL_SECRET_ID" ]; then
  for agent in $(onecli agents list | jq -r '.data[].id'); do
    REMAINING=$(onecli agents secrets --id "$agent" | jq -r --arg id "$VERCEL_SECRET_ID" '[.data[] | select(. != $id)] | join(",")')
    onecli agents set-secrets --id "$agent" --secret-ids "$REMAINING"
  done
  onecli secrets delete --id "$VERCEL_SECRET_ID"
fi
```

## 4. The Vercel CLI in the container image

The Vercel CLI ships with the agent image on the NanoClaw trunk (`ARG VERCEL_VERSION` and `pnpm install -g "vercel@${VERCEL_VERSION}"` in `container/Dockerfile`). Leave those lines — they are part of the base image, not added by this skill. No rebuild is needed.

## 5. Restart running containers

So sessions stop loading the removed `vercel-cli` skill on next wake:

```bash
docker ps --format "{{.ID}} {{.Names}}" | grep nanoclaw-v2 | awk '{print $1}' | xargs -r docker stop
```
