---
name: add-karpathy-llm-wiki
description: Add a persistent wiki knowledge base to a NanoClaw group. Based on Karpathy's LLM Wiki pattern. Triggers on "add wiki", "wiki", "knowledge base", "llm wiki", "karpathy wiki".
---

# Add Karpathy LLM Wiki

Set up a persistent wiki knowledge base on NanoClaw, based on Karpathy's LLM Wiki pattern.

Each step is safe to re-run: directory creation uses `mkdir -p`, initial wiki files are created only if absent, the container skill is preserved unless the user opts to update it, and the group CLAUDE.md section is replaced in place via marker comments rather than duplicated.

## Step 1: Read the pattern

Read `${CLAUDE_SKILL_DIR}/llm-wiki.md` — this is the full LLM Wiki idea as written by Karpathy. Understand it thoroughly before proceeding. Summarize the core idea to the user briefly, then discuss what they want to build.

## Step 2: Choose a group

AskUserQuestion: "Which group should have the wiki?"

1. **Main group** — add to your existing main chat
2. **Dedicated group** — create a new group just for the wiki
3. **Other** — pick an existing group

If dedicated: ask which channel and chat, then register with `pnpm exec tsx setup/index.ts --step register`.

## Step 3: Design collaboratively

Discuss with the user based on the pattern:
- What's the wiki's domain or topic?
- What kinds of sources will they add? (URLs, PDFs, images, voice notes, books, transcripts)
- Do they want the full three-layer architecture or a lighter version?
- Any specific conventions they care about? (The pattern intentionally leaves this open.)

Based on this discussion, create three things:

### 3a. Directory structure

Create `wiki/` and `sources/` directories in the group folder (`mkdir -p` — safe if they already exist). Create initial `index.md` and `log.md` per the pattern's Indexing and Logging section, adapted to the user's domain. Skip any of these files that already exist so a populated wiki is never clobbered on re-run.

### 3b. Container skill

Create `container/skills/wiki/SKILL.md` tailored to this user's wiki. This is the schema layer from the pattern — it tells the agent how to maintain the wiki. Base it on the pattern's Operations section (ingest, query, lint) and the conventions you agreed on with the user. Don't over-prescribe — the pattern says "your LLM figures out the rest."

If `container/skills/wiki/SKILL.md` already exists, ask the user whether to update it before overwriting, so an existing tailored schema is preserved on re-run.

### 3c. Group CLAUDE.md

Edit the group's CLAUDE.md to add a wiki section, wrapped in marker comments so it can be located and replaced on re-run:

```markdown
<!-- BEGIN karpathy-llm-wiki -->
## Wiki
...section body...
<!-- END karpathy-llm-wiki -->
```

If a `<!-- BEGIN karpathy-llm-wiki -->` block already exists, replace it in place rather than appending a second copy. This is critical — it's what turns the agent into a wiki maintainer. The section should:

- Explain the wiki system concisely: what it is, the three layers (sources, wiki, schema), the three operations (ingest, query, lint)
- Index the key files and folders (`wiki/`, `sources/`, `wiki/index.md`, `wiki/log.md`)
- Point to the container skill for detailed workflow
- **Ingest discipline:** Be very explicit that when the user provides multiple files or points at a folder with many files, the agent MUST process them one at a time. For each file: read it, discuss takeaways, create/update all wiki pages (summary, entities, concepts, cross-references, index, log), and completely finish with that file before moving to the next. Never batch-read all files and then process them together — this produces shallow, generic pages instead of the deep integration the pattern requires.

## Step 4: Source handling capabilities

Based on the source types the user plans to ingest (discussed in Step 3), check whether the agent can already handle those formats — some are supported natively, others need a skill (e.g. `/add-image-vision`, `/add-pdf-reader`, `/add-voice-transcription`). If a needed capability isn't installed, check if there's an available skill for it and help the user get it set up.

### URL handling note

claude has built-in `WebFetch`, but it returns a summary, not the full document. For wiki ingestion of a URL where the full text matters, the container skill and CLAUDE.md should instruct claude to use bash commands to download full files instead. For example:

```bash
curl -sLo sources/filename.pdf "<url>"
```

If the document is a webpage, then claude can use fetch or `agent-browser` to open the page and extract full text if available. The container skill and CLAUDE.md should note this so claude gets full content for sources rather than summaries.


## Step 5: Optional lint schedule

AskUserQuestion: "Want periodic wiki health checks?"

1. **Weekly**
2. **Monthly**
3. **Skip** — lint manually

If yes, ask the agent to schedule the lint task using the `schedule_task` MCP tool in conversation.

## Step 6: Restart

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

Tell the user to test by sending a source to the wiki group.
