# Contributing

## Before You Start

1. **Check for existing work.** Search open PRs and issues before starting:
   ```bash
   gh pr list --repo nanocoai/nanoclaw --search "<your feature>"
   gh issue list --repo nanocoai/nanoclaw --search "<your feature>"
   ```
   If a related PR or issue exists, build on it rather than duplicating effort.

2. **Check alignment.** Read the [Philosophy section in README.md](README.md#philosophy). Source code changes should only be things 90%+ of users need. Skills can be more niche, but should still be useful beyond a single person's setup.

3. **One thing per PR.** Each PR should do one thing — one bug fix, one skill, one simplification. Don't mix unrelated changes in a single PR.

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** Features, capabilities, compatibility, enhancements. These should be skills.

## Breaking Changes

Breaking changes are allowed; **silent** ones are not. NanoClaw does not migrate user installs at runtime — the user's coding agent is the migrator, so every breaking change must ship a migration path that agent can execute without a human reverse-engineering the diff:

1. **Every `[BREAKING]` CHANGELOG entry must reference its migration path** — either a skill to run (`Run /<skill-name> to <action>`) or a `docs/` page covering **detect / why / fix / verify / rollback** (see [docs/onecli-upgrades.md](docs/onecli-upgrades.md) for the shape). `/update-nanoclaw` surfaces these entries after every update and walks the user through them.
2. **If the change moves an external component's sanctioned version** (gateway, pinned CLI binary, …), update its pin in [`versions.json`](versions.json). The changelog stays human-narrative; `versions.json` is the machine-checkable signal — `/update-nanoclaw` diffs it across the update and routes the user to the linked doc for any pin that moved.

## Skills

NanoClaw uses [Claude Code skills](https://code.claude.com/docs/en/skills) — markdown files with optional supporting files that teach Claude how to do something. There are four types of skills in NanoClaw, each serving a different purpose.

### Why skills?

Every user should have clean and minimal code that does exactly what they need. Skills let users selectively add features to their fork without inheriting code for features they don't want.

A skill is a self-contained add-on: a `SKILL.md` with the apply steps written as prose a coding agent can run, plus whatever the skill carries (code files, tests, a `REMOVE.md` that reverses every change apply made — required exactly when apply leaves anything behind). A fork tracks its customizations as a **recipe** of skills, which is what keeps upgrades cheap. [docs/skills-model.md](docs/skills-model.md) explains the whole model — recipes, tests, upgrades; [docs/skill-guidelines.md](docs/skill-guidelines.md) is the authoring checklist.

### Skill types

#### 1. Channel and provider skills (registry branches)

Add a messaging channel or an agent provider. The SKILL.md contains the install steps; the actual code lives on a long-lived registry branch (`channels` or `providers`) that we keep in sync with `main`.

**Location:** `.claude/skills/` on `main` (instructions only), code on the `channels` or `providers` branch

**Examples:** `/add-telegram`, `/add-slack`, `/add-discord`, `/add-opencode`

**How they work:**
1. User runs `/add-telegram`
2. Claude follows the SKILL.md: `git fetch origin channels`, then copies each file in with `git show origin/channels:<path> > <path>`. Install is an additive fetch, never a `git merge`.
3. The adapter's registration test is fetched the same way and run as verification
4. Claude walks through interactive setup (tokens, bot creation, etc.)

**Contributing a channel or provider skill:**
1. Fork `nanocoai/nanoclaw` and branch from `main`
2. Build the adapter following [docs/skill-guidelines.md](docs/skill-guidelines.md): a self-registering module, one appended barrel import, and a registration test that imports the real barrel
3. Add a SKILL.md in `.claude/skills/<name>/` with the fetch-and-copy steps, and a REMOVE.md that reverses every change. Plain prose steps are all that's required. A skill with a credential prompt or an interactive step should include a `## Troubleshooting` section.
4. Open a PR. We'll land the code on the registry branch from your work

See `/add-slack` for a good example. See [docs/skills-model.md](docs/skills-model.md) for why install is a fetch, never a merge.

#### 2. Utility skills (with code files)

Standalone tools that ship code files alongside the SKILL.md. The SKILL.md tells Claude how to install the tool; the code lives in the skill directory itself (e.g. in a `scripts/` subfolder).

**Location:** `.claude/skills/<name>/` with supporting files

**Examples:** a self-contained CLI or helper shipped in a `scripts/` subfolder of the skill.

**Key difference from channel/provider skills:** the code is self-contained in the skill directory and gets copied into place during installation; nothing is fetched from a registry branch.

**Guidelines:**
- Put code in separate files, not inline in the SKILL.md
- Use `${CLAUDE_SKILL_DIR}` to reference files in the skill directory
- SKILL.md contains installation instructions, usage docs, and troubleshooting

#### 3. Operational skills (instruction-only)

Workflows and guides with no code changes. The SKILL.md is the entire skill — the coding agent follows the instructions to perform a task.

**Location:** `.claude/skills/` on `main`

**Examples:** `/setup`, `/debug`, `/customize`, `/update-nanoclaw`, `/update-skills`

**Guidelines:**
- Pure instructions — no code files, no branch merges
- Use `AskUserQuestion` for interactive prompts
- These stay on `main` and are always available to every user

#### 4. Container skills (agent runtime)

Skills that run inside the agent container, not on the host. These teach the NanoClaw agent how to use tools, format output, or perform tasks. They are synced into each group's `.claude/skills/` directory when a container starts.

**Location:** `container/skills/<name>/`

**Examples:** `agent-browser` (web browsing), `frontend-engineer`, `onecli-gateway` (OneCLI proxy usage), `self-customize`, `vercel-cli`, `welcome`; channel-specific: `slack-formatting` (Slack mrkdwn syntax) and `whatsapp-formatting` (channels branch; installed by `/add-slack` / `/add-whatsapp`)

**Key difference:** You never invoke these from a coding-agent session on the host, the way you run `/setup` or `/update-nanoclaw` in Claude Code/Codex/OpenCode. They're mounted into the sandbox and loaded by the NanoClaw agent itself, shaping how it behaves when you chat with it.

**Guidelines:**
- Follow the same SKILL.md + frontmatter format
- Use `allowed-tools` frontmatter to scope tool permissions
- Keep them focused — the agent's context window is shared across all container skills

### Writing a good skill

The authoring bar is [docs/skill-guidelines.md](docs/skill-guidelines.md): mostly adds, minimal reach-ins into existing code, a test for every functional integration point, and a REMOVE.md whenever apply leaves anything behind. [docs/skills-model.md](docs/skills-model.md) explains the model behind it.

### SKILL.md format

All skills use the [Claude Code skills standard](https://code.claude.com/docs/en/skills):

```markdown
---
name: my-skill
description: What this skill does and when to use it.
---

Instructions here...
```

**Rules:**
- Keep SKILL.md **under 500 lines** — move detail to separate reference files
- `name`: lowercase, alphanumeric + hyphens, max 64 chars
- `description`: required — Claude uses this to decide when to invoke the skill
- Put code in separate files, not inline in the markdown
- See the [skills standard](https://code.claude.com/docs/en/skills) for all available frontmatter fields

## Templates

Agent templates (reusable bundles of instructions + MCP servers + skills) ship in the separate [`nanocoai/nanoclaw-templates`](https://github.com/nanocoai/nanoclaw-templates) repo, not this one. Contribute them there via PR (its README has the anatomy and checklist). For how templates load and the OneCLI credential model, see [docs/templates.md](docs/templates.md).

## Testing

Test your contribution on a fresh clone before submitting. For skills, run the skill end-to-end and verify it works.

## Pull Requests

### Before opening

1. **Link related issues.** If your PR resolves an open issue, include `Closes #123` in the description so it's auto-closed on merge.
2. **Test thoroughly.** Run the feature yourself. For skills, test on a fresh clone.
3. **Check for installation-specific files.** Before creating a PR, verify no installation-specific files are in your diff (see PR Hygiene in CLAUDE.md).
4. **Check the right box** in the PR template. Labels are auto-applied based on your selection:

| Checkbox | Label |
|----------|-------|
| Feature skill | `PR: Skill` + `PR: Feature` |
| Utility skill | `PR: Skill` |
| Operational/container skill | `PR: Skill` |
| Fix | `PR: Fix` |
| Simplification | `PR: Refactor` |
| Documentation | `PR: Docs` |

### PR description

Keep it concise. Remove any template sections that don't apply. The description should cover:

- **What** — what the PR adds or changes
- **Why** — the motivation
- **How it works** — brief explanation of the approach
- **How it was tested** — what you did to verify it works
- **Usage** — how the user invokes it (for skills)

Don't pad the description. A few clear sentences are better than lengthy paragraphs.
