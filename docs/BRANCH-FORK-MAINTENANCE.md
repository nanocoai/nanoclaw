# Branch and fork maintenance

How the long-lived branches on `nanocoai/nanoclaw` relate to `main` and how to keep them in sync. This is the maintainer view: [skills-model.md](skills-model.md) explains the customization model itself, and [CONTRIBUTING.md](../CONTRIBUTING.md) covers contributing a channel or provider.

## Structure

**`main`** — core engine plus skill definitions (`.claude/skills/`). It carries the shared channel machinery every install needs (`src/channels/`: adapter interface, channel registry, Chat SDK bridge, CLI channel, ask-question flow, channel defaults) and the default Claude provider — but no optional channel adapters and no alternative providers.

**Registry branch** (`channels`) — a long-lived branch carrying the code that channel skills install: every channel adapter with its tests (`src/channels/telegram.ts`, `src/channels/telegram-registration.test.ts`, …). The channel `/add-*` skills on `main` fetch files from it (`git show origin/channels:<path> > <path>`) — an additive copy into the user's clone, never a merge.

**Provider payloads** — alternative agent providers (OpenCode, Codex, Cursor) have no registry branch. Each `/add-<provider>` skill ships its code and tests in its own `payload/` folder on `main` and copies them in from there. (`/add-ollama-provider` and `/add-llmman-provider` are configuration-only and redirect the built-in Claude path.)

**`providers`** — the former provider registry branch. It is locked by the `providers-locked` ruleset (no pushes, no deletion) and kept, never deleted, for two reasons: `/add-codex` in v2026.10.0 and earlier still copies from it, and the registry-skills workflow fetches it on every PR to prove those installs still refresh onto today's payload. An install that copied Codex from this branch needs no migration step: after it updates to a `main` that carries the payload, the next `/update-skills` rewrites every skill-owned file from `payload/`. Provider fixes land on `main`, in the skill's `payload/`.

**Legacy mechanisms** — the channel fork repos (`nanoclaw-whatsapp`, `nanoclaw-telegram`, …) and the `skill/*` branches (`skill/compact`, `skill/apple-container`, …) are the pre-skills delivery model: applied code that users merged into their clones. They are frozen (no forward merges since spring 2026) and superseded by the `channels` branch and `/add-*` skills. Don't build on them and don't forward-merge them.

## How users add capabilities

```
user clones upstream main
  ├── runs /add-whatsapp   → skill copies the adapter in from the channels branch
  ├── runs /add-opencode   → skill copies the provider in from its own payload/ folder
  └── runs /add-<tool>     → skill copies files in from its own folder
```

Channel installs are additive fetch-and-copies; other skills ship their files in their own folder or are instruction-only. Either way a user's clone never merges a registry branch, and registry branches are never merged back into `main`. [skills-model.md](skills-model.md) explains why.

## Merge directions

```
upstream main ──→ channels     (forward merge to keep adapters building against current core)
```

Fixes to existing adapters land as PRs based directly on `channels`; provider fixes land as PRs on `main`, in the skill's `payload/`. New channels and providers are contributed from a branch off `main` (see [Adding a new channel or provider](#adding-a-new-channel-or-provider)); maintainers land a channel's code portion on `channels`. Nothing merges back from `channels` into `main`.

## Forward merge procedure

```bash
# In your local nanoclaw checkout
git checkout main && git pull

git checkout -B channels origin/channels
git merge main
# Resolve conflicts (see below)
git push origin channels
git checkout main && git branch -D channels
```

This procedure assumes the branch is reasonably current. A registry branch left unmerged for months will conflict far beyond the table below — treat a large catch-up as its own reviewed effort, build and test both branches afterward, and update the table from that merge's actual receipts.

## Conflict resolution

Files with known mechanical resolutions:

| File | Resolution |
|------|------------|
| `package.json` | Take main's version + keep branch-specific deps |
| `pnpm-lock.yaml` | `git checkout main -- pnpm-lock.yaml && pnpm install` |
| `.env.example` | Combine: main's entries + branch-specific entries |
| `repo-tokens/badge.svg` | Take main's version (auto-generated) |

Source code changes (e.g. `src/types.ts`, `src/index.ts`) usually auto-merge cleanly, but can conflict if both sides modify the same lines. **Always build and test after every forward merge** — auto-merged code can be silently wrong (e.g. referencing a renamed function or using a removed parameter) even when git reports no conflicts.

## When to merge forward

After any main change that touches shared files (`package.json`, `src/index.ts`, `CLAUDE.md`, etc.). Small frequent merges = trivial conflicts. Large infrequent merges = painful. A registry branch that drifts far behind main also means every `/add-*` install copies in code written against an old core.

## Adding a new channel or provider

Skills replaced fork setup. The short version ([CONTRIBUTING.md](../CONTRIBUTING.md) has the full flow):

1. Build the adapter or provider following [skill-guidelines.md](skill-guidelines.md): a self-registering module, one appended barrel import, and a registration test that imports the real barrel.
2. Write the `/add-<name>` skill in `.claude/skills/` on `main` — a SKILL.md with the copy steps and a REMOVE.md that reverses them. A provider's code and tests go in the skill's `payload/`.
3. Open a PR from a branch off `main`; maintainers land a channel's code portion on `channels`.

## Dependencies

The `channels` branch adds its own deps on top of upstream's. Skill `nc:dep` directives pin exact versions at install time (the supply-chain policy rejects ranges and `latest`). When upstream adds or removes a dependency, verify `channels` still builds after the next forward merge — transitive dependency changes can break adapter code. Provider payloads live on `main`, so the registry-skills CI workflow applies, builds and tests each provider skill whose `nc:copy` block copies from its payload on every PR to `main`.
