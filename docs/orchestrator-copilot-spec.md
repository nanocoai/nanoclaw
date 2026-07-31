# Orchestrator + Copilot specification

## Purpose

Add two dedicated NanoClaw agents to the existing Discord deployment:

- **orchestrator**: owns planning, coordination, budget checks, task tracking, review, and status reporting.
- **copilot**: a general-purpose implementation agent, similar to the current Codex assistant. It researches, writes, codes, diagnoses, and returns evidence-backed results.

The existing **nano** agent remains the familiar Discord entry point and completion reporter.

## Goals

1. Make multi-step work predictable and auditable.
2. Keep responsibilities separate: the orchestrator coordinates; the copilot executes.
3. Restrict initial access to the Discord owner account.
4. Track available usage information without conflating ChatGPT/Codex limits with OpenAI API billing.
5. Require a clear final result, test instructions, and blocker report for every task.

## Agent definitions

### Orchestrator

**Responsibilities**

1. Receive a request and restate its objective and acceptance criteria.
2. Inspect available usage/limit information before allocating work.
3. Break work into tasks with an owner, scope, priority, budget, and completion condition.
4. Delegate implementation tasks to copilot.
5. Track each task as `queued`, `active`, `blocked`, `review`, or `complete`.
6. Review copilot results against the acceptance criteria.
7. Send concise progress, blocker, and final summaries to Discord.

**Must not**

- Perform substantial implementation work when it can be delegated to copilot.
- Create new agents or grant permissions without owner approval.
- Use paid API credentials or take destructive/external actions without owner approval.
- Claim completion without verification evidence.

### Copilot

**Responsibilities**

- Perform delegated research, configuration, coding, debugging, and verification.
- Work only within the approved task scope and assigned workspace/mounts.
- Return: outcome, changed items, verification performed, usage observations, and blockers.

**Must not**

- Delegate to new agents on its own.
- Change access controls, create paid resources, publish externally, or delete material data without owner approval.
- Represent estimates as exact token or cost figures.

## Operating procedure

For every orchestrator task:

1. **Intake** — identify objective, constraints, deadline, and success criteria.
2. **Budget check** — record available Codex usage/rate-limit status if exposed; separately record API usage/cost data only when an Admin API key has been intentionally configured.
3. **Plan** — create one or more copilot tasks with explicit completion criteria.
4. **Execute** — delegate; post a short start update for work expected to take more than a few minutes.
5. **Monitor** — request progress only at meaningful milestones or when a task is blocked.
6. **Review** — validate the result and required evidence.
7. **Report** — provide a final summary, tests, remaining risks, and next actions.

Every tracked agent call must produce a separate usage report immediately after it completes. The report identifies the call, outcome, exposed Codex/ChatGPT usage information, separately available API usage/cost information, and next action. Unavailable values are labelled `unavailable`.

## Budget and usage policy

Two independent ledgers must be reported separately:

| Ledger | Source | What it represents |
|---|---|---|
| Codex / ChatGPT usage | Codex account usage and rate-limit information, when exposed | Subscription/service capacity; not API billing |
| OpenAI API usage and cost | OpenAI Usage and Costs APIs, when an organization Admin API key is configured | Metered API tokens, requests, and cost |

Initial policy:

- Use subscription-backed Codex for the first two agents.
- Do not add an OpenAI API key solely for monitoring.
- Report unavailable metrics as unavailable rather than guessing.
- Add a configurable per-task budget before enabling autonomous delegation beyond copilot.

## Discord design

Create two owner-restricted Discord channels:

| Channel | Agent | Engagement | Initial access |
|---|---|---|---|
| `#orchestrator` | orchestrator | Respond to the recognized owner | Owner only |
| `#copilot` | copilot | Respond to the recognized owner | Owner only |

All Discord messages from Orchestrator begin with `⚪️`. All Discord messages from Copilot begin with `🔵`.

The current `nano` channel stays available for general assistance. On completion of this setup, the implementer will manually send `nano` a completion signal so it posts a Discord summary.

## Required persistent instructions

Each agent receives a dedicated `AGENTS.md`.

### Orchestrator instruction requirements

- Follow the operating procedure in this document for every task.
- Treat delegation, budget recording, review, and reporting as required steps.
- Ask the owner when the task scope, authority, or budget is unclear.
- Maintain a compact task ledger in its working directory.

### Copilot instruction requirements

- Start only from an explicit orchestrator task or direct owner request.
- Prefer reversible, scoped changes.
- Verify proportionally to risk.
- Return structured results to the orchestrator.

## Permissions and safety

- Both agents run in NanoClaw-managed containers.
- Initial workspace mounts are read-only unless a specific project requires write access.
- Docker, external messaging, deletion, publishing, account changes, and paid API usage require owner approval.
- The orchestrator may delegate only to copilot initially.
- New agents require a spec update and owner approval.

## Completion criteria for the implementation

The setup is complete when:

1. Both agent groups exist and use the Codex provider.
2. Each has its required `AGENTS.md` instructions.
3. Each is wired to its owner-restricted Discord channel.
4. Orchestrator-to-copilot delegation is configured and tested with a harmless task.
5. The orchestrator returns a structured status report.
6. `nano` receives a manual completion signal and posts the final Discord notification.

## Decisions still required

- Discord channel IDs for `#orchestrator` and `#copilot`, after the channels are created.
- Initial per-task budget threshold and escalation threshold.
- Which local project directories, if any, copilot may write to.
