# TypeSafe judgments: `/add-typesafe-tool` and the `maintainer` template

Two pieces let a NanoClaw agent hand its snap decisions to a decision model
while it keeps the reasoning and the writing:

- **`/add-typesafe-tool`** mounts the `typesafe-judge` container skill into
  every agent and registers the `api.typesafe.ai` credential with the
  install's gateway. The agent gets a CLI that asks TypeSafe's Jev model typed
  questions and returns probabilities, never text.
- **The `maintainer` template** (`templates/maintainer/`) is the first agent
  built on it: it triages issues, routes pull requests, finds duplicates, and
  ranks the backlog, with every label, route, rank, and yes/no coming from
  Jev and every action gated on confidence.

## What TypeSafe is

A "System One" model. `POST https://api.typesafe.ai/v1/systemone` with
`{ state, model: "jev-latest", questions }` and get one typed answer per
question:

| Primitive | Ask | Get |
|---|---|---|
| `noul` | Is this true? | `noul`: probability of yes |
| `choice` | Which one of these? (rubric per option) | `choice`, `probabilities`, `confidence` |
| `score` | Where on this ordered scale? (level descriptions) | `score`, `legend`, `probabilities`, `confidence` |

Questions in one request run in parallel over the same state and cannot see
each other, so a workflow asks everything it might need in one call
(speculative fan-out) and lets code pick the answers that matter.
`confidence` summarizes how peaked an answer's distribution is; the docs at
https://docs.typesafe.ai (primitives, confidence, patterns) are the reference.

## The container tool

`container/skills/typesafe-judge/` (installed by the skill, not shipped on
trunk) carries:

- `SKILL.md`: when to ask Jev instead of reasoning (classify, route, rank,
  verify, yes/no), how to phrase a question, how to read the gate.
- `scripts/typesafe-judge.ts`: a Bun CLI with no runtime dependencies. Reads
  `{state, questions}` on stdin or from flags (`--state`, `--questions`, and
  `--noul` / `--choice --options` / `--score --levels` shorthands), posts
  through the gateway, prints the answers. `--gate` adds a per-answer
  `act | propose | withhold` decision from confidence (choice/score: act at
  0.8, propose at 0.6; noul: act at max(p, 1−p) ≥ 0.85, propose at 0.7;
  all four flags tunable).
- `scripts/typesafe-judge.test.ts`: bun:test with a mocked fetch. Run
  `cd container/skills/typesafe-judge && bun test`.
- `references/question-design.md`: the condensed TypeSafe guidance.

Exit codes: 0 ok, 1 usage, 2 credential not connected (401/403, no retry, the
body is never printed), 3 upstream failure (429/529 retried with backoff
first). An answer that does not match its question (wrong primitive, a
probability outside 0–1, an option that was not offered) is an upstream
error, never an `act`.

## How the key gets in

The CLI sends `Authorization: Bearer placeholder`. The gateway replaces it
at the network edge for host `api.typesafe.ai`, exactly as `/add-vercel`
does for `api.vercel.com`. The key never sits in an env var, a file inside
the repo, a command line, or a chat. `/add-typesafe-tool` reads
`NANOCLAW_GATEWAY_PROVIDER` and drives the matching gateway:

- **OneCLI** (default): the operator stores the key themselves, either
  through the prefilled dashboard form
  (`/connections/secrets?create=generic&host=api.typesafe.ai&…`) or with
  `onecli secrets create --type generic --host-pattern api.typesafe.ai
  --header-name Authorization --value-format "Bearer {value}" --file <path>`
  from a private file. The skill then verifies that a secret exists for that
  exact host (names are not consulted) and merges it into every
  `selective`-mode agent, leaving an agent untouched if its list cannot be
  read; `all`-mode agents (the default) need nothing.
- **Iron Proxy**: the operator creates a static secret in Iron Control for
  host `api.typesafe.ai` (header `Authorization`, formatter
  `Bearer {{ .Value }}`), grants it with
  `.claude/skills/add-iron-proxy/scripts/control.ts grant static <id>` and
  allows the host with `setup.ts --allow-host api.typesafe.ai`.

The skill's guard test (`src/typesafe-manifest.test.ts` after apply) fails
if the CLI stops targeting `api.typesafe.ai`, drops the placeholder, or
starts reading a key from anywhere.

## The maintainer template

An Agent Plugins directory at `templates/maintainer/` (long-term home:
[`nanocoai/nanoclaw-templates`](https://github.com/nanocoai/nanoclaw-templates)).
Stamp it with `ncl groups create --template maintainer --name Maintainer`
after applying `/add-typesafe-tool` and connecting a GitHub credential for
`api.github.com` in the gateway.

| Skill | Judgments from Jev | Deterministic code | Writes |
|---|---|---|---|
| `triage-issues` | area, kind (choice); priority (score); needs-repro (noul) | rubric loading, label application | `area/*`, `kind/*`, `triage/*`; one marker comment |
| `route-pr` | area, kind, priority; pr_ready and scope-matches-title (noul) | PR-template section status; reviewer from CODEOWNERS, else recent authors | `Status: Needs Review` / `triage/needs-author`, area; one comment |
| `dedupe-issues` | "same defect as #X" per candidate, 30 in one call | title-similarity candidates over open issues | one comment with matches and probabilities |
| `rank-backlog` | priority (score), needs-repro (noul) per issue | staleness, composite ranking, digest text | posts the digest |

Policy, in the persona: `act` applies a reversible label, `propose` writes a
line in the skill's single comment (`<!-- maintainer:<skill> -->`, updated on
re-runs), `withhold` leaves `triage/unresolved`. `priority/*` is always a
proposal. The agent never merges, closes, assigns, requests reviews, or
edits. One paused recurring task, `weekly-digest`, posts the backlog digest
and the PR queue in report-only mode on Mondays.

The rubrics (`rubrics/labels.json`) and gates came from a measured dry run
of the same questions over nanocoai/nanoclaw (area/kind 0.6, priority 0.6,
noul 0.7 as proposal floors). `scripts/gh.ts` is the GitHub helper (Bun, no
dependencies, no auth header: the gateway injects it); `scripts/gh.test.ts`
covers it with a mocked fetch.

## Removal

`.claude/skills/add-typesafe-tool/REMOVE.md` reverses the install: the
container skill, the guard test, the gateway credential, and a restart.
