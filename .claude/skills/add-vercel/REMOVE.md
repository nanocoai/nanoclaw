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
rm -f src/vercel-manifest.test.ts
```

## 3. Remove the OneCLI credential

Detach the Vercel secret from every agent, then delete it:

```bash
VERCEL_SECRET_ID=$(onecli secrets list --max 0 | jq -r '.data[] | select(.name | test("(?i)vercel")) | .id' | head -1)
if [ -n "$VERCEL_SECRET_ID" ]; then
  for agent in $(onecli agents list --max 0 | jq -r '.data[].id'); do
    onecli agents grants detach-secret --id "$agent" --secret-id "$VERCEL_SECRET_ID" >/dev/null
  done
  onecli secrets delete --id "$VERCEL_SECRET_ID"
fi
```

## 4. The Vercel CLI in the container image

Remove the `vercel` entry from `container/cli-tools.json` — this skill added it, and it is
not part of the base image. Then `./container/build.sh` so the image matches the manifest.

## 5. Restart running containers

So sessions stop loading the removed `vercel-cli` skill on next wake:

```bash
docker ps --filter label=nanoclaw-session -q | xargs -r docker stop
```
