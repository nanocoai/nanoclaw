# Updating to NanoClaw 2.4

Use the supported `/update-nanoclaw` transaction for an existing installation. It stages source, dependencies, installed skills, and tests before cutover; it snapshots mutable state and checks service health before considering the update complete. A raw `git pull` does not perform those steps and trips the upgrade tripwire; see [upgrade recovery](upgrade-recovery.md).

This guide covers changes since v2.3.0. Installations starting earlier must also complete the migration actions in the intervening [CHANGELOG.md](../CHANGELOG.md) entries.

## Before you start

Decide now whether to keep today's defaults. Three of them change in 2.4.0 and two of them change your bill:

- **Claude groups with no model set move to Opus 5.5.** API-key installs move from Opus 5, Pro and Team Standard installs from Sonnet.
- **New Codex threads start on `gpt-6-astra`.** `/add-codex` pins `@openai/codex` 0.155.1; existing threads keep the model they started on.
- **Claude agents default to a concise tone** unless the group already sets `outputStyle`.

Back up first:

```bash
cp -a data data.bak-$(date +%F) && cp .env .env.bak-$(date +%F)
```

To pin models before the update:

```bash
# Every group without its own model (applies to Claude and Codex groups alike)
echo 'NANOCLAW_DEFAULT_MODEL=<model>' >> .env

# One group
ncl groups config update --id <group> --model <model>

# A Codex group that should stay on the old default
ncl groups config update --id <group-id> --model gpt-5.6-sol && ncl groups restart --id <group-id>
```

To keep or change the tone, set `outputStyle` in `data/v2-sessions/<agent-group-id>/.claude-shared/settings.json` (the group's `/home/node/.claude/settings.json`). An explicit value is never overwritten.

## Read the fetched update instructions first

The update skill shipped with 2.3 extracts an incomplete controller archive and fails with `MODULE_NOT_FOUND` before an update is prepared, even when the new target has the corrected instructions. Fetch the intended official source without changing the live checkout, then read the skill from that fetched ref.

Use the remote you have verified points to `nanocoai/nanoclaw`; it is named `upstream` below. Use `origin` instead if that is your official remote.

```bash
git remote get-url upstream
git fetch upstream --prune
upstream_ref=refs/remotes/upstream/main
git show "$upstream_ref":.claude/skills/update-nanoclaw/SKILL.md
```

To select a published release instead of `main`, fetch its exact tag and read the skill from that tag. The fetched skill's first step selects `main` or `master` by default; after that selection, and before the controller extraction, replace `upstream_ref` with your fetched release tag or its commit, and keep that same value for both the extraction and the `prepare --upstream-ref` argument so the update stages the release you chose.

Follow the instructions from that ref, including its extraction of the complete `scripts/` tree and `src/install-slug.ts`; do not reuse the old local archive list.

## Standard installations

Keep a clean checkout and finish any active setup, including a pending community-portal Slack installation. Follow the fetched update skill to prepare the update in its separate staging worktree.

Let staged validation refresh installed skills, build, and test. `/update-nanoclaw` reapplies your credential gateway (OneCLI stays OneCLI), refreshes installed skills including the Codex 0.155.1 pin, and rebuilds the agent image if your install builds its own. It does not migrate the live database: cutover stops the service and snapshots mutable state before changing the live source, and SQLite migrations run when the host starts during finish, after that snapshot. This release adds approval-instance, host-coordination, and speed schema changes.

Cutover stops this install's agent containers itself (10-second grace, one-minute bound) and names them as it goes; no manual `docker stop` is needed. An agent in the middle of a turn loses that turn, as with `ncl groups restart`.

Complete the requirements the controller lists (the two `[BREAKING]` entries from the changelog), acknowledge them, then let finish restart and health-check the service. Keep the transaction ID and backup while checking your existing agents, an installed channel or provider, and a scheduled task.

Claude, Codex and OpenCode use provider contracts. Do not infer support for a new provider from the existence of the shared contract API.

When editing `NANOCLAW_DEFAULT_MODEL` or `NANOCLAW_FAST_MODE` in the host `.env`, the new value is read when a group's container.json is next materialized, so it takes effect on that group's next container start with no host restart. A group's own model or `--speed` setting also applies on its next container start. Fast serving tiers cost more per token.

## Credential gateway

Gateways now install through skills: `/add-onecli` supplies OneCLI and `/add-iron-proxy` adds Iron Proxy. `/update-nanoclaw` detects the existing selection and applies that gateway's skill before cutover, so a standard installation needs no action. Existing installations keep their selected gateway; Iron Proxy is offered in advanced setup for new installations, and this release does not document an in-place switch from OneCLI.

A fork that merges upstream by hand must materialize its gateway before restarting: setting `NANOCLAW_GATEWAY_PROVIDER` alone does not install the implementation, and the host refuses to start without a registered gateway. Apply `/add-onecli` (or the skill for the gateway already selected) and confirm `.env` records the matching `NANOCLAW_GATEWAY_PROVIDER`. Detection, verification and rollback are in [gateway migration](gateway-seam.md#migrating-an-existing-installation).

## Custom instruction composition

Search custom source before cutover:

```bash
grep -rn --exclude='*.test.ts' "claude-md-compose\|composeGroupClaudeMd\|claude-fragments" src/ setup/ scripts/
```

No matches means no source migration for this seam; a stock tree returns nothing. Otherwise:

1. Change imports from `claude-md-compose` to `project-doc-compose`.
2. Replace `composeGroupClaudeMd(group)` with an awaited `composeGroupProjectDoc(group, groupDir, DEFAULT_PROJECT_DOC)` call, using the intended group's directory. Import both names from the new module.
3. Remove custom reliance on the old `/app/CLAUDE.md` and `/workspace/agent/.claude-fragments` mounts. The generated document now contains the instruction sections inline.

Legacy `.claude-fragments` directories and `.claude-shared.md` files under group directories are inert; nothing reads them. Clear them once, after backing up anything your custom code still owns:

```bash
rm -rf groups/*/.claude-fragments groups/*/.claude-shared.md
```

Run the project-document tests and inspect one generated group document. Confirm that it contains the expected capability sections and preserves your intended persona and instructions:

```bash
pnpm exec vitest run src/project-doc-compose.test.ts
pnpm run typecheck
```

## OpenCode installations

The optional `/add-opencode` skill now uses the native provider contracts, and the new contract refuses the old payload. Existing OpenCode installs must:

1. Re-run `/add-opencode` to refresh the payload.
2. Rebuild the agent image with `./container/build.sh build`.
3. Restart the host and the OpenCode groups (`ncl groups restart --id <group>`).

OpenCode can now store API keys and native ChatGPT OAuth credentials through Iron Control when Iron Proxy is the gateway.

## Provisional provider contracts

This section applies to custom provider payloads that adopted a provisional contract shape. Supported pre-contract providers retain their compatibility path.

| Removed declaration              | Required adjustment                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `skillBackings[].sharedLinks`    | Remove it; core always synchronizes shared skill links.                                |
| `files[].prepare.mode`           | Remove it; prepared files use the process default mode.                                |
| `projectDocument.baseDocumentFile` | Remove the provider-owned base document declaration; core owns the canonical instructions. |
| `projectDocument.extraSections`  | Replace free-form contract sections with supported typed instruction facts.            |

First refresh the installed provider from its registry source (`/update-skills`). For a custom provider, compare its runtime and host declarations with the shipped contract types, update its conformance tests, and run the installation verifier. For example, a declared Codex installation can require the Codex contract while other installed providers keep their supported path:

```bash
pnpm exec tsx scripts/provider-contract-verifier.ts --required-declared codex
```

Use your actual declared provider name in place of `codex`. A failed verifier is a stop before restart, not permission to disable registration checks.

## Container image choice

The hardened image reference in `versions.json` and a local build from this source are different delivery paths. The pinned image is `hardened-2026-08-24` and runs Bun 1.4.0; local builds pick up Claude Code 2.1.280. Follow the [hardened-image guide](hardened-image.md) for selection, compatibility diagnostics, and the local-build recovery path.

## Optional after updating

- Community-portal enrollment is optional for existing installations. If you use it, verify sign-in and whichever perks you enabled: the selected Echo image and a real Slack reply. See [the community portal](community-portal.md).
- Per-group fast serving: `ncl groups config update --id <group> --speed fast` (`--speed ""` clears it).
- Mattermost: `/add-mattermost`.
- Slack pasted tables reach the agent after a `/add-slack` refresh.

## Verification and rollback

For an installation whose service was running before the update, finish checks the restarted service, `data/ncl.sock`, and a real `bin/ncl groups list` request. If you updated an offline installation, start its service deliberately and make those checks yourself. Then send a controlled message through an existing agent, check that `ncl groups list` shows the models you expect, and check that an existing scheduled task is still usable. Keep the transaction backup until these ordinary installation checks pass.

If staged validation fails, the live source and data have not changed and no cutover snapshot exists yet. Repair the staged checkout and revalidate, or use the transaction's abandon command to leave the existing installation as it was.

After cutover, use the recorded transaction's rollback path if recovery is needed: `pnpm exec tsx scripts/update-nanoclaw.ts rollback --id <transaction-id>`. A build or finish health failure invokes local rollback automatically. Rollback restores the previous source and mutable-state snapshot, rebuilds the prior image, and restarts and health-checks a service that was previously active. Do not reset only Git while leaving newly migrated data in place. External services such as OneCLI or Iron Proxy need their separately recorded restore steps; a local snapshot does not reverse them.
