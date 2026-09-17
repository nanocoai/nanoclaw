---
name: pr-factory
description: Recipe — compose the PR Factory (GitHub PR triage, review, and testing with human approval gates in Slack) from the component skills shipped inside this folder. Apply order, core-version probes, operator setup, and the composed-stack validation.
---

# PR Factory (recipe)

The PR Factory turns incoming GitHub pull requests into Slack threads, each driven by a per-PR worker agent session that triages, reviews, and test-plans the change — with a human approving every consequential action (merges, test runs, skill edits) from an approval card in the thread. An optional supervisor bot takes feedback and improves the worker, and an optional tester bot executes approved test plans on ephemeral VMs. Everything runs inside one NanoClaw host: the webhook receiver, the thread lifecycle, the approval gates, and the VM control plane.

This is a **recipe**: a thin composition layer over the component skills shipped inside this folder. Each component is independently appliable and removable and carries its own SKILL.md, REMOVE.md, `files.txt` manifest, and generated `files/` mirror; the details (apply steps, credentials, guard tests, known smells) live there. Architecture: [docs/pr-factory.md](../../../../docs/pr-factory.md).

**Discovery note:** `recipes/` is not slash-discoverable — there is no `/pr-factory` command. A recipe applies by reading this file: point Claude at `.claude/skills/recipes/pr-factory/SKILL.md` (or run it from a `/setup`-style flow) and follow it top to bottom.

```
.claude/skills/recipes/pr-factory/
  SKILL.md                  # this recipe
  REMOVE.md                 # recipe-level reversal (delegates to the components)
  files.txt + files/        # recipe-owned files: docs + composed-stack tests + sync infra
  skills/
    slack-bots/             # supervisor + tester Slack adapters (named channel instances)
    pr-factory-core/        # the engine: webhook, sessions, approvals, MCP tools, seams
    gh-action-approval/     # approval-gated gh execution (seam component)
    vm-test-orchestrator/   # ephemeral test-VM control plane (seam component)
    slack-canvas/           # markdown → Slack Canvas rendering (seam component)
```

## Prerequisites — core version

Requires **nanoclaw ≥ 2.1.11**. The components make near-zero core edits because core already ships the hooks they register against. The probes are the real check — run each; on a failed probe, **stop** and update core first.

| Probe | Core capability |
|---|---|
| `test -f src/db/migrations/016-messaging-group-instance.ts && grep -q 'instance?: string' src/channels/adapter.ts && echo OK` | native channel-instance substrate |
| `grep -q 'export function getDeliveryAction' src/delivery.ts && echo OK` | delivery-action read-side getter |
| `grep -q 'byLine' src/channels/chat-sdk-bridge.ts && echo OK` | approval-card actor byline |
| `grep -q 'justWoke' src/host-sweep.ts && echo OK` | host-sweep wake grace period |
| `grep -q 'export function registerApprovalResolvedHandler' src/modules/approvals/primitive.ts && echo OK` | approval-resolved hook |
| `awk '/export function writeOutboundDirect/{f=1} f&&/openOutboundDbRw/{print "OK"; exit} /^}/{if(f)f=0}' src/session-manager.ts` | writeOutboundDirect opens read-write |
| `grep -q 'export function registerWebhookHandler' src/webhook-server.ts && echo OK` | raw webhook-route registry |

The component SKILL.mds re-probe the subset each one depends on; this table is the full set.

## Apply order

**Apply the recipe as a unit — all components, in this order.** Each component degrades gracefully on its own (a missing canvas provider falls back to `.md` uploads, a missing test orchestrator answers "not installed"), so they read as "optional" individually. But the recipe ships composed-stack guard tests (`recipe-pr-factory-stack.test.ts`, `skill-sync.test.ts`) that assume the whole stack is present — a partial apply leaves those red. So for a recipe install, apply every component below; treat "what you lose without component X" as a description of graceful degradation, not an invitation to skip it.

Order is load-bearing: `slack-bots` patches the adapter `/add-slack` installs, `pr-factory-core` imports `slack-bots`' instance constants, and the three seam components register on seams owned by `pr-factory-core`. Apply each component by following its own SKILL.md.

1. **`/add-slack`** (stock channel skill) — the worker bot. When `/add-slack` reaches its dependency-install step, **install `@chat-adapter/slack` exactly pinned at 4.26.0** — `pnpm install @chat-adapter/slack@4.26.0 --save-exact`. The exact pin is load-bearing: 4.27.0 pulls `chat@4.27.0` types that fail the build against core's `chat@^4.24.0` resolution, and a caret range re-resolves forward and breaks the build later. Verify the resolved version before continuing:

   ```bash
   node -p "require('@chat-adapter/slack/package.json').version"   # must print 4.26.0
   grep '"@chat-adapter/slack"' package.json                       # must read "4.26.0" (no ^ or ~)
   ```

   If it shows anything other than `4.26.0`, re-run the pinned install above before moving on.
2. **`skills/slack-bots`** — supervisor + tester Slack apps as named channel instances, sibling-echo suppression, the bot_id→instance legacy-upgrade migration.
3. **`skills/pr-factory-core`** — the engine. Inert until `GITHUB_WEBHOOK_SECRET` is set.
4. **`skills/gh-action-approval`** — credentialed `gh` execution. (Absent, `credentialed_gh` calls answer "component not installed".)
5. **`skills/vm-test-orchestrator`** — the test-VM control plane. (Absent, approved test plans answer "no test orchestrator installed".)
6. **`skills/slack-canvas`** — Canvas rendering. (Absent, plans and reviews post as plain text + `.md` uploads.)

Finally copy in the recipe-owned files (idempotent, like every apply step; run from the repo root, like every command in this bundle):

```bash
RECIPE=.claude/skills/recipes/pr-factory
cp $RECIPE/files/docs/pr-factory.md docs/pr-factory.md
cp $RECIPE/files/src/recipe-pr-factory-stack.test.ts src/recipe-pr-factory-stack.test.ts
cp $RECIPE/files/scripts/sync-skill-files.sh scripts/sync-skill-files.sh && chmod +x scripts/sync-skill-files.sh
cp $RECIPE/files/src/skill-sync.test.ts src/skill-sync.test.ts
```

`sync-skill-files.sh` + `skill-sync.test.ts` are the manifest/mirror infrastructure every component's `files/` folder is generated by; the stack test is described under Validate.

## Operator setup

Summary only — each item is detailed in the named component's SKILL.md:

- **Three Slack apps** in one workspace: worker (`/add-slack`), supervisor + tester (`skills/slack-bots` → Credentials). Webhook URLs `/webhook/slack`, `/webhook/slack-supervisor`, `/webhook/slack-tester`.
- **GitHub webhook**: set `GITHUB_WEBHOOK_SECRET` in `.env` and add a Pull requests webhook on the repo pointing at `/webhook/github` (`skills/pr-factory-core` → Configuration).
- **Channels + repo env**: `PR_FACTORY_SLACK_CHANNEL_ID`, optional `PR_FACTORY_SUPERVISOR_SLACK_CHANNEL_ID`, `PR_FACTORY_DEFAULT_REPO` (`skills/pr-factory-core`).
- **Approver roles (required)**: core silently ignores approval-card clicks from users without a `user_roles` row. `pnpm run ncl roles grant --user 'slack:U0XXXXXXX' --role admin` for every human who will click cards (`skills/pr-factory-core` → "Grant approver roles").
- **gh auth + approver mapping**: install `gh`, log in each approver's account, create `data/gh-users.json` from the shipped sample — keys are **namespaced** (`"slack:U0XXX": "gh-login"`) with no bare-id fallback (`skills/gh-action-approval`).
- **VM pool knobs**: `PR_FACTORY_TEST_VM_TEMPLATE` (required for test runs), `PR_FACTORY_TEST_SSH_HOST`, `TEST_VM_SSH_USER`, `TEST_VM_NAME_PREFIX`, `TEST_VM_HOST_TEMPLATE` — defaults are exe.dev's conventions; any SSH-driven provider works (`skills/vm-test-orchestrator`). Tester needs the operator-created `pr-tester` agent group.

## Validate

```bash
pnpm run build
pnpm test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test)
```

All suites green. `src/recipe-pr-factory-stack.test.ts` is the composed-stack leg: it runs the full migration chain (instance substrate + the two component migrations) on a fresh DB, bootstraps the PR Factory entities on that composed schema, asserts the delivery file-transform slot has exactly one registrant across all modules, and runs `sync-skill-files.sh --all --check` so a drifted component mirror fails CI. Each component's own guard tests cover its integration points.

## What you get

- **Per-PR worker flow** — webhook → Slack thread (status reactions 🟢⚪🔴🟣) → per-thread agent session seeded with the diff → triage report → review → test plan. The default triage/review/test-plan workflow is seeded into `groups/pr-factory-worker/CLAUDE.local.md` (edit it to tune trusted contributors, merge policy, review depth) or replaced wholesale via `PR_FACTORY_REVIEW_SKILL` — see "Tailoring the bots" below.
- **Approval cards for every consequential action** — send-to-testing, retry, skill edits, and every `gh` write (merge, close, comment), executed with the approving human's gh identity.
- **Supervisor bot** — its own Slack identity; takes feedback in an admin channel or @-mentioned in PR threads, proposes worker skill/instruction edits behind a diff + approval card. Approved edits apply to the next PR the worker triages.
- **VM test runs** — approved plans clone an ephemeral VM from a template, check out the PR, build, boot, and hand the VM to the tester agent; PASS wakes the worker to propose a merge, FAIL to analyze.
- **Canvases** — test plans, results, and review writeups render as Slack Canvases instead of file uploads (paid Slack plan; falls back to `.md` uploads otherwise).

## Tailoring the bots — your own container skills

The shipped triage/review/test-plan workflow is deliberately generic. The PR Factory gets sharply better when the operator replaces it with skills written for **their** repo — its review dimensions, its triage rules, its test environments. The mechanism is all core's:

- **Container skills** live at `container/skills/<name>/SKILL.md` (read-only at `/app/skills` in every agent container). Each group's container config has a `skills` selection (default `'all'`) that controls which ones are symlinked into that group's `~/.claude/skills` at spawn — so a new skill folder reaches the worker on its next container start, no config change needed.
- **Group-private skills**: a directory at `groups/<folder>/.claude/skills/<name>/` is discovered as a project-level skill (the agent's cwd is `/workspace/agent`, the group folder). Use this for a skill only one group should ever see — but note it sits outside the supervisor's edit loop below.
- **Precedence**: with `PR_FACTORY_REVIEW_SKILL=<name>` set, every PR trigger opens with `Use the /<name> skill to triage this pull request.` and the generic defaults seeded into `groups/pr-factory-worker/CLAUDE.local.md` are ignored. Without it, the seeded instructions run — editing them in place is the lighter path when the defaults are close.
- **Iteration loop**: `container/skills/` is what the supervisor bot edits — `propose_skill_edit` writes `container/skills/<skill>/<file>` behind a diff + approval card; the edit applies to the next PR the worker triages (running sessions keep their old read-only skill view until they next spawn). Routing repo-specific workflow into a container skill (rather than CLAUDE.local.md) is what makes the feedback loop reviewable.

### Interview the operator, then generate

Run this as a conversation — one cluster of questions per skill, then write the files:

1. **Review standards** — what does a good review catch in this repo? Which dimensions matter (correctness, security, migration safety, API stability, performance, docs)? Any house rules — error-handling patterns, layering, naming? What severity scale gates a merge? → the **review skill**: the entry point named in `PR_FACTORY_REVIEW_SKILL`, owning the full triage → review → test-plan pipeline (keep the shipped hard constraints: GitHub writes only via `credentialed_gh`, output to the PR thread, the `[PR_CONTEXT: …]` tag is authoritative).
2. **Triage categories and routing** — what kinds of PRs arrive (features, fixes, dep bumps, docs, vendor syncs)? Which classes auto-merge, which auto-close, who are the trusted authors? What's the merge strategy? → the triage stage of that skill, or a separate **triage skill** it invokes.
3. **Test environments and depth** — what exists (unit suites, integration rigs, a staging VM, devices)? What depth is conventional per change type, and what can't be tested automatically? → a **test-planning skill** that fixes plan depth and the plan-file format.

Then: write each as `container/skills/<name>/SKILL.md`, set `PR_FACTORY_REVIEW_SKILL=<review-skill-name>` in `.env`, restart the host, and point future tuning at the supervisor bot ("the worker keeps missing X — fix the skill") so every refinement lands as a diff behind an approval card.

### Worked example — review skill skeleton

`container/skills/acme-review/SKILL.md`:

```markdown
---
name: acme-review
description: Triage and review a pull request against acme/widgets' standards. Used by the PR Factory worker for every incoming PR.
---

# acme/widgets PR review

Triage first (per the categories below), then review the diff dimension by
dimension. Verdict first, then findings — most severe first, each with file:line.

## Dimensions

1. **Migration safety** — anything under `migrations/` must be backward-compatible
   one release back; destructive ops (DROP/ALTER) without a two-step plan are Must-fix.
2. **API stability** — exported types and HTTP routes are frozen; a breaking change
   needs a v2 route, not an edit.
3. **Error handling** — no swallowed errors; failures propagate to the route-level
   handler. A bare `catch {}` is Must-fix.

## Severity

Must-fix (blocks merge) · Should-fix (request changes) · Nit (comment only).
```

Then `PR_FACTORY_REVIEW_SKILL=acme-review` in `.env` and restart. Triage and test-planning skills follow the same shape.

## Upgrading a legacy bot_id install

For installs that ran an earlier PR Factory build on the old `bot_id` multi-bot substrate. Boot order matters — **never boot bare core on such a DB** (migration 016 crash-loops on the supervisor/tester rows):

1. Stop the host.
2. Check out a tree with this recipe **fully applied** (all components).
3. Boot. The two component migrations run first: `module-slack-bots-bot-id-to-instance` maps `bot_id` rows to instances and rewrites the Chat SDK state namespaces; `module-pr-factory-pr-threads-v2` drops the dead `bot_id` column from `pr_threads`.
4. Verify the Slack webhook URLs — they are byte-identical (`/webhook/slack-supervisor`, `/webhook/slack-tester`), so the Slack app consoles need zero changes.
5. Expect at most one re-@mention per subscribed thread (`chat_sdk_locks` is cleared; it is TTL-bound state).
6. **Re-key `data/gh-users.json` to namespaced ids** (`"U0XXX"` → `"slack:U0XXX"`). An un-migrated mapping silently degrades every approver to the default gh credentials — there is no bare-id fallback.
7. Operator data carries by hand: `data/gh-users.json`, the repo mirror dir, `groups/pr-tester/`, the OneCLI vault.

## Remove

[REMOVE.md](REMOVE.md) — runs the component REMOVE.mds in reverse apply order, then deletes the recipe-owned files.
