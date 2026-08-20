---
name: add-mnemon
description: Add persistent graph-based memory via mnemon. Agents recall past context before responding and remember insights after each turn.
---

# Add Mnemon — Persistent Memory

Installs [mnemon](https://github.com/mnemon-dev/mnemon) into the agent container image and calls `mnemon setup` once per container start from the agent-runner's startup path. Setup registers Claude Code hooks that surface relevant memory before the agent responds (`SessionStart`, `UserPromptSubmit`) and nudge it to store new insights after each turn (`Stop`). The graph is written into the per-agent-group `.claude-shared` mount, so it survives container restarts.

Three reach-ins, all removable (see `REMOVE.md`):

| Where | What |
|-------|------|
| `container/Dockerfile` | the `mnemon` binary + `jq` + `MNEMON_DATA_DIR` (image rebuild) |
| `container/agent-runner/src/mnemon/setup.ts` | new file: the idempotent `mnemon setup` call |
| `container/agent-runner/src/index.ts` | one import + one call in the runner's startup |

**Do not wire the setup call into `container/entrypoint.sh`.** The image `ENTRYPOINT` is not on the spawn path: the host composes the agent container's argv itself (`composeSessionSpec` in `src/container-runner.ts` emits `bash -c 'exec bun run /app/src/index.ts'`, realized with `--entrypoint bash`), so `entrypoint.sh` only runs for a bare `docker run`. An earlier version of this skill wired the setup there and every install was silently inert. `/app/src` is a read-only bind mount of `container/agent-runner/src`, so the wiring half needs no image rebuild — only the binary does.

## Provider Compatibility

This skill wires mnemon's `claude-code` target, so it takes effect for agent groups running the default Claude provider. A group on another provider spawns its own agent process, never invokes the `claude` CLI, and may not even have the `.claude` mount — `ensureMnemonSetup()` logs `no memory target for provider '<name>'` and does nothing for those groups.

mnemon >= 0.2 does ship `--target opencode` (writing to `~/.config/opencode/`), which this skill does not wire. Adding a row to `TARGET_BY_PROVIDER` in `mnemon/setup.ts` is the whole change if you want to try it — untested here.

The provider is the `provider` column of the `container_configs` row for each agent group. Read the DB, which is the source of truth — **not** `groups/*/container.json`, which is a per-spawn materialization of that row: it is absent for any group that has never spawned, and stale for any group reconfigured since.

```bash
./bin/ncl groups list                       # agent groups
./bin/ncl groups config get --id <group-id> # includes provider (empty = claude)
```

`ncl` talks to the running host over a Unix socket, so on a stopped install it
exits with "cannot reach NanoClaw host". Read the DB directly instead — same
source of truth, no host needed, and it prints every group at once:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "select agent_group_id, coalesce(nullif(provider,''),'claude') from container_configs"
```

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q 'MNEMON_VERSION' container/Dockerfile && echo "image: applied" || echo "image: not applied"
grep -q 'ensureMnemonSetup' container/agent-runner/src/index.ts && echo "wiring: applied" || echo "wiring: not applied"
```

If either says applied, run Phase 2 anyway — every step is idempotent and skips work already in place — then continue to Phase 3.

### Pick the mnemon version

```bash
curl -fsSL https://api.github.com/repos/mnemon-dev/mnemon/releases/latest | grep '"tag_name"'
```

The block in the next step pins `0.2.4`. If the latest release is newer, use that number instead — and say so when you report back, because the flag surface this skill depends on (`setup --target claude-code --yes --global`) is only verified through 0.2.4. Confirm it on the new version with `mnemon setup --help` after the rebuild.

## Phase 2: Apply Changes

### 1. Dockerfile — install the mnemon binary

Insert this block into `container/Dockerfile` **immediately above the `# ---- ncl CLI wrapper` section** (skip if `grep -q 'MNEMON_VERSION' container/Dockerfile` already matches). Placement matters: an `ARG` invalidates every layer below it, and the Dockerfile's own convention is "most stable first, most frequently bumped last" — inserted higher up, every `MNEMON_VERSION` bump would redo `bun install` and the pnpm global CLIs on every install.

```dockerfile
# ---- mnemon — persistent agent memory (add-mnemon skill) ---------------------
# Low on purpose. An ARG invalidates every layer below it, so a version bump
# must not sit above `bun install` or the pnpm global CLIs; everything below
# this line is cheap to redo. curl and ca-certificates come from the
# system-deps layer above.
#
# jq is mnemon's optional dependency for the Stop hook's "smart silence": the
# hook reads the last assistant message through it and skips the remember nudge
# when the model already stored something. Without jq the nudge fires after
# every single turn.
ARG MNEMON_VERSION=0.2.4
RUN apt-get update && apt-get install -y --no-install-recommends jq \
    && rm -rf /var/lib/apt/lists/* \
    && ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://github.com/mnemon-dev/mnemon/releases/download/v${MNEMON_VERSION}/mnemon_${MNEMON_VERSION}_linux_${ARCH}.tar.gz" \
       | tar -xz -C /usr/local/bin mnemon \
    && chmod 0755 /usr/local/bin/mnemon \
    && mnemon --version

# The graph store lives in the per-agent-group `.claude-shared` mount, which is
# host-backed, so memory outlives the ephemeral container. Host path:
# data/v2-sessions/<agent-group-id>/.claude-shared/mnemon/
ENV MNEMON_DATA_DIR=/home/node/.claude/mnemon
```

The trailing `mnemon --version` makes a bad version or a moved asset fail the build instead of the first container start.

### 2. Copy the setup module into the agent-runner

```bash
mkdir -p container/agent-runner/src/mnemon
cp .claude/skills/add-mnemon/mnemon-setup.ts     container/agent-runner/src/mnemon/setup.ts
cp .claude/skills/add-mnemon/mnemon-setup.test.ts   container/agent-runner/src/mnemon/setup.test.ts
cp .claude/skills/add-mnemon/mnemon-startup.test.ts container/agent-runner/src/mnemon/startup.test.ts
```

`setup.ts` exports `ensureMnemonSetup(provider)`: it maps the provider to a mnemon `--target`, runs `mnemon setup --target <t> --yes --global`, and returns/logs the outcome. It never throws — an agent without memory hooks must still serve messages — and it is idempotent, so running it on every start is correct.

### 3. Wire it into the runner's startup

Edit `container/agent-runner/src/index.ts`. Add the import beside the other memory imports:

```ts
import { ensureMnemonSetup } from './mnemon/setup.js';
```

Then call it in `main()`, immediately after `providerName` is resolved and **before** `getAgentMailbox()`:

```ts
  const providerName = config.provider.toLowerCase() as ProviderName;

  // add-mnemon: assert the graph-memory hooks in $HOME/.claude before the
  // provider is constructed, so the provider's own settings.json merge lands
  // after ours. Idempotent, never fatal. See mnemon/setup.ts for why this is
  // here and not in container/entrypoint.sh.
  ensureMnemonSetup(providerName);

  const mailbox = getAgentMailbox();
```

Two reasons for that position. Ordering: the Claude provider merges its own `SessionStart` memory hook into the same `settings.json` when it is constructed, and its merge preserves foreign entries (it only strips its own commands), so mnemon's entries must land first. Independence: registration needs nothing but `$HOME`, so it must not sit behind the mailbox, whose failure would take the memory wiring down with it.

If the file already contains `ensureMnemonSetup`, skip this step.

### 4. Copy the integration tests and run them

```bash
cp .claude/skills/add-mnemon/mnemon-install.test.ts src/mnemon-install.test.ts
pnpm exec vitest run src/mnemon-install.test.ts
cd container/agent-runner && bun test src/mnemon/ && cd ../..
```

- `src/mnemon-install.test.ts` (host) — the Dockerfile layer, and the linkage that actually matters: it reads the entry module **out of the composed spawn argv** and asserts the setup call is in that file. Re-point the entry, or move the call back into a file the spawn path does not run, and it goes red.
- `container/agent-runner/src/mnemon/setup.test.ts` — the exact argv handed to the binary, plus the three non-fatal outcomes (missing binary, failing setup, unwired provider).
- `container/agent-runner/src/mnemon/startup.test.ts` — runs the real entry module with a stub `mnemon` first on `PATH` and asserts the stub was invoked. This is the guard the old version of this skill lacked: a test that greps a shell script stays green while the feature is 100% dead.

`src/mnemon-install.test.ts` imports from `bun:test`-free host code and joins the main suite (`pnpm test`). The two container-tree tests run under Bun (`bun test`). Because the two Bun files also live in the skill directory, add them to the exclusion list in `vitest.skills.config.ts` if they are not there already — that file's `include` glob sweeps every `.test.ts` under `.claude/skills/`, and vitest cannot load `bun:test`:

```
      '.claude/skills/add-mnemon/mnemon-setup.test.ts',
      '.claude/skills/add-mnemon/mnemon-startup.test.ts',
```

### 5. Rebuild the image and smoke-test the binary

```bash
./container/build.sh
source setup/lib/install-slug.sh
docker run --rm --entrypoint mnemon "$(container_image_base):latest" --version
docker run --rm --entrypoint jq     "$(container_image_base):latest" --version
```

The image tag is per-install (`nanoclaw-agent-v2-<slug>`); `container_image_base` from `setup/lib/install-slug.sh` resolves it. A bare `nanoclaw-agent:latest` does not exist in a v2 install.

## Phase 3: Restart and Verify

### Restart the service

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)                 # Linux
# launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
```

### Confirm setup ran in a live container

Every `docker` lookup below is scoped to **this** install — several NanoClaw checkouts can run side by side on one host, and an unscoped `--filter label=nanoclaw-session | head -1` picks one of them at random.

```bash
source setup/lib/install-slug.sh
IMAGE=$(container_image_base)        # nanoclaw-agent-v2-<slug>
INSTALL=${IMAGE#nanoclaw-agent-v2-}  # <slug> — the value of the nanoclaw-install label
CTR=$(docker ps --filter "label=nanoclaw-install=$INSTALL" --filter label=nanoclaw-session \
        --format '{{.Names}}' | head -1)
echo "container: ${CTR:-none running — send the agent a message first}"

docker logs "$CTR" 2>&1 | grep -i mnemon
# expect: [mnemon] memory hooks registered (--target claude-code)
```

To narrow to one agent group, add `--filter label=nanoclaw-group=<agent-group-id>`.

Then check the hooks landed:

```bash
docker exec "$CTR" cat /home/node/.claude/settings.json
# expect SessionStart -> hooks/mnemon/prime.sh, UserPromptSubmit -> user_prompt.sh,
# Stop -> stop.sh, alongside NanoClaw's own SessionStart memory hook.

docker exec "$CTR" bash /home/node/.claude/hooks/mnemon/prime.sh
# expect: [mnemon] Memory active (N insights, M edges) + the recall guide
```

### Test memory recall

Ask the agent to remember something specific, let the session end, then start a new one and reference it obliquely. Mnemon should surface the context without you restating it. A direct check, from inside the container:

```bash
docker exec "$CTR" mnemon recall "<something you told it>"
```

## Memory Storage

Mnemon writes to `/home/node/.claude/mnemon/` inside the container. That is the per-agent-group `.claude-shared` mount, whose host path is `data/v2-sessions/<agent-group-id>/.claude-shared/mnemon/` — there is no `groups/<folder>/.claude`. Confirm at runtime:

```bash
docker inspect "$CTR" \
  --format '{{range .Mounts}}{{if eq .Destination "/home/node/.claude"}}{{.Source}}{{end}}{{end}}'
```

To reset one agent group's memory, stop its containers and delete the `mnemon/` subdirectory under that path.

## Troubleshooting

### `[mnemon] binary not on PATH` in the container logs

The image was not rebuilt after the Dockerfile block was added, or the group runs a per-group image built earlier. Run `./container/build.sh` (and `ncl groups restart --id <group-id>` for a group with its own image) and restart the service.

### `no memory target for provider '<name>'`

Expected: this skill wires the `claude-code` target only. See **Provider Compatibility**.

### Nothing about mnemon in the container logs at all

The wiring is not on the executed path. Check `grep -n ensureMnemonSetup container/agent-runner/src/index.ts` and re-run `pnpm exec vitest run src/mnemon-install.test.ts` — its second case reads the entry module named by the composed spawn argv and will say which file it looked in. Note that `container/entrypoint.sh` is *not* that file.

### Memory not persisting across restarts

`MNEMON_DATA_DIR` must resolve inside the `/home/node/.claude` mount:

```bash
docker exec "$CTR" sh -c 'echo $MNEMON_DATA_DIR; ls -la $MNEMON_DATA_DIR/data'
```

If it points anywhere else, the `ENV` line from Phase 2 step 1 is missing from the image.

### The "consider remembering this" nudge fires after every turn

mnemon's `stop.sh` needs `jq` to tell whether the model already stored something. Confirm with `docker exec "$CTR" jq --version`; if it is missing, the Dockerfile block's `jq` install was dropped.

### Setup fails at container start

Reproduce it by hand with the same arguments the runner uses:

```bash
docker exec -it "$CTR" mnemon setup --target claude-code --yes --global
```
