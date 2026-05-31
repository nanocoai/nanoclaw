---
name: web-fetch
description: Generic web-fetch CLI for the container agent. One command to fetch any URL — drives agent-browser as the primary path, auto-detects Cloudflare challenges (status / title / body / cf-ray / cf-mitigated heuristics), and transparently falls back to the container-local cf-fetch-server sidecar when a CF challenge is detected. End-to-end orchestration handles timeouts, retries, error recovery, and structured logging so the agent gets one envelope on stdout, one exit code, and a single command to call.
allowed-tools: Bash(python3:*), Bash(agent-browser:*)
---

# web-fetch

A single CLI the agent calls to fetch any URL. The wrapper drives the
existing `agent-browser` runtime as the **primary path** and returns a
normalised JSON / HTML / status response. Every result carries a
`cf_detection` field; when it indicates a Cloudflare challenge the
wrapper transparently falls back to the container-local `cf-fetch-server`
sidecar (Sub-AC 2.3). The agent calls **one command** and the wrapper
picks the right backend behind the scenes.

## Quick start

```bash
# JSON envelope (default — easiest for the agent to parse)
web-fetch https://example.com

# Raw HTML straight to stdout
web-fetch --output html https://example.com

# HTTP status only
web-fetch --output status https://example.com
```

`web-fetch` lives on $PATH inside the agent container — the image bakes
the wrapper at `/opt/web-fetch/web_fetch.py` and a shim at
`/usr/local/bin/web-fetch` (Sub-AC 3.3, see `container/Dockerfile`).
The same source files are also synced to
`/home/node/.claude/skills/web-fetch/` per group at runtime; the long-form
invocation `python3 /home/node/.claude/skills/web-fetch/web_fetch.py …`
still works for skills that prefer absolute paths or that need to monkey-
patch the wrapper for a specific group.

The sidecar URL is resolved from `$CF_FETCH_SIDECAR_URL`, which defaults
to `http://127.0.0.1:8765` in the image and is re-injected at production
spawn time by `src/container-runner.ts`.

Webshare proxy credentials are never baked into the image or command line.
When configured, `HTTP_PROXY_URL` is passed as a key-only container env
from the host secret store, and the sidecar redacts it from logs and health
responses.

## Arguments

| Flag | Default | Notes |
|---|---|---|
| `<url>` | required | Absolute URL with scheme. |
| `--method`, `-X` | `GET` | One of `GET POST PUT DELETE PATCH HEAD`. |
| `--header`, `-H` | none | Repeatable `'Key: Value'`. Non-trivial headers route through an in-page `fetch()` so they actually apply. |
| `--body`, `-d` | none | Raw request body. Mutually exclusive with `--body-file`. |
| `--body-file` | none | Read body from file. |
| `--timeout` | `30` | Per-request seconds. |
| `--output`, `-o` | `json` | One of `json html status`. |
| `--verbose`, `-v` | off | Bump the structured-log threshold from the always-on `INFO` to `DEBUG` for this call only — exposes per-attempt sidecar events (`sidecar.attempt.start` / `sidecar.attempt.end`) without requiring `WEB_FETCH_LOG_LEVEL=DEBUG` in the env. The always-on attempt trace is unaffected. |
| `--quiet`, `-q` | off | Silence the orchestration log on stderr for this call only (equivalent to `WEB_FETCH_QUIET=1`). The response envelope on stdout is untouched. `--verbose` wins if both are passed. |

## Output (default `--output json`)

```json
{
  "ok": true,
  "backend": "agent-browser",
  "status": 200,
  "url": "https://example.com/",
  "title": "Example Domain",
  "html": "<!doctype html>...",
  "headers": {},
  "error": null,
  "elapsed_s": 1.42,
  "cf_detection": {
    "is_challenge": false,
    "confidence": "none",
    "signals": [],
    "reason": "no Cloudflare challenge signals detected"
  }
}
```

`backend` is `agent-browser` whenever the primary path served the request,
or `cf-fetch-server` when the sidecar fallback served it (Sub-AC 2.3 —
see "Sidecar fallback" below). The agent does NOT need to pick the
backend itself.

When the sidecar serves the request the envelope grows a `fallback`
field with the diagnostic trail:

```json
{
  "ok": true,
  "backend": "cf-fetch-server",
  "status": 200,
  "url": "https://utoon.net/",
  "title": "유툰",
  "html": "<!doctype html>...",
  "headers": {"content-type": "text/html"},
  "error": null,
  "elapsed_s": 3.21,
  "cf_detection": { "is_challenge": false, "confidence": "none", "signals": [], "reason": "..." },
  "fallback": {
    "fired": true,
    "reason": "cf_detection.is_challenge=True (confidence='high', signals=[title:cloudflare])",
    "sidecar_url": "http://127.0.0.1:8765",
    "sidecar_backend": "nodriver",
    "sidecar_http_status": 200,
    "primary_backend": "agent-browser",
    "primary_status": 200,
    "primary_signals": ["title:cloudflare"],
    "method_downgraded_to_get": false,
    "body_dropped": false,
    "proxy_auth_wired": true
  }
}
```

`cf_detection` is re-computed on the sidecar envelope so an agent that
branches on `cf_detection.is_challenge` sees a uniform contract.

### `cf_detection` field (Sub-AC 2.2)

Every primary-path response is tagged with a Cloudflare-challenge verdict.
Sub-AC 2.3 reads this signal to decide whether to fall back to the local
sidecar; the agent itself does NOT have to interpret it.

| Field          | Type           | Meaning                                            |
|----------------|----------------|----------------------------------------------------|
| `is_challenge` | bool           | True ⇒ a Cloudflare challenge / block was detected and fallback should fire. |
| `confidence`   | str            | `"high"` (definitive signal: title / strong body / cf-mitigated header), `"medium"` (paired-only signal: cf-ray + bad status), `"none"`. |
| `signals`      | list[str]      | Which heuristics matched (e.g. `"title:just a moment"`, `"body:cdn-cgi-challenge-platform"`, `"header:cf-mitigated"`, `"header:cf-ray+bad-status"`). |
| `reason`       | str            | One-line human-friendly summary for logs.          |

Heuristic surface (matches the Seed's `cf_signals` list):

- **Title** — `Just a moment`, `Attention required`, `Cloudflare`, `Checking your browser`, Korean `잠시만 기다리`.
- **Body** — `/cdn-cgi/challenge-platform/`, `cf_chl_opt`, `cf_chl_jschl_tk`, `__cf_chl_tk`, `_cf_chl_managed_tk`, `id="challenge-form"`, `DDoS protection by Cloudflare`, `checking your browser before accessing`, Korean `잠시만 기다리`.
- **Headers** — `cf-mitigated` (any status), `cf-chl-bypass` (any status), `cf-ray` paired with 403/503/429/52x, `server: cloudflare` paired with bad status.
- **Weak body markers** (only when paired with another CF signal) — `Sorry, you have been blocked`, `Ray ID:`.

Pages that are not behind Cloudflare (e.g. `example.com`) always come back
with `is_challenge=false`. A page that just *mentions* "cloudflare" in
prose body text does NOT trigger fallback.

### Sidecar fallback (Sub-AC 2.3)

When `cf_detection.is_challenge` is True, the wrapper transparently
forwards the request to the container-local `cf-fetch-server` sidecar at
`http://127.0.0.1:8765/fetch` (POST, JSON body). The
sidecar's response is reshaped into the same envelope the primary path
returns — only the `backend` switches to `cf-fetch-server` and a
`fallback` record is added. The sidecar consumes `HTTP_PROXY_URL` only
inside its own process and never returns the raw credential value.

| Env var | Default | Purpose |
|---------|---------|---------|
| `CF_FETCH_SIDECAR_URL` | `http://127.0.0.1:8765` | Override the sidecar base URL for tests or custom deployments. |
| `CF_FALLBACK_ON_PRIMARY_FAILURE` | unset | When `1`, the wrapper also falls back to the sidecar on **any** primary-path failure (not just CF challenges). Off by default — keeps non-CF transient failures from silently routing through the proxy. |
| `WEB_FETCH_PRIMARY_TIMEOUT_PCT` | `0.6` | Fraction of `--timeout` allotted to the primary tier. The sidecar gets the remainder. Range: 0.05–0.95. |
| `WEB_FETCH_PRIMARY_TIMEOUT_MIN_S` | `5.0` | Floor on the primary tier's per-request budget. |
| `WEB_FETCH_SIDECAR_TIMEOUT_MIN_S` | `5.0` | Floor on the sidecar tier's per-request budget. The sidecar still gets at least this much even when the primary tier blew the budget. |
| `WEB_FETCH_SIDECAR_RETRY` | `1` | Number of *additional* sidecar attempts on a network-level failure (`SidecarUnavailable` — connection refused / DNS / socket timeout). HTTP errors (4xx/5xx queue-full) are NOT retried. Range: 0–5. |
| `WEB_FETCH_SIDECAR_RETRY_DELAY_S` | `1.0` | Wait between sidecar retries. Skipped when the remaining budget can't absorb it. Range: 0–30. |
| `WEB_FETCH_LOG_LEVEL` | `INFO` | Structured-log threshold. One of `NONE`, `ERROR`, `WARNING`, `INFO`, `DEBUG`. Lines go to **stderr** so the response envelope on stdout stays clean. |
| `WEB_FETCH_QUIET` | unset | Shortcut for `WEB_FETCH_LOG_LEVEL=NONE`. |
| `WEB_FETCH_DISABLE_FALLBACK` | unset | **Debug opt-out (Sub-AC 2.2.4).** When truthy (`1`, `true`, `yes`, `on`) the orchestrator skips the sidecar tier even when `cf_detection.is_challenge=True` and returns the primary envelope as-is. Useful for reproducing primary-path bugs in isolation or confirming a CF-tagged page is actually a CF page (the primary's `cf_detection` field is preserved so the detector's verdict stays visible). The orchestrator emits a single `fallback.skipped.opt_out` warning event so the decision is visible in the structured log. **The opt-out NEVER changes the envelope schema or the exit-code contract** — `EXIT_OK` if the primary returned `ok=true`, `EXIT_FETCH_FAILED` otherwise. |

The sidecar's `/fetch` endpoint is GET-shaped only (Seed: "Fetch-only —
no interactive automation"). If the agent calls the wrapper with a
non-GET method and the wrapper falls back, the sidecar request
downgrades to a GET. The downgrade is recorded as
`fallback.method_downgraded_to_get=true` and any non-empty request
body is recorded as `fallback.body_dropped=true` so the agent can see
what happened. When the sidecar is unreachable the envelope stays
shape-compatible (`ok=false`, `backend="cf-fetch-server"`,
`fallback.sidecar_backend="unreachable"`) — the agent has one parser
to write regardless of which path served the request.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success — either primary or sidecar fallback served the request. |
| `2` | Bad CLI usage. |
| `3` | Both primary and (if applicable) sidecar fallback failed unrecoverably. |

The exit code is computed once, by the orchestrator, regardless of which
tier served the request. The agent reads `result.ok` from the JSON
envelope (or `$?` when invoking via shell) and never has to reason about
"the primary failed but the sidecar saved it."

## End-to-end orchestration (Sub-AC 2.4)

The CLI is a thin shell over `orchestrator.run_fetch()`, which provides:

- **Timeout split** — `--timeout` is treated as a *total* budget. The
  primary tier gets at most `WEB_FETCH_PRIMARY_TIMEOUT_PCT * total`
  (default 60%); the sidecar gets the remainder, with a floor so a
  budget-exhausted primary can still fall back. A slow primary path
  cannot starve the fallback.
- **Sidecar retry** — when the sidecar round-trip fails at the network
  level (`SidecarUnavailable`-shaped envelope: `connection refused`,
  DNS failure, socket timeout) the orchestrator retries once after a
  short delay (`WEB_FETCH_SIDECAR_RETRY_DELAY_S`). HTTP-level failures
  (queue-full 503, 4xx) do NOT retry — their structured error body is
  already useful. The retry is skipped when the remaining budget can't
  absorb it.
- **Exception safety** — every code path that can raise is wrapped so
  the agent always gets a wrapper-shaped JSON envelope on stdout, and
  never a Python stack trace. Bad CLI usage is the only condition that
  exits non-zero with stderr text.
- **Unified exit code** — single decision point: `0` if either tier
  produced `ok=true`, otherwise `3`. The agent's contract is uniform.
- **Structured logging** — every decision lands as one JSON line on
  stderr. Default events:

  | Event | When | Useful fields |
  |---|---|---|
  | `fetch.start` | Top of the run | `url`, `method`, `timeout`, `primary_budget`, `primary_pct` |
  | `primary.complete` | After tier 1 | `ok`, `status`, `elapsed_s`, `cf_is_challenge`, `cf_signals` |
  | `fallback.decision` | Tier 2 gate | `fire`, `reason`, `primary_signals` |
  | `fallback.skipped.opt_out` | Sub-AC 2.2.4 debug opt-out fired | `env_var`, `value`, `cf_is_challenge`, `cf_signals` |
  | `sidecar.start` | Tier 2 starts | `sidecar_url`, `sidecar_budget`, `retry_count` |
  | `sidecar.retry.scheduled` | Between attempts | `attempt`, `delay_s`, `reason` |
  | `sidecar.retry.skip.budget_exhausted` | Retry skipped | `attempts_made`, `elapsed_s`, `budget_s` |
  | `sidecar.complete` | After tier 2 | `ok`, `sidecar_backend`, `sidecar_attempts`, `elapsed_s` |
  | `both_paths_failed` | Sub-AC 2.2.4 — primary AND sidecar both failed | `primary_error`, `sidecar_error`, `sidecar_backend`, `sidecar_http_status` |
  | `fetch.complete` | End | `tier` (`primary`/`sidecar`/`sidecar-failed`), `served_by` (which runtime served — `agent-browser`/`nodriver`/`stub`/`queue-full`/`unreachable`/`none`), `ok`, `exit_code`, `total_elapsed_s` |
  | `primary.exception` / `sidecar.exception` | Unexpected raise | `error`, `error_type`, `traceback` |
  | `fallback.url_resolution_failed` | $CF_FETCH_SIDECAR_URL invalid | `error`, `reason` |

  **Single-line "which runtime served?"** — every `fetch.complete` event
  carries a `served_by` field, so a single grep tells the operator which
  runtime answered the request without having to walk the trail:

  ```bash
  python3 web_fetch.py "$URL" 2> >(jq -c 'select(.event=="fetch.complete") | {tier,served_by,ok,exit_code}')
  ```

  **Both paths failed** — the dedicated `both_paths_failed` event is
  emitted exactly once when the primary failed AND the sidecar fallback
  also failed. Use it to alert on real outages without correlating two
  separate events.

  Tail with `jq` for a quick decision trail:

  ```bash
  python3 web_fetch.py https://utoon.net/ 2> >(jq -c 'select(.event)') > /tmp/page.json
  ```

  ### Verbosity flags (Sub-AC 3)

  The structured-log trail is **always on** at INFO so verification can
  confirm the sequence from logs without flags. Each event records the
  three deciding fields the AC mandates:

  | Field on event | Where | Meaning |
  |---|---|---|
  | `elapsed_s` | `primary.complete`, `sidecar.complete`, `sidecar.attempt.end`, `fetch.complete` | Per-attempt runtime. |
  | `cf_is_challenge` / `cf_confidence` / `cf_signals` | `primary.complete` | Detected Cloudflare signal (the deciding heuristic for fallback). |
  | `fire` / `reason` | `fallback.decision` | The fallback decision (true ⇒ sidecar fires; reason names the cause). |

  Two CLI flags adjust the threshold for one call without exporting an
  env var:

  - `--verbose` / `-v` → bumps the threshold to DEBUG. Adds the
    per-attempt sidecar events `sidecar.attempt.start` and
    `sidecar.attempt.end` so an operator chasing a flaky retry sees
    individual attempt outcomes inline. The always-on INFO trail is
    unaffected — `--verbose` only **adds** detail.
  - `--quiet` / `-q` → silences stderr. The stdout envelope is
    untouched, so a caller piping the JSON envelope into a parser can
    suppress the orchestration log without setting
    `WEB_FETCH_QUIET=1`.
  - If both flags are passed, `--verbose` wins (explicit per-call
    opt-in beats the silencer).

  Internally the flags simply rewrite the env handed to
  `orchestrator.run_fetch` (`WEB_FETCH_LOG_LEVEL=DEBUG` for `--verbose`
  or `WEB_FETCH_QUIET=1` for `--quiet`). When neither flag is passed
  the ambient env passes through unchanged so a persistent
  `WEB_FETCH_LOG_LEVEL` export keeps working.

  ```bash
  # Always-on trace (default INFO):
  python3 web_fetch.py https://utoon.net/ 2>&1 1>/tmp/page.json | jq -c .

  # Per-attempt sidecar detail for one call:
  python3 web_fetch.py --verbose https://utoon.net/ 2>&1 1>/tmp/page.json | jq -c .

  # Silence the trail entirely:
  python3 web_fetch.py --quiet https://utoon.net/ > /tmp/page.json
  ```

## Notes

- GET with no special headers uses real browser navigation (`agent-browser
  open <url>`) — best fidelity for JS-rendered pages.
- GET with non-trivial custom headers, and any non-GET verb, runs through
  an in-page `fetch()` call so headers / body / method actually apply.
- The wrapper closes the browser session at the end of every invocation so
  consecutive calls don't share state. Use `agent-browser` directly when
  you need persistent state across multiple actions.
- Cloudflare detection (Sub-AC 2.2) tags every result envelope with
  `cf_detection`. When `cf_detection.is_challenge` is True the wrapper
  automatically forwards the request to the container-local `cf-fetch-server`
  sidecar (Sub-AC 2.3) and reshapes its response into the same JSON
  envelope — only `backend` switches to `"cf-fetch-server"` and a
  `fallback` record is added.
- Tests:
  - CF detector — `python3 -m unittest test_cf_detect` (or
    `python3 cf_detect.py --self-test` for the built-in smoke test).
  - Sidecar client — `python3 -m unittest test_sidecar_client`
    (HTTP layer is stubbed via the `opener` injection point so the
    tests run with no network).
  - Orchestrator (Sub-AC 2.4) — `python3 -m unittest test_orchestrator`
    (every dependency — primary runner, sidecar runner, sidecar URL
    resolver, clock, sleep, log emitter — is injectable, so the suite
    runs with no agent-browser, no socket, and no real wall-clock
    waits). Run all three with
    `python3 -m unittest test_cf_detect test_sidecar_client test_orchestrator`.
