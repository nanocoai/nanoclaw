---
name: add-web-search-plus
description: Add Web Search Plus (wsp) to agent containers — multi-provider web search and URL extraction on self-managed provider keys instead of the metered WebSearch tool. 13 providers (Serper, Brave, Tavily, Exa, Linkup, Firecrawl, Perplexity, SearXNG, ...) with auto-routing, fallback chains, and caching. Pure-stdlib Python engine; adds python3 to the agent image.
---

# Web Search Plus (wsp)

Gives every agent container a `wsp` CLI for web search and page extraction
through the Web Search Plus engine: provider auto-routing, fallback chains,
parallel extraction, response caching. Calls go out on self-managed provider
keys — not the metered `WebSearch` tool — at a fraction of the cost.

This is a utility skill: it ships its code in this folder and copies it into
the project. The engine is pure-stdlib Python (12 `.py` files, no pip, no
venv); the only runtime requirement is a `python3` interpreter, which this
skill adds to the agent image.

## Install

### Pre-flight

If all of the following are already present, skip to **Configure a provider key**:

- `container/skills/web-search-plus/SKILL.md`
- `container/skills/web-search-plus/bin/wsp` (executable)
- `container/skills/web-search-plus/engine/search.py` (plus the other engine files)
- `src/wsp-skill.test.ts`
- a `python3 \` line in the system-deps `apt-get install` block of `container/Dockerfile`

Missing pieces — continue below. All steps are idempotent; re-running is safe.

### 1. Copy the container skill files

Wholesale copies (owned entirely by this skill — user edits to these files
won't survive a re-run, as designed):

```bash
mkdir -p container/skills/web-search-plus
cp -R .claude/skills/add-web-search-plus/resources/web-search-plus/. container/skills/web-search-plus/
chmod +x container/skills/web-search-plus/bin/wsp
```

This lands the agent-facing `SKILL.md`, the `bin/wsp` wrapper, and the
`engine/` directory (12 `.py` files + `LICENSE`). `container/skills/` is
mounted read-only into every agent container at `/app/skills/`, so agents see
the tool at `/app/skills/web-search-plus/bin/wsp`.

### 2. Add python3 to the container Dockerfile

The base image is Node-only; the engine needs a Python interpreter. In
`container/Dockerfile`, add one line to the system-deps `apt-get install
-y --no-install-recommends` block, between `git \` and `tini \`:

```dockerfile
        python3 \
```

Idempotent: if the line is already in the block, skip this step.

`python3` is deliberately **not** version-pinned. The `ARG <X>_VERSION` pin
pattern in this Dockerfile is for pnpm-installed CLIs; the apt system-deps
block installs unpinned distro packages by house style (chromium, git, curl —
all unpinned), because Debian's archive drops superseded point releases and a
pinned `python3=3.x.y-z` breaks rebuilds at random. Reproducibility for apt
packages comes from the base image, and the engine targets the stdlib of any
python3 ≥ 3.9, so the distro's stable version is the correct dependency.

### 3. Copy the integration-point test

```bash
cp .claude/skills/add-web-search-plus/resources/wsp-skill.test.ts src/wsp-skill.test.ts
```

`wsp-skill.test.ts` is the guard for this skill's one functional integration
point, the Dockerfile python3 dependency: a CLI binary installed via apt is
not importable, so neither a behavior test nor the build leg can see it, and a
structural test of the Dockerfile line is the correct guard. The test scopes
its assertion to the apt-get install block (a `python3` mention elsewhere
can't keep it green) and also asserts the copied wrapper, engine entry, and
container SKILL.md are present and executable — red on a half-applied or
half-removed skill.

The skill reaches into no host or container TypeScript (no barrel edit, no
`main()` call), so there is no code-wiring test to ship; the engine files are
pure adds.

### 4. Build and validate

```bash
pnpm run build                              # host typecheck (unaffected, must stay green)
pnpm exec vitest run src/wsp-skill.test.ts  # Dockerfile + skill-file guards
./container/build.sh                        # agent image — bakes python3 in
```

All must be clean before proceeding. To confirm the interpreter actually
landed in the image:

```bash
docker run --rm --entrypoint python3 nanoclaw-agent:latest --version
```

Then restart the service so new sessions use the new image:

```bash
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

### 5. Enable for groups

Groups with the default skill selection (`skills: "all"` in container config)
pick up `web-search-plus` automatically at the next container spawn. For a
group with an explicit skills list, add `"web-search-plus"` to that list —
`ncl groups config get` shows the current selection; until an `ncl` verb for
skill selection lands, the in-tree query wrapper (`pnpm exec tsx scripts/q.ts`)
is the sanctioned way to update the `skills` JSON column.

## Configure a provider key

This skill never handles credential values: apply copies no keys, sets no env
vars, and threads nothing into the container. The engine routes to a provider
when that provider's key variable is set in the per-group key file
`/workspace/agent/.wsp.env` (inside the container; `groups/<folder>/.wsp.env`
on the host, covered by the `groups/*` git-ignore).

**Preferred: the OneCLI gateway holds the real key.** The engine's HTTP layer
is stdlib `urllib`, which honors the `HTTPS_PROXY` / `SSL_CERT_FILE`
environment the gateway sets in every agent container, so provider calls route
through the gateway like all other outbound HTTPS. Store the key in the OneCLI
vault as a custom secret scoped to the provider's API host (e.g.
`api.search.brave.com` with header `X-Subscription-Token` for Brave), and set
the placeholder in the key file so the engine routes to that provider:

```bash
# inside the agent container / group workspace
cat > /workspace/agent/.wsp.env <<'EOF'
BRAVE_API_KEY=onecli-managed
EOF
chmod 600 /workspace/agent/.wsp.env
```

The gateway injects the real credential per request; no key material enters
the container or the repo.

**Fallback: real key in the key file.** On installs without a vault entry for
the provider, put the real key in `.wsp.env` instead of the placeholder. Same
file, same permissions. One working provider is enough; more keys add fallback
resilience. The full provider/key-variable table is in the agent-facing
[SKILL.md](resources/web-search-plus/SKILL.md) this skill installs.

## Next steps

In a wired agent, run `wsp doctor` (offline provider/key report), then a live
`wsp search "test query"` — the JSON response's `routing.provider` shows which
provider served it. If every provider reports `missing_api_key`, the key file
is absent or unreadable; if `python3: command not found`, the running
container predates the image rebuild in step 4.

## Recipe entry

Independent — no dependency on other skills and no ordering constraint. Needs
the agent-image rebuild (step 4) after apply; when composing several
image-touching skills in one recipe run, one rebuild at the end covers them
all.

To back this skill out, follow [REMOVE.md](REMOVE.md).
