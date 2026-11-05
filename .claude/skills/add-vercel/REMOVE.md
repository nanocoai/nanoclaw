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

Detach the Vercel secret from every agent, then delete it. If OneCLI holds more than one Vercel token, the block lists them and stops: put the id of the one this install saved in `VERCEL_SECRET`.

```bash
(
VERCEL_SECRET=""
L=$(onecli secrets list --max 0) && [ -n "$(printf '%s' "$L" | tr -d '[:space:]')" ] || { echo "could not list OneCLI secrets" >&2; exit 1; }
T=$(printf '%s' "$L" | jq -c '[(if type == "array" then . else .data end)[] | select(.hostPattern == "api.vercel.com") | {id, name, createdAt}]') || { echo "could not read the OneCLI secret list" >&2; exit 1; }
if [ -n "$VERCEL_SECRET" ]; then
  S=$(printf '%s' "$T" | jq -r --arg s "$VERCEL_SECRET" '.[] | select(.id == $s) | .id'); [ -n "$S" ] || { echo "'$VERCEL_SECRET' is not a Vercel token in OneCLI" >&2; exit 1; }
else
  case "$(printf '%s' "$T" | jq length)" in
    0) echo "no Vercel token in OneCLI: nothing to remove"; exit 0 ;;
    1) S=$(printf '%s' "$T" | jq -r '.[0].id') ;;
    *) echo "more than one Vercel token in OneCLI:" >&2; printf '%s' "$T" | jq -r '.[] | "  \(.id)  \(.name)  created \(.createdAt)"' >&2
       echo "set VERCEL_SECRET to the one to remove (check its name and time; ask if unsure) and run this again" >&2; exit 1 ;;
  esac
fi
AG=$(onecli agents list --max 0) || { echo "could not list OneCLI agents" >&2; exit 1; }
for agent in $(printf '%s' "$AG" | jq -r '.data[].id'); do
  onecli agents grants detach-secret --id "$agent" --secret-id "$S" >/dev/null
done
onecli secrets delete --id "$S"
)
```

## 4. The Vercel CLI in the container image

Remove the `vercel` entry from `container/cli-tools.json` — this skill added it, and it is
not part of the base image. Then `./container/build.sh` so the image matches the manifest.

## 5. Restart running containers

So sessions stop loading the removed `vercel-cli` skill on next wake:

```bash
docker ps --filter label=nanoclaw-session -q | xargs -r docker stop
```
