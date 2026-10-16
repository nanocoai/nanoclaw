# PR Factory

The PR Factory automatically triages, reviews, and tests incoming GitHub pull requests, with humans approving every consequential action from Slack. It is composed by the recipe at [`.claude/skills/recipes/pr-factory/`](../.claude/skills/recipes/pr-factory/SKILL.md) from five component skills on top of the stock `/add-slack` channel: `slack-bots`, `pr-factory-core`, and the optional `gh-action-approval`, `vm-test-orchestrator`, and `slack-canvas`.

Everything runs inside this NanoClaw host: the GitHub webhook receiver, the Slack thread lifecycle, the approval gates, and the test orchestration. Test runs execute on ephemeral VMs cloned per PR over SSH; results come back through the tester agent's `submit_test_results` MCP tool — there is no secondary "orchestrator VM", no SCP inbox/outbox.

```
GitHub webhook ──▶ NanoClaw host ──▶ Slack thread per PR (worker bot)
                       │                  │ humans approve cards
                       │                  ▼
                       ├─▶ worker agent container (triage → review → test plan)
                       ├─▶ supervisor agent container (feedback loop, own bot)
                       └─▶ test orchestrator ──ssh──▶ ephemeral VM per PR
                                  ▲                        │
                                  └── tester agent container (runs plan, submits results)
```

**One instance, one repository.** A factory instance serves a single repository — the one in `PR_FACTORY_DEFAULT_REPO`, the one its GitHub webhook is attached to. All run state (per-PR sessions, test VMs, the 30-minute timeouts) is keyed per-PR *within that repo*; PR numbers collide across repos, so one instance cannot safely fan out to several. Cover more repositories by running more instances, each with its own channels, bots, and `PR_FACTORY_DEFAULT_REPO`.

---

## Table of Contents

1. [Components and Seams](#components-and-seams)
2. [Environment Variables](#environment-variables)
3. [Module Initialization](#module-initialization)
4. [Bootstrap: Agent Groups, Messaging Groups, and Wiring](#bootstrap)
5. [Database: pr_threads Table](#database-pr_threads-table)
6. [Webhook Receiver](#webhook-receiver)
7. [PR Handler: From Webhook to Agent Session](#pr-handler)
8. [The Worker's Review Workflow](#the-workers-review-workflow)
9. [The Supervisor Agent](#the-supervisor-agent)
10. [The Tester Agent and Test Orchestration](#test-orchestration)
11. [MCP Tools (Container-Side)](#mcp-tools-container-side)
12. [Delivery Actions and Approval Handlers (Host-Side)](#delivery-actions-and-approval-handlers-host-side)
13. [Testing Approval Gate](#testing-approval-gate)
14. [Skill Edit Approval Gate](#skill-edit-approval-gate)
15. [GitHub CLI Approval Gate](#github-cli-approval-gate)
16. [Slack: Three Bots, One Channel Type](#slack-three-bots-one-channel-type)
17. [Slack Canvases](#slack-canvases)
18. [Activity Log](#activity-log)
19. [File Map](#file-map)
20. [Manual Operations](#manual-operations)

---

## Components and Seams

`pr-factory-core` is the engine; the three seam components register against seams core owns, at import time, and core degrades gracefully when any is absent (so a partial install still runs — but the recipe is meant to be applied whole, since its composed-stack tests assume every component is present):

| Seam (core file) | Registered by | Without the component |
|---|---|---|
| `src/modules/pr-factory/gh-action.ts` (`setGhActionHandler`) | `gh-action-approval` | `credentialed_gh` calls notify the agent that the component is missing |
| `src/modules/pr-factory/test-orchestration.ts` (`registerTestOrchestrator`) | `vm-test-orchestrator` | approved test plans answer "no test orchestrator installed" |
| `src/modules/pr-factory/canvas.ts` (`registerCanvasProvider`) | `slack-canvas` | test plans/results post as plain text + `.md` file upload |

The `slack-bots` component owns the `SUPERVISOR_INSTANCE` / `TESTER_INSTANCE` constants (`'slack-supervisor'` / `'slack-tester'`); core imports both. Each seam holds a single provider — a declared smell in core's SKILL.md, acceptable while exactly one component implements each.

---

## Environment Variables

All read from `.env` (via `readEnvFile`) or `process.env`. The module is **inert** if `GITHUB_WEBHOOK_SECRET` is unset.

| Variable | Required | Purpose |
|----------|----------|---------|
| `GITHUB_WEBHOOK_SECRET` | Yes (to enable) | HMAC-SHA256 secret for GitHub webhook signature verification |
| `PR_FACTORY_SLACK_CHANNEL_ID` | Yes | Bare Slack channel ID (e.g. `C0XXXXXXX`) where PR threads are created |
| `SLACK_BOT_TOKEN` | Yes | Worker Slack app's bot token (the one installed by `/add-slack`) |
| `PR_FACTORY_SUPERVISOR_SLACK_CHANNEL_ID` | No | Bare Slack channel ID for the supervisor's admin channel. Enables the supervisor agent group |
| `SLACK_SUPERVISOR_BOT_TOKEN` / `SLACK_SUPERVISOR_SIGNING_SECRET` | No* | Supervisor Slack app credentials (`slack-bots` component) |
| `SLACK_TESTER_BOT_TOKEN` / `SLACK_TESTER_SIGNING_SECRET` | No** | Tester Slack app credentials (`slack-bots` component) |
| `PR_FACTORY_DEFAULT_REPO` | No | Repo assumed when an MCP action omits `repo`. No built-in default — set it (e.g. `acme/widgets`) or always pass `repo` explicitly |
| `PR_FACTORY_REPO_MIRROR_DIR` | No | Local clone refreshed before each triage (default: `data/repo-mirror`; no-op when absent) |
| `PR_FACTORY_REVIEW_SKILL` | No | Operator-supplied container skill that owns the review workflow (see [The Worker's Review Workflow](#the-workers-review-workflow)) |
| `PR_FACTORY_GH_REPO_ALLOWLIST` | No | The repos the approved `gh` actions may touch — a comma-separated `owner/name` list; an approved `gh` command referencing a repo outside it is refused before execution (`gh-action-approval`). This is a write-target guard, **not** a multi-repo switch: a factory instance still serves the one repo in `PR_FACTORY_DEFAULT_REPO` |
| `PR_FACTORY_TEST_VM_TEMPLATE` | For testing | Template VM cloned per test run. Test runs fail gracefully without it |
| `PR_FACTORY_TEST_SSH_HOST` | No | VM control-plane SSH host (default: `exe.dev`) |
| `PR_FACTORY_TEST_SSH_KEY` | No | SSH identity file for the control plane (default: ssh's own identities) |
| `TEST_VM_SSH_USER` | No | Login user on cloned VMs (default: `exedev`) |
| `TEST_VM_NAME_PREFIX` | No | VM name = `<prefix><pr-number>` (default: `nctest-`) |
| `TEST_VM_HOST_TEMPLATE` | No | Per-VM hostname; `{name}` expands to the VM name (default: `{name}.exe.xyz`) |
| `WEBHOOK_PORT` | No | Port for the shared webhook server (default: `3000`) |

\* Required when `PR_FACTORY_SUPERVISOR_SLACK_CHANNEL_ID` is set.
\*\* Required when the tester agent group (`pr-tester`) is in use.

The `TEST_VM_*` / `PR_FACTORY_TEST_*` defaults are exe.dev's conventions; any provider whose control plane speaks `cp <template> <name>` / `tag <name> ephemeral` / `rm <name>` over SSH and gives each VM a DNS-resolvable hostname works by overriding the knobs.

If `NANOCLAW_EGRESS_LOCKDOWN` is enabled (default off), worker containers cannot reach GitHub and tester containers cannot SSH to test VMs — leave it off for PR Factory groups or allowlist those hosts.

---

## Module Initialization

**File:** `src/modules/pr-factory/index.ts`

The module self-registers when imported by `src/modules/index.ts`. Even in inert mode (no `GITHUB_WEBHOOK_SECRET`), two things still bind at import time because they live at module top level:

- the **approval handlers** (`pr_send_to_testing`, `pr_retry_test`, `pr_propose_skill_edit` in core; `pr_gh` in `gh-action-approval`) — registered by their own files on import;
- the **approval-resolved hook** — `registerApprovalResolvedHandler` clears the 👀 awaiting-approval reaction when an admin *rejects* an approval card on a PR-thread session (approve paths clear it inside each handler).

With the env trio present (`GITHUB_WEBHOOK_SECRET`, `PR_FACTORY_SLACK_CHANNEL_ID`, `SLACK_BOT_TOKEN`), the gated block runs:

### Phase 1: registration (immediate)

Six `registerDeliveryAction` calls (see [the table](#delivery-actions-and-approval-handlers-host-side)). The container tools omit `repo` when the agent doesn't pass one; the default is applied **here, host-side**, from `PR_FACTORY_DEFAULT_REPO` — the container never sees that env var.

### Phase 2: adapter-ready callback (deferred)

Once the Slack delivery adapter is connected (`onDeliveryAdapterReady`), the module:

1. **Bootstraps** agent groups, messaging groups, and wirings (`bootstrapPrFactory`).
2. **Registers** the GitHub webhook handler at `/webhook/github`.
3. **Initializes the orchestrator pair** (`initOrchestrator`) — only when the `vm-test-orchestrator` component is installed *and* the operator-created `pr-tester` agent group and its messaging group exist; otherwise logs "Test orchestrator disabled" with which pieces are missing.
4. **Registers** a shutdown handler (`shutdownOrchestrator` + the orchestrator module's `shutdown`, which destroys all live test VMs).

### Guard chain

```
GITHUB_WEBHOOK_SECRET missing?       → debug log, module disabled
PR_FACTORY_SLACK_CHANNEL_ID missing? → warn, disabled
SLACK_BOT_TOKEN missing?             → warn, disabled
All present?                         → enabled
```

---

## Bootstrap

**File:** `src/modules/pr-factory/bootstrap.ts`

Runs on every boot (from the adapter-ready callback). All operations are idempotent and self-correcting: existing wirings with drifted `engage_mode` / `session_mode` values are updated, not skipped. Messaging groups are keyed by `(channel_type, platform_id, instance)` on the channel-instance substrate (core migration 016) and resolved with exact-instance lookups — the worker, supervisor, and tester rows share one Slack channel without shadowing each other.

### Worker

1. Agent group `pr-factory-worker`, created via `initGroupFilesystem(ag, { instructions })` — the default triage/review/test-plan workflow is seeded into `groups/pr-factory-worker/CLAUDE.local.md` once, never overwritten.
2. Messaging group `slack:<WORKER_CHANNEL_ID>` on the **default instance** (`'slack'`), `unknown_sender_policy: 'public'`.
3. Wiring: `engage_mode: 'mention-sticky'`, `session_mode: 'per-thread'`, `sender_scope: 'all'`, `ignored_message_policy: 'drop'`. The PR handler pre-subscribes each new PR thread, so in-thread replies engage the worker without an @-mention.
4. **Foreign-wiring cleanup** — any other agent group wired to the worker's row is dropped (prevents legacy groups double-engaging).

### Supervisor (when `PR_FACTORY_SUPERVISOR_SLACK_CHANNEL_ID` is set)

1. Agent group `pr-factory-supervisor`, seeded with `SUPERVISOR_INSTRUCTIONS`.
2. Admin-channel messaging group (instance `'slack-supervisor'`): `engage_mode: 'pattern'` (`.`), `session_mode: 'shared'`.
3. PR-channel messaging group (instance `'slack-supervisor'`): `engage_mode: 'mention'`, `ignored_message_policy: 'accumulate'`, `session_mode: 'per-thread'`.

### Tester (when the operator has created the `pr-tester` agent group)

The tester agent group's instructions describe the operator's test environment, so the group itself is **operator-created** (folder `pr-tester`). When it exists, bootstrap ensures the tester's PR-channel messaging group (instance `'slack-tester'`) with `engage_mode: 'mention'`, `ignored_message_policy: 'accumulate'`, `session_mode: 'per-thread'`. The orchestrator resolves tester sessions against this row.

---

## Database: pr_threads Table

**Migration:** `src/db/migrations/module-pr-factory-pr-threads-v2.ts` (name `module-pr-factory-pr-threads-v2`)
**CRUD:** `src/db/pr-threads.ts`

Central index mapping PR threads to sessions, in the central DB (`data/v2.db`). The delivering bot is resolved per messaging group via `messaging_groups.instance`, so the table carries no bot identity column. (The `-v2` migration name is deliberate: the runner dedupes by name, and installs upgraded from the legacy bot_id substrate have the v1 name recorded — the new name is what makes the column-drop arm run there.)

```sql
CREATE TABLE pr_threads (
    channel_id      TEXT NOT NULL,     -- e.g. "slack:C0XXXXXXX"
    thread_ts       TEXT NOT NULL,     -- bare Slack thread timestamp
    channel_type    TEXT NOT NULL,     -- "slack"
    repo_full_name  TEXT NOT NULL,     -- e.g. "acme/widgets"
    pr_number       INTEGER NOT NULL,
    session_id      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (channel_id, thread_ts)
);

CREATE INDEX idx_pr_threads_repo_pr ON pr_threads (repo_full_name, pr_number);
CREATE INDEX idx_pr_threads_session ON pr_threads (session_id);
```

| Function | Key | Used by |
|----------|-----|---------|
| `getPrThread(channelId, threadTs)` | PK | CRUD primitive (covered by `pr-threads.test.ts`) |
| `getPrThreadByRepoPr(repo, prNumber)` | `idx_pr_threads_repo_pr` | handler (dedup, close, synchronize), orchestrator |
| `getPrThreadBySession(sessionId)` | `idx_pr_threads_session` | testing-approval, gh-action-approval, reactions |
| `updatePrThreadSession(channelId, threadTs, sessionId)` | PK | handler (synchronize repoints the row) |
| `deletePrThread(channelId, threadTs)` | PK | CRUD primitive (covered by `pr-threads.test.ts`) |

---

## Webhook Receiver

**File:** `src/modules/pr-factory/webhook.ts`

Registers a **raw HTTP handler** at `/webhook/github` on the shared webhook server via core's `registerWebhookHandler` (`src/webhook-server.ts`) — the same server that serves the Chat SDK adapter routes.

1. **Method check** — only POST (405 otherwise).
2. **HMAC-SHA256 verification** — `x-hub-signature-256` vs `sha256=HMAC(secret, body)` with `crypto.timingSafeEqual`; 401 on failure.
3. **Immediate 200** — before processing, so GitHub doesn't time out.
4. **Event filter** — only `x-github-event: pull_request`.
5. **Action filter** — `opened`, `synchronize`, `closed`, `ready_for_review`, `converted_to_draft`.
6. **Parse and dispatch** a `PREvent` to the callback.

---

## PR Handler

**File:** `src/modules/pr-factory/handler.ts`

`handlePullRequest()` dispatches per action:

- **`closed`** — swap the thread reaction to 🟣 (merged) or 🔴 (closed), destroy the PR's test VM if one exists. No new session.
- **`converted_to_draft`** — swap to ⚪ (draft).
- **`ready_for_review`** — swap ⚪→🟢 and re-triage in the same thread (or fall through to the opened flow if no thread exists yet).
- **`synchronize`** (new commits) — skipped for drafts; otherwise kill the old container, delete the old session, resolve a fresh session **in the same Slack thread**, repoint `pr_threads` (`updatePrThreadSession`), re-fetch the diff, write a new trigger.
- **`opened`** (and unseen PRs arriving via other actions):
  1. Dedup: an existing `pr_threads` row for (repo, pr#) means a redelivered webhook — no-op.
  2. Fetch PR stats + touched areas (GitHub API) and post the **thread opener** to the PR channel via `chat.postMessage` with the worker bot token; the response `ts` becomes the thread.
  3. React 🟢 (or ⚪ for drafts).
  4. `resolveSession(workerAgentGroupId, workerMessagingGroupId, 'slack:<channel>:<ts>', 'per-thread')`.
  5. `createPrThread(...)` recording (channel, thread) ↔ (repo, pr#, session).
  6. **Drafts stop here** — triage is deferred to `ready_for_review`.
  7. Pre-subscribe the worker to the thread (mention-sticky wiring).
  8. Refresh the repo mirror (`PR_FACTORY_REPO_MIRROR_DIR`) — best-effort `git fetch` + `reset --hard origin/main`.
  9. Fetch the diff (truncated at 50k chars), write the trigger message (with the triage directive — see the next section) to the session's inbound DB, wake the container.

Per-PR worker sessions have no dedicated fast teardown: idle workers are reaped by host-sweep's 30-minute staleness ceiling.

### The PR_CONTEXT contract

Every trigger message ends with:

```
[PR_CONTEXT: channel=slack:CXXXX thread=1700000000.000100 repo=org/name pr=42]
```

The worker's instructions (and any operator review skill) parse this tag for repo/PR identifiers and test-plan file naming; it is a cross-process contract — change it nowhere or everywhere.

### GitHub API access through OneCLI

Diff/stats fetches route through the OneCLI gateway's HTTP forward proxy so the gateway injects a vault-stored GitHub PAT:

1. undici's own `fetch` + `ProxyAgent` (Node's built-in fetch rejects external dispatchers — the reason for the pinned `undici` dependency);
2. the OneCLI agent access token embedded as proxy Basic auth;
3. the gateway CA (`~/.onecli/gateway-ca.pem`) trusted by the ProxyAgent.

If any piece is unavailable the module falls back to direct unauthenticated GitHub calls (60 req/h instead of 5000).

### Security model: the GitHub token must be read-only

The PAT in the vault — the one injected into worker/tester containers and used for these host-side fetches — **must be fine-grained and read-only** (`Contents: read`, `Pull requests: read`, `Metadata: read`; no write, no merge, no admin), scoped to the single repository the factory serves. This is the boundary that makes the autonomous parts of the pipeline safe:

- The worker reads diffs and runs read-only `gh` lookups with this token. It cannot comment, label, approve, close, or merge with it — those calls 403 at GitHub.
- **All writes go through `credentialed_gh` only**, behind a human approval card, executed under the *approving human's* gh credentials (the `gh-action-approval` component), not the injected token.

So even if a malicious PR diff or a confused worker tries to act on GitHub directly, the worst it can do is read. Provisioning a write-capable token defeats the entire approval-gate design — it would let an agent merge to `main` without a human ever clicking a card. Treat "the injected GitHub token is read-only" as a hard invariant, not a recommendation.

---

## The Worker's Review Workflow

The worker runs inside a container as a standard NanoClaw agent. Its triage/review/test-plan behavior is **group instructions, not shipped container skills** — two override levels:

1. **Default (shipped):** `src/modules/pr-factory/worker-instructions.ts` is seeded into `groups/pr-factory-worker/CLAUDE.local.md` on first bootstrap and never overwritten. It carries a three-stage triage workflow (high-level read → author assessment → categorize and decide CLOSE / MERGE / REVIEW), a review stage, and a test-plan stage, plus the hard constraints (never act on GitHub directly — every write goes through `credentialed_gh`; all output to the PR thread). **Edit that file** to tune trusted contributors, merge policy, and review depth for your repo.
2. **Operator skill:** write the skill to `container/skills/<skill-name>/` and set `PR_FACTORY_REVIEW_SKILL=<skill-name>`. Every PR trigger then opens with `Use the /<skill-name> skill …` and the seeded defaults are ignored. This is the path for operators who maintain their own tuned review pipeline as a container skill. With the worker group's default `skills: 'all'` selection the new folder reaches the worker on its next container start — no container-config change is needed unless the group uses an explicit `skills` allowlist.

Test plan files are written to `/workspace/agent/test-plans/` (host path: `groups/pr-factory-worker/test-plans/`) with the `.md.pending` suffix; the host's testing gate looks them up by PR number.

---

## The Supervisor Agent

**File:** `src/modules/pr-factory/supervisor.ts` (instructions only; wiring lives in bootstrap)

A separate agent group (`pr-factory-supervisor`) speaking as its own Slack bot. It improves the worker based on human feedback:

- **Admin channel** — shared session, engages on every message.
- **PR threads** — engages when @-mentioned, sees accumulated thread history.

Its MCP tool: `propose_skill_edit` (see below). A proposed edit is posted as a diff for human approval and, on accept, written under `container/skills/`. Skill edits apply to the **next** PR each affected worker session triages — running sessions keep their old read-only skill view until they next spawn; there is no force-rerun of an in-flight session.

---

## Test Orchestration

Two modules split the responsibility across a seam; they communicate only via callbacks wired in `initOrchestrator`.

### test-orchestrator.ts — VM lifecycle (everything SSH; `vm-test-orchestrator` component)

- Implements the `TestOrchestratorModule` contract and registers itself on core's seam at import time.
- Sequential queue: one test run at a time (`submitTest` enqueues).
- Per run: `ssh <control-plane> cp <template> <prefix><pr>` → wait for SSH → check out the PR branch in `~/nanoclaw` on the VM → `pnpm run build` + restart the systemd unit → wait for stable `active` → `onVmReady`.
- VM naming: `<TEST_VM_NAME_PREFIX><pr>` reachable at `TEST_VM_HOST_TEMPLATE` with `{name}` expanded; login as `TEST_VM_SSH_USER`. Pool capped at 20 (oldest destroyed first). VMs are tagged `ephemeral`.
- On any setup failure: VM destroyed, `onRunFailed`.
- `destroyVm` on PR close/merge; `shutdown` destroys everything.

The template VM is operator-prepared: project at `~/nanoclaw` with an `origin` that serves `pull/<n>/head` refs, buildable with `pnpm run build`, running as a systemd user service whose unit name contains `nanoclaw`, and the host's control-plane key authorized on cloned VMs.

### orchestrator.ts — NanoClaw coordination (never SSHes; core)

- `onVmReady` → resolves a **tester session** in the PR's thread (tester agent group + tester-instance messaging group), writes the plan + VM host as a trigger, wakes the tester, arms a **30-minute timeout** (timeout → `cancelRun` destroys the VM and posts to the thread).
- `handleTestResults` (the `pr_submit_test_results` delivery action) → cancels the timeout, `completeRun` (VM stays alive for investigation), posts a results summary into the worker session's `outbound.db` via `writeOutboundDirect` (as a Slack Canvas link when canvas creation succeeds), then wakes the **worker**:
  - `PASS` → prompt to propose merge via `credentialed_gh`;
  - `FAIL` / `PARTIAL` → prompt to analyze whether failures are PR-related.
- `onRunFailed` → posts the failure into the thread and offers a **Retry Test** approval card (`pr_retry_test`).

---

## MCP Tools (Container-Side)

**File:** `container/agent-runner/src/mcp-tools/pr-factory.ts`

Four tools, registered in every container via the mcp-tools barrel. Each writes a `kind: 'system'` row to `messages_out`; the host's delivery loop dispatches the `action` string to the matching registered handler. In a non-PR-factory install the actions are unregistered and dropped with "Unknown system action".

| Tool | Action emitted | Args |
|------|----------------|------|
| `propose_skill_edit` | `pr_propose_skill_edit` | `{ skill_name, file_name, content }` |
| `send_to_testing` | `pr_send_to_testing` | `{}` (plan located via session → pr_threads → file naming) |
| `credentialed_gh` | `pr_gh` | `{ command?, commands?, description }` — `command` is normalized into `commands` |
| `submit_test_results` | `pr_submit_test_results` | `{ pr_number, repo?, verdict: PASS\|PARTIAL\|FAIL, content }` |

When the agent omits `repo`, the field is omitted from the payload too — the host applies `PR_FACTORY_DEFAULT_REPO`. The container never bakes in a repo default.

---

## Delivery Actions and Approval Handlers (Host-Side)

**Registered in:** `src/modules/pr-factory/index.ts` (delivery actions) and the individual gate files (approval handlers).

| Delivery action | Handler | Effect |
|--------|-------------|--------|
| `pr_send_to_testing` | `testing-approval.handleSendToTesting` | Post plan canvas + approval card |
| `pr_propose_skill_edit` | `skill-edit-approval.handleProposeSkillEdit` | Post diff + approval card |
| `pr_gh` | gh-action seam → `gh-action-approval.handleGh` | Post command preview + approval card |
| `pr_submit_test_results` | `orchestrator.handleTestResults` | Post results, wake worker per verdict |

| Approval action | Fires on Accept |
|-----------------|------------------|
| `pr_send_to_testing` | Read plan file, `submitTest` to the queue, delete the file |
| `pr_retry_test` | Re-submit the same plan to the queue |
| `pr_propose_skill_edit` | Re-validate path, write the file under `container/skills/` |
| `pr_gh` | Execute the gh command(s) sequentially |

Rejecting any card resolves through core's response handler; pr-factory's approval-resolved hook then clears the thread's 👀 reaction.

**Approver roles are required.** Core's `isAuthorizedApprovalClick` silently ignores card clicks from users without a `user_roles` row — the symptom is a card that does nothing, with only a host-log warning. Grant every approver a role: `pnpm run ncl roles grant --user 'slack:U0XXXXXXX' --role admin`.

---

## Testing Approval Gate

**File:** `src/modules/pr-factory/testing-approval.ts`

1. **Worker** writes the plan to `/workspace/agent/test-plans/pr-{N}-thread-{tsSafe}.md.pending` (`tsSafe` = thread ts with `.` → `-`) and calls `send_to_testing`.
2. **Host** locates the file by PR number (via the session's `pr_threads` row), renders the plan as a **Slack Canvas** in the PR thread (file-upload fallback when canvas creation fails or the `slack-canvas` component is absent), dismisses any stale approval cards for the session, and posts a **Send to Testing / Reject** card. The thread gets the 👀 reaction.
3. **Accept** → plan content is read and `submitTest({ prNumber, repo, planContent })` enqueues the run; the `.md.pending` file is deleted.
4. **Reject** → the card resolves and the 👀 clears; the plan file stays in place until the worker produces a new one.

On a VM setup failure, `postRetryCard` offers **Retry Test / Dismiss** with the same plan content (`pr_retry_test`).

---

## Skill Edit Approval Gate

**File:** `src/modules/pr-factory/skill-edit-approval.ts`

1. **Supervisor** reads the current skill from `/app/skills/` (read-only mount) and calls `propose_skill_edit` with the full new content.
2. **Host** validates the path (must resolve inside `container/skills/`), computes a unified diff (`diff -u`; full content for new files), posts it as a `.diff` file in the supervisor's thread, then posts an **Apply Edit / Reject** card.
3. **Accept** → path re-validated, directories created as needed, file written. Running containers keep their old read-only view; the change applies on the next container spawn.

Path traversal is rejected at both proposal and approval time.

---

## GitHub CLI Approval Gate

**File:** `src/modules/pr-factory/gh-action-approval.ts` (`gh-action-approval` component)

1. Agent calls `credentialed_gh` with command(s) starting with `gh ` and a description.
2. Host posts the description in the thread, then an approval card showing the exact command block.
3. **Accept** → commands run sequentially via `execFile('gh', args)` (quote-aware tokenization, leading `gh ` stripped), stopping at the first failure. When `PR_FACTORY_GH_REPO_ALLOWLIST` is set, commands explicitly referencing a repo outside the list are refused before execution. Merge failures get guidance appended (branch protection vs command error). Results are sent back to the agent via `ctx.notify`.

### Approver credential mapping

`data/gh-users.json` (operator-created, never in the repo; sample at `src/modules/pr-factory/gh-users.sample.json`) maps **namespaced** approver ids to gh CLI account logins:

```json
{ "slack:U0XXXXXXX": "their-gh-login" }
```

Keys are exactly the namespaced user ids core's approval flow reports (`<channel>:<handle>`); there is no bare-id fallback. When the approver maps to an account, the host reads that account's `oauth_token` from `~/.config/gh/hosts.yml` and passes it as `GH_TOKEN` to the subprocess, so the action is attributed to the human who approved it. The read is lazy and fail-soft: a missing/malformed mapping file just means default `gh` credentials (logged as "No gh account mapping for approver").

> **Known smell:** threading tokens out of `gh`'s hosts.yml into a subprocess environment bypasses the OneCLI gateway (skill-guidelines anti-pattern #5). The redesign direction is to route `gh` through the gateway's forward proxy with per-approver vault credentials. Carried with explicit sign-off; declared in the `gh-action-approval` SKILL.md.

---

## Slack: Three Bots, One Channel Type

Three Slack apps in one workspace, on core's native channel-instance substrate (core migration 016; `slack-bots` component). One instance value per adapter drives the registry key, the webhook route, the Chat SDK state namespace, and the `messaging_groups.instance` column:

| Bot | Adapter | Instance | Webhook path |
|-----|---------|----------|--------------|
| Worker | `src/channels/slack.ts` (stock `/add-slack`) | `slack` (default) | `/webhook/slack` |
| Supervisor | `src/channels/slack-supervisor.ts` | `slack-supervisor` (`SUPERVISOR_INSTANCE`) | `/webhook/slack-supervisor` |
| Tester | `src/channels/slack-tester.ts` | `slack-tester` (`TESTER_INSTANCE`) | `/webhook/slack-tester` |

The router disambiguates inbound events by `(channel_type, instance)`. The three adapters share a sibling-bot ID set (`src/channels/slack-bot-ids.ts`): each registers its own bot user id at factory time and wraps its bridge in `withSiblingEchoGuard`, so sibling-authored messages are dropped across all four Chat SDK dispatch paths — no echo loops. A router-side helper (`src/channels/sibling-mention.ts`) additionally keeps `@pr-tester …` follow-ups in a sticky worker thread from engaging the worker. Humans @-mention each bot distinctly.

Thread status reactions (worker bot): 🟢 open · ⚪ draft · 🔴 closed · 🟣 merged · 👀 awaiting approval (`src/modules/pr-factory/reactions.ts`).

---

## Slack Canvases

**File:** `src/modules/pr-factory/slack-canvas.ts` (`slack-canvas` component)

Registers the Slack Canvas API client on core's canvas seam (`canvases.create` → `canvases.access.set` → `files.info` permalink), and a delivery file transform on core's `registerFileTransform` hook: `.md` outbox attachments from the worker's Slack sessions deliver as canvas links appended to the message text instead of file uploads. Non-`.md` files, non-worker sessions, and provider failures pass through / fall back to the original upload. Requires `canvases:write` + `files:read` scopes on the worker app and a paid Slack plan; on free plans everything falls back to `.md` uploads.

---

## Activity Log

`src/modules/pr-factory/activity-log.ts` appends NDJSON events to `data/pr-activity/<owner>/<repo>/<pr>.log` (`prLog(prNumber, repo, event, details)`). Events without a resolvable repo (no `PR_FACTORY_DEFAULT_REPO`) land under `data/pr-activity/unconfigured/`.

```bash
tail -f data/pr-activity/<owner>/<repo>/42.log    # single PR
tail -f data/pr-activity/<owner>/<repo>/*.log     # all PRs
```

---

## Operational notes for adopters

Practical things to know before you run this on a real repo.

### `gh` in the worker container

The default worker workflow runs read-only `gh` lookups inside the worker container. The stock agent image **does not ship `gh`** (its apt block installs `git`, `curl`, `chromium`, `tini`, `unzip`; the Node-CLI block installs `claude-code` / `agent-browser` / `vercel`). Either add `gh` to `container/Dockerfile` (pinned via a new `ARG`, then `./container/build.sh`) or supply a review skill that uses the GitHub REST API through the OneCLI proxy instead. Whichever you pick, the read-only GitHub credential must reach the container so the calls authenticate — and writes still go only through `credentialed_gh`.

### Tester → VM SSH access

The tester agent SSHes from inside its container to the cloned VM (`TEST_VM_SSH_USER@<TEST_VM_HOST_TEMPLATE>`) to run the plan. Provision a private key into the `pr-tester` group's container with the matching public key in the VM's `authorized_keys` (the host's own key handles the host→control-plane clone/reap leg separately). Add a `known_hosts` entry or `StrictHostKeyChecking accept-new` so the first connection doesn't hang on a prompt. Without this the VM reports ready but the tester can't log in, and the run hits the 30-minute timeout. Details in the `vm-test-orchestrator` SKILL.md.

### Host restart drops in-flight test runs

The test queue, the per-run timeouts, and the live-VM registry are all in-process state — a host restart loses them. An approved test run that was executing when the host went down is **not resumed**: its timeout timer is gone (so no timeout message ever posts), the queue is empty on reboot, and the VM that was cloned for it is **orphaned** — still running on the provider, no longer tracked by the pool. Recovery is manual: list ephemeral VMs on the control plane and `rm` any that no longer correspond to an open PR (they are tagged `ephemeral`; `destroyVm` runs on PR close/merge for tracked ones, but an orphan won't be reaped automatically). Re-approve the test plan from the PR thread to start a fresh run.

### Cost and scale

- **One container per PR.** Each open PR gets its own worker session/container; a burst of PRs is a burst of concurrent containers and LLM sessions.
- **Full-diff LLM sessions.** The worker is seeded with the PR diff (truncated at 50k chars) and reasons over it — token cost scales with diff size and review depth, per PR.
- **Re-triage on every push.** A `synchronize` event (new commits) kills the session and re-runs triage against the fresh diff, so an actively-pushed PR is re-reviewed repeatedly.
- **Single-repo throughput.** A factory instance serves one repo (see "One instance, one repository"); throughput is bounded by that repo's PR/push rate and your container/LLM concurrency budget. Scale out with more instances for more repos, not more load per instance.

### Single trust domain

The factory registers host-wide delivery actions (`pr_*`) and seam providers that **trust every agent group on the host** — any agent group that emits a `pr_*` system action is serviced, and the gh/skill-edit/test gates act on whatever session calls them. There is no per-group authorization on these actions beyond the human approval cards. Run the PR Factory on a host you control, with agent groups you trust; do not co-locate it with untrusted or third-party agent groups.

---

## File Map

### Host (src/modules/pr-factory/) — by component

| File | Component | Purpose |
|------|-----------|---------|
| `index.ts` | core | Module entry: env gating, six delivery actions, adapter-ready bootstrap + webhook + orchestrator init, approval-resolved hook, shutdown |
| `bootstrap.ts` | core | Idempotent entity setup (worker / supervisor / tester), instance-keyed lookups, foreign-wiring cleanup, drift correction |
| `defaults.ts` | core | `DEFAULT_REPO`, `REPO_MIRROR_DIR`, `REVIEW_SKILL` + `triageDirective()` |
| `worker-instructions.ts` | core | Default triage/review/test-plan group instructions (the operator override point) |
| `webhook.ts` | core | GitHub webhook: HMAC, event/action filter, `PREvent` parsing |
| `handler.ts` | core | Per-PR lifecycle: opener, session, pr_threads, trigger, wake; synchronize/close/draft handling; OneCLI proxy GitHub fetches |
| `supervisor.ts` | core | `SUPERVISOR_FOLDER` + `SUPERVISOR_INSTRUCTIONS` |
| `testing-approval.ts` | core | Testing gate + retry card |
| `skill-edit-approval.ts` | core | Skill-edit gate (traversal-guarded writes into `container/skills/`) |
| `orchestrator.ts` | core | Tester wake, 30-min timeout, results → worker |
| `reactions.ts` | core | Thread status reactions + 👀 helpers |
| `dismiss-approvals.ts` | core | One-active-card-per-thread dismissal |
| `activity-log.ts` | core | Per-PR NDJSON activity log |
| `gh-action.ts` | core (seam) | `setGhActionHandler` / `dispatchGhAction` |
| `test-orchestration.ts` | core (seam) | `registerTestOrchestrator` / `getTestOrchestrator` + module contract |
| `canvas.ts` | core (seam) | `registerCanvasProvider` / `createCanvas` |
| `gh-action-approval.ts` (+ `gh-users.sample.json`) | gh-action-approval | GitHub CLI gate + approver credential mapping |
| `test-orchestrator.ts` | vm-test-orchestrator | VM lifecycle, sequential queue, pool |
| `slack-canvas.ts` | slack-canvas | Canvas provider + `.md` → canvas delivery transform |

### Database

| File | Purpose |
|------|---------|
| `src/db/pr-threads.ts` | CRUD for pr_threads |
| `src/db/migrations/module-pr-factory-pr-threads-v2.ts` | Creates pr_threads (drops the legacy bot column on legacy-substrate upgrades) |
| `src/db/migrations/module-slack-bots-bot-id-to-instance.ts` | Legacy-upgrade: bot_id substrate → instance substrate |
| `src/db/sessions.ts` | (+4 appended pending_approvals helpers) |

### Container

| File | Purpose |
|------|---------|
| `container/agent-runner/src/mcp-tools/pr-factory.ts` | The six MCP tools |

### Channels

| File | Purpose |
|------|---------|
| `src/channels/slack-supervisor.ts` / `slack-tester.ts` | Supervisor/tester adapters as named instances |
| `src/channels/slack-bot-ids.ts` | Shared sibling-bot id set + echo guard |
| `src/channels/sibling-mention.ts` | Sticky-thread sibling-mention suppression |

---

## Manual Operations

### Re-run a PR from scratch

There is no in-place "clear and retrigger" — a skill edit applies to the next PR the worker triages, and a fresh push (a `synchronize` event) re-triages an open PR in the same thread against the updated diff. To force a clean re-run, close and reopen the PR on GitHub, or push a no-op commit; the webhook drives a fresh session either way.

### Inspect pr_threads

Use the sanctioned query wrapper, not the sqlite3 binary:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT * FROM pr_threads WHERE pr_number = 42"
```

### Check pending test plans

```bash
ls -la groups/pr-factory-worker/test-plans/
```

### Check test-VM control-plane connectivity

```bash
ssh -o ConnectTimeout=5 "${PR_FACTORY_TEST_SSH_HOST:-exe.dev}" ls
```

### View module logs

```bash
grep 'PR factory\|pr_' logs/nanoclaw.log | tail -50
grep 'PR factory\|pr_' logs/nanoclaw.error.log | tail -20
```
