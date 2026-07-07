# Switching an agent group between providers

How an **operator** moves a live agent group from one agent provider to another (e.g. Claude → Codex) and back. Switching is an operator action: it runs from the host via `ncl groups config update --provider` + restart.

NanoClaw's runtime does not migrate anything when you switch. Provider-neutral state simply stays where it is; provider-specific state (memory, in-flight context) stays with its provider, and carrying memory across is a separate, explicit operator step (`/migrate-memory`, executed by your coding agent).

## Preconditions

1. **The target provider is installed** — run its `/add-<provider>` skill and rebuild the container image (`./container/build.sh`). If the provider isn't installed (or the name is a typo), the container fails at boot and the host surfaces its last words in the logs: look for `Container exited non-zero` with a `stderrTail` like `Unknown provider: codexx. Registered: claude, codex`.
2. **Auth is configured** — each provider documents its own auth in its install skill (for Codex: a ChatGPT-subscription or API-key secret in the OneCLI vault).

## Switching

```bash
ncl groups config update --id <group-id> --provider codex
ncl groups restart --id <group-id>
```

Sessions resolve their provider at container spawn (`sessions.agent_provider` is only set when you've explicitly pinned a session), so existing sessions pick up the new provider on their next wake.

## What carries over automatically

| State | How |
|-------|-----|
| Group identity, wiring, members, roles, destinations | Provider-neutral, in the central DB — untouched |
| Container config (model aside), skills, MCP servers, packages, mounts, cli_scope | Provider-neutral — untouched |
| Workspace files (`groups/<folder>/` — notes, data files the agent created) | Same workspace, mounted for every provider |
| Conversation archives (`conversations/`) | Provider-neutral markdown — readable by the new provider |
| Agent surfaces (system instructions / project docs) | Composed fresh at every spawn from the same sources — nothing to migrate |

## What does NOT carry over

- **Agent memory.** Each provider keeps its own store: Claude's per-group memory is `CLAUDE.local.md` in the workspace; scaffold providers (e.g. Codex) keep a `memory/` tree. Neither is touched by a switch — the old store sits intact, the new provider starts with its own. To carry memory across, run **`/migrate-memory`**: your coding agent reads the source store, distills it into the target store (copy, never move), and restarts the group. Both directions work.
- **In-flight conversation context.** Continuations are provider-specific (a Claude SDK session, a Codex thread) and stored in separate per-provider slots — the new provider starts a fresh thread. The old slot is kept, not deleted. Recent context is recoverable from `conversations/` archives.
- **Provider state dirs** (`.claude-shared/`, `.codex-shared/`). Each provider keeps its own; they sit idle while unused and are reused if you switch back.

## Rolling back

```bash
ncl groups config update --id <group-id> --provider claude
ncl groups restart --id <group-id>
```

Rollback is lossless by construction: the per-provider continuation slot means Claude resumes its previous session (subject to normal transcript-rotation age limits), and `CLAUDE.local.md` was never modified by the switch. Memory written **while on the other provider** lives in that provider's store — run `/migrate-memory` again if you want it carried back.
