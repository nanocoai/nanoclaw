---
name: add-rtk
description: Install the rtk token-compression proxy into NanoClaw agent containers and route an agent group's Bash tool calls through it, for 60-90% fewer output tokens on common dev commands (git, cargo, pytest, docker, kubectl). Use when an agent's command output is eating its context.
---

# Add rtk

[rtk](https://github.com/rtk-ai/rtk) is a CLI proxy that filters and summarizes command output before it reaches the model — 60-90% fewer tokens on common dev commands. This skill puts the pinned `rtk` binary in the agent container image and wires a chosen agent group's `Bash` tool calls through it with the Claude Code `PreToolUse` hook, so the agent needs no instructions: it runs `git status`, the hook rewrites the call to `rtk git status`, and the model sees the compressed output.

## What this sets up

- `rtk 0.45.0` at `/usr/local/bin/rtk` in the agent image — a pinned `binary` entry in `container/cli-tools.json`, fetched from the upstream release archive for the image's architecture with its SHA-256 verified at build time. `/usr/local/bin` is on the container PATH, which the hook's rewritten `rtk <command>` depends on. Install-wide: one image, every group.
- A `PreToolUse` hook in one agent group's `settings.json`, matching `Bash` and running `rtk hook claude`. Per-group opt-in: adding rtk to the image changes no agent's behavior until a group gets this hook.

## Integration tests

This skill ships `rtk-manifest.test.ts`, copied into `src/` on apply (Phase 3). It guards all three things that can silently break the feature:

- the manifest entry — pinned version, both architectures, exact checksums, and that rtk is installed as a **release binary, not from npm** (see Phase 1);
- the `PreToolUse` hook write — the `jq` programs in this document and in `REMOVE.md` are extracted and run against a fixture `settings.json`, asserting the hook lands once, survives a re-run, leaves other hooks alone, and is fully removed by `REMOVE.md`;
- the container lookup in Verify — asserted against the real driver: `src/drivers/types.ts` labels and `agentContainerName()`, so a filter that could never match a running container goes red here instead of at the operator's terminal.

## Phase 1 — Preflight

**rtk is not an npm package.** `rtk` on the npm registry is `cliffano/rtk`, an unrelated release-versioning tool that also installs a binary called `rtk` — installing it would give the agent the wrong program under the right name. Upstream ships prebuilt release archives instead, so rtk goes into the image as a `binary` manifest entry: a per-architecture URL plus a SHA-256, which is the pin an exact npm version provides for the npm entries (`container/cli-tools.json`, `container/install-cli-tools.sh`).

Confirm the pinned artifacts are still the ones this skill checksums, before changing any file:

```bash
curl -fsSL https://github.com/rtk-ai/rtk/releases/download/v0.45.0/checksums.txt \
  | grep -E 'rtk-(x86_64-unknown-linux-musl|aarch64-unknown-linux-gnu)\.tar\.gz$'
```

Both of these lines must appear, byte for byte:

```
80a746dd305ef944ff50ef011ae4ce3878dd5ba88dfe35d859d05498191637c3  rtk-aarch64-unknown-linux-gnu.tar.gz
c4c036fbf181fc55ef329786c8c17e0d427972b053b825944d968a6aafef1ba4  rtk-x86_64-unknown-linux-musl.tar.gz
```

If a checksum differs, stop and report it: a published tag whose bytes changed is a supply-chain event, not a version bump. Do not relax the pin, and do not point the entry at a URL that can move (`/latest/`, a branch tarball, the `install.sh` one-liner) — the checksum is meaningless against bytes that are allowed to change.

Then read the current state:

```bash
grep -c '"rtk"' container/cli-tools.json
```

`0` means nothing is installed yet. `1` means the entry is already there — go to Phase 3 and re-verify.

## Phase 2 — Add rtk to the container CLI manifest

Append this exact object to the JSON array in `container/cli-tools.json`. It carries no `onlyBuilt` key: that opts an npm package into running its build scripts, and this entry is not an npm package.

```json
{
  "name": "rtk",
  "version": "0.45.0",
  "binary": {
    "amd64": {
      "url": "https://github.com/rtk-ai/rtk/releases/download/v0.45.0/rtk-x86_64-unknown-linux-musl.tar.gz",
      "sha256": "c4c036fbf181fc55ef329786c8c17e0d427972b053b825944d968a6aafef1ba4"
    },
    "arm64": {
      "url": "https://github.com/rtk-ai/rtk/releases/download/v0.45.0/rtk-aarch64-unknown-linux-gnu.tar.gz",
      "sha256": "80a746dd305ef944ff50ef011ae4ce3878dd5ba88dfe35d859d05498191637c3"
    }
  }
}
```

## Phase 3 — Copy the guard test and run it

```bash
cp .claude/skills/add-rtk/rtk-manifest.test.ts src/rtk-manifest.test.ts
pnpm exec vitest run src/rtk-manifest.test.ts container/cli-tools.test.ts
```

Both files must be green before building: `container/cli-tools.test.ts` proves the installer puts a binary entry on the container PATH at all, and `src/rtk-manifest.test.ts` proves this entry is the pinned rtk and that the hook commands below do what this document says.

## Phase 4 — Build the image

```bash
./container/build.sh
```

On an install that builds its own image this rebuilds it, downloading and checksum-verifying rtk as it goes. On an install that pulls a published image, the same command re-applies the whole manifest as one layer on top of the image already there, so the publisher's hardened bytes underneath are kept — you are adding a tool, not replacing the runtime.

Confirm rtk is on PATH in the image before wiring any group to it:

```bash
source setup/lib/install-slug.sh
image="$(container_image_base):latest"
docker run --rm --entrypoint sh "$image" -c 'command -v rtk && rtk --version'
```

Expect `/usr/local/bin/rtk` and `rtk 0.45.0`. A group pinned to its own derived image (custom apt/npm packages) keeps that image until it is rebuilt:

```bash
if [ -f data/v2.db ]; then
  while IFS='|' read -r group_id image_tag; do
    [ -n "$group_id" ] || continue
    echo "Rebuilding derived image for $group_id ($image_tag)"
    ncl groups restart --id "$group_id" --rebuild
  done < <(pnpm exec tsx scripts/q.ts data/v2.db \
    "SELECT agent_group_id, image_tag FROM container_configs WHERE image_tag IS NOT NULL ORDER BY agent_group_id")
fi
```

## Phase 5 — Choose the agent group

```bash
ncl groups list
```

Note the group ID (e.g. `ag-1776342942165-ptgddd`). Run Phases 6 and 7 once per group that should route its Bash calls through rtk.

## Phase 6 — Add the PreToolUse hook

Each agent group has a `settings.json` at `data/v2-sessions/<group-id>/.claude-shared/settings.json`, mounted at `/home/node/.claude/settings.json` in the container and read by Claude Code for hooks, env, and model config.

Write the hook with `jq`. This drops any existing rtk Bash hook first and then appends a fresh one, so re-running it never duplicates the entry and never disturbs other hooks:

```bash
SETTINGS="data/v2-sessions/<group-id>/.claude-shared/settings.json"

jq '.hooks.PreToolUse = ((.hooks.PreToolUse // [])
      | map(select((.hooks // []) | any(.command == "rtk hook claude") | not)))
    + [{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook claude"}]}]' \
  "$SETTINGS" > /tmp/rtk-settings.json && mv /tmp/rtk-settings.json "$SETTINGS"
```

## Phase 7 — Restart the group's containers

```bash
ncl groups restart --id <group-id>
```

## Verify

Find the group's running container by the label the driver stamps on it — container names are built from the install slug and the session id, so a name filter cannot find a group:

```bash
name="$(docker ps --filter "label=nanoclaw-group=<group-id>" \
  --filter "label=nanoclaw-role=agent" --format '{{.Names}}' | head -1)"
if [ -z "$name" ]; then
  echo "No container running for this group — send the group a message, then re-run."
else
  docker exec "$name" rtk --version
  printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git status"}}' \
    | docker exec -i "$name" rtk hook claude
fi
```

The second command is the whole feature in one line: it must print `"updatedInput":{"command":"rtk git status"}`. If it does, the hook engine is live in the container the agent actually runs in.

Then ask the agent to run `git status` in a git repository. The rewrite is silent — the agent sees compressed output and no mention of rtk.

### Reading the savings

`rtk gain` reads a tracking database under `$HOME`. In the container `$HOME` is `/home/node`, which is container-local, and session containers run with `--rm` — so the numbers cover that one container's lifetime and are discarded when it exits. Read them while it is up:

```bash
docker exec "$name" rtk gain
```

There is no install-wide savings total, and running `rtk gain` on the host reports the host's own usage, not the agent's.

Telemetry stays off: rtk asks for consent before sending anything and the consent state lives under the same container-local `$HOME`, so it is never granted. Confirm with `docker exec "$name" rtk telemetry status`.

## Troubleshooting

### `rtk: command not found` inside the container

The container is running an image built before Phase 4. Check the image, then the group:

```bash
source setup/lib/install-slug.sh
docker run --rm --entrypoint sh "$(container_image_base):latest" -c 'command -v rtk || echo MISSING'
ncl groups config get --id <group-id>   # an imageTag means a derived image
```

`MISSING` from the first command means Phase 4 has not run. An `imageTag` on the group means it has its own derived image: rebuild it with `ncl groups restart --id <group-id> --rebuild`.

A host mount is not an alternative route for the binary: additional mounts are rewritten to `/workspace/extra/<basename>`, which is not on the container PATH, so the hook's rewritten `rtk <command>` still resolves to nothing.

### The hook does not fire

Check that the entry is in the group's settings and that the container restarted after it was written:

```bash
jq '.hooks.PreToolUse' data/v2-sessions/<group-id>/.claude-shared/settings.json
ncl groups restart --id <group-id>
```

### The hook fires and the command fails with exit 127

`rtk hook claude` rewrites the command to `rtk <subcommand>`, so `rtk` has to be resolvable on the container's PATH. Run the Verify block: if `docker exec "$name" rtk --version` fails, the problem is the image (see above), not the hook.

### A command comes back with output the agent cannot use

rtk compresses per subcommand, and a filter can drop something a specific task needed. Ask the agent to run that one command through `rtk run '<command>'`, which executes it raw with no filtering, or remove the hook for the group (`REMOVE.md`, step 1) if the trade is wrong for its work.
