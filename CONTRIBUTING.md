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

## Issues

Open issues through the issue forms. Each form asks only for what maintainers need to act, and it applies the starting labels for you.

1. **Pick the matching form.**

| Form | Use it when | Labels it applies |
|------|-------------|-------------------|
| Bug report | Something is not working as expected | `kind/bug`, `triage/unresolved` |
| Capability or skill request | You want NanoClaw to do something new; capabilities usually ship as skills | `kind/feature`, `delivery/skill`, `triage/unresolved` |
| Documentation correction | A docs page is wrong, missing, or unclear | `kind/documentation`, `triage/unresolved` |
| Security hardening | A public defense-in-depth idea that is not an exploitable vulnerability | `kind/hardening`, `triage/unresolved` |

2. **Vulnerabilities are private.** If it could be exploited on a normal, correctly configured install, do not open a public issue. [Report it privately](https://github.com/nanocoai/nanoclaw/security/advisories/new). A maintainer applies `kind/security` only when disclosure is safe.

3. **Questions go to [GitHub Discussions](https://github.com/nanocoai/nanoclaw/discussions).** Setup, usage, and troubleshooting questions get faster answers there than as issues.

4. **Labels after you file.** The form stamps one `kind/*` label plus `triage/unresolved` (the capability form also adds `delivery/skill`); `triage/unresolved` means no maintainer has read the issue yet. A triager then applies exactly one `area/*` label; you never pick it. `priority/*` labels are maintainer-only, so there is no need to ask for one. `triage/needs-repro` means the issue is waiting on a minimal reproduction against a correctly configured deployment; posting one is the fastest way to move your issue.

The labels are their own reference. Run `gh label list` to print the full set with descriptions, including the `area/*`, `priority/*`, and `triage/*` families a maintainer applies after you file.

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
4. **Check exactly one change kind** in the PR template. The kind label is auto-applied from your selection:

| Checkbox | Meaning |
|----------|---------|
| `kind/bug` | Something is not working as expected |
| `kind/feature` | New capability or improvement |
| `kind/documentation` | Documentation is wrong, missing, or unclear |
| `kind/cleanup` | Refactor or cleanup with no behavior change |
| `kind/hardening` | Defense-in-depth improvement; not an exploitable vulnerability |

   Check one box, not several — with zero or multiple boxes checked, the workflow falls back to your PR title's [conventional-commit](https://www.conventionalcommits.org/) prefix (`fix:` → `kind/bug`, `feat:` → `kind/feature`, `docs:` → `kind/documentation`, `refactor:`/`chore:` → `kind/cleanup`). If that is ambiguous too, no kind is applied and a maintainer classifies the PR at triage; nothing is auto-closed.

5. **Skill delivery is separate from kind.** If your PR ships a skill, check the skill box in the Skill delivery section — a skill can be a feature, a fix, or a docs change, and the checkbox adds `delivery/skill` without changing the kind.

6. **AI assistance.** If AI tools or agents helped produce the change, check the disclosure box. The human-review attestation — "A human has reviewed this PR and stands behind every change" — is required either way: you must stand behind every line you submit.

7. **Opening PRs from the CLI or API** (`gh pr create`, agents): GitHub does not apply the template there, so paste `.github/PULL_REQUEST_TEMPLATE.md` into the body — or at minimum use a conventional-commit title so the kind fallback can classify the PR.

Area labels (`area/*`) are applied automatically from the files your PR touches; you don't pick one.

**Changelog:** `CHANGELOG.md` is maintainer-owned — don't edit it in your PR. If your change is user-visible, put one user-facing line in the template's `release-note` block; it's optional raw material that maintainers harvest at release time. Skip it and a maintainer writes the line. For a breaking change, the release note must cover detect, why, fix/migration, and rollback.

### PR body shape

This applies to humans and coding agents alike:

- First line of Summary = the purpose, one sentence. A reviewer reading only
  it knows why the PR exists.
- Then bold-led bullets, one fact per bullet (**Problem**: / **Fix**: /
  **Out of scope**:). No prose walls; depth only some reviewers need goes in
  a `<details>` appendix.
- Plain English, short sentences, no filler. If a sentence adds no
  reviewable fact, delete it.
- Concise stays king, but five attestation sections are always present —
  Summary, Change kind, Validation, Security and trust boundaries, AI
  assistance — because silence is ambiguous: "None." beats deletion, and
  reviewers rely on the fixed five landing in the same place every PR.
- Three situational sections may be deleted when they don't apply: Related
  work, User and release impact (only when there is no user-visible change),
  Skill delivery (only when this is not a skill).
- Validation lists receipts, one bullet per piece of evidence:
  command -> result. Name the test that covers the changed behavior, or say
  in one line why none does (docs-only, config-only, unreachable in CI).

One pair, same facts, the shape is the difference.

Hard to review:

> The host sweep's ABSOLUTE_CEILING_MS was a hardcoded 30 minutes, so a slow
> local-model backend that legitimately spends longer decoding one turn gets
> cold-killed mid-turn, and this change makes the ceiling configurable by
> resolving it per group from the new turn_ceiling_ms column added by
> migration 024, falling back to the NANOCLAW_TURN_CEILING_MS env var and
> then the built-in default, while invalid values fall through a level and
> values below 60s are refused and a declared Bash timeout still extends
> whatever ceiling wins.

Easy to review:

> **Problem**: `ABSOLUTE_CEILING_MS` is a hardcoded 30 minutes — slow
> local-model turns get cold-killed mid-decode.
>
> **Fix**: ceiling resolved per group: (1) `turn_ceiling_ms` (migration 024),
> (2) `NANOCLAW_TURN_CEILING_MS`, (3) the unchanged 30-minute default.
>
> **Guardrails**: invalid values fall through a level; sub-60s refused; a
> declared Bash timeout still extends whatever ceiling wins.
