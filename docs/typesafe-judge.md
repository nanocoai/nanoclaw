# TypeSafe judgments: `/add-typesafe-tool`

`/add-typesafe-tool` lets a NanoClaw agent hand its snap decisions to a
decision model while it keeps the reasoning and the writing. It mounts the
`typesafe-judge` container skill into every agent and registers the
`api.typesafe.ai` credential with the install's OneCLI gateway. The agent gets a
CLI that asks TypeSafe's Jev model typed questions and returns probabilities,
never text.

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
each other, so a workflow asks what its decision tree can use in one call
(speculative fan-out) and lets code pick the answers that matter.
`confidence` summarizes how peaked an answer's distribution is; the docs at
https://docs.typesafe.ai (primitives, confidence, patterns) are the reference.

## The container tool

`container/skills/typesafe-judge/` (installed by the skill, not shipped on
trunk) carries:

- `SKILL.md`: when to ask Jev instead of reasoning (classify, route, rank,
  verify, yes/no), how to phrase a question, how to read the gate, what it
  costs.
- `scripts/typesafe-judge.ts`: a Bun CLI with no runtime dependencies. Reads
  `{state, questions}` on stdin or from flags (`--state`, `--questions`, and
  `--noul` / `--choice --options` / `--score --levels` shorthands), posts
  through the gateway, prints the answers. `--gate` adds a per-answer
  `act | propose | withhold` decision from confidence (choice/score: act at
  0.8, propose at 0.6; noul: act at max(p, 1−p) ≥ 0.85, propose at 0.7;
  all four tunable).
- `scripts/typesafe-judge.test.ts`: bun:test with a mocked fetch. Run
  `cd container/skills/typesafe-judge && bun test` (the install's verify step
  runs it when Bun is on the host; Bun is only guaranteed inside the image).
- `references/question-design.md`: the condensed TypeSafe guidance.

Behavior worth knowing:

- **An upstream defect never becomes an `act`.** An answer must match its
  question: same primitive, probabilities in 0–1 that sum to 1 over exactly
  the offered options or levels, a `choice` that is the top of its own
  distribution, a `score` that equals its probability-weighted level with a
  legend that restates exactly the offered levels in order (strings, or
  TypeSafe's structured level descriptions). Anything else is exit 3.
- **Exit codes**: 0 ok; 1 usage; 2 refused; 3 upstream failure; 5 rate
  limited (a 429 that will not clear within the call's patience, from the
  gateway's spend ceiling or the plan: the agent stops its loop). Exit 2
  distinguishes a **401** (credential missing or rejected: run
  `/add-typesafe-tool`) from a **403** (a gateway block or rate-limit rule
  for this agent, or the key's quota or permissions; the credential may be
  fine). Auth-class response bodies are never printed, and every error path
  redacts credential-shaped text.
- **Retries**: 429 and 529 are retried with exponential backoff that waits at
  least `Retry-After` (capped at 60 s). One request waits up to 150 s by
  default (`--timeout`), longer than the 120 s a NanoClaw gateway approval
  card stays open.
- **Spend**: one call refuses more than 64 questions unless
  `--max-questions` raises it. The ceiling over time is the gateway's job
  (below), because only the gateway sees every agent and every loop.

### Calibration, not confidence, justifies acting

The default gate thresholds came from triage runs on one repository. A
confidence of 0.85 says the answer is peaked; it does not say how often
answers that peaked are right in another domain. The skill tells agents to
treat every `act` as a `propose` until the same questions have been measured
against known answers in their own domain, and to use their own judgment as a
brake only: an agent may downgrade a gate and say why, never upgrade one.

## How the key gets in

The CLI sends `Authorization: Bearer placeholder`. The gateway replaces it
at the network edge for host `api.typesafe.ai`, exactly as `/add-vercel`
does for `api.vercel.com`. The key never sits in an env var, a file inside
the repo, a command line, or a chat.

**OneCLI only, for now.** `/add-typesafe-tool` reads the gateway stamp
(`NANOCLAW_GATEWAY_PROVIDER`, environment first, then `.env`; it never probes)
and refuses any other gateway. On Iron Proxy every judgment is a POST, and
core auto-approves only the provider's model domains and GET/HEAD on
`NANOCLAW_GATEWAY_READ_ONLY_HOSTS`, so each call would raise a human
approval card; Iron support waits on a per-host auto-approval rule in core.

On OneCLI the operator stores the key themselves, either through the
prefilled dashboard form
(`/connections/secrets?create=generic&host=api.typesafe.ai&…`) or with
`onecli secrets create --type generic --host-pattern api.typesafe.ai
--header-name Authorization --value-format "Bearer {value}" --file <path>`
from a private file. The skill then verifies that a secret exists for that
exact host (names are not consulted), merges it into every
`selective`-mode agent of this install (leaving an agent untouched if its
list cannot be read; `all`-mode agents need nothing), and creates one
rate-limit rule, "TypeSafe: spend ceiling" (600 requests an hour; OneCLI
counts it per agent, so it caps each agent rather than the host; edit the
number in the dashboard). A same-named rule that is disabled, scoped, on
another host, or narrowed to a method or path judgments never use fails the
step instead of passing as protection.

The skill's guard test (`src/typesafe-manifest.test.ts` after apply) fails
if the CLI stops targeting `api.typesafe.ai`, drops the placeholder, or
starts reading a key from anywhere.

## Removal

`.claude/skills/add-typesafe-tool/REMOVE.md` reverses the install: the
container skill, the guard test, the gateway credential and rate-limit rule,
and a restart.
