<!-- graphiti-memory:start -->
## Long-term memory (Graphiti)

You have a knowledge graph behind the `mcp__graphiti__*` tools. It persists
across sessions and restarts. Your graph is `group_id` **`{{GROUP_ID}}`** —
pass it on every call (`group_id` for `add_memory`, `group_ids: ["{{GROUP_ID}}"]`
for searches and `get_episodes`). Never read or write any other `group_id`;
other graphs on this server belong to other agents.

**Recall before answering.** When a message touches people, projects,
preferences, decisions, or anything the user may have told you before, run
`search_memory_facts` (relationships) and/or `search_nodes` (entities) with a
specific query first. Only the results enter your context, so search narrowly
rather than dumping the graph.

**Remember durable information.** After a turn that establishes something
worth keeping — a preference, a decision, a fact about a person or project, a
correction to something you believed — call `add_memory` with a short,
self-contained episode in plain prose. Use `source: "text"` (or `"json"` for
structured data) and a descriptive `name`. Do not store secrets, credentials,
or one-off chatter. Ingestion is asynchronous: a fact you just added may take
a few seconds to become searchable.

**Let the graph handle change.** When something changes, add the new fact as
a new episode; Graphiti invalidates the superseded fact (it keeps its history
with `invalid_at`). Prefer facts that are currently valid when answering.
Delete an episode or edge only when the user asks you to forget it.

If a Graphiti call fails with a connection error, say memory is unavailable
and carry on; do not retry in a loop.
<!-- graphiti-memory:end -->
