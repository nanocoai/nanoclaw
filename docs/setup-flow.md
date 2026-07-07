# Setup flow

This document is the contract for NanoClaw's end-to-end scripted setup
(`bash nanoclaw.sh` → `pnpm run setup:auto`). Read it before adding a new
step, fixing a regression, or changing how output is rendered.

## The three output levels

Every setup step produces output at **three distinct levels**. They have
different audiences, go to different places, and are formatted differently.
Don't conflate them.

| Level | Audience | Destination | Format |
|---|---|---|---|
| 1. User-facing | The operator running setup | Terminal (via clack) | Branded, concise, informational — "product content" |
| 2. Progression | Future debuggers, AI agents reviewing a failed run, release support | `logs/setup.log` (one file, append-only) | Structured per-step blocks, linear chronology, human + machine readable |
| 3. Raw | Whoever is deep-debugging a specific step | `logs/setup-steps/NN-step-name.log` (one file per step) | Full raw child stdout + stderr, verbatim |

Think of it as: the user sees a **summary**, the progression log is an
**index with key facts**, the raw logs are the **evidence**.

### Level 1: user-facing (clack)

Rendered by `setup/auto.ts` via `@clack/prompts`. This is our *product
surface* for setup — every line should read as if we designed it for a
stranger on day one.

- Clack spinners for in-progress work. Show elapsed time.
- `p.log.success` / `p.log.step` / `p.log.warn` for permanent status
  markers.
- `p.note` for multi-line information (pairing code, next steps).
- `p.text` / `p.select` / `p.password` for prompts.
- Brand palette: `brand()` / `brandBold()` / `brandChip()` helpers in
  `setup/auto.ts`. Truecolor when the terminal supports it, 16-color
  cyan fallback otherwise, plain text when piped / `NO_COLOR`.

Rules:
- **No discontinuity.** Every sub-step belongs to the same visual flow.
  The only exception is Anthropic credential registration (see below).
- **No raw child output.** Never `stdio: 'inherit'` a child whose output
  wasn't written by us. Capture it and show it on failure only.
- **No debug-style prefixes** (`[add-telegram] …`, `INFO …`, timestamps).
  Those belong in levels 2 and 3.
- **No emoji** unless the clack glyph requires it.

### Level 2: progression log

`logs/setup.log` — one file per setup run, append-only, cumulative across
a multi-run install (if a run fails midway and is re-attempted, the new
entries append). It's the thing you'd ask an operator to paste when they
report a setup bug, and the thing an AI agent would read to understand
what happened.

Entry format:

```
=== [2026-04-22T22:14:12Z] bootstrap [45.1s] → success ===
  platform: linux
  is_wsl: false
  node_version: 22.22.2
  deps_ok: true
  native_ok: true
  raw: logs/setup-steps/01-bootstrap.log

=== [2026-04-22T22:14:57Z] environment [2.3s] → success ===
  docker: running
  apple_container: not_found
  raw: logs/setup-steps/02-environment.log

=== [2026-04-22T22:15:00Z] container [92.4s] → success ===
  runtime: docker
  image: nanoclaw-agent:latest
  build_ok: true
  raw: logs/setup-steps/03-container.log
```

Design constraints:
- Start-time timestamp (UTC, ISO-8601) on the opening line so a `grep`
  gives you the sequence.
- Duration in seconds with one decimal — fast steps read as "0.5s", not
  "0ms".
- Status is one of: `success`, `skipped`, `failed`, `aborted`.
- Fields are step-specific but **must** be short scalar values. No JSON,
  no multi-line. If a value is long, put it in the raw log and reference
  it.
- Always emit a `raw:` pointer, even on success — makes debugging the
  second failure easier.
- **User choices** are their own entries, not nested inside a step:

  ```
  === [2026-04-22T22:17:44Z] user-input → display_name ===
    value: gav

  === [2026-04-22T22:17:51Z] user-input → channel_choice ===
    value: telegram
  ```

  These matter because the path through the setup flow depends on them.

The log opens with a header block identifying the run, and closes with
a completion block:

```
## 2026-04-22T22:14:12Z · setup:auto started
  user: exedev
  cwd: /home/exedev/nanoclaw
  branch: branded-setup
  commit: 6e0d742

… (step entries) …

## 2026-04-22T22:18:54Z · completed (total 4m42s)
```

On failure the completion block names the failing step and its error:

```
## 2026-04-22T22:16:40Z · aborted at container (err=cache_miss)
```

### Level 3: raw per-step logs

`logs/setup-steps/NN-step-name.log` — one file per step, numbered in
execution order (zero-padded 2-digit prefix for natural sorting). Full
verbatim stdout + stderr from the child process. Truncated and rewritten
on each run (not appended).

Contents are whatever the step emits: apt output, docker build layers,
pnpm install spam, `curl` bodies, etc. This is the evidence plane —
"what did the shell actually see?" Nothing is filtered.

## Contract for a new step

When you add a step (either a TS step in `setup/<name>.ts` or a bash
installer invoked from `auto.ts`), it must:

1. **Receive a raw-log path** from the caller. Write all stdout + stderr
   there. Don't write to the terminal directly.
2. **Emit a single terminal status block** at the end, containing
   `STATUS: success|skipped|failed` and any step-specific fields:

   ```
   === NANOCLAW SETUP: STEP_NAME ===
   STATUS: success
   KEY: value
   KEY: value
   === END ===
   ```

   Field names are `UPPER_SNAKE_CASE`. Values are short scalars.

3. If it's a long-running step, optionally emit **sub-status blocks**
   mid-stream. `auto.ts` parses them live and can render intermediate
   UI (as `pair-telegram` does with `PAIR_TELEGRAM_CODE` /
   `PAIR_TELEGRAM_ATTEMPT`).

4. **Exit non-zero** on hard failure so `auto.ts` can distinguish
   "step ran to completion and reported failed" from "step crashed".

The driver handles the rest: spinner in level 1, structured append to
level 2, raw capture to level 3.

## The Anthropic exception

Anthropic credential registration (`setup/register-claude-token.sh`) is
the **one** permitted break in the visual flow. Why:

- `claude setup-token` opens a browser, runs its own OAuth prompt, and
  prints the token. It owns the TTY via `script(1)`.
- We don't want to re-implement the OAuth device flow ourselves.
- We don't want to intercept / mirror the token (it appears in the
  user's terminal already — mirroring it adds attack surface).

So during this step:
- The clack flow explicitly pauses (a `p.log.step` marker says "this
  part is interactive, you're handing off to Anthropic").
- The child inherits stdio fully.
- When control returns, clack resumes on the next line with a success
  marker.

The level-2 log still gets an entry (`auth [interactive] → success`
with the method — subscription / oauth-token / api-key). Level-3 captures
are optional here; mirroring `script -q` output is tricky and the risk of
leaking the token to disk outweighs the debugging value.

## File reference

| File | Role |
|---|---|
| `nanoclaw.sh` | Top-level wrapper. Phase 1 (bootstrap) and phase 2 (setup:auto) orchestration. Writes bootstrap's raw log + progression entry. `--uninstall` bypasses bootstrap entirely — it execs setup:auto directly (the flow lives in `setup/uninstall/`), or prints manual-cleanup guidance and exits 1 when the TS toolchain is missing. |
| `setup.sh` | Phase 1 bootstrap: Node, pnpm, native-module verify. Emits its own `BOOTSTRAP` status block (historically printed to stdout; now goes to the bootstrap raw log). |
| `setup/auto.ts` | Phase 2 driver. Orchestrates the clack UI, step execution, user prompts, and writes to all three log levels for every step it spawns. |
| `setup/logs.ts` | The logging primitives (`logStep`, `logUserInput`, `logComplete`, `stepRawLog`, `initSetupLog`). Single source of truth for level 2/3 formatting and file paths. |
| `setup/<step>.ts` | Individual step implementations. Must emit one terminal status block; must not write directly to the terminal. |
| `setup/register-claude-token.sh` | The Anthropic exception. Inherits stdio, prints its own UI, returns a status to the driver. |
| `setup/add-telegram.sh` | Non-interactive adapter installer. Reads `TELEGRAM_BOT_TOKEN` from env; never prompts. User-facing bits live in `auto.ts`. |
| `setup/pair-telegram.ts` | Emits `PAIR_TELEGRAM_CODE` / `PAIR_TELEGRAM_ATTEMPT` / `PAIR_TELEGRAM` status blocks. Never prints UI. The driver renders it via clack notes. |

## Common pitfalls

- **Printing debug output from inside a step.** Tempting during
  development; forbidden in checked-in code. All runtime messaging goes
  through status blocks (level 2) or raw log writes (level 3).
- **Adding a `console.log` that "just this once" goes to the terminal.**
  It breaks the clack flow — the spinner line gets torn. Use
  `log.info` / `log.error` from `src/log.ts` (writes to the raw log)
  instead.
- **`stdio: 'inherit'` for a non-exception child.** See Anthropic above.
  Anything else needs `pipe` + explicit capture.
- **Tee-ing to stderr.** Clack's spinner owns the terminal during a step.
  Even stderr writes tear the frame. Pipe everything, then choose what
  to surface.
- **UTF-8 in bash `$VAR…` positions.** Bash's lexer can pull the first
  byte of a multi-byte character into the variable name and trip
  `set -u`. Always brace: `${VAR}…`.

## Future work (not yet implemented)

- **Progression log rotation.** Today's implementation truncates on each
  run. Future: roll prior runs to `logs/setup.log.1`, `.2`, etc.
- **Raw log rotation for multi-run installs.** Currently each run
  overwrites. Fine for now; revisit if support needs to compare
  successive attempts.
- **Structured output from `register-claude-token.sh`.** The interactive
  step emits no machine-readable status today. Future could add a
  post-interaction status block with the method used.
