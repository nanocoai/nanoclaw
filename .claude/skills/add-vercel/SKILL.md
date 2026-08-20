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

Verify OneCLI is working (required for credential injection). Every later phase
talks to the **gateway**, not to the CLI binary — a present binary with a dead
gateway would pass a `command -v` style check and then fail halfway through
Phase 3 with the vault half-configured. `onecli version` prints the
reachability signal in its own output (`{"version":…,"server_version":…,"server_status":"ok"}`),
so gate on that field:

```bash
onecli version 2>/dev/null | jq -e '.server_status == "ok"' >/dev/null \
  && echo "ONECLI_OK" || echo "ONECLI_UNAVAILABLE"
```

If `ONECLI_UNAVAILABLE`, the binary is missing **or** the gateway is down. Run
`onecli version` and show the user the raw output, then tell them to run
`/init-onecli` (missing binary) or start the gateway (`onecli up`, or Docker
Desktop if the gateway container is not running) and retry `/add-vercel`. Stop here.

## Phase 2: Install Container Skill

Copy the bundled container skill into the container skills directory:

```bash
rsync -a .claude/skills/add-vercel/container-skills/ container/skills/
```

Verify:

```bash
head -5 container/skills/vercel-cli/SKILL.md
```

`container/skills/` is the single source of truth: it is bind-mounted read-only
into every container at `/app/skills`, and each group's
`.claude-shared/skills/<name>` entry is a **symlink** to `/app/skills/<name>`
planted at spawn time. One copy here reaches every group — see Phase 5.

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

Once the user provides the token, add it to OneCLI. The `--header-name` /
`--value-format` pair is load-bearing, not decoration: it is what makes the
gateway rewrite the `Authorization` header the Vercel CLI sends (see
`container/skills/vercel-cli/SKILL.md` → Auth). A secret created without
`--header-name` injects as a query parameter instead, and every `vercel`
command then ships the placeholder token to Vercel and gets a 403.

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

### Assign the secret — only for agents in `selective` mode

Auto-created agents default to `all` secret mode: every vault secret whose
host pattern matches is injected automatically, so **on a default install
Phase 3 ends here**. Do not put agents on the selective path to add this
credential — a mistake there silently kills credential injection for that
agent (the symptom is a 401/403 from an API whose credential *is* in the vault).

Only agents already in `selective` mode need an explicit assignment. Merging is
done in `jq`, not in shell: `set-secrets` **replaces** the whole list, and the
assigned list may come back as ids or as objects, so a shell `printf`/`tr`
merge produces a leading empty element (`--secret-ids ",sec-…"`) which onecli
rejects.

```bash
VERCEL_SECRET_ID=$(onecli secrets list | jq -r '.data[] | select(.name | test("(?i)vercel")) | .id' | head -1)
[ -n "$VERCEL_SECRET_ID" ] || { echo "FAILED: no Vercel secret in the vault — redo the previous step"; exit 1; }

SELECTIVE=$(onecli agents list | jq -r '.data[] | select(.secretMode != "all") | .id')
if [ -z "$SELECTIVE" ]; then
  echo "All agents are in 'all' secret mode — nothing to assign."
else
  for agent in $SELECTIVE; do
    MERGED=$(onecli agents secrets --id "$agent" \
      | jq -r --arg id "$VERCEL_SECRET_ID" \
          '[(.data[]? | if type == "object" then .id else . end)] + [$id] | unique | join(",")')
    [ -n "$MERGED" ] || { echo "FAILED: could not read assigned secrets for $agent"; exit 1; }
    onecli agents set-secrets --id "$agent" --secret-ids "$MERGED" \
      || { echo "FAILED: could not assign the Vercel secret to $agent"; exit 1; }
  done
fi
```

If you would rather stop managing per-agent lists, the supported alternative is
`onecli agents set-secret-mode --id <agent-id> --mode all`.

## Phase 4: Ensure Vercel CLI in Container Image

The Vercel CLI is not in the agent image by default — this skill is what adds
it. It goes in `container/cli-tools.json` as a json-merge rather than a
Dockerfile edit, which is what keeps the change deterministic and removable.

Key the idempotency check on **the image**, not on the manifest text. A
manifest entry with no rebuild is exactly the broken state this skill must not
report as done: the agent loads the `vercel-cli` skill, follows it, and finds
no `vercel` binary on `PATH`.

```bash
. setup/lib/install-slug.sh
IMAGE="$(container_image_base):latest"
docker run --rm --entrypoint sh "$IMAGE" -c 'command -v vercel' >/dev/null 2>&1 \
  && echo "IMAGE_HAS_VERCEL" || echo "IMAGE_MISSING_VERCEL"
```

`sh -c`, not `sh -lc`: the global CLIs live in `/pnpm`, which is on the image's
`ENV PATH` — and a login shell re-reads `/etc/profile`, which resets `PATH`
without it. Under `-lc` even `agent-browser` looks missing, so the probe would
report `IMAGE_MISSING_VERCEL` forever no matter how many times you rebuild.

(If the install sets `CONTAINER_RUNTIME` in `.env` to something other than
`docker` — podman, nerdctl — use that binary here and in Phase 6.)

Make sure the manifest carries the entry either way, with an exact pinned
version — the manifest rejects ranges, so the supply-chain policy still
applies:

```json
{ "name": "vercel", "version": "52.2.1" }
```

Then, **only if `IMAGE_MISSING_VERCEL`**, apply it:

```bash
./container/build.sh
```

On an install that builds its own image, that rebuilds it. On one that fetches a
published image, the same command adds Vercel as a single layer on top of the
image already there, so the publisher's patched components underneath are kept —
you are adding a tool, not replacing the runtime. The command says what that does
and does not cover.

Re-run the `docker run … command -v vercel` probe afterwards and only continue
once it prints a path.

## Phase 4b: Copy and Run the Dependency Guard

The Vercel CLI is a globally-installed binary — not importable or typed — so a structural test guards the install. Copy it into the host test tree and run it:

```bash
cp .claude/skills/add-vercel/vercel-manifest.test.ts src/vercel-manifest.test.ts
pnpm exec vitest run src/vercel-manifest.test.ts
```

The test asserts both halves of the install: a pinned `vercel` entry in `container/cli-tools.json`, and the container skill at `container/skills/vercel-cli/`. Either alone is a broken install — a manifest entry with no skill leaves the agent a binary nobody told it about, and a skill with no entry tells it to run a command that is not there. It cannot see the image, which is why Phase 4 probes that separately.

Then run the whole host suite once, because the copied test now lives in it:

```bash
pnpm exec vitest run
```

`container/cli-tools.test.ts` guards the manifest's *shape* (unique names, exact
semver, only keys the installer reads, Dockerfile wiring) and deliberately does
not name individual tools, so an appended `vercel` entry keeps it green.

## Phase 5: Make the Skill Visible to Existing Agent Groups

**Do not copy `container/skills/` into `data/v2-sessions/*/.claude-shared/skills/`.**
Those entries are symlinks into the read-only `/app/skills` mount, planted (and
pruned) on every spawn by `syncSkillSymlinks` in `src/container-runner.ts`. A
real directory at that path permanently shadows the shared mount — the host logs
`Shared skill not symlinked: real entry occupies the path` and the group is
frozen at whatever bytes were copied, for *every* skill copied, not just this one.

For groups whose config is `skills: "all"` (the default) there is nothing to do:
`selectedSkillNames` recomputes the list from `container/skills/` at spawn, so
`vercel-cli` appears on the next wake. Confirm which groups are not on `"all"`:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT agent_group_id, skills FROM container_configs WHERE skills <> '\"all\"'"
```

If that prints nothing, Phase 5 is done. For each group it does print, add
`vercel-cli` to that group's list — `ncl groups config update` has no
`--skills` flag, so write the JSON array back directly (verify with
`ncl groups config get --id <group-id>` afterwards):

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "UPDATE container_configs
      SET skills = json_insert(skills, '\$[#]', 'vercel-cli')
    WHERE agent_group_id = '<group-id>'
      AND skills <> '\"all\"'
      AND NOT EXISTS (SELECT 1 FROM json_each(skills) WHERE value = 'vercel-cli')"
```

Finally, clear any real directory left at the shared-skill path by an older
version of this skill (it would shadow the symlink). `vercel-cli` is never a
template-stamped skill, so removing this one name is safe — do not widen the
glob:

```bash
for d in data/v2-sessions/*/.claude-shared/skills/vercel-cli; do
  [ -d "$d" ] && [ ! -L "$d" ] && rm -rf "$d" && echo "removed stale copy: $d"
done
```

If that loop found anything, an older `/add-vercel` also froze the group's
*other* shared skills, and the host will log `Shared skill not symlinked: real
entry occupies the path` for each on the next spawn. Those are the same stale
copies, but this skill must not delete them blind: a template-stamped skill is
legitimately a real directory at that path. Show the operator the warned names
and let them confirm which are stale before removing any.

## Phase 6: Restart Running Containers

Restart per group through the supported path, so only this install is touched:

```bash
for id in $(pnpm exec tsx scripts/q.ts data/v2.db "SELECT id FROM agent_groups"); do
  ncl groups restart --id "$id"
done
```

If `ncl` is unavailable, stop the containers directly — but scope the filter to
**this install's slug**, or you stop every other NanoClaw install's agent
containers on the same host:

```bash
. setup/lib/install-slug.sh
SLUG="$(container_image_base)"; SLUG="${SLUG##*-}"
docker ps --filter "label=nanoclaw-install=$SLUG" --filter "label=nanoclaw-role=agent" -q \
  | xargs -r docker stop
```

Containers come back on the next user message.

## Done

The agent can now deploy web applications to Vercel. Key commands:

- `vercel deploy --yes --prod --token placeholder` — deploy to production
- `vercel ls --token placeholder` — list deployments
- `vercel whoami --token placeholder` — check auth

`--token placeholder` is not a stand-in for a step you skipped: the CLI puts
whatever it is given into `Authorization: Bearer …`, and the gateway overwrites
that header with the vault value (Phase 3's `--header-name Authorization`).
Confirm the whole chain once, from inside a container:

```bash
ncl groups restart --id <group-id> --message "Run: vercel whoami --token placeholder — report the exact output"
```

Expect the Vercel username. If the agent reports `The token provided via
'--token' argument is not valid`, the placeholder reached Vercel unrewritten —
re-check that the secret was created with `--header-name "Authorization"` and
`--host-pattern "api.vercel.com"`, and that the group's container has the
gateway proxy env (`/debug` shows it).

For the full command reference, the agent has the `vercel-cli` container skill loaded automatically.
