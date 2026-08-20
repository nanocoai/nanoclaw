---
name: add-karpathy-llm-wiki
description: Add a persistent wiki knowledge base to a NanoClaw group. Based on Karpathy's LLM Wiki pattern. Triggers on "add wiki", "wiki", "knowledge base", "llm wiki", "karpathy wiki".
---

# Add Karpathy LLM Wiki

Set up a persistent wiki knowledge base for **one** agent group, based on Karpathy's LLM Wiki pattern.

Every step is safe to re-run: directory creation uses `mkdir -p`, the initial wiki files are created only when absent, the wiki skill is preserved unless the user opts to update it, and the standing-instructions section is replaced in place through marker comments.

## Where each piece lives

| Piece | Host path | Container path |
|---|---|---|
| Raw sources | `groups/<folder>/sources/` | `/workspace/agent/sources/` (read-write) |
| Wiki pages | `groups/<folder>/wiki/` | `/workspace/agent/wiki/` (read-write) |
| Wiki schema (the skill) | `data/v2-sessions/<group-id>/.claude-shared/skills/wiki/SKILL.md` | `~/.claude/skills/wiki/SKILL.md` |
| Standing instructions | `groups/<folder>/instructions.prepend.md` | inlined as the first import of `/workspace/agent/CLAUDE.md` |

Two host behaviors decide those locations, and both run on **every** container spawn:

- `groups/<folder>/CLAUDE.md` is regenerated from the shared base plus fragments (`src/claude-md-compose.ts`). It is a list of `@` imports and nothing else. Wiki text written there is destroyed before the agent reads it. `instructions.prepend.md` is the provider-neutral standing-instructions file the composer inlines as the persona fragment and imports first, so that is where the wiki section goes.
- The per-group skill store is pruned down to the group's selected shared skills (`syncSkillSymlinks` in `src/container-runner.ts`). The prune removes only symlinks, so a **real** directory in that store survives — which is what keeps the wiki skill scoped to this one group. A skill placed in the install-wide `container/skills/` mount instead appears in every agent group, so do not put it there.

Changes to either surface take effect when the group's container next starts (Step 7).

## Step 1: Read the pattern

Read `${CLAUDE_SKILL_DIR}/llm-wiki.md` — the full LLM Wiki idea as written by Karpathy. Understand it thoroughly before proceeding. Summarize the core idea to the user briefly, then discuss what they want to build.

## Step 2: Choose the group and pin its identity

AskUserQuestion: "Which group should have the wiki?"

1. **Main group** — add to the user's existing main chat
2. **Dedicated group** — a new group just for the wiki
3. **Other** — another existing group

List the candidates:

```bash
ncl groups list
```

If `ncl` cannot reach the host (the service is not running), read the same rows with the in-tree query wrapper:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, name, folder FROM agent_groups ORDER BY name"
```

For a dedicated group, create it and wire a chat to it:

```bash
ncl groups create --folder <slug> --name "<display name>"
```

Then run `/manage-channels` to wire a chat to the new group, or wire it directly when the platform ids are already known:

```bash
ncl messaging-groups create --channel-type <channel> --platform-id <platform id> --name "<chat name>"
ncl wirings create --messaging-group-id <mg-id> --agent-group-id <ag-id>
```

Record the two values the rest of this skill needs, and confirm them with the user:

```bash
GROUP_ID=<ag-...>        # agent group id
GROUP_FOLDER=<folder>    # the group's folder under groups/
```

Provision the group's filesystem before writing into it — `ncl groups create` is idempotent on `--folder`, so this returns the existing group and repairs a missing scaffold:

```bash
ncl groups create --folder "$GROUP_FOLDER"
```

## Step 3: Design collaboratively

Discuss with the user based on the pattern:

- What is the wiki's domain or topic?
- What kinds of sources will they add? (URLs, PDFs, office documents, images, transcripts, books)
- Do they want the full three-layer architecture or a lighter version?
- Any specific conventions they care about? (The pattern intentionally leaves this open.)

Carry the answers into every file written in Step 4 — the domain shapes the index categories, the page types, and the ingest checklist.

## Step 4: Install

### 4a. Wiki and sources directories

```bash
mkdir -p "groups/$GROUP_FOLDER/wiki" "groups/$GROUP_FOLDER/sources"
```

Create `groups/$GROUP_FOLDER/wiki/index.md` and `groups/$GROUP_FOLDER/wiki/log.md` per the pattern's Indexing and Logging section, adapted to the user's domain. Skip either file when it already exists, so a populated wiki is never clobbered.

### 4b. The wiki skill, scoped to this group

```bash
mkdir -p "data/v2-sessions/$GROUP_ID/.claude-shared/skills/wiki"
```

Write `data/v2-sessions/$GROUP_ID/.claude-shared/skills/wiki/SKILL.md` — the schema layer from the pattern, tailored to this user's wiki. Base it on the pattern's Operations section (ingest, query, lint) and the conventions agreed in Step 3. Don't over-prescribe; the pattern says "your LLM figures out the rest." Give it YAML frontmatter with `name: wiki` and a `description` that says when to use it, then cover:

- the three layers and where each lives inside the container (`/workspace/agent/sources`, `/workspace/agent/wiki`, this skill)
- the ingest workflow, one source at a time, ending in updates to `wiki/index.md` and an entry appended to `wiki/log.md`
- the query workflow: read `wiki/index.md` first, then drill into pages, cite the pages used, and offer to file good answers back as new pages
- the lint workflow: contradictions, stale claims, orphan pages, missing cross-references, data gaps
- fetching full sources rather than summaries (see Step 5)

When that file already exists, ask the user whether to update it before overwriting, so an existing tailored schema is preserved.

### 4c. Standing instructions

Write this marker-wrapped section into `groups/$GROUP_FOLDER/instructions.prepend.md`, creating the file when absent, replacing an existing `<!-- BEGIN karpathy-llm-wiki -->` block in place, and appending it after any other standing instructions otherwise:

```markdown
<!-- BEGIN karpathy-llm-wiki -->
## Wiki
...section body...
<!-- END karpathy-llm-wiki -->
```

This section is what turns the agent into a wiki maintainer, so write it deliberately. It covers:

- **The system, concisely:** what the wiki is, the three layers (sources, wiki, schema), the three operations (ingest, query, lint).
- **The file map:** `sources/` (immutable raw material), `wiki/` (the agent's own pages), `wiki/index.md` (the catalog to read first), `wiki/log.md` (append-only chronology).
- **The store boundary**, so the agent is never choosing between two knowledge bases: `memory/` holds durable facts about the user and this group; `wiki/` holds compiled knowledge about the wiki's subject domain, sourced from `sources/`. A fact about the user goes in `memory/`; a fact about the domain goes in `wiki/`. The always-loaded `memory/index.md` gets one line pointing at `wiki/index.md` so the agent can find the wiki from a cold context.
- **A pointer to the `wiki` skill** for the detailed workflow.
- **Ingest discipline**, explicitly: when the user provides multiple files or points at a folder of them, process them **one at a time**. For each file — read it, discuss takeaways, create and update all affected wiki pages (summary, entities, concepts, cross-references, index, log), and finish completely before opening the next. Never batch-read every file and then process them together; that produces shallow, generic pages instead of the deep integration the pattern requires.
- **Full sources, not summaries:** `WebFetch` returns a summary, so fetch full documents with `curl` or `agent-browser` instead (see Step 5).

Add the pointer line to `groups/$GROUP_FOLDER/memory/index.md` under its map section, and leave the rest of that file alone. That file is scaffolded when the group's container first boots, so on a brand-new group add the line after the restart in Step 7.

Do not edit `groups/$GROUP_FOLDER/CLAUDE.md`; it is regenerated on every spawn.

When the group carries an agent plugin, a later `ncl groups create --template <ref> --yes` restamp rewrites `instructions.prepend.md` and flags the section as a lost customization. Re-run this step after any restamp of this group.

### 4d. Install the delivery-seam guard

The wiki section only works because the composer inlines `instructions.prepend.md` and the skill prune spares real per-group directories. Copy the test that guards both, and run it:

```bash
skill_dir="${CLAUDE_SKILL_DIR:-$(git rev-parse --show-toplevel)/.claude/skills/add-karpathy-llm-wiki}"
cp "$skill_dir/wiki-delivery-seam.test.ts" src/wiki-delivery-seam.test.ts
pnpm exec vitest run src/wiki-delivery-seam.test.ts
```

If it fails, stop and report which seam moved — the wiki instructions would not reach the agent.

## Step 5: Source handling capabilities

Ingestion is worth nothing if the agent cannot read the source. From the source types agreed in Step 3, check what this install already handles, and list the installed skills before naming one:

```bash
ls .claude/skills
```

Match each planned source type against that list rather than assuming a skill exists:

- **Images and text-layer PDFs** — the container agent reads them with its own file tools; no skill needed.
- **Office documents** (Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV) and **scanned-text PDFs** — `/add-anydoc` installs a local converter.
- **Anything else** (audio, video, a proprietary format) — search the list for a match, offer to install it, and when nothing matches say so plainly and agree on a manual path (the user exports text themselves).

### URL handling

`WebFetch` returns a summary, not the full document, so it loses exactly the detail wiki ingestion needs. Fetch the real file instead:

```bash
curl -sLo "sources/<filename>" "<url>"
```

For a web page, `agent-browser` opens it and extracts the full text. Both the wiki skill (4b) and the standing instructions (4c) say this, so the agent files full sources rather than summaries.

## Step 6: Optional lint schedule

AskUserQuestion: "Want periodic wiki health checks?"

1. **Weekly**
2. **Monthly**
3. **Skip** — lint manually

For weekly or monthly, create a scheduled task for the group. The cron expression is interpreted in the group's timezone; the first run comes off the cron grid:

```bash
# Weekly, Monday 09:00
ncl tasks create --group "$GROUP_ID" --name "wiki lint" --recurrence "0 9 * * 1" \
  --prompt "Run a wiki lint pass over /workspace/agent/wiki using the wiki skill: find contradictions, stale claims superseded by newer sources, orphan pages, concepts that deserve their own page, missing cross-references, and data gaps. Fix what is unambiguous, append a lint entry to wiki/log.md, and report the rest with suggested sources to pursue."

# Monthly, the 1st at 09:00 — same command with:
#   --recurrence "0 9 1 * *"
```

Record the series id it returns; REMOVE.md needs it to cancel the schedule. Confirm and re-read it any time with:

```bash
ncl tasks list --group "$GROUP_ID"
```

## Step 7: Restart and verify

The composed project document and the per-group skill store are read when a container starts, so restart this install's service:

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k "gui/$(id -u)/$(launchd_label)"  # macOS
systemctl --user restart "$(systemd_unit)"              # Linux
```

Run only the command for the current platform. If NanoClaw is not service-managed, stop this install's running agent containers by their `nanoclaw-install=<install-slug>` label so the group respawns with the new context.

Then send a real source to the wiki group and confirm the round trip: the agent files it under `sources/`, writes or updates wiki pages, refreshes `wiki/index.md`, and appends to `wiki/log.md`. Confirm the files changed on the host:

```bash
ls "groups/$GROUP_FOLDER/sources" "groups/$GROUP_FOLDER/wiki"
grep '^## \[' "groups/$GROUP_FOLDER/wiki/log.md" | tail -5
```

Report to the user which group has the wiki, where its files live, and that `groups/<folder>/CLAUDE.md` is generated — wiki instructions are edited in `instructions.prepend.md`.

## Troubleshooting

**The agent replies but ignores the wiki entirely.** Its container started before Step 4 landed. Restart per Step 7, or `ncl groups restart --id "$GROUP_ID" --message "reloaded wiki context"`.

**The agent produces no output at all.** Check `logs/nanoclaw.error.log` before suspecting the wiki wiring — a credential-gateway `401` on `ensureAgent` fails the spawn well before any group context is read.

**The wiki section is missing from the agent's context.** Confirm it is in `groups/$GROUP_FOLDER/instructions.prepend.md` (not in `CLAUDE.md`, which is regenerated), then re-run the Step 4d test.

**The wiki skill shows up in other groups.** A copy landed in the install-wide `container/skills/wiki/`. Remove it; the per-group copy under `data/v2-sessions/$GROUP_ID/.claude-shared/skills/wiki/` is the one this skill installs.

**Pages read shallow and generic.** The agent batched the ingest. Strengthen the ingest-discipline wording in 4b and 4c, and re-ingest the sources one at a time.
