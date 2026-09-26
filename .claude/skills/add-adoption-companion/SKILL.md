---
name: add-adoption-companion
description: Install the Adoption Companion pack — a growing bundle of opt-in "companion tips" that help a user adopt and kickstart their assistant. Ships two tips. Memory Receipts drops a light "📝 Noted" when the agent learns a durable fact, per agent group, on from install and off whenever the user says stop. Knowledge Inventory answers "what do you know about me?" with a plain-language picture of what the agent tracks, available to every group. Zero runtime code, reversible.
---

# Add Adoption Companion pack

Installs the **Adoption Companion** pack — a growing bundle of small, opt-in **companion tips** that help a user adopt and kickstart their assistant. Each tip is self-contained at runtime; the pack is a distribution bundle, not a runtime coupling. Two tips ship today:

| Tip | What the user gets | Scope | Toggle |
|---|---|---|---|
| **Memory Receipts** | a glanceable `📝 Noted` when the agent saves a durable fact, so they *see* it learn and can correct it in plain chat | one agent group | ships **on**; user can turn it off in chat |
| **Knowledge Inventory** | they ask *"what do you know about me?"* and get a plain-language picture of what the agent tracks, plus an offer to add, fix, or stop tracking anything | every group in the fork | none |

Adds **zero** runtime code — no MCP tools, no hooks, no core changes. The only code is a pure, install-time block helper (`resources/receipts-block.ts`).

## How this install runs — two phases

The two tips reach the agent by different mechanisms, so they install at different scopes. Do both phases:

- **Step 0 — once per fork.** Copy the pack's code and tests into `src/`.
- **Steps 1–4 — per agent group.** Memory Receipts is a managed block in that group's `instructions.prepend.md`. Repeat for each user-facing assistant you want it on.
- **Step 5 — once per fork.** Knowledge Inventory is a container skill under `container/skills/`, which is repo-level: writing it makes the tip available to **every** group at once. Idempotent, so re-running it during a later per-group install is a no-op.

## Step 0 — Copy the pack's code and tests into `src/`

The block helper and the pack's three tests ship with the skill and are copied into `src/`, where `pnpm run test` and `tsc` already look. Run from the repo root:

```bash
S=.claude/skills/add-adoption-companion
cp $S/resources/receipts-block.ts                    src/adoption-receipts-block.ts
cp $S/resources/receipts-block.test.ts               src/adoption-receipts-block.test.ts
cp $S/resources/adoption-companion-wiring.test.ts    src/adoption-companion-wiring.test.ts
cp $S/resources/knowledge-inventory-skill.test.ts    src/knowledge-inventory-skill.test.ts
```

Run the helper's tests now; the two wiring tests need Step 5 to have run, so they come at the end:

```bash
pnpm exec vitest run src/adoption-receipts-block.test.ts
```

> **Why they differ.** A receipt must fire **mid-turn**, the moment a fact is saved — only always-in-prompt standing behavior guarantees that timing, and receipts should be opt-in per group, so a per-group block is both the reliable trigger and the correct blast radius. An inventory only ever fires **when the user asks**, so a model-invoked container skill is enough — and being fork-wide is safe, because it cannot interrupt anyone and only ever reveals that agent's own memory.

## Step 1 — Identify the target agent group

Receipts belong on the **user-facing assistant** group, not Builder/Researcher sub-agents (personas are per-group; sub-agents don't inherit). Repeat Steps 2–4 for each user-facing group you want it on.

```bash
ncl groups list
```

Note the group's folder under `groups/` (e.g. `groups/my-assistant/`).

**Install on the group as-is — any session mode works, so keep the existing channel wiring.** Receipts read two per-group files that core loads at every session start regardless of session mode: the group's Core Memory (`memory/index.md`) and the block's `Receipts: ON/OFF` line. Saving, dedup, the toggle, and per-turn batching all hold even when each message lands in its own session.

## Step 2 — Guard: confirm the group is on the new memory model

These features read the group's memory tree, so the group must be on the shared-memory model. Two conditions prove it — check **both**:

```bash
GROUP=<group-folder>          # the folder name from `ncl groups list`

# (a) UPDATED: the memory scaffold exists (auto-created on first boot)
test -f "groups/$GROUP/memory/index.md" && echo "index.md: present" || echo "index.md: MISSING"

# (b) MIGRATED: no durable content stranded in a legacy CLAUDE.local.md
if [ -s "groups/$GROUP/CLAUDE.local.md" ]; then echo "CLAUDE.local.md: residual content — NOT migrated"; else echo "CLAUDE.local.md: clean"; fi
```

The two checks are **not** redundant: the scaffold auto-creates `index.md`, so its presence proves the version is new enough but **not** that old content moved over — the `CLAUDE.local.md`-residue check is what confirms migration.

**If either fails, STOP.** Do not install. Tell the operator:

> *"This group isn't on NanoClaw's new memory system yet. Run **update** + **`/migrate-memory`** for it first, then re-run `/add-adoption-companion`."*

## Step 3 — Insert the block

Writes a managed block, delimited `<!-- adoption:receipts v=1 -->` … `<!-- /adoption:receipts -->`, into the group's `instructions.prepend.md`. The delimiters are pure markers: they are how this skill finds the block to refresh, and how `REMOVE.md` finds it to strip. Everything between them is the tip's behavior, including the `Receipts: ON/OFF` line the agent reads and edits.

A fresh install ships **`Receipts: ON`** — installing this tip *is* the opt-in, so it works from the first message rather than waiting for the user to discover a phrase that turns it on.

Idempotent: appends the v1 block if absent; if a block already exists, it refreshes the body **and preserves the current `Receipts: ON/OFF` value** (a re-install never flips a user's OFF back to ON, or their ON back to OFF). Uses the pure helper — no core code runs.

```bash
FILE="groups/$GROUP/instructions.prepend.md"
touch "$FILE"   # group-persona.ts stages this file with wx; we append to it

pnpm exec tsx --eval "
import { readFileSync, writeFileSync } from 'fs';
import { applyReceiptsBlock } from './src/adoption-receipts-block.ts';
const f = process.argv[process.argv.length - 1];
writeFileSync(f, applyReceiptsBlock(readFileSync(f, 'utf8'), { version: 1 }));
" "$FILE"
```

Verify the block landed once, on:

```bash
grep -c 'adoption:receipts v=1' "$FILE"   # expect 1
grep 'Receipts:' "$FILE"                  # expect **Receipts: ON.** on a fresh install
```

## Step 4 — Restart the group so the new persona takes effect

Standing-instruction changes apply on the next container spawn.

```bash
ncl groups restart --id <group-id>
```

## Step 5 — Fork-level: install the Knowledge Inventory tip (once per fork)

Run this once per fork — it makes Knowledge Inventory available to **every** agent group at once. Idempotent, so running it again during a later per-group install is a no-op.

### 5a — Guard

Same two conditions as Step 2 — the tip reads the new memory model. Check the group(s) you're installing for:

```bash
GROUP=<group-folder>
test -f "groups/$GROUP/memory/index.md" && echo "index.md: present" || echo "index.md: MISSING"
if [ -s "groups/$GROUP/CLAUDE.local.md" ]; then echo "CLAUDE.local.md: residual content — NOT migrated"; else echo "CLAUDE.local.md: clean"; fi
```

**If either fails, STOP** — do not install. Same operator message as Step 2:

> *"This group isn't on NanoClaw's new memory system yet. Run **update** + **`/migrate-memory`** for it first, then re-run `/add-adoption-companion`."*

### 5b — Copy the skill into `container/skills/`

The tip ships inside this pack at `add/container/skills/knowledge-inventory/`, where `add/` mirrors the destination path from the repo root. This step copies it to `container/skills/knowledge-inventory/`, which core mounts and rescans at spawn — so **copying it there is what makes it exist for any agent**. Until this step runs, no group has the tip.

Run from the repo root:

```bash
rsync -a "${CLAUDE_SKILL_DIR}/add/" .
echo "knowledge-inventory: installed"
```

Overwriting is intentional and is what makes this idempotent: the copy under `add/` is canonical, so re-running is also how you take an update.

This is why the tip is **not** in `container/skills/` in trunk. That directory is bind-mounted into every container and rescanned on every spawn, so a tip that shipped there would be live for every group the moment it merged — before anyone ran this installer. Keeping the canonical copy under `add/` means trunk carries the file but never at a path core reads.

### 5c — Activate: restart the group

**Restart activates the tip.** Groups also pick it up on their next message.

```bash
ncl groups restart --id <group-id>
```

**One caveat — explicit skill lists.** A group whose skill selection is an explicit array instead of `"all"` never gets a symlink for the new skill: the files are mounted but the agent never sees them, **silently**. Only v1-migrated groups can be in this state, but the check is one command:

```bash
ncl groups config get --id <group-id> | grep -i skills   # "all" → nothing to do
```

If it's an array, append the name. There is no `ncl` verb for this (skills is a JSON column; only `mcp_servers` and `packages_*` have add/remove verbs), so write it directly. The `json_type` + `NOT EXISTS` guards make this safe to re-run and a no-op on `"all"` rows:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "UPDATE container_configs
   SET skills = json_insert(skills, '\$[#]', 'knowledge-inventory')
   WHERE agent_group_id = '<group-id>'
     AND json_type(skills) = 'array'
     AND NOT EXISTS (SELECT 1 FROM json_each(container_configs.skills) WHERE value = 'knowledge-inventory')"
```

Then restart that group. (Use `scripts/q.ts`, not the `sqlite3` CLI — setup never installs that binary; see `setup/verify.ts:5`.)

### 5d — Verify the install

Both tests read the composed project, so they only pass once Step 5b has landed the tip:

```bash
pnpm exec vitest run src/adoption-companion-wiring.test.ts src/knowledge-inventory-skill.test.ts
```

### 5e — Report the fork-level blast radius

Do not let this scope be a surprise. See the Report section below.

## Report

Tell the operator — **both scopes**, explicitly:

**Per-group (Memory Receipts):**
- Memory receipts are **installed and ON** on `groups/<id>/` — the user will start seeing `📝 Noted` as soon as the agent saves a durable fact.
- The **user** turns it off by asking in chat (e.g. *"stop telling me what you learned"*); the agent flips the block to `Receipts: OFF.` They turn it back on the same way (*"tell me when you learn something about me"*).
- Off ≠ uninstall — memory keeps working; only the surfacing stops. Full removal is `REMOVE.md`.
- A re-install preserves whatever the user chose; it never flips their OFF back on.

**Fork-level (Knowledge Inventory):**
- Knowledge Inventory is now available to **all assistants in this fork** (newly installed / already present — say which). This is by design: it only answers when asked, and only about that agent's own memory.
- There is **no toggle** and nothing for the user to enable — they can just ask *"what do you know about me?"*.
- It is **not** removed when you remove the pack from a single group (other groups may still use it). Only a full uninstall deletes it — see `REMOVE.md`.

## Optional — install across all existing groups at once

Receipts are **per-agent-group** (personas don't inherit between groups), so each user-facing group needs the block. To roll it out to every eligible existing group in one pass, run the guard + insert per group. Skip Builder/Researcher/utility groups — receipts belong on **user-facing assistants** only.

```bash
# List groups and their folders, then loop. Review the list first and exclude
# any non-user-facing groups (builders, researchers, and any bot you don't
# want receipting) by editing GROUPS.
GROUPS="$(ls groups/)"        # or hand-pick: GROUPS="my-assistant my-other-assistant"

for GROUP in $GROUPS; do
  idx="groups/$GROUP/memory/index.md"; loc="groups/$GROUP/CLAUDE.local.md"
  if [ ! -f "$idx" ] || [ -s "$loc" ]; then
    echo "SKIP $GROUP — not migrated (run update + /migrate-memory first)"; continue
  fi
  FILE="groups/$GROUP/instructions.prepend.md"; touch "$FILE"
  pnpm exec tsx --eval "
import { readFileSync, writeFileSync } from 'fs';
import { applyReceiptsBlock } from './src/adoption-receipts-block.ts';
const f = process.argv[process.argv.length - 1];
writeFileSync(f, applyReceiptsBlock(readFileSync(f, 'utf8'), { version: 1 }));
" "$FILE"
  echo "OK   $GROUP — installed ON"
done
```

Every group ships `ON`; each user can turn their own off in chat. Re-running preserves each group's existing ON/OFF (idempotent). Restart each group (or let it restart on next message) to pick up the persona.

Because this lands ON, the loop is a **live behavior change for every group it touches** — review the list before running it, and keep it to groups whose users you'd want receipting today.

## Optional — inherit into newly created agents (template)

New agents are stamped from a **template** (`context/instructions.md` → the new group's `instructions.prepend.md`); nothing is copied from the creating agent (`src/templates/create-agent.ts`). To make future agents inherit receipts, append the block to a template's `context/instructions.md`:

```bash
TPL="templates/<your-assistant-template>/context/instructions.md"
pnpm exec tsx --eval "
import { readFileSync, writeFileSync } from 'fs';
import { applyReceiptsBlock } from './src/adoption-receipts-block.ts';
const f = process.argv[process.argv.length - 1];
writeFileSync(f, applyReceiptsBlock(readFileSync(f, 'utf8'), { version: 1 }));
" "$TPL"
```

**Caveats:** (1) only agents created **via that template** (`ncl groups create --template …`) inherit it — not ones made by `/init-first-agent` or the setup wizard. (2) It blankets **every** agent from that template, so only add it to a **user-facing/assistant** template, never a generic or Builder one. (3) It ships `ON`, same as a direct install — every future agent from that template receipts from its first message until its user says stop.

