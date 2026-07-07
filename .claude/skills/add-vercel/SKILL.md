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

### Check if Vercel credential already exists

```bash
onecli secrets list 2>/dev/null | grep -i vercel
```

If a Vercel credential already exists, skip to Phase 4.

### Set up Vercel API credential

The agent needs a Vercel personal access token. Tell the user:

> I need your Vercel personal access token. Go to https://vercel.com/account/tokens and create one with these settings:
>
> - **Token name:** `nanoclaw` (or any name you'll recognize)
> - **Scope:** "Full Account" — the agent needs to create projects, deploy, and manage domains
> - **Expiration:** "No expiration" recommended (avoids credential rotation), or pick a date if your security policy requires it
>
> After creating the token, copy it — you'll only see it once.

Once the user provides the token, add it to OneCLI:

```bash
onecli secrets create \
  --name "Vercel API Token" \
  --type generic \
  --value "<TOKEN>" \
  --host-pattern "api.vercel.com" \
  --header-name "Authorization" \
  --value-format "Bearer {value}"
```

Verify:

```bash
onecli secrets list | grep -i vercel
```

### Assign the secret to all agents

OneCLI uses selective secret mode — secrets must be explicitly assigned to each agent. Get the Vercel secret ID from the output above, then assign it to every agent:

```bash
# set-secrets replaces the entire list — read and merge for each agent.
VERCEL_SECRET_ID=$(onecli secrets list | jq -r '.data[] | select(.name | test("(?i)vercel")) | .id' | head -1)
for agent in $(onecli agents list | jq -r '.data[].id'); do
  CURRENT=$(onecli agents secrets --id "$agent" | jq -r '[.data[]] | join(",")')
  MERGED=$(printf '%s' "$CURRENT,$VERCEL_SECRET_ID" | tr ',' '\n' | sort -u | paste -sd ',' -)
  onecli agents set-secrets --id "$agent" --secret-ids "$MERGED"
done
```

## Phase 4: Ensure Vercel CLI in Container Image

The Vercel CLI is installed globally in the agent image via `container/Dockerfile`. Check for both halves of the install — the pinned version arg and the install line:

```bash
grep -Eq '^ARG VERCEL_VERSION=' container/Dockerfile && \
  grep -Eq 'pnpm install -g "?vercel@\$\{VERCEL_VERSION\}"?' container/Dockerfile && \
  echo "PRESENT" || echo "MISSING"
```

If `MISSING`, add a pinned `ARG VERCEL_VERSION=52.2.1` near the other version args and a `pnpm install -g "vercel@${VERCEL_VERSION}"` step in the global-install block of `container/Dockerfile`, then rebuild the image:

```bash
./container/build.sh
```

If `PRESENT`, the CLI is already in the image — skip the rebuild.

## Phase 4b: Copy and Run the Dependency Guard

The Vercel CLI is a globally-installed binary — not importable or typed — so a structural test guards the Dockerfile install. Copy it into the host test tree and run it:

```bash
cp .claude/skills/add-vercel/vercel-dockerfile.test.ts src/vercel-dockerfile.test.ts
pnpm exec vitest run src/vercel-dockerfile.test.ts
```

The test parses `container/Dockerfile` and asserts both the `ARG VERCEL_VERSION=...` and the `pnpm install -g "vercel@${VERCEL_VERSION}"` line are present. It goes red if either is dropped or drifts.

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
docker ps --format "{{.ID}} {{.Names}}" | grep nanoclaw-v2 | awk '{print $1}' | xargs -r docker stop
```

## Done

The agent can now deploy web applications to Vercel. Key commands:

- `vercel deploy --yes --prod --token placeholder` — deploy to production
- `vercel ls --token placeholder` — list deployments
- `vercel whoami --token placeholder` — check auth

For the full command reference, the agent has the `vercel-cli` container skill loaded automatically.
