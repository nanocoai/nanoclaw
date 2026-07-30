# Remove migrate-from-openclaw

This skill copies a small, fixed set of files into the project tree. Removal
deletes exactly those. It does **not** undo the migration itself — the agents,
messaging groups, wirings, roles, `.env` channel tokens, and OneCLI vault
secrets the migration created are your live NanoClaw install, not skill files.
Undoing those is a separate decision (see the last section).

Idempotent: every step skips cleanly if the file is already gone.

## 1. Remove the copied transform module and its test

These are the only files the skill installs into the project's source tree (the
validate step in Phase 8 copies them into `scripts/` so vitest runs them):

```bash
rm -f scripts/openclaw-transform.ts scripts/openclaw-transform.test.ts
```

## 2. Remove the migration state file

```bash
rm -f migration-state.md
```

## 3. Remove deferred-task notes (if Phase 5 deferred any)

When a task couldn't be scheduled yet, the skill records it per group:

```bash
rm -f groups/*/openclaw-migration-tasks.md
```

## 4. Migrated content files (review before deleting)

These are content you chose to bring over, now part of your agent groups. Delete
only the ones you no longer want — review each first.

- Identity / personality: `groups/*/instructions.prepend.md` and the memory
  concepts recorded for identity reference material
- User context and memories: the destination files recorded in the migration's
  source-to-destination summary under `groups/*/memory/`
- Copied OpenClaw skills: directories you added under `container/skills/`
  (compare against the stock set before removing — do not delete
  `onecli-gateway`, `welcome`, `self-customize`, `agent-browser`,
  `slack-formatting`, or other shipped container skills).

Per-group standing instructions live in `groups/<folder>/instructions.prepend.md`;
durable facts live under `groups/<folder>/memory/`. Review and revert only the
OpenClaw-derived entries by hand if desired.

## 5. Rebuild if you removed copied skills

If step 4 deleted any `container/skills/` directories:

```bash
./container/build.sh
```

Then restart the service from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
# Linux
systemctl --user restart $(systemd_unit)
```

## 6. Undo the migration itself (optional, destructive)

This reverses the live install state the migration produced — only do it to
fully back out. Use `ncl` to inspect first:

```bash
ncl wirings list
ncl messaging-groups list
ncl groups list
ncl roles list
```

Then delete what the migration added with the matching `ncl ... delete` /
`ncl roles revoke` / `ncl members remove` verbs. Remove migrated channel tokens
from `.env`, and remove vault secrets with `onecli secrets delete` (list them
with `onecli secrets list`). There is no automatic rollback — delete only the
entities you recognize as migration output.
