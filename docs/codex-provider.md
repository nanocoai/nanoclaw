# Codex Provider

NanoClaw can run an agent group with Codex instead of Claude by selecting the
`codex` provider in that group's container config.

```sh
ncl groups config update --id <group-id> --provider codex --model gpt-5.4-mini
ncl groups restart --id <group-id> --rebuild
```

The default provider remains `claude`. Existing Claude sessions and `.claude`
state are not converted.

## Authentication

The Codex provider mounts a provider-specific session directory at
`/home/node/.codex`.

Authentication is resolved in this order:

1. `.env` or host environment value `CODEX_AUTH_JSON`
2. host `~/.codex/auth.json`
3. `.env` or host environment value `OPENAI_API_KEY`
4. `.env` or host environment value `CODEX_ACCESS_TOKEN`

When an auth JSON file is available, NanoClaw copies it into the session's
`.codex` directory before starting the container. This keeps Codex state
separate from Claude state.

## Runtime Behavior

The container image installs both Claude Code and Codex CLI. Codex is used only
for groups whose effective provider is `codex`.

The container-side provider runs:

```sh
codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C /workspace/agent -
```

For resumed conversations it runs `codex exec resume` with the stored Codex
thread id. If Codex reports a missing rollout/thread, NanoClaw starts a fresh
Codex thread and stores the new id.

### In-Flight Prompts

Codex CLI processes one complete prompt at a time in this provider. While Codex
is running, NanoClaw leaves follow-up messages pending and includes them in the
next turn instead of pushing them into the active process.

Codex itself supports interactive steering, but this first adapter uses
`codex exec` as a one-shot child process and does not have a stable
programmatic handle for sending steer messages into an active rollout. The
intended implementation is to switch `push()` to Codex steering when the
provider uses a Codex API or SDK path that exposes active rollout control.

## Memory Files

The Codex provider reads existing NanoClaw memory files as prompt context:

- `/workspace/agent/CLAUDE.md`
- `/workspace/agent/CLAUDE.local.md`
- `/workspace/global/CLAUDE.md`

It does not rename, migrate, or rewrite those files as part of provider setup.
