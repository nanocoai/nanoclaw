# Switching an agent group between providers

How an operator moves a live agent group between providers, for example Claude
to Codex and back. The switch runs from the host.

## Preconditions

1. Install or reapply the target provider's `/add-<provider>` skill, then
   rebuild the container image. Reapplication matters when core adds a provider
   contract such as a lifecycle hook.
2. Configure the provider's authentication as documented by its skill.
3. If the group still has `.seed.md`, `CLAUDE.local.md`, or unindexed
   legacy `memory/memories/imported-agent-memory.md`, run `/migrate-memory`
   first. This is a one-time upgrade migration, not part of a provider switch.

## Switching

```bash
ncl groups config update --id <group-id> --provider codex
ncl groups restart --id <group-id>
```

Sessions resolve their provider at container spawn, so existing sessions use
the new provider on their next wake unless the session itself was explicitly
pinned.

## What carries over

| State | How |
|-------|-----|
| Group identity, wiring, members, roles, destinations | Provider-neutral central DB |
| Container config, skills, MCP servers, packages, mounts, CLI scope | Provider-neutral config |
| Standing role and persona | `instructions.prepend.md`, composed into each provider's native project document |
| Durable memory | Shared `memory/` tree; the provider hook loads its index and definition |
| Workspace files and conversation archives | Same group workspace for every provider |

The memory hook runs when a context window is created: `startup`, `clear`, and
`compact`. It does not run on `resume`, because the resumed conversation already
contains the injected memory context.

The shared tree is an Open Knowledge Format (OKF) v0.1 bundle. Durable Markdown
concepts use YAML frontmatter with a `type`, while reserved `index.md` and
`log.md` files do not. Missing metadata does not block recall; the agent repairs
it opportunistically when working with that file. Search remains ordinary
filesystem search (`rg`, `find`, and relative Markdown links).

## What does not carry over

- **In-flight conversation context.** Continuations are provider-specific (a
  Claude SDK session, a Codex thread). The target provider starts a fresh
  context; the old continuation remains available if you switch back.
- **Provider state directories.** `.claude-shared/` and `.codex-shared/` remain
  separate and idle while their provider is not selected.
- **Provider-specific model settings.** Confirm the selected model and effort
  are valid for the target provider.

## Rolling back

```bash
ncl groups config update --id <group-id> --provider claude
ncl groups restart --id <group-id>
```

Memory and standing instructions need no reverse migration because both
providers use the same files. The prior provider resumes its own continuation,
subject to its normal transcript rotation policy.
