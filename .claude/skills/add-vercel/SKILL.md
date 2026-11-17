---
name: add-vercel
description: Add Vercel deployment capability to NanoClaw agents. Installs the Vercel CLI in agent containers and sets up OneCLI credential injection for api.vercel.com. Use when the user wants agents to deploy web applications to Vercel.
---

# Add Vercel

This skill gives NanoClaw agents the ability to deploy web applications to Vercel. It installs the Vercel CLI in agent containers and configures OneCLI to inject Vercel credentials automatically.

**Principle:** Do the work — don't tell the user to do it. Only ask for their input when it genuinely requires manual action (pasting a token).

## Phase 1: Pre-flight

### Check if already applied

Check if the container skill exists:

```bash
test -d container/skills/vercel-cli && echo "INSTALLED" || echo "NOT_INSTALLED"
```

If `INSTALLED`, skip to Phase 3 (Configure Credentials).

### Check prerequisites

Verify OneCLI is working (required for credential injection):

```bash
onecli version 2>/dev/null && echo "ONECLI_OK" || echo "ONECLI_MISSING"
```

If `ONECLI_MISSING`, tell the user to run `/init-onecli` first, then retry `/add-vercel`. Stop here.

## Phase 2: Install Container Skill

Copy the bundled container skill into the container skills directory:

```bash
rsync -a .claude/skills/add-vercel/container-skills/ container/skills/
```

Verify:

```bash
head -5 container/skills/vercel-cli/SKILL.md
```

## Phase 3: Configure Credentials

### Check the OneCLI gateway first

The Vercel secret reaches only the groups it is attached to, through OneCLI agent grants. On an older gateway a saved secret reaches every agent and the attach step fails, so check the gateway and CLI before asking for a token or saving one. It reads only:

```bash
sh .claude/skills/add-onecli/scripts/check-grants-gateway.sh /add-vercel
```

If it fails, show the user the message as it is and stop: do not ask for the token or save it, and do not attach it to agents by hand.

### Check if Vercel credential already exists

```bash
onecli secrets list --max 0 2>/dev/null | jq -r '(if type == "array" then . else .data end)[] | select(.hostPattern == "api.vercel.com") | "\(.id)  \(.name)  created \(.createdAt)"'
```

If a Vercel credential already exists, skip to [Attach the secret to the groups that use Vercel](#attach-the-secret-to-the-groups-that-use-vercel): a re-run still asks which groups get it.

### Set up Vercel API credential

The agent needs a Vercel personal access token. Tell the user:

> I need your Vercel personal access token. Go to https://vercel.com/account/tokens and create one with these settings:
>
> - **Token name:** `nanoclaw` (or any name you'll recognize)
> - **Scope:** "Full Account" — the agent needs to create projects, deploy, and manage domains
> - **Expiration:** "No expiration" recommended (avoids credential rotation), or pick a date if your security policy requires it
>
> After creating the token, copy it — you'll only see it once.

Once the user provides the token, add it to OneCLI from a file in a private temporary directory. Never put the token in a shell command: any local user can read a running command's text with `ps`. Make the directory:

```bash
mktemp -d "${TMPDIR:-/tmp}/nanoclaw-vercel-token.XXXXXX"
```

Write the token, and nothing else, to `token` in the printed directory with your file-writing tool, not a shell command. Then put the directory in `D` and run the block right away. If you are not going to run it (the user stops, or the token was wrong), delete the directory with `rm -rf` first. OneCLI's own output is dropped, since a gateway error can quote the token. The block also clears a directory of yours that an earlier run left more than 10 minutes ago, when it stopped before this step:

```bash
(
D="<directory printed by mktemp -d>"
trap 'rm -rf "$D"; find -H "${TMPDIR:-/tmp}" -maxdepth 1 -name "nanoclaw-vercel-token.*" -user "$(id -u)" -mmin +10 -exec rm -rf {} + 2>/dev/null' EXIT
onecli secrets create \
  --name "Vercel API Token" \
  --type generic \
  --file "$D/token" \
  --host-pattern "api.vercel.com" \
  --header-name "Authorization" \
  --value-format "Bearer {value}" >/dev/null 2>&1 \
  || { echo "OneCLI did not save the token: check that onecli secrets list works, then ask for the token again" >&2; exit 1; }
)
```

Verify:

```bash
onecli secrets list --max 0 | jq -r '(if type == "array" then . else .data end)[] | select(.hostPattern == "api.vercel.com") | "\(.id)  \(.name)  created \(.createdAt)"'
```

### Attach the secret to the groups that use Vercel

A OneCLI agent receives only the secrets attached to it, and NanoClaw gives a group only its model credential on its own. List the agent groups and ask the user which ones should be able to deploy to Vercel:

```bash
ncl groups list --json --limit 100000 | jq -r '.data[] | "\(.id)  \(.name)"'
```

Put the chosen group ids, comma-separated, in `VERCEL_GROUPS` and run the block. If OneCLI holds more than one Vercel token, the block lists them (id, name, creation time) and stops: ask the user which one they saved and put its id in `VERCEL_SECRET`. The block attaches the Vercel secret to each chosen group's OneCLI agent, creating the agent for a group that has not run yet (NanoClaw adds its model credential on its first spawn). Attaching adds this one secret and leaves each agent's other grants alone; other groups, and groups created later, do not get it:

```bash
(
VERCEL_GROUPS="<agent-group-id>,<agent-group-id>"
VERCEL_SECRET=""
L=$(onecli secrets list --max 0) && [ -n "$(printf '%s' "$L" | tr -d '[:space:]')" ] || { echo "could not list OneCLI secrets" >&2; exit 1; }
T=$(printf '%s' "$L" | jq -c '[(if type == "array" then . else .data end)[] | select(.hostPattern == "api.vercel.com") | {id, name, createdAt}]') || { echo "could not read the OneCLI secret list" >&2; exit 1; }
if [ -n "$VERCEL_SECRET" ]; then
  S=$(printf '%s' "$T" | jq -r --arg s "$VERCEL_SECRET" '.[] | select(.id == $s) | .id'); [ -n "$S" ] || { echo "'$VERCEL_SECRET' is not a Vercel token in OneCLI" >&2; exit 1; }
else
  case "$(printf '%s' "$T" | jq length)" in
    0) echo "no Vercel token in OneCLI yet: save it with the command above first" >&2; exit 1 ;;
    1) S=$(printf '%s' "$T" | jq -r '.[0].id') ;;
    *) echo "more than one Vercel token in OneCLI:" >&2; printf '%s' "$T" | jq -r '.[] | "  \(.id)  \(.name)  created \(.createdAt)"' >&2
       echo "set VERCEL_SECRET to the one to attach (check its name and time; ask if unsure) and run this again" >&2; exit 1 ;;
  esac
fi
G=$(ncl groups list --json --limit 100000) || { echo "could not list agent groups; is the NanoClaw host running?" >&2; exit 1; }
AG=$(onecli agents list --max 0 | jq -ce 'if type == "array" then . else .data end | arrays') || { echo "could not list OneCLI agents" >&2; exit 1; }
for gid in $(printf '%s' "$VERCEL_GROUPS" | tr ',' ' '); do
  gname=$(printf '%s' "$G" | jq -r --arg g "$gid" '.data[] | select(.id==$g) | .name'); [ -n "$gname" ] || { echo "unknown agent group '$gid'; see: ncl groups list" >&2; exit 1; }
  aid=$(printf '%s' "$AG" | jq -r --arg g "$gid" '.[] | select(.identifier==$g) | .id')
  [ -n "$aid" ] || aid=$(onecli agents create --name "$gname" --identifier "$gid" | jq -r '.id // empty'); [ -n "$aid" ] || { echo "could not create a OneCLI agent for $gname ($gid)" >&2; exit 1; }
  onecli agents grants attach-secret --id "$aid" --secret-id "$S" >/dev/null || { echo "could not attach the Vercel secret to $gname ($gid)" >&2; exit 1; }
  echo "Vercel attached to $gname ($gid)"
done
)
```

To add a group later, run the block again with its id. To take Vercel away from one group: `onecli agents grants detach-secret --id <agent-id> --secret-id <vercel-secret-id>`. Check one agent with `onecli agents grants list --id <agent-id>`. This needs a OneCLI gateway with the grants API (1.44 or later; see `/add-onecli`).

## Phase 4: Ensure Vercel CLI in Container Image

The Vercel CLI is not in the agent image by default — this skill is what adds
it. It goes in `container/cli-tools.json` as a json-merge rather than a
Dockerfile edit, which is what keeps the change deterministic and removable.

```bash
grep -q '"vercel"' container/cli-tools.json && echo "PRESENT" || echo "MISSING"
```

If `MISSING`, append the entry, keeping an exact pinned version — the manifest
rejects ranges, so the supply-chain policy still applies:

```json
{ "name": "vercel", "version": "52.2.1" }
```

Then apply it:

```bash
./container/build.sh
```

On an install that builds its own image, that rebuilds it. On one that fetches a
published image, the same command adds Vercel as a single layer on top of the
image already there, so the publisher's patched components underneath are kept —
you are adding a tool, not replacing the runtime. The command says what that does
and does not cover.

If `PRESENT`, the CLI is already in the manifest — skip the rebuild.

## Phase 4b: Copy and Run the Dependency Guard

The Vercel CLI is a globally-installed binary — not importable or typed — so a structural test guards the install. Copy it into the host test tree and run it:

```bash
cp .claude/skills/add-vercel/vercel-manifest.test.ts src/vercel-manifest.test.ts
pnpm exec vitest run src/vercel-manifest.test.ts
```

The test asserts both halves of the install: a pinned `vercel` entry in `container/cli-tools.json`, and the container skill at `container/skills/vercel-cli/`. Either alone is a broken install — a manifest entry with no skill leaves the agent a binary nobody told it about, and a skill with no entry tells it to run a command that is not there.

## Phase 5: Sync Skills to Running Agent Groups

Container skills are copied once at group creation and not auto-synced. After installing or updating a container skill, sync it to all existing agent groups:

```bash
for session_dir in data/v2-sessions/ag-*; do
  if [ -d "$session_dir/.claude-shared/skills" ]; then
    rsync -a container/skills/ "$session_dir/.claude-shared/skills/"
    echo "Synced skills to: $session_dir"
  fi
done
```

## Phase 6: Restart Running Containers

Stop all running agent containers so they pick up the new skills on next wake:

```bash
docker ps --filter label=nanoclaw-session -q | xargs -r docker stop
```

## Done

The agent can now deploy web applications to Vercel. Key commands:

- `vercel deploy --yes --prod --token placeholder` — deploy to production
- `vercel ls --token placeholder` — list deployments
- `vercel whoami --token placeholder` — check auth

For the full command reference, the agent has the `vercel-cli` container skill loaded automatically.
