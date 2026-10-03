---
name: hindsight
description: Long-term memory discipline for agents wired to the hindsight MCP server. You MUST consult this skill at the start of every substantive turn to decide whether to recall and what (if anything) to retain afterwards. Available only when `mcp__hindsight__*` tools are present.
---

# Hindsight Memory Discipline

You have a per-group long-term memory bank addressed by `group=<this group's folder>`. The MCP server exposes three tools:

- `mcp__hindsight__memory_recall(group, query, budget)` — semantic search across past memories. Returns ranked observations + extracted entities. Read-only; cheap.
- `mcp__hindsight__memory_retain(group, content, context?)` — persist a one- or two-sentence durable fact. The bank LLM extracts entities and links to the knowledge graph. Costs tokens server-side; pollution is permanent.
- `mcp__hindsight__memory_reflect(group, query, budget)` — synthesise an answer from memories with evidence. Heavier than recall.

**`group`** is always your agent group's folder name. Don't switch groups; you can only read your own bank. The server-side bank prefix is configured by the operator (default `nanoclaw:`) so the full bank id is `<prefix>:<folder>`.

## When to recall

At the start of any turn that *might* benefit from prior context:

- The user references a person, project, decision, or topic by name → recall on the named entity.
- The user asks "do you remember…", "what did we talk about…", "is X still…" → recall on the topic.
- The user shares a new fact that overlaps with old territory ("I switched the deploy target") → recall on the territory before answering.

You may *skip* recall for:
- Pure pleasantries ("hi", "thanks", "ok").
- Self-contained tool tasks where past context cannot help ("schedule X", "what's 2+5", "open URL Y").
- Commands you fully understand from the current message alone.

When in doubt, recall — it's read-only and cheap. Use `budget: "low"` by default, `"mid"` for ambiguous queries, `"high"` only for genuinely open-ended reflection (and prefer `memory_reflect` for that).

## When to retain

Selectively, after a turn produces something durable. Save:

- **Facts about the user** — name, location, role, relationships, preferences they state.
- **Facts about projects** — repos they own, stacks they use, deployment targets, ports, conventions.
- **Decisions** — both what and why ("we picked Postgres over MySQL because of jsonb").
- **Lessons / pitfalls** — recurring failure modes, "this dependency breaks if you bump past X".
- **Pointers** — paths, URLs, channel ids, where things live ("staging API gateway lives at `api.staging.example.com`").

Do NOT save:

- Pleasantries, ack messages, transient state.
- Verbatim user messages — the bank is not a chat log.
- Secrets, tokens, API keys, OAuth credentials, passwords. Even if the user pastes one, do not retain it.
- Anything already obvious from the current codebase, README, or globally-loaded files.
- Speculation, future plans not yet confirmed, draft ideas.

**If unsure, don't retain.** The bank is searched on every future turn — pollution is more expensive than missing one fact.

## How to retain well

A retained memory should be:

- **One or two sentences max.** Long blobs hurt search relevance.
- **Self-contained.** A future turn must understand it without reading the surrounding conversation. Bad: "He said yes." Good: "Operator approved the database cutover on 2026-03-14."
- **Specific.** Include names, dates, numbers, paths. Avoid pronouns and vague time references ("recently" → use a date).
- **Factual, not interpretive.** "User prefers terse replies" beats "User seems to prefer terse replies".

The optional `context` argument is a short hint (e.g. `"infra-cutover"`, `"deploy-config"`) — useful for grouping in the bank, not user-facing.

## Anti-patterns

- **Phantom retain.** Saying "Got it, saved." without actually calling `memory_retain`. If you didn't call the tool, the memory does not exist. Never claim retention you didn't execute.
- **Retain-everything.** Calling retain on every turn or on the entire user message. Pollutes the bank, degrades future recall.
- **Recall-without-acting.** Calling recall and then ignoring the result in your answer. Either use what came back or don't recall.
- **Cross-group leakage.** Calling recall/retain with a `group` other than your own folder. You can't read other groups' banks anyway, but writing under a wrong group fragments memory.
- **Replaying the recall block verbatim.** Don't paste recall results back to the user. Synthesise them into your answer.

## Smoke check (when in doubt)

If a turn just produced a clear durable fact, ask yourself: "Would a future me, with no chat history, want this?" If yes, retain. If you're hedging — don't.
