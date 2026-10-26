---
name: gh-action-approval
description: PR Factory component — approval-gated GitHub CLI execution. Registers the executor on pr-factory-core's gh-action seam, posts each agent-proposed `gh` command behind a human approval card, and on approve runs it with the approver's gh credentials (namespaced gh-users mapping) under an optional repo allowlist.
---

# gh-action-approval (PR Factory component)

The execution half of the PR Factory's credentialed-GitHub flow. `pr-factory-core` owns the `pr_gh` delivery action and a seam (`src/modules/pr-factory/gh-action.ts`); without this component every `credentialed_gh` MCP call answers "component not installed". With it:

1. The agent's `credentialed_gh` call lands on core's `pr_gh` action and dispatches here through the seam.
2. The command(s) + reason post as a preview in the PR's Slack thread, followed by an approval card.
3. On **Approve**, the host runs `gh <command>` — sequentially, stopping at the first failure, with merge-failure guidance for branch-protection errors — and reports the output back to the agent.
4. The approver's namespaced user id (`<channel>:<handle>`) resolves to a gh account via the operator-created `data/gh-users.json`, so merges and comments are attributed to the human who clicked, not to a bot identity.

Skill-owned files: `src/modules/pr-factory/gh-action-approval.ts` (the executor + `pr_gh` approval handler) and `src/modules/pr-factory/gh-users.sample.json` (mapping template). Integration surface: one appended barrel line in `src/modules/index.ts`. No new dependencies — `gh` is a host binary prerequisite.

## Prerequisites

Probe each before applying; stop on a failed probe and do what it names first.

1. **The `pr-factory-core` component is applied** (this component registers on its seam and reuses its approval plumbing):

   ```bash
   grep -q 'export function setGhActionHandler' src/modules/pr-factory/gh-action.ts && echo OK
   ```

   If it fails: apply the `pr-factory-core` component first.

2. **The GitHub CLI is installed on the host** (commands run via `execFile('gh', ...)`):

   ```bash
   command -v gh && echo OK
   ```

   If it fails: install `gh` (e.g. `brew install gh`) and log in the default account with `gh auth login`.

Each step below is idempotent: if the file or line is already present, leave it as is and continue.

## Apply

All copy sources are under this component's folder; run every command from the repo root:

```bash
SKILL=.claude/skills/recipes/pr-factory/skills/gh-action-approval
```

### 1. Copy the module and the mapping template

```bash
cp $SKILL/files/src/modules/pr-factory/gh-action-approval.ts src/modules/pr-factory/gh-action-approval.ts
cp $SKILL/files/src/modules/pr-factory/gh-users.sample.json src/modules/pr-factory/gh-users.sample.json
```

### 2. Append the modules-barrel line (`src/modules/index.ts`)

After the `import './pr-factory/index.js';` line, append (skip if already present):

```typescript
import './pr-factory/gh-action-approval.js';
```

### 3. Copy the guard test

```bash
cp $SKILL/files/src/modules/pr-factory/gh-action.test.ts src/modules/pr-factory/gh-action.test.ts
```

| Test | Guards |
|------|--------|
| `src/modules/pr-factory/gh-action.test.ts` | The barrel line via the REAL modules barrel and both registrations through core's read sides: `dispatchGhAction` reaches the installed executor (preview + card + `pending_approvals` row, routed through the messaging group's instance), and `getApprovalHandler('pr_gh')` drives execution against a PATH-shimmed `gh` — tokenization, stop-on-first-failure + merge guidance, the repo-allowlist refusal, the NAMESPACED gh-users lookup with NO bare-id fallback (GH_TOKEN from a HOME-sandboxed hosts.yml), and the fail-soft missing-mapping path |

## Configuration

### Approver → gh account mapping (`data/gh-users.json`)

Operator-created (real user ids are operator data — they live under gitignored `data/`, never in the repo). Start from the shipped sample:

```bash
cp src/modules/pr-factory/gh-users.sample.json data/gh-users.json
```

then edit. Keys are **namespaced** user ids exactly as core's approval flow reports them — `<channel>:<handle>`, e.g.:

```json
{ "slack:U0XXXXXXX": "their-gh-login" }
```

There is no bare-id fallback: a key like `"U0XXXXXXX"` never matches. Each mapped gh login must be logged in on the host (`gh auth login`; the token is read from `~/.config/gh/hosts.yml`). A missing file, or an unmapped approver, degrades to the default `gh` credentials — the symptom is the host-log line "No gh account mapping for approver".

### Repo allowlist (optional, `.env`)

```bash
PR_FACTORY_GH_REPO_ALLOWLIST=acme/widgets,acme/gadgets
```

When set, any approved command that explicitly references a repo (`-R`/`--repo`, a `repos/owner/name` API path, or a github.com URL) outside the list is refused before execution. Best-effort defense in depth — commands with no recognizable repo reference run against the default gh context, and the human approval card remains the primary gate. Unset = no restriction.

### Approver roles

Card clicks from users without a `user_roles` row are silently ignored by core — the role-grant step in `pr-factory-core`'s SKILL.md ("Grant approver roles") covers this component's cards too.

## Known smell (declared, carried with sign-off)

**gh credential threading (skill-guidelines anti-pattern #5).** `onGhApproved` maps the approving user to a gh account, reads that account's `oauth_token` out of `~/.config/gh/hosts.yml`, and passes it as `GH_TOKEN` in the subprocess env — credential handling outside the OneCLI gateway. Carried deliberately because it is what attributes merge actions to the human approver. **Redesign direction:** route `gh` through the OneCLI forward proxy (the same mechanism core's handler.ts already uses for api.github.com) with per-approver vault credentials, so no token ever transits the host process env. Do not extend this pattern to new commands or new credential sources.

## Validate

```bash
pnpm run build
pnpm test
```

All green. Any failure means a step didn't apply cleanly.
