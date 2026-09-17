# Label taxonomy (nanocoai/nanoclaw)

Four families. The issue forms stamp `kind/*` and `triage/unresolved`; a
triager applies exactly one `area/*`; `priority/*` is maintainer-only.
`gh label list` on the repo is the source of truth; this is the working copy.

## area/* — exactly one per triaged item

agent-memory, agent-runner, channels, configuration, containers, core,
credentials, ncl-cli, providers, repository-maintenance, scheduled-tasks,
security, sessions, setup-installation, skills, tools. The rubric for each is
in `rubrics/labels.json`; `.github/labeler.yml` maps paths to areas for PRs.

## kind/* — one per item

| Label | Meaning |
|---|---|
| kind/bug | Something is not working as expected |
| kind/feature | New capability or improvement (usually delivered as a skill) |
| kind/documentation | Documentation is wrong, missing, or unclear |
| kind/question | Usage or design question (belongs in Discussions) |
| kind/security | Exploitable vulnerability crossing a trust boundary; reported privately first |
| kind/hardening | Defense-in-depth improvement; not exploitable |
| kind/cleanup | Refactor or cleanup with no behavior change |

## priority/* — maintainer-set, always a proposal from you

low, medium, high, critical. The score rubric in `rubrics/labels.json` maps
the four levels; you propose the rounded level with its confidence and never
apply it.

## triage/* — workflow state

| Label | Meaning | You |
|---|---|---|
| triage/unresolved | No maintainer has read it yet | Remove only when every gate on the item said act; add when any gate withheld |
| triage/needs-repro | Waiting for a minimal reproduction | Add when `needs_repro` acts yes on a bug; propose otherwise |
| triage/needs-author | Waiting on the author | Add when `pr_ready` acts no on a PR; propose otherwise |
| triage/keep | Exempt from the inactivity policy | Never touch an item carrying it |

## Pull request status

| Label | Meaning |
|---|---|
| Status: Needs Review | Ready for maintainer review — add when `pr_ready` acts yes |
| Status: Changes Requested, Status: Needs QA, Status: Blocked, Status: WIP, Status: Pending Closure | Human-set; never change |

Other labels (`core-team`, `follows-guidelines`, `delivery/skill`,
`good first issue`, `stale`) are set by workflows or humans. Leave them.
