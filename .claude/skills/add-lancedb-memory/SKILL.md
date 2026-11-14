---
name: add-lancedb-memory
description: Add searchable long-term memory (LanceDB, hybrid vector + BM25 recall) to selected NanoClaw agent groups as an MCP server backed by memory-lancedb-pro. Use when agents should store and recall many small facts, preferences and decisions across conversations.
---

# Add LanceDB Memory

Give selected agent groups a long-term memory store they search by meaning and
keywords. A small stdio MCP server wraps the store, embedder and hybrid
retriever of [memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro)
(pinned to `1.1.0-beta.9`) and exposes:

- `mcp__lancedb_memory__memory_recall`
- `mcp__lancedb_memory__memory_store`
- `mcp__lancedb_memory__memory_update`
- `mcp__lancedb_memory__memory_forget`
- `mcp__lancedb_memory__memory_list`
- `mcp__lancedb_memory__memory_stats`

The database lives in the group folder at `/workspace/agent/lancedb-memory/`
(`groups/<group-folder>/lancedb-memory/` on the host), so it persists and each
group has its own. It sits beside the built-in file memory under
`/workspace/agent/memory/` and does not replace it. Embeddings come from any
OpenAI-compatible endpoint; the API key is injected by the credential gateway
and never enters the container config.

How the pieces reach the container:

- The server runs from the shared agent-runner tree, mounted read-only at
  `/app/src` in every container, so it resolves `@modelcontextprotocol/sdk` and
  `zod` from the agent-runner's own dependencies. The base image is unchanged.
- The agent-facing instructions are a container skill in
  `container/skills/lancedb-memory/`.
- The library is installed only for the selected groups, as a per-group npm
  package in a derived image.

The npm release ships TypeScript sources that Bun runs directly. Its
`package.json` declares the MIT license; the GitHub repository carries no
`LICENSE` file. Cross-encoder reranking, automatic capture and the library's
other OpenClaw plugin features are out of scope: the server uses the library's
store, embedder and retriever only.

## Phase 1: Pre-flight

Check whether the files are already in place and list the groups:

```bash
ls container/agent-runner/src/lancedb-memory-mcp.ts container/skills/lancedb-memory/SKILL.md 2>/dev/null
ncl groups list
```

Ask which agent groups get the memory store, and which embedding provider to
use (Phase 3). When the files already exist, still run Phase 2: it overwrites
them with this skill's copies.

## Phase 2: Copy the server, its test and the container skill

```bash
S=.claude/skills/add-lancedb-memory
cp $S/lancedb-memory-mcp.ts      container/agent-runner/src/lancedb-memory-mcp.ts
cp $S/lancedb-memory-mcp.test.ts container/agent-runner/src/lancedb-memory-mcp.test.ts
mkdir -p container/skills/lancedb-memory
cp $S/container-skills/lancedb-memory/SKILL.md container/skills/lancedb-memory/SKILL.md
```

Typecheck the container tree and run the server's test:

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test src/lancedb-memory-mcp.test.ts)
```

The test spawns the real server over stdio against a fake embedding endpoint,
lists its six tools and checks the missing-library error. It goes red when the
server stops booting against the agent-runner's MCP SDK or zod. Its
store-and-recall case needs an unpacked `memory-lancedb-pro@1.1.0-beta.9` and
runs when `LANCEDB_MEMORY_LIB` points at that package directory; without it the
case is skipped.

The per-group MCP registration and package install in Phase 4 are runtime state
stored through `ncl`. They have no line in the tree for a registration test to
guard, so the server test and the typecheck are this skill's in-tree checks.

## Phase 3: Choose the embedding provider and connect its key

Pick one row. The model must stay the same once memories are stored: vectors
from different models or dimensions do not mix.

| Provider | `EMBEDDING_BASE_URL` | `EMBEDDING_MODEL` | Key host |
|----------|----------------------|-------------------|----------|
| OpenAI (default) | `https://api.openai.com/v1` | `text-embedding-3-small` | `api.openai.com` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-embedding-001` | `generativelanguage.googleapis.com` |
| Jina | `https://api.jina.ai/v1` | `jina-embeddings-v5-text-small` | `api.jina.ai` |
| Ollama (local) | `http://host.docker.internal:11434/v1` | `nomic-embed-text` | none |

These models have known dimensions. For any other model, also set
`EMBEDDING_DIM` to its output size; the server then requests that size from the
API, so use it only with providers that accept a `dimensions` field.

For a hosted provider, register the API key with the credential gateway,
matched to the key host, sent as `Authorization: Bearer <key>`. With OneCLI,
check first that the gateway attaches keys per agent:

```bash
sh .claude/skills/add-onecli/scripts/check-grants-gateway.sh /add-lancedb-memory
```

If it fails, show the operator its message and stop until the gateway is
upgraded. Otherwise make a private directory with `mktemp -d`, write the key
and nothing else to `key` in it with your file-writing tool (never in a shell
command, where `ps` shows it), then create the secret, delete the directory and
attach the secret to each selected group:

```bash
onecli secrets create --name "<Provider> embeddings" --type generic \
  --host-pattern <key-host> --header-name Authorization \
  --value-format 'Bearer {value}' --file <private-dir>/key >/dev/null
rm -rf <private-dir>
onecli secrets list --max 0
A=$(onecli agents list --max 0 | jq -r '(if type == "array" then . else .data end)[] | select(.identifier == "<group-id>") | .id')
onecli agents grants attach-secret --id "$A" --secret-id <secret-id>
```

Take `<secret-id>` from the `secrets list` entry with the key host. An empty
`$A` means the group has no OneCLI agent yet: send it one message, then attach.
With another gateway, follow its skill (for example `/add-iron-proxy`) to inject
the same header for the key host. Never put the key in `--env`.

Ollama needs no key: pull the model on the host (`ollama pull nomic-embed-text`).

## Phase 4: Install and register per group

`config add-package`, `config add-mcp-server` and `groups restart` are
approval-gated. Run from inside a container they return `approval-pending`
immediately; that is not an error. Wait for the admin's approval before the
next command.

For each selected `<group-id>`, install the library into the group's image:

```bash
ncl groups config add-package --id <group-id> --npm memory-lancedb-pro@1.1.0-beta.9
```

Register the server with the chosen row's values. `add-mcp-server` replaces an
existing `lancedb_memory` entry, so re-running it is safe:

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name lancedb_memory \
  --command bun \
  --args '["/app/src/lancedb-memory-mcp.ts"]' \
  --env '{"EMBEDDING_BASE_URL":"https://api.openai.com/v1","EMBEDDING_MODEL":"text-embedding-3-small","EMBEDDING_API_KEY":"placeholder"}'
```

Add `"EMBEDDING_DIM":"<size>"` to `--env` only for a model outside the table.
`EMBEDDING_API_KEY` stays the literal `placeholder`: the client needs a value to
start, and the gateway replaces the header on the way out.

Rebuild the group's image and restart it:

```bash
ncl groups restart --id <group-id> --rebuild \
  --message "LanceDB memory is installed. Store the fact 'LanceDB memory test entry', recall it with memory_recall, then delete it with memory_forget and report each result."
```

## Phase 5: Verify

Confirm the stored configuration has one `lancedb_memory` server and the
package:

```bash
ncl groups config get --id <group-id>
```

Then read the agent's reply to the restart message: all three calls must
succeed through `mcp__lancedb_memory__*` tools. The database directory
`groups/<group-folder>/lancedb-memory/` exists afterwards.

## Troubleshooting

- `memory-lancedb-pro could not be loaded`: the group's image lacks the
  package. Check `packages_npm` in `ncl groups config get`, then run
  `ncl groups restart --id <group-id> --rebuild`. A group whose
  `image_tag` is empty or points at the base image was never rebuilt.
- 401 or 403 from the embedding API: the key is missing or not attached to
  this group. Re-check Phase 3, including the grant for this group's agent.
- `Embedding dimension mismatch` or `Unsupported embedding model`: the model is
  not in the table, so set `EMBEDDING_DIM` to its real output size and
  re-register. After a model change, move the old store aside
  (`groups/<group-folder>/lancedb-memory/`) and start fresh.
- Ollama connection refused on Linux: Ollama listens on `127.0.0.1` by
  default; start it with `OLLAMA_HOST=0.0.0.0` so containers reach it through
  `host.docker.internal`, and allow that host in the gateway if it filters
  egress.
- The tools are absent: verify the `lancedb_memory` entry, then restart the
  group. A restart without `--rebuild` is enough after a config-only change.
- The agent ignores the tools: the instructions reach groups whose skill
  selection is `all` (the default). The tools work either way; ask for them by
  name.

## Removal

See [REMOVE.md](REMOVE.md) for the idempotent removal procedure.

## References

- [memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro)
- [LanceDB](https://lancedb.github.io/lancedb/)
