---
name: update-nanoclaw
description: Transactionally update a customized NanoClaw checkout from official upstream without exposing live mounted source, with fork-safe skill refresh, mutable-state snapshots, migration gates, exact-code upgrade markers, detected service restart, health verification, and automatic local rollback. Use for routine merge, rebase, or selective upstream updates.
---

# Update NanoClaw

Update a customized install through an isolated, resumable transaction. The
live checkout is not touched until the staged result has passed validation.

Use ordinary conversation for decisions and confirmations. Do not depend on
Claude Code, Codex, OpenCode, or any provider-specific question/skill tool.

## Safety contract

- Require a clean live checkout.
- Stage Git integration, dependency installation, installed-skill refresh, and
  tests in a separate worktree.
- Resolve registry branches from the remote that actually carries them.
- Stop the detected service and drain this install's active containers before
  changing source mounted into agent containers.
- Snapshot `.env`, `data/`, `groups/`, `store/`, and manual-service state before
  cutover. Sockets and other ephemeral special files are intentionally omitted.
- Gate every breaking migration and external version-pin move.
- Stamp the exact Git commit/tree only after all required work succeeds.
- Restart through the detected launchd, user-systemd, system-systemd, or nohup
  mode; require process state, `data/ncl.sock`, and `bin/ncl groups list`.
- Refuse cutover while an unmanaged `pnpm dev`/Node host is running. Stop that
  process explicitly, update offline, then start it again manually.
- On build or health failure, restore Git and the mutable-state snapshot, rebuild
  the previous image, restart the previous service, and health-check it.

## 1. Load the newest controller without changing the live tree

Confirm the live tree is clean:

```bash
git status --porcelain
```

Stop if it prints anything.

Use the official remote if one already exists. Otherwise add it as `upstream`:

```bash
if git remote get-url upstream >/dev/null 2>&1; then
  upstream_remote=upstream
elif git remote get-url origin 2>/dev/null | grep -Eq '(^|[:/])nanocoai/nanoclaw(.git)?$'; then
  upstream_remote=origin
else
  git remote add upstream https://github.com/nanocoai/nanoclaw.git
  upstream_remote=upstream
fi
git fetch "$upstream_remote" --prune
```

Select `main` when present, otherwise `master`:

```bash
if git show-ref --verify --quiet "refs/remotes/$upstream_remote/main"; then
  upstream_ref="$upstream_remote/main"
elif git show-ref --verify --quiet "refs/remotes/$upstream_remote/master"; then
  upstream_ref="$upstream_remote/master"
else
  echo "Official remote has neither main nor master" >&2
  exit 1
fi
```

Materialize the newest controller from that ref. This is the self-update seam:
an older local skill still executes the newest safety code before any mutation.

```bash
controller_dir="$(mktemp -d)"
git archive "$upstream_ref" \
  scripts/update-nanoclaw.ts scripts/update scripts/update-skills.ts \
  scripts/skill-apply.ts scripts/skill-directives.ts src/install-slug.ts \
  | tar -x -C "$controller_dir"
```

## 2. Choose the Git strategy and prepare

Default to `merge`. Use `rebase` only when the user explicitly wants linear
history. Use `cherry-pick` only with an explicit comma-separated commit list.

```bash
pnpm exec tsx "$controller_dir/scripts/update-nanoclaw.ts" prepare \
  --project-root "$PWD" --upstream-ref "$upstream_ref" --strategy merge
```

The JSON result is `nanoclaw-update/v1`. Record its `id`, `stageRoot`, backup
branch/tag, changed files, and requirements. The live `HEAD` is still unchanged.

If `phase` is `conflict`, resolve conflicts only inside `stageRoot`, preserving
intentional local customizations. Complete the merge/rebase/cherry-pick there,
commit it, then run:

```bash
pnpm exec tsx "$stageRoot/scripts/update-nanoclaw.ts" resume \
  --project-root "$PWD" --id "$id"
```

Show the user the upstream commits, changed-file buckets, requirements, and any
resolved conflicts. To stop with no live mutation:

```bash
pnpm exec tsx "$stageRoot/scripts/update-nanoclaw.ts" abandon \
  --project-root "$PWD" --id "$id"
```

## 3. Validate the staged result

```bash
pnpm exec tsx "$stageRoot/scripts/update-nanoclaw.ts" validate \
  --project-root "$PWD" --id "$id"
```

Validation performs a fork-safe structured refresh of every installed channel
and provider, commits refreshed payloads in the staging branch, installs frozen
dependencies, runs the host build and full host tests, and runs the container
dependency/typecheck leg when Bun is available. A provider skill that declares
Bun dependencies does not require Bun on the host: refresh runs the exact Bun
version pinned by `container/Dockerfile` through pnpm. Any selected skill
refresh or validation failure blocks cutover and the completion stamp.

Fix only failures caused by the staged update, inside `stageRoot`, commit the
fix, and re-run validation. Do not mutate the live checkout to repair staging.

## 4. Confirm and cut over

Before downtime, show the exact changed files, required migrations, detected
backup tag, and rollback command. Ask for one confirmation to begin cutover.

```bash
pnpm exec tsx "$stageRoot/scripts/update-nanoclaw.ts" cutover \
  --project-root "$PWD" --id "$id"
```

Cutover stops the detected service, waits for this install's labeled agent
containers to exit, snapshots mutable state, resets the live branch to the
validated target, installs frozen dependencies, builds the host, and updates
the agent image when `container/` changed. Hardened-image installs use `pull`;
local-image installs build locally. The service remains stopped while required
migrations are pending.

## 5. Complete every requirement

Process requirements one at a time.

- For a referenced local guide, read it from the cut-over checkout and follow
  its detect, fix, verify, and rollback sections.
- For a referenced `/<skill>`, read that skill's current `SKILL.md` and follow
  it directly. Do not require a harness-specific skill invocation feature.
- For OneCLI pin moves, follow `docs/onecli-upgrades.md`; record the exact old
  version or rollback command because OneCLI is outside the Git snapshot.

If a migration intentionally changes tracked files, review and commit those
changes before acknowledging it. Finish refuses a dirty cut-over checkout.

After verification, acknowledge the requirement:

```bash
pnpm exec tsx "$stageRoot/scripts/update-nanoclaw.ts" ack \
  --project-root "$PWD" --id "$id" \
  --requirement "$requirement_id" --status succeeded
```

For an external component, also pass a concise exact rollback instruction:

```bash
... ack ... --rollback "restore onecli-gateway to <old-version>"
```

Use `--status failed` when verification fails. A pending or failed requirement
blocks finish; never offer “restart anyway.” The state snapshot is the recovery
path for forward local migrations.

## 6. Finish and health-check

```bash
pnpm exec tsx "$stageRoot/scripts/update-nanoclaw.ts" finish \
  --project-root "$PWD" --id "$id"
```

Finish stamps the exact version/commit/tree, restarts the service mode detected
before cutover, and waits for the process, CLI socket, and a real CLI request.
Only `phase: complete` is success.

After success, remove the staging worktree and its temporary branch from the
live checkout. This keeps the backup branch/tag and mutable snapshot intact for
rollback:

```bash
pnpm exec tsx scripts/update-nanoclaw.ts cleanup --id "$id"
```

If health fails, the controller restores the previous Git commit and mutable
state, rebuilds the previous image, restarts the old service, and verifies it.
If an external component was changed, also execute the recorded external
rollback instruction and verify that component; Git cannot restore it.

## 7. Report and retain one rollback point

Report:

- transaction id and final phase;
- old, target, and official upstream commits;
- backup branch/tag and mutable snapshot location;
- conflicts resolved;
- registry remotes and refreshed skills;
- validation and image result;
- completed migrations and external rollback instructions;
- detected service mode and health result; and
- remaining diff from official upstream.

Manual rollback remains available while the snapshot is retained:

```bash
pnpm exec tsx scripts/update-nanoclaw.ts rollback --id "$id"
```

Do not describe the Git tag alone as full rollback. The transaction snapshot is
what restores SQLite and other mutable local state. Keep the newest successful
transaction until the next update completes. Then preview older terminal
transactions that are safe to prune:

```bash
pnpm exec tsx scripts/update-nanoclaw.ts prune --id "$id" --dry-run
```

Show the `removed` list and ask for confirmation. If confirmed, run the same
command without `--dry-run`. Pruning keeps the selected transaction, every
newer transaction, and every nonterminal transaction. It removes older terminal
snapshots and their staging/backup Git references. Never delete transaction
directories directly.
