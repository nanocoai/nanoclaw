# The skill-engine seam: declare/emit vs. acquire/present

Status: IMPLEMENTED on `feat/structured-skill-format` (clean break, no compat shims) — kept as the boundary-rule rationale and the consumer-contract reference. Author-facing directive grammar: [skill-directives.md](skill-directives.md).

## 1. The boundary rule

> **The engine may DECLARE needs and EMIT events; it may never ACQUIRE input or PRESENT anything.**

`scripts/skill-apply.ts` accumulated interactive-setup-wizard concerns in its core
contract: a `Prompter` with `tell`/`confirm`/`open`, authored presentation attrs
(`gate`, `open:`, `min:`, `error:`, `label:`, `on-fail:`), and a `StepReporter`
shaped around a clack spinner. That couples the deterministic applier to one
consumer (the setup wizard) when there are three:

1. **wizard** — interactive setup (`setup/lib/skill-driver.ts` + `setup/channels/run-channel-skill.ts`, clack UI)
2. **agent-relay** — a coding agent driving a skill conversationally over chat
3. **pipeline** — CI/CD & customer deployments: inputs from env, no human, `operatorMessages` consumed as a "manual steps" report

Declaration & semantics (what a value must look like, what a step is, what the
human must be told) = **core**. Acquisition & presentation (how the value is
collected, how the message is rendered, when to pause) = **consumer**. The
rule binds only the core: a driver may define whatever interaction types it
wants on its side of the seam.

### Invariants (non-negotiable)

- **Prose-primary / oblivious-to-auto-apply**: with `nc:` fences stripped, every SKILL.md reads as a normal skill. Never narrate the engine.
- **Degrade-to-agent**: anything the engine can't do bounces to an `agentTask` — never a crash, never a silent drop.
- **Option A split untouched**: no change to any resolve/wire logic; every `platform_id` / `user_id` byte produced by the **production code paths** is identical. The Option-A test (`setup/channels/run-channel-skill.test.ts:24-70`) keeps its assertion structure, but its fixture credentials MUST be updated to valid-shaped values in the same step that lands validate-at-bind (§4): today's `signing_secret: 's'` fails add-slack's `^[a-fA-F0-9]{16,}$` and `owner_handle: 'U1'` fails `^U[A-Z0-9]{8,}$` (both bypass validation only because inputs bypass it today). The `userId` assertion updates consistently (e.g. `owner_handle: 'U12345678'` ⇒ `'slack:U12345678'`). Byte-parity is a claim about production code, not about test-fixture literals shaped to exploit the removed bypass.
- **Coverage parity**: suite is 680 passed | 1 skipped today. Seam-touching tests are reworked *at the seam*; gate/open attr tests become driver-policy tests proving the parity claims in §5.
- **Never stage/commit** the pre-existing unrelated local changes: `package.json`, `pnpm-lock.yaml`, `src/channels/index.ts`, `src/providers/claude.ts`, `src/providers/index.ts` — nor untracked files this work did not create.

## 2. The new core interface

The entire interaction surface of the engine, after the refactor
(`scripts/skill-apply.ts`):

```ts
// What an nc:prompt declares about the value it needs. Passed to resolveInput
// so a consumer can run its OWN re-ask loop (clack validate, a chat exchange).
export interface InputMeta {
  question: string;                              // the prompt body (verbatim)
  secret: boolean;                               // consumer must mask
  validate?: string;                             // regex source (nc:prompt validate:<re>)
  flags?: string;                                // regex flags   (nc:prompt flags:<f>)
  normalize?: 'trim' | 'rstrip-slash' | 'lower'; // applied by the ENGINE at bind
}

// Everything the engine emits. `onEvent` is AWAITED before the engine
// proceeds — that ordering guarantee is what lets a consumer implement
// gating (hold the operator event until the human confirms readiness).
export type ApplyEvent =
  | { type: 'step-start'; kind: string; line: number; label: string | null }
  | { type: 'step-end';   kind: string; line: number; label: string | null;
      ok: boolean; durationMs: number; error?: string }
  | { type: 'operator';   line: number; text: string };
      // text = the rendered, {{var}}-substituted block body;
      // line = the directive's opening-fence line (keys driver policy maps)

export interface ApplyOptions {
  // Pre-supplied answers (var → value). Checked FIRST. Unchanged.
  inputs?: Record<string, string>;
  // Replaces Prompter.ask. undefined ⇒ defer (unchanged semantics).
  resolveInput?: (name: string, meta: InputMeta) => Promise<string | undefined>;
  // Unchanged.
  exec?: (cmd: string) => string | void | Promise<string | void>;
  // Unchanged.
  execStream?: (cmd: string) => Promise<StepOutcome>;
  // Unchanged.
  skipEffects?: string[];
  // Unchanged.
  resolveRemote?: (branch: string) => string;
  // Replaces BOTH StepReporter and Prompter.tell. Awaited before proceeding.
  onEvent?: (e: ApplyEvent) => void | Promise<void>;
}
```

**Gone from the core entirely**: `Prompter` (ask/tell/confirm/open), `PromptOpts`,
`StepReporter`, `ApplyOptions.prompter`, `ApplyOptions.reporter`.

**`ApplyResult` — unchanged fields**: `applied`, `skipped`, `agentTasks`,
`operatorMessages` (still collected in the result — the pipeline reads them
there; the `operator` *event* is for live rendering), `vars`, `journal`,
`referenceProse`. `fullyApplied()` and `firstFailureHint()` unchanged.
Two adjustments:

- `deferred: string[]` — same field, one new entry form: an input rejected by
  validate-at-bind is recorded as `` `<var>: invalid value (does not match validate:<re>)` ``
  (see §4). Missing-input entries stay the bare var name; unresolved-`{{var}}`
  entries stay the thrown message (`skill-apply.ts:841` today).
- `AgentTask.hint` is **dropped** (it existed only for `on-fail:`; with that attr
  gone, hint ≡ prose). `firstFailureHint` reads `prose` directly.

**Derived metadata stays core** (exposure, not authored presentation):
`stepLabel` (heading-derived only — the `label:` attr override at
`skill-apply.ts:458` is removed), `AgentTask` prose/`reason` (proseFor-derived),
`firstFailureHint`, `referenceProse`, `operatorMessages`.

**`stepLabel` null semantics, re-documented.** Today's doc comment
(`skill-apply.ts:73-79`, `:442-446`) frames `label: null` as "the driver should
NOT spin on this" — spinner advice, i.e. presentation smuggled into the core.
The contract wording changes (no payload change): `label: null` means *instant/
cheap, or the step renders its own live operator-facing output* (`effect:step`'s
QR card / pairing code). That is step-cost/interactivity **declaration**; the
event carries `kind` + `line`, so a consumer wanting a different render policy
can derive its own.

**Event ordering contract** (normative):

1. Per directive, `step-start` fires immediately before the mutation, `step-end`
   immediately after (or on the failure path) — always balanced. The payload is
   today's `StepReporter` payload (`skill-apply.ts:80-83` — it already includes
   `line`) unchanged, plus only the discriminating `type` field.
2. For an `nc:operator`, the engine substitutes `{{vars}}`, pushes to
   `res.operatorMessages`, then `await onEvent({type:'operator', …})` before
   evaluating the next directive. An unresolved `{{var}}` in the body defers the
   whole block before any event fires (today's behavior, `skill-apply.ts:787`).
   **Once the run is `blocked`** (an earlier bounce), operator directives are
   skipped instead — no event, no `operatorMessages` entry, recorded in
   `skipped`. Walking the human through steps whose side effects the run has
   already gated ("a pairing code is about to appear" → nothing appears) is
   actively misleading, and a failed run's manual-steps report must not include
   steps predicated on the failure.
3. Every `onEvent` call is awaited; a rejection from `onEvent` is treated like
   any other throw at that directive (bounce, not crash). This applies to
   operator events too: a consumer that throws from `onEvent` **accepts the
   bounce consequence**, including the `blocked` latch cascading over later
   side effects. The engine itself never defers/bounces an operator block
   (open question 7); consequently a well-behaved driver's handler must never
   throw for a *declined* confirm — decline semantics are defined in §5.1.

## 3. Migration table

Every existing hook / attr / caller → destination. "core seam" = survives in
`ApplyOptions`/`ApplyResult`; "driver policy" = reimplemented from document
structure (shared policy module + `setup/lib/skill-driver.ts`, §5); "deleted" =
removed with no replacement syntax.

### Engine hooks

| Today | Where (file:line) | Destination |
|---|---|---|
| `ApplyOptions.inputs` | `scripts/skill-apply.ts:263` | core seam (unchanged, but validated — §4) |
| `Prompter.ask(name, question, secret, validate, opts)` | `scripts/skill-apply.ts:50`, called at `:774` | core seam → `resolveInput(name, meta)` |
| `Prompter.tell(text)` | `scripts/skill-apply.ts:54`, called at `:793` | core seam → `onEvent` `operator` event |
| `Prompter.confirm(msg)` | `scripts/skill-apply.ts:58`, called at `:802` (gate; result discarded — decline proceeds today) | driver policy (natural-barrier gating, §5.1) + driver-owned reuse offer — both via the new `RunSkillOptions.confirm` seam (§5.0) |
| `Prompter.open(url)` | `scripts/skill-apply.ts:63`, called at `:796` | driver policy (URL offer, §5.2) via the new `RunSkillOptions.openUrl` seam (§5.0) |
| `StepReporter.stepStart/stepEnd` | `scripts/skill-apply.ts:80-83`, fired at `:827,:830,:839` | core seam → `onEvent` `step-start`/`step-end` events (payload + balance guarantee identical; only `type` added) |
| `ApplyOptions.prompter` | `scripts/skill-apply.ts:266` | deleted (split into `resolveInput` + `onEvent`) |
| `ApplyOptions.reporter` | `scripts/skill-apply.ts:287` | deleted (folded into `onEvent`) |
| `ApplyOptions.exec` / `execStream` | `scripts/skill-apply.ts:269,:275` | core seam (unchanged) |
| `ApplyOptions.skipEffects` | `scripts/skill-apply.ts:279` | core seam (unchanged) |
| `ApplyOptions.resolveRemote` | `scripts/skill-apply.ts:283` | core seam (unchanged) |
| `PromptOpts` (flags/min/error/normalize) | `scripts/skill-apply.ts:37-42`, built at `:499` (`promptOptsOf`) | type deleted; `flags`/`normalize` move into `InputMeta`; `min`/`error` deleted (§ grammar) |
| `normalizeValue` at bind | `scripts/skill-apply.ts:483`, applied `:779` | core seam (unchanged; now paired with validate-at-bind, §4) |
| `stepLabel` | `scripts/skill-apply.ts:457-474` | core seam, minus the `label:` attr branch (`:458`); null semantics re-documented (§2) |
| `failHint` / `AgentTask.hint` | `scripts/skill-apply.ts:419-430`, `:236`, `:749` | deleted (`on-fail:` gone ⇒ hint ≡ prose; `firstFailureHint` at `:308` reads `prose`) |
| run-health gate (`blocked` latch) | `scripts/skill-apply.ts:744-750,:816` | core seam (unchanged) |
| `when:` guard | `scripts/skill-apply.ts:521-525,:762` | core seam (unchanged) |
| `effect:check` / `effect:step` + terminal-block capture | `scripts/skill-apply.ts:646-667` | core seam (unchanged) |
| multi-field JSON capture + validate-on-capture | `scripts/skill-apply.ts:551-572` | core seam (unchanged) |
| journal / `removeSkill` | `scripts/skill-apply.ts:851-870` | core seam (unchanged) |
| `referenceProse` / `operatorMessages` / `vars` in result | `scripts/skill-apply.ts:239-257` | core seam (unchanged) |

### Authored grammar (`scripts/skill-directives.ts`)

| Attr / syntax | Where | Destination |
|---|---|---|
| `nc:operator open:<url>` | grammar doc `:61-73`; lint `:277`, `:287-291`; engine `:791,:796` | **deleted**. Driver URL-offer policy scans the rendered text (§5.2). URLs must live in the prose. |
| `nc:operator gate` | grammar doc `:68-71`; engine `:802` | **deleted**. Driver natural-barrier policy (§5.1). |
| `nc:prompt min:<n>` | grammar doc `:53-54`; lint `:264-266`; driver enforcement `setup/lib/skill-driver.ts:46` | **deleted**. Authors re-encode as regex, e.g. `min:20` → `validate:^.{20,}$`. |
| `nc:prompt error:<msg>` | grammar doc `:55`; driver `setup/lib/skill-driver.ts:46-47` | **deleted**. Error text derived from the question prose (§5.3). |
| `nc:run label:<word>` | `scripts/skill-apply.ts:458`; doc-comment mention `:451` | **deleted**. Labels are heading-derived only. |
| `on-fail:<token>` | `scripts/skill-apply.ts:419-430` (no lint rule exists) | **deleted**. Hint is always the surrounding prose. |
| `validate:` + `flags:` (prompt & run-capture) | lint `:249-263,:311-317` | **kept** (data semantics). Prompt validate now enforced at bind (§4). |
| `normalize:trim\|rstrip-slash\|lower` | lint `:267-269`; bind `skill-apply.ts:483` | **kept** (canonical-value semantics). |
| `reuse:<ENV_KEY>` | lint `:270-272`; driver `setup/lib/skill-driver.ts:169-172` | **kept** (binding metadata; consumed only by the driver's reuse offer). |
| `when:`, `effect:check`, `effect:step`, capture forms, journal semantics | various | **kept**, unchanged. |

Lint addition: `validate()` gains errors for the six removed attrs
(`operator open:/gate`, `prompt min:/error:`, any-directive `label:`/`on-fail:`)
so stale authorship fails loudly instead of silently no-oping. Lint also gains a
**warning** for an unguarded `nc:operator` immediately followed by `when:`-guarded
directives spanning more than one branch value (the static gate policy cannot
know which branch runs — see §5.1 and open question 1).

### Authored skills carrying removed attrs (strip + prose check)

| Skill | Line | Change |
|---|---|---|
| `.claude/skills/add-teams/SKILL.md` | `:101` | drop `open:https://portal.azure.com` (URL already in the body — step 1, body line 2; body line 1 is the heading sentence) |
| `.claude/skills/add-teams/SKILL.md` | `:132` | `min:20` → `validate:^.{20,}$` |
| `.claude/skills/add-teams/SKILL.md` | `:173`, `:203` | drop `gate` (policy reproduces both — §5.1 parity) |
| `.claude/skills/add-telegram/SKILL.md` | `:134` | drop `open:https://t.me/{{bot_username}}` **and fold the URL into the body** (verified: body says "Open @{{bot_username}}" — the URL exists only in the attr today) |
| `.claude/skills/add-discord/SKILL.md` | `:125` | drop `open:https://discord.com/...` **and fold the invite URL into the body** (verified: body says "Open the invite link" — URL only in the attr today) |

No skill uses `error:`, `label:`, or `on-fail:` (grep verified). Re-lint every
touched skill (`pnpm exec tsx scripts/skill-directives.ts <dir>`).

### Prompter / reporter implementers & callers (all migrate — clean break)

| Caller / implementer | Where | Migration |
|---|---|---|
| `clackPrompter` (the wizard Prompter) | `setup/lib/skill-driver.ts:66-120` | becomes the driver's `resolveInput` impl (ask + `?` help-escape + clearOnError + secret masking) — `tell`/`confirm`/`open` dissolve into the `onEvent` handler + the `confirm`/`openUrl` seams (§5) |
| `promptValidator` | `setup/lib/skill-driver.ts:37-50` | driver-side; loses `min`/`error`, gains prose-derived message (§5.3) |
| `spinnerReporter` | `setup/lib/skill-driver.ts:259-274` | folded into the driver's `onEvent` handler (step-start/step-end branch), still built on `startSpinner` (`setup/lib/runner.ts:314`) |
| `runSkill` + `RunSkillOptions` | `setup/lib/skill-driver.ts:286-340` | `prompter?`/`reporter?` options become `resolveInput?`/`onEvent?`; **new** `confirm?`/`openUrl?` options (§5.0); `reuse`, `channel`/`step` (help-escape ctx, `:308-314`), `reuseFromEnv` (`:143-188`, now validate-pre-filtered — §5.4) stay driver-side |
| skill-driver CLI | `setup/lib/skill-driver.ts:343-360` | uses the new defaults; no interface change visible to the operator |
| `runChannelSkill` overrides | `setup/channels/run-channel-skill.ts:122` (`prompter`), `:126` (`reporter`) | override fields renamed to `resolveInput`/`onEvent`; `confirm`/`openUrl` passthroughs added; fail-path (`:133-151`) unchanged |
| `applyProviderSkill` defer-all Prompter | `setup/providers/install.ts:62-66` | delete the stub — omit `resolveInput` entirely (absent ⇒ defer, same semantics) |
| `setup/auto.ts` call sites | `:350` (provider), `:560-572` (channels) | no signature change needed (they pass no prompter/reporter) |
| `setup/provider-auth.ts` | `:53` | unchanged (blockers contract survives) |
| engine test fakes | `scripts/skill-apply.test.ts:39` (`headless`), `:447`, `:505`, `:518`, `:534`, `:545`, `:613`, `:637`, `:1219` | `headless(vals)` becomes `{ resolveInput: async (n) => vals[n] }`; tell/open/confirm fakes become recorded `onEvent` handlers or move to driver-policy tests (§9); any fixture whose `inputs` violate a declared `validate:` updates to valid-shaped values (§4) |
| driver test fakes | `setup/lib/skill-driver.test.ts:73`, `:100` (reporter) | mechanical rewrite to `resolveInput`/`onEvent` |
| driver reuse-offer tests | `setup/lib/skill-driver.test.ts:149`, `:167`, `:202` | NOT a mechanical rewrite — today they queue answers through fake `prompter.confirm`s; they migrate to the new `RunSkillOptions.confirm` seam (§5.0) |
| run-channel-skill test stub prompter | `setup/channels/run-channel-skill.test.ts:95-100` (teams gate/open assertions `:115-124`) | becomes a driver-policy assertion running the **default** `onEvent` policy handler with `confirm`/`openUrl` injected (§5.0 injection semantics) — proving the §5.1/§5.2 parity claims. Fixture `app_password: 'sekret'` → a 20+-char value (§4); Option-A slack fixture (`:41-70`) updates `signing_secret`/`owner_handle` + the `userId` assertion (§1 invariant) |
| `back-nav.ts` `backGate`, `claude-handoff.ts` help-escape | `setup/lib/back-nav.ts:31`, `setup/lib/claude-handoff.ts:82,:164,:182` | untouched (already driver-side) |

## 4. Behavior change: validate + normalize apply to EVERY bound value

Today `validate:` is enforced only by the interactive prompter
(`setup/lib/skill-driver.ts:37-50`); `inputs` bypass it
(documented at `scripts/skill-directives.ts:51`). That is data validation
misfiled as prompt UX. New rule, at the single bind point
(`skill-apply.ts:766-780` region):

1. Resolve the raw value: `inputs[var]` first, else `await resolveInput(var, meta)`.
   Both `undefined` ⇒ defer (push bare var name — unchanged).
2. Apply `normalize:` (unchanged, already both-paths — `normalizeValue`, `:483`).
3. **New:** if the prompt carries `validate:` (+ `flags:`), test the *normalized*
   value. On mismatch: the var stays **unbound**, and
   `` `<var>: invalid value (does not match validate:<re>)` `` is pushed to
   `deferred`. Not an agentTask, not a throw — downstream consumers of the var
   defer exactly as if the value were never supplied, and `fullyApplied` is
   `false`. A pipeline passing a malformed env value fails loudly.

Notes:
- Normalize-then-validate order is normative (a trailing-slash URL is stripped
  before the `^https://` check — matches the teams `public_url` authoring).
- An invalid `inputs` value does **not** fall through to `resolveInput` — inputs
  win outright, and a caller that pre-supplied a value gets a loud rejection,
  never a surprise second acquisition path. The interactive dead-end this could
  create for reused `.env` credentials is closed on the driver side instead:
  `reuseFromEnv` pre-filters every offer through the prompt's
  `normalize`/`validate`/`flags` meta, so a stale credential that no longer
  matches the declared shape is **never offered** and the operator is prompted
  fresh (§5.4). A caller passing raw `inputs` (pipeline, tests) still fails
  loudly — that is the point.
- The interactive re-ask loop moves into the wizard's `resolveInput` (clack
  `validate`), so engine-level rejection rarely fires interactively; it is the
  backstop for programmatic paths.
- Secret values never appear in the deferred entry (only the var name and the
  regex source).
- run-capture `validate:` is unchanged (it already throws → bounces,
  `skill-apply.ts:551-572` — a command's output has no human to re-ask).
- **Test-fixture consequence** (part of the step that lands this change): every
  in-tree fixture that supplies an `inputs` value violating its prompt's
  declared `validate:` must update to a valid-shaped value. Known: the Option-A
  slack fixture (`run-channel-skill.test.ts:49` — `signing_secret`,
  `owner_handle`, with the `userId` assertion at `:62` updated consistently)
  and the teams deferWire fixture (`:102-107` — `app_password` vs. the new
  `^.{20,}$`). Sweep `scripts/skill-apply.test.ts` fixtures the same way.

## 5. Wizard driver policy (presentation derived from document structure)

### 5.0 Where the policy lives, and the driver's own seams

The policy **logic** is UI-free and shared: a new module
`scripts/skill-policy.ts` beside the parser exports `gatePolicy(md)` (→ map of
operator line → needs-confirm + confirm flavor, §5.1) and `extractOfferUrl(text)`
(§5.2), both built on the shared `parseDirectives`. The wizard driver consumes
it; an agent-relay consumer (§7) imports the same module instead of duplicating
the judgment or dragging in clack. The §9 policy unit tests live at this shared
home.

The wizard driver (`setup/lib/skill-driver.ts`) keeps the clack rendering and
gains two injectable interaction seams on `RunSkillOptions` — these are
*driver* options, allowed by the boundary rule (it binds only the core):

- `confirm?: (message: string) => Promise<boolean>` — used by the reuse offer
  (§5.4), the natural-barrier gate (§5.1), and the URL offer (§5.2). Default:
  clack `p.confirm`, **TTY-gated exactly like `spinnerReporter`**
  (`skill-driver.ts:260`) — non-TTY resolves `true` (proceed), preserving
  today's headless-prompter-without-confirm semantics (`skill-apply.ts:802`'s
  optional chain). A non-TTY run with full inputs never stalls.
- `openUrl?: (url: string) => Promise<void>` — used by the URL offer. Default:
  `setup/lib/browser.ts` `openUrl`, attempted only after a `confirm` yes.

**Injection semantics (normative):** an injected `onEvent` **replaces** the
driver's default policy handler entirely — same rule as today's injected
prompter ("the injector owns its I/O", `skill-driver.ts:311`). Therefore
driver-policy parity tests must run the **default** handler and inject
`confirm`/`openUrl` (the run-channel teams test does exactly this — §3, §9);
injecting `onEvent` to observe policy behavior would only observe itself.

Because the engine awaits `onEvent` (§2), a confirm inside the default handler
blocks the engine — that is the entire gating mechanism.

### 5.1 Natural-barrier gate policy

For each `nc:operator` directive at line L, `gatePolicy` computes
`needsConfirm(L)`:

1. Scan forward through subsequent directives, skipping **only** directives
   whose `when:<var>=<value>` guard is **incompatible** with this operator's own
   guard — same var, different value. No guard, or an identical guard, is
   compatible. (This makes mutually-exclusive branches gate on their *own* next
   action: imessage's `when:mode=local` operator at `:111` skips the two
   remote-only prompts and gates on the local configure run at `:151`;
   whatsapp's `when:auth_method=qr` operator at `:96` skips the pairing-code
   operator at `:104` — guard-incompatible — and gates on the qr step at `:114`.)
2. Next compatible directive is another `operator` → **no confirm** — the chain's
   **last** operator carries the barrier. (Operators are NOT skipped-and-scanned-past:
   that would make the earlier block of a chain inherit the later block's barrier
   and double-confirm — the exact bug the teams parity table below forbids.)
3. Next compatible directive is a `prompt` → **no confirm** (the prompt is the barrier).
4. No such directive (end of document) → **no confirm** (a final handoff block, e.g. teams `:228`).
5. Anything else (`run`, `copy`, `dep`, `append`, `env-set`, `json-merge`) →
   **confirm** after rendering. Confirm wording is derived from the barrier's
   *flavor* — the next compatible directive's effect: `effect:step` →
   readiness phrasing (`"Ready? The next step starts immediately."` — the block
   describes future action: "a pairing code is about to appear"); anything else
   → completed-work phrasing (`"Done with the steps above? Continue when you're
   ready."`). `gatePolicy` returns the flavor with the boolean.

**Decline semantics (normative):** the barrier confirm is a *pause*, not a
branch. A "No"/cancel answer proceeds anyway — matching today's engine, which
discards the gate confirm's result (`skill-apply.ts:802`). The driver's handler
must never throw for a decline (an operator-event throw would bounce + latch
`blocked`, §2.3). A driver MAY upgrade decline to a re-ask loop as pure polish;
it must not abort.

**Known limitation (lint-warned, open question 1):** an *unguarded* operator
followed by guarded directives of more than one branch value keys its barrier
decision off a directive that may be runtime-skipped. No in-tree skill authors
this; the §3 lint warning flags it.

At runtime, on each `operator` event the default handler: renders the clack
note (`p.note(text, 'Do this')`), runs the URL offer (§5.2), then the confirm
if `needsConfirm(line)`.

**Verified parity against today's tree** (re-derived under rules 1–5 above):

- teams `:80` → prompt `:93`: no confirm. `:101` → prompt `:110`: no confirm.
  `:124` → prompt `:132`: no confirm. `:158` → next compatible is **operator**
  `:173` (rule 2): **no confirm** — the chain's last block carries the barrier.
  `:173` → `run effect:check` `:186`: **confirm**. `:203` → `run effect:restart`
  `:217`: **confirm**. `:228` → end: no confirm. Exactly the two authored
  `gate`s reproduced — behavior identical.
- telegram `:134` (→ `run effect:step` pairing `:142`) **gains** a confirm with
  readiness phrasing — this restores the old bespoke flow's readiness pause
  that the directive port lost.
- signal `:94` (→ `effect:step` `:105`) and both whatsapp operators (`:96` →
  guard-skip `:104` → `effect:step` `:114`; `:104` → guard-skip `:114` →
  `effect:step` `:117`) gain the same readiness pause before a QR/pairing
  appears. whatsapp `:146` → prompt `:155`: no confirm.
- imessage `:111` (`when:mode=local`) → guard-skips `:126`,`:134`,`:137` →
  `run effect:external` `:151`: **confirm**. `:126` (`when:mode=remote`) →
  prompt `:134`: no confirm.
- discord `:125` (→ `run effect:fetch` `:139`, the DM resolve) gains a confirm —
  desirable: the DM open fails until the bot is invited (open question 2). Slack's
  operators (`:69` → prompt `:80`; `:97` → prompt `:112`) are prompt-followed →
  unchanged.

### 5.2 URL offer (replaces `open:`)

On an `operator` event, `extractOfferUrl(text)` scans the **rendered** text for
the first *offerable* URL: matches `/https?:\/\/[^\s)>\]]+/`, then **excludes**
candidates containing `<` or `{{` (template placeholders / unsubstituted vars)
and requires the candidate to parse via `new URL()` with a well-formed host.
Without the exclusion, slack's `:97` block — `https://<your-public-host>/webhook/slack`
— would produce a nonsense "Open https://<your-public-host?" offer (the char
class stops at `>` but not `<`). Slack `:97` is the normative negative fixture.

If an offerable URL is found and the run is interactive:
`confirm("Open <url> in your browser?")` → on yes, `openUrl` (both via the §5.0
seams — TTY-gated, non-TTY skips). Confirm-then-open matches the old bespoke
flows; prose-primary already forces URLs into the text (after the §3 skill
edits), so `open:` was redundant authorship. Order within the handler:
note → URL offer → natural-barrier confirm.

**Full operator-body URL inventory** (the offer scans *every* operator body,
not just ex-`open:` blocks — audited like §5.1):

| Site | URL | Outcome |
|---|---|---|
| teams `:101` (body line 2) | `https://portal.azure.com` | offer — preserves today's `open:` behavior |
| telegram `:134`, discord `:125` (after the §3 fold-into-prose edits) | t.me / invite URL | offer — preserves today's `open:` behavior |
| teams `:158` (body) | `https://portal.azure.com` | **new** offer (no `open:` today) — accepted, same judgment as the discord confirm; open question 3 |
| discord `:70` (body `:72`) | `https://discord.com/developers/applications` | **new** offer — accepted; open question 3 |
| imessage `:126` (body `:128`) | `https://photon.codes` | **new** offer — accepted; open question 3 |
| slack `:97` (body `:99`) | `https://<your-public-host>/webhook/slack` | **excluded** (placeholder) — slack stays offer-free, as today |
| slack `:69` (`api.slack.com/apps`, no scheme), signal `:94` (`sgnl://…`), all other operators | — | no match |

### 5.3 Validation error text (replaces `error:`)

`promptValidator(validate, flags, question)` — on a regex miss the message is
`` `That doesn't match the expected format. ${question}` `` (the full prompt
body, which by authoring convention describes the expected shape, e.g.
"Paste the bot token from BotFather (looks like `123456:ABC-DEF...`)."). No
`min` branch (regex-encoded now), no `error:` override.

### 5.4 Stays driver-side, unchanged in spirit

`clearOnError` secret re-paste, secret masking (`p.password`), the masked reuse
offer (`reuseFromEnv` + its `reuse:` linkage — confirm now via the §5.0 seam,
`skill-driver.ts:327-328` today), the `?` help-escape (channel/step ctx already
threaded via `RunSkillOptions`, `run-channel-skill.ts:130-131`), `backGate`,
spinners (now driven by step events), `hostExec`/`hostExecStream`.

**One behavior addition:** `reuseFromEnv` pre-filters offers through the target
prompt's `normalize`/`validate`/`flags` (parsed from the same directives it
already walks) — an `.env` value that would fail validate-at-bind is silently
not offered, so the operator is prompted fresh instead of hitting a §4
dead-end (`fullyApplied` false → `failWith`). This is the driver-side closure
of the stale-credential path; raw `inputs` remain loud-fail (§4).

## 6. Pipeline consumer contract

- **Inputs from env — convention:** for each prompt var `foo_bar`, read
  `NC_INPUT_FOO_BAR` (prefix `NC_INPUT_`, var uppercased). A small helper
  `inputsFromEnv(md: string, env = process.env)` (driver-agnostic, implemented
  at `scripts/skill-inputs.ts`) parses the skill's prompt vars via `parseDirectives` and
  returns the `inputs` record. Var names are case-sensitive in the grammar
  (`skill-directives.ts:111`), so uppercasing can collide (`bot_token` vs
  `Bot_Token`): `inputsFromEnv` **errors on a collision**. All in-tree vars are
  lowercase today; a lint rule requiring lowercase prompt/capture var names is
  cheap and makes the mapping bijective (open question 6). No `resolveInput`,
  no `onEvent` required (optionally an `onEvent` that logs step events as CI
  lines).
- **Run:** `applySkill(skillDir, root, { inputs, exec, execStream?, skipEffects })`
  with `skipEffects` per deployment (e.g. `['restart']` when the deploy restarts once).
- **What a pipeline can fully apply (normative boundary):** `inputs` binds
  **prompt** vars only — the engine never reads it for `run`/`step` captures
  (`skill-apply.ts:773` — prompt branch only), so a pipeline cannot pre-supply
  a capture-bound var like `platform_id`. And `effect:step` without a real
  `execStream` throws → bounces (`skill-apply.ts:655-656`);
  `skipEffects:['step']` avoids the bounce but leaves the step's capture vars
  unbound, so downstream consumers defer either way. Consequence: **skills with
  an `effect:step` are wizard/relay-only for full application** — today that is
  telegram (`:142`), whatsapp (`:114`,`:117`), and signal (`:105`). slack,
  discord, teams, and imessage carry no `effect:step` and can go fully green
  from env inputs (+ `exec`), with their operator blocks landing in the
  manual-steps report. A pipeline-grade `execStream`, or letting `inputs`
  pre-bind capture vars (bound var ⇒ capture skipped), would move that
  boundary — deliberately out of scope here (open question 10).
- **Consume the result:**
  - `res.operatorMessages` → emitted verbatim, numbered, as the "manual steps"
    report artifact (the human steps the pipeline cannot do).
  - `fullyApplied(res)` gates the job: `false` ⇒ non-zero exit, printing
    `res.deferred` (which now includes §4 invalid-input reasons — a malformed
    env value is a loud failure) and `firstFailureHint(res)` + each
    `agentTask.reason` for real bounces.
  - `res.vars` → exported for downstream jobs (e.g. `platform_id` into a wire step).

## 7. Agent-relay consumer sketch

A coding agent driving a skill over chat implements the two seams:

- `resolveInput(name, meta)`: send `meta.question` to the chat; for
  `meta.secret`, instruct the user to supply the value out-of-band (or via the
  platform's redaction affordance) and never echo it back. Run its own re-ask
  loop against `meta.validate`/`meta.flags` conversationally ("that doesn't look
  like a bot token — it should start with `xoxb-`"); return the final answer, or
  `undefined` if the user says skip (⇒ defer, degrade-to-agent semantics apply
  downstream).
- `onEvent(e)`: `operator` → relay the text as a chat message and (because the
  engine awaits) hold the return until the user replies "done" when the next
  action is side-effecting — importing `gatePolicy` from the shared
  `scripts/skill-policy.ts` (§5.0) for the same natural-barrier judgment as the
  wizard, with no clack/TTY baggage; or simply always ask.
  `step-start`/`step-end` → optional progress messages ("Building… ok, 12s").
- Everything else (`exec`, journal, bounce handling) is identical to the wizard;
  the agent reads `agentTasks[].prose` and applies bounced steps itself — which
  is exactly the degrade-to-agent path the prose was written for.

## 8. Implementation step plan

*Historical — this plan was executed on `feat/structured-skill-format`; kept as the record of how the refactor landed.*

Each step must be independently green — `pnpm exec tsc --noEmit` (root) +
`pnpm test` (full vitest suite) + skill lint on every touched skill — and
committable on its own. Core lands before consumers migrate; the old seam is
deleted only after no consumer uses it (transitional coexistence inside the
branch is fine; the *merged* result has no compat layer).

1. **Core: add the new seam (additive) + validate-at-bind.**
   `scripts/skill-apply.ts`: add `resolveInput` + `onEvent` + `InputMeta` +
   `ApplyEvent`; engine prefers them when present (falls back to
   `prompter`/`reporter` if not — temporary); implement validate-at-bind (§4)
   and the awaited-event ordering; re-document `stepLabel` null semantics (§2).
   **Includes the §4 fixture sweep**: Option-A slack inputs + `userId`
   assertion, teams deferWire `app_password`, and any `skill-apply.test.ts`
   fixture with shape-violating inputs — updated in this same commit so the
   suite is green. New tests: event union payloads + balance,
   await-before-proceed ordering (an async `onEvent` that records completion),
   `resolveInput` meta contents, validate-at-bind for inputs AND resolveInput
   answers (normalize-then-validate, no-fallthrough from invalid inputs to
   `resolveInput`, deferred entry format, `fullyApplied` false, secret never in
   the entry), onEvent-throw ⇒ bounce (incl. on an operator event).
2. **Shared policy module + wizard driver migration.** New
   `scripts/skill-policy.ts`: `gatePolicy(md)` (§5.1 rules incl. operator-chain
   termination, guard-compatibility, confirm flavor) + `extractOfferUrl(text)`
   (§5.2 incl. placeholder exclusion) — with the parity-table unit tests.
   `setup/lib/skill-driver.ts`: `resolveInput` impl (ex-`clackPrompter.ask`,
   help-escape intact), default `onEvent` handler (spinner branch from
   `spinnerReporter` + operator branch consuming `gatePolicy`/`extractOfferUrl`),
   new `confirm`/`openUrl` options with TTY-gated defaults (§5.0), decline =
   proceed, `reuseFromEnv` validate-pre-filter (§5.4), §5.3 error text;
   `RunSkillOptions.prompter/reporter` → `resolveInput/onEvent` (+ documented
   replacement semantics for injected `onEvent`);
   `setup/channels/run-channel-skill.ts` override renames + `confirm`/`openUrl`
   passthrough; `setup/providers/install.ts` drops its stub Prompter. Reuse
   tests migrate to the `confirm` seam; the teams run-channel test runs the
   default handler with injected `confirm`/`openUrl` (§9). After this step no
   in-tree caller passes `prompter`/`reporter`.
3. **Core: delete the old seam.** Remove `Prompter`, `PromptOpts`,
   `StepReporter`, `ApplyOptions.prompter/reporter`; remove engine handling of
   `open:`/`gate` (`:791,:796,:802`), `label:` (`:458`), `on-fail:`+`AgentTask.hint`
   (`:419-430,:236`), `min:`/`error:` plumbing (`:499-506`). Rework/delete the
   engine tests that asserted removed behavior (§9).
4. **Skills cleanup.** Strip attrs per §3 table; fold the telegram + discord
   URLs into their operator prose; teams `min:20` → `validate:^.{20,}$`.
   Re-lint all touched skills; the run-channel teams parity test (now
   driver-policy-based from step 2) must still prove both barriers fire and the
   portal offer survives the `open:` removal (body URL, §5.2 inventory).
5. **Grammar diet.** `scripts/skill-directives.ts`: drop `min:`/`error:`/`open:`/`gate`
   validation + grammar doc; add lint errors rejecting the six removed attrs
   and the §3 unguarded-operator/multi-branch warning; rework directive tests.
   (Ordered after step 4 so lint never fails on skills still carrying the attrs.)
6. **Sweep + parity audit.** Grep proves zero remaining references to
   `Prompter|PromptOpts|StepReporter|on-fail:|label:|min:|error:` (in the seam
   sense) and `operator.*(open:|gate)`; container typecheck
   (`pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`) untouched;
   full suite count ≥ 680 passed | 1 skipped; Option-A test assertion structure
   unmodified (fixture values per §1/§4); production resolve/wire paths
   untouched.

## 9. Test-migration notes (per step)

*Historical — executed alongside §8; line numbers reference the pre-refactor tree.*

- **Step 1:** all existing tests stay green — the ONLY permitted edits are the
  §4 shape-violating input fixtures (Option-A slack `:49`/`:62`, teams deferWire
  `:106`, plus any `skill-apply.test.ts` siblings the sweep finds). New
  describe blocks in `scripts/skill-apply.test.ts`: `onEvent` events (mirror of
  the reporter suite at `:1003-1054`, plus operator events + await-ordering) and
  validate-at-bind (extends the PromptOpts suite pattern at `:1189-1242`).
- **Step 2:** `setup/lib/skill-driver.test.ts` fakes (`:73,:100`) rewritten
  mechanically to `resolveInput`/`onEvent`; the reuse-offer tests
  (`:149,:167,:202`) migrate to the injected `confirm` option (accept /
  decline / helper-reuse paths preserved); the `clackPrompter.open`
  existence test (`:218-223`) becomes a URL-offer policy test; help-escape tests
  (`:225-259`) keep their shape (the escape lives in the driver's `resolveInput`);
  `promptValidator` test (`:261-271`) loses min/error, gains prose-derived-message
  assertions. **Policy tests at `scripts/skill-policy.ts`'s home** encode the
  §5.1 parity table: teams (confirm ×2, **no confirm on the `:158` chain head** —
  the operator-chain rule's regression fixture), telegram/signal/whatsapp
  (readiness-flavor pause), imessage (guard-compatibility), end-of-document;
  plus `extractOfferUrl` fixtures: the §5.2 inventory incl. slack's placeholder
  as the negative case. `run-channel-skill.test.ts:75-125` (teams) re-asserts
  gate-before-manifest + portal-URL-offer by running the **default** `onEvent`
  handler with injected `confirm`/`openUrl` (never an injected `onEvent`, which
  replaces the policy — §5.0).
- **Step 3:** delete engine tests for removed syntax: `nc:operator open + gate`
  (`scripts/skill-apply.test.ts:492-551`), `label:` override + `on-fail:` cases
  (`:1064,:1072`, `:1145-1162`); keep their *semantic* siblings (heading labels,
  prose hint default, unresolved-var deferral of an operator body). The prompter
  threading tests (`:634-645,:1212-1231`) become `InputMeta` assertions.
- **Step 4:** no test-file changes beyond fixtures; skill lint is the gate.
- **Step 5:** `scripts/skill-directives.test.ts`: drop `:268-271` (min) and
  `:325-355` (open/gate) as validations-of-supported-syntax; re-add them
  inverted (the new lint errors reject the attrs). PromptOpts-parse test
  (`:247-261`) drops `min:`.
- **Throughout:** the coverage-parity bar is behavioral, not file-shaped: every
  guarantee an old test proved (barrier ordering, open-after-render, balanced
  spinner events, hint provenance) must have a successor at its new home.

## 10. Open questions (decisions this spec made that the design left open)

1. **Guard-compatibility in the gate scan (§5.1.1).** The design said "followed
   by"; this spec defines *followed by* as skipping `when:`-incompatible
   directives so mutually-exclusive branches gate correctly (imessage local,
   whatsapp qr/pairing). Alternative (pure document order) would miss imessage's
   "stop and wait" and double-gate whatsapp. Two scrutiny points: (a) the
   compatibility rule compares only same-var/different-value; different-var
   guards are treated as compatible (conservative). (b) An **unguarded**
   operator followed by guarded directives of more than one branch value keys
   its decision off a directive that may be runtime-skipped (e.g. unguarded
   operator → `prompt when:mode=remote` → `run when:mode=local`: policy says
   no-confirm, but at runtime mode=local skips the prompt). No in-tree skill
   authors this; §3's lint warning covers it.
2. **Discord gains a confirm** (`add-discord:125` → `effect:fetch`). The design's
   parity list mentioned teams + telegram only; the policy also pauses before
   discord's DM resolve. Judged desirable (the fetch fails until the bot is
   invited) — but it is a new prompt in an existing flow.
3. **Three new URL offers** (§5.2 inventory): teams `:158` (portal.azure.com),
   discord `:70` (developers portal), imessage `:126` (photon.codes) had no
   `open:` today and gain an offer because the scan covers every operator body.
   Accepted — same judgment as the discord confirm — but they are behavior
   changes in existing flows.
4. **Confirm triggers on ALL non-prompt/non-operator directives** (§5.1.5), not
   just the engine's dangerous-side-effect set (`restart|step|wire`). Needed for
   teams parity (its first gate precedes `effect:check`+`external`). Consequence:
   an operator block directly followed by e.g. an `env-set` would also confirm —
   no such authoring exists today.
5. **Invalid-input failure shape (§4): deferred, not agentTask.** Chosen because
   a bad value is a missing-*valid*-value (re-supply and re-run), not a step an
   agent can apply from prose; it also keeps the run-health gate un-tripped so a
   re-run with a fixed env var completes. The alternative (bounce) would
   cascade-block later side effects. Relatedly: invalid `inputs` do NOT fall
   through to `resolveInput` (§4) — the driver's reuse pre-filter (§5.4) is the
   interactive recovery path.
6. **Env-input convention `NC_INPUT_<VAR>` (§6)** and that `inputsFromEnv` is a
   helper, not an engine feature (inputs stay the only env-agnostic seam). Prefix
   bikeshed welcome; the engine never reads `process.env` for inputs.
   `inputsFromEnv` errors on an uppercase collision; a lowercase-var lint rule
   would make the mapping bijective.
7. **Operator event fires even with no consumer** — with `onEvent` absent the
   block is still collected in `operatorMessages` (today's headless behavior,
   `skill-apply.test.ts:452-456`). The **engine** never defers/bounces an
   operator block on its own; a consumer that *throws* from `onEvent` opts into
   the standard bounce path (§2.3) — that is the consumer's choice, not an
   engine judgment, and the wizard's default handler never throws (decline =
   proceed, §5.1).
8. **`AgentTask.hint` field removal** (vs. keeping it always-equal-to-prose for
   result-shape stability). Removal chosen for the clean break; any external
   consumer of `hint` (none in-tree) would break.
9. **Teams `min:20` regex** chosen as `^.{20,}$` (any 20+ chars). If the intent
   was tighter (Azure secret alphabet), tighten in the skill edit — the seam
   doesn't care.
10. **Pipeline boundary for `effect:step` skills (§6).** telegram/whatsapp/signal
    cannot go fully green in a pipeline (no human at the QR/pairing step, and
    `inputs` cannot pre-bind capture vars). Two possible future escapes — a
    pipeline-grade `execStream` contract, or `inputs` pre-binding capture vars
    (bound var ⇒ capture skipped) — both deliberately out of scope; the spec'd
    behavior is the loud `fullyApplied:false`.
11. **`step-end` on validate-at-bind rejection:** none — prompts never emitted
    step events (they are not mutations) and still don't. Only the deferred entry
    records the rejection. If wizards want live feedback, their own `resolveInput`
    loop already provided it.

## 11. Rejected review findings

- **"`run-channel-skill.ts:122` is `exec`; the `prompter` passthrough is at `:123`"**
  (review 1, citation sweep) — rejected: `grep -n` shows `:121 exec: overrides.exec,`
  and `:122 prompter: overrides.prompter,`. The spec's `:122` citation was
  correct as written. (The same review's other three citation fixes —
  `resolveRemote :283`, teams `:101` body-line wording, `label:` doc mention
  `:451` — were verified correct and are folded.)
