# Remove the Adoption Companion pack

Removal mirrors the pack's **two install scopes**. Pick the path you actually mean — they are not the same:

| You want to… | Run | Touches |
|---|---|---|
| Take the pack off **one group** (others keep it) | **Part A only** | That group's Memory Receipts block. **Not** `container/skills/knowledge-inventory/`. |
| **Fully uninstall** the pack from the fork (or you just removed it from the **last** group) | **Part A** for each group, then **Part B** | The blocks, then the fork-level skill directory. |

Both parts are idempotent — safe to run when nothing was installed or it's already gone. Neither touches the user's `memory/` or the rest of their persona.

---

# Part A — Per-group removal (Memory Receipts)

Strips the pack's managed block from one group's standing instructions. Run Steps 1–2 once per agent group that had it (`ncl groups list`).

**This path does not remove Knowledge Inventory.** `container/skills/knowledge-inventory/` is fork-level — other groups in this fork may still be using it, and removing it here would silently break them. Leave it alone; it is Part B's job only.

## 1. Strip the receipts block

Deletes exactly the `<!-- adoption:receipts … -->` … `<!-- /adoption:receipts -->` span from the group's standing instructions. If no marker is present, the file is returned unchanged (**skip-if-absent** — idempotent by construction). Sibling `adoption:*` blocks from other features are left intact.

```bash
GROUP=<group-folder>          # the folder name from `ncl groups list`
FILE="groups/$GROUP/instructions.prepend.md"
test -f "$FILE" || { echo "no instructions.prepend.md — nothing to remove"; exit 0; }

pnpm exec tsx --eval "
import { readFileSync, writeFileSync } from 'fs';
import { removeReceiptsBlock } from './src/adoption-receipts-block.ts';
const f = process.argv[process.argv.length - 1];
writeFileSync(f, removeReceiptsBlock(readFileSync(f, 'utf8')));
" "$FILE"
```

Verify the markers are gone:

```bash
grep -c 'adoption:receipts' "$FILE"   # expect 0
```

## 2. Restart the group

So the container re-composes its persona without the block.

```bash
ncl groups restart --id <group-id>
```

## Note

This removes the **installed block only**. It does not touch the user's memory, the rest of the persona, the fork-level `container/skills/knowledge-inventory/` directory, or the skill files under `.claude/skills/add-adoption-companion/`. To also delete the pack skill itself, remove that directory.

---

# Part B — Fork-level removal (Knowledge Inventory)

**Only run this on an explicit full uninstall, or when you have just removed the pack from the *last* group that used it.** Knowledge Inventory lives at `container/skills/knowledge-inventory/`, which is repo-level: deleting it removes the tip from **every** agent group in this fork at once. If any other group still has the pack, stop here — Part A was enough.

## 1. Delete the copied code and tests

Reverses Step 0. Do this only on a full uninstall — the helper is what Part A's block-strip runs, so remove it *after* you have run Part A for every group.

```bash
rm -f src/adoption-receipts-block.ts src/adoption-receipts-block.test.ts \
      src/adoption-companion-wiring.test.ts src/knowledge-inventory-skill.test.ts
```

## 2. Delete the installed skill directory

Deletes what Step 5b copied to `container/skills/`. Skip-if-absent — idempotent by construction, so a second run is a clean no-op.

```bash
if [ -d container/skills/knowledge-inventory ]; then
  rm -rf container/skills/knowledge-inventory
  echo "knowledge-inventory: removed"
else
  echo "knowledge-inventory: already absent — skipping"
fi
```

Verify it's gone:

```bash
test -d container/skills/knowledge-inventory && echo "STILL PRESENT" || echo "skill: gone"
```

This removes the **installed copy** only. The canonical copy under `.claude/skills/add-adoption-companion/add/` stays — that is the pack itself, and deleting it is a separate act (remove the skill directory). Because trunk never ships anything at `container/skills/knowledge-inventory/`, removal sticks: no update brings it back, and re-running `/add-adoption-companion` reinstalls it.

## 3. Restart the groups

Restart each group so it re-resolves its skills from the `container/skills/` listing at spawn. Groups also pick this up on their next message.

```bash
ncl groups restart --id <group-id>     # repeat per group, or let them restart naturally
```

## Note

This deletes the pack's **copied files and the installed skill directory**. The user's `memory/` is untouched — the agent still remembers everything; it just no longer has the skill for showing an inventory of it. Memory Receipts blocks in any remaining group are unaffected (that's Part A's job).
