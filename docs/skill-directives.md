# nc: skill directives — authoring reference

The structured skill format: how a SKILL.md carries its mechanical steps as machine-applicable `nc:` directive fences.

**Who this is for.** This format is core tooling for the trunk channel/provider install skills — the ones the setup wizard drives (`/add-slack`, `/add-telegram`, …). Those skills carry `nc:` fences so a deterministic engine (`scripts/skill-apply.ts`) and the setup wizard can apply them programmatically, and the conformance suite holds them to it. **A contributed skill does not need any of this.** Contributions are held to the standard bar in [skill-guidelines.md](skill-guidelines.md) — prose an agent can run, tests, REMOVE.md. Adopting `nc:` fences in a contributed skill is welcome but entirely optional; if you do, run the lint (below) and follow this reference.

Engineering source of truth: the header comment in [`scripts/skill-directives.ts`](../scripts/skill-directives.ts) (grammar + lint) — this document is its author-facing distillation. The engine's consumer contract (what a wizard, pipeline, or agent-relay plugs into) is [skill-engine-seam.md](skill-engine-seam.md).

## Two readers, one document

A fenced code block whose info-string starts with `nc:` is a load-bearing directive; every other fence, and all prose, is the human floor the parser ignores. An agent applies the prose; a tool applies the directives; the two describe the same install.

Two invariants follow, and both are non-negotiable:

- **Prose-primary.** With the `nc:` fences stripped, the SKILL.md must read as a normal skill — a coding agent following only the prose performs the same install. The prose never mentions the apply engine, the setup wizard, or programmatic application; a skill narrating its own tooling breaks the very degradation path the format exists for.
- **Degrade-to-agent.** Anything the engine can't do (a step it doesn't understand, a failed command, a missing streaming exec for an interactive step) bounces to an agent task — never a crash, never a silent drop. The agent reads the surrounding prose and applies the step the way skills have always worked.

## Fence syntax

````
```nc:<kind> <arg>... [key:value]...
<body line(s)>
```
````

- `<kind>` is one of the eight directives below.
- Bare tokens after the kind are positional args (e.g. `prompt`'s variable name).
- `key:value` tokens are attributes.
- The body's meaning is per-kind.

`prompt` only *acquires* a value and binds it to a name; a separate directive *applies* it, referenced as `{{name}}`. That keeps "ask the human" decoupled from "what you do with the answer" (env, `ncl`, the OneCLI vault, a file).

## The eight kinds

Every directive is idempotent — apply is safe to re-run, per the skills model.

### `copy [from-branch:<b>]`

Body: one path per line — `PATH` (source == destination) or `SRC -> DST`. Copies the file in; with `from-branch:` the source is fetched from a registry branch (`git show origin/<b>:<path>`). **Idempotency: skip when every destination is present; when any is missing, all listed files are (re)copied — copying overwrites.**

### `append to:<file> [at:<marker>]`

Body: the line(s) to add. Without `at:`, appends at end of file. With `at:<marker>`, inserts before the `// <<< <marker>` closing line of a dormant marker region (see `setup/index.ts`). **Idempotency: skip if already present.**

### `dep [manager:pnpm]`

Body: `pkg@<exact-semver>` line(s). Exact pins only — ranges are a lint error. **Idempotency: reinstalling a present pin is a no-op.**

### `run [effect:<e>] [capture:<spec>] [validate:<re>]`

Body: shell command(s), with `{{vars}}` substituted in. **Idempotency: the command must be re-runnable** — that's the author's contract.

`effect:` classifies the command so consumers can reason about it:

| Effect | Meaning |
|---|---|
| `build` | Compile step (e.g. `pnpm run build`) |
| `test` | Verification run (e.g. the registration test) |
| `fetch` | Network read that resolves data (e.g. an API call resolving an id) |
| `external` | Invokes an external helper/tool outside the tree |
| `wire` | Runs `ncl …` to wire collected input. No undo — the rows it creates are user runtime data, not reversed on skill remove |
| `restart` | Restarts the service so following `ncl` runs reach it. A caller that owns the restart (a rebuild, or a setup that restarts once) skips it via `ApplyOptions.skipEffects` |
| `step` | A long-running, operator-interactive step (a pairing code, a QR device-link) run through the streaming exec: its `=== NANOCLAW SETUP: … ===` status blocks render to the operator live. Degrades to an agent when no streaming exec is wired |
| `check` | A shell **predicate** (a precondition gate): mutates nothing — no journal, no capture. Zero exit passes silently; non-zero bounces to an agent (degrade, not crash) and, via the run-health gate, blocks the dangerous side effects that follow it (a restart, a pairing/QR step, a wire). An unresolved `{{var}}` defers |

`capture:` binds command output into vars (the twin of `prompt`):

- `capture:<var>` — binds the command's stdout to `{{var}}`.
- `capture:<var>=<dot-path>[,<var2>=<dot-path2>…]` — parses stdout as JSON and binds each var to its jq-style dot-path (`.id`, `.owner.id`), so one API call resolves several values at once.
- On an `effect:step`, `capture:<var>=<FIELD>[,…]` binds the terminal status block's named fields instead — the structured twin of stdout capture.

`validate:<re>` shape-guards each captured value (e.g. `validate:^discord:`); a mismatch bounces to an agent — a command's output has no human to re-prompt, unlike `prompt`.

### `prompt <var> [secret] [validate:<re>] [flags:<re-flags>] [normalize:<how>] [reuse:<ENV_KEY>]`

Body: the question to ask. Binds the answer to `{{var}}`. **Idempotency: skip if the var is already satisfied** (via `inputs` or an earlier bind).

- `secret` — consumers must mask the value.
- `validate:<re>` — a regex enforced **at bind** for **every** value, programmatic `inputs` and interactive answers alike (e.g. `validate:^xoxb-` to require a Slack bot token). A mismatch leaves the var unbound and records a deferred entry — a pipeline passing a malformed value fails loudly. Encode minimum lengths in the regex (`validate:^.{20,}$`).
- `flags:<re-flags>` — regex flags for `validate` (e.g. `flags:i`).
- `normalize:trim|rstrip-slash|lower` — a deterministic transform applied at bind, *before* validate, for both `inputs` and interactive answers.
- `reuse:<ENV_KEY>` — lets a re-run offer an existing `.env` value for a credential a **helper script** owns (written by an `effect:external`, not by `nc:env-set`) — the masked reuse offer that the usual `env-set`→ENV_KEY inference can't see. Consumed by interactive drivers only.

### `operator`

Body: instructions for the human operator. **Output-only** — it mutates nothing.

The SKILL.md is addressed to the coding agent; `operator` delineates the parts meant for the *human* (e.g. clicking through the Slack admin UI). Lead into it with agent-facing prose like "Tell the user:" so an agent relays it; a tool renders the body to the operator with `{{vars}}` substituted in.

The block carries **no presentation attributes**. A URL to visit lives in the body prose (a consumer may offer to open it), and whether a consumer pauses for confirmation before the next side effect is derived from document structure (`scripts/skill-policy.ts`) — never authored here.

### `env-set`

Body: `KEY=value` line(s) (`{{var}}` allowed) written to `.env`. **Idempotency: set-if-absent** — an existing key is left alone.

### `json-merge into:<file> key:<field>`

Body: a JSON object. Reads an array-of-objects JSON file and pushes the body object unless an element already has `body[key] === element[key]`. **Idempotency: push-if-absent, keyed by `key:`.**

## `when:` guards

Any directive may carry `when:<var>=<value>` — a guard evaluated against an earlier prompt/capture var. If it doesn't match (including the var being unresolved), the directive is skipped — a guarded prompt is skipped, never deferred. One skill can thus express mutually-exclusive branches (e.g. a local vs. remote install mode) in document order while still running fully programmatically from `inputs`.

## `{{var}}` substitution

`{{name}}` references a var bound by a `prompt` or a `capture:`. Substituted into `run` bodies, `env-set` values, and `operator` text. An unresolved `{{var}}` defers the directive (and its consumers) rather than executing with a hole in it.

## Retired attrs and kinds (lint errors)

These were removed deliberately; authoring them is a **lint error**, so stale skills fail loudly instead of silently no-oping:

| Retired | Where its job went |
|---|---|
| `prompt min:<n>` | Encode in the regex: `validate:^.{20,}$` |
| `prompt error:<msg>` | The miss message derives from the question prose — write questions that describe the expected shape |
| `operator open:<url>` | Put the URL in the body prose; consumers offer to open it |
| `operator gate` | Whether to pause is derived from document structure (`scripts/skill-policy.ts`) |
| `label:<word>` (any directive) | Step labels derive from the preceding heading |
| `on-fail:<hint>` (any directive) | The failure hint is always the surrounding prose |
| `nc:env-sync` (whole kind) | Retired — nothing read the mirror it wrote (and it copied live tokens); adapters read `.env` directly |

## Lint

```bash
pnpm exec tsx scripts/skill-directives.ts .claude/skills/<name>/SKILL.md
```

Errors block (malformed fences, unknown kinds, retired attrs, non-exact dep pins, undefined `{{vars}}`). Two special cases worth knowing: a `@chat-adapter/*` dep pin must match the `chat` core version in the lockfile (the family moves together), and there are two warn-only checks. **Gate ambiguity**: an unguarded `nc:operator` followed by `when:`-guarded directives spanning more than one branch value — guard the operator or restructure, so the barrier decision can't key off a runtime-skipped directive. **Reference floor**: a skill with a secret prompt or an interactive step should carry a `## Troubleshooting` section, the human floor a reader scrolls to when a live step misbehaves.

Applying without writing (plan mode): `pnpm exec tsx scripts/skill-apply.ts <skillDir>`.

## See also

- [skill-guidelines.md](skill-guidelines.md) — the authoring checklist every skill meets (fences or not)
- [skill-engine-seam.md](skill-engine-seam.md) — the engine's consumer contract: wizard, pipeline, agent-relay
- [skills-model.md](skills-model.md) — why skills work this way at all
