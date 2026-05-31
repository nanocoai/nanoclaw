#!/usr/bin/env python3
# pyright: reportImplicitRelativeImport=false
"""
web-fetch — container-side wrapper CLI for the NanoClaw agent.

Sub-AC 2.1: primary fetch path (drive agent-browser, return HTML / status /
            title / final URL).

Sub-AC 2.2: Cloudflare-challenge detection on the agent-browser result.
            After the primary path returns we run
            `cf_detect.detect_cloudflare_challenge(...)` against the
            envelope and tag the response with a `cf_detection` field
            so the wrapper can decide whether to fall back. The
            detector inspects status code, page title, body markers,
            and CF-set response headers (cf-ray / cf-mitigated /
            cf-chl-bypass / server:cloudflare). See
            `container/skills/web-fetch/cf_detect.py` for the full
            heuristic surface and the false-positive guard.

Sub-AC 2.3: Container-sidecar fallback. When `cf_detection.is_challenge`
            is True (or, opt-in via $CF_FALLBACK_ON_PRIMARY_FAILURE=1,
            when the primary path fails for any reason) the wrapper
            forwards the request to the container-local cf-fetch-server
            sidecar at http://127.0.0.1:8765/fetch. The
            sidecar's response is reshaped into the same envelope the
            primary path returns — only the `backend` field changes
            from "agent-browser" to "cf-fetch-server" and a `fallback`
            record is added with the diagnostic trail. The agent never
            has to choose between two runtimes.

Sub-AC 2.4 (this update): End-to-end orchestration. `main()` is now a
            thin shell over `orchestrator.run_fetch()`, which:
              * splits `--timeout` between the primary and sidecar
                tiers so a slow primary cannot starve the fallback;
              * retries the sidecar once on network-level failures
                (configurable via $WEB_FETCH_SIDECAR_RETRY);
              * emits structured JSON log lines to stderr (one per
                tier event — `fetch.start`, `primary.complete`,
                `fallback.decision`, `sidecar.complete`,
                `fetch.complete`) so operators can grep the
                decision trail without parsing prose;
              * catches any unexpected exception in either tier so
                the agent always sees a wrapper-shaped envelope on
                stdout (never a stack trace);
              * computes a unified exit code in one place regardless
                of which tier served the request.
            The LLM-facing argument surface is unchanged.

See:
  - `container/skills/web-fetch/orchestrator.py` for the state machine
    + timeout split + retry + logging policy.
  - `container/skills/web-fetch/sidecar_client.py` for the sidecar
    forwarder + envelope reshape.
  - `/opt/cf-fetch-server/server.py` for the sidecar's
    HTTP contract.

Invocation:
    python3 /home/node/.claude/skills/web-fetch/web_fetch.py <url> \
        [--method GET|POST|PUT|DELETE|PATCH|HEAD] \
        [--header "Key: Value"]... \
        [--body '<raw body>' | --body-file PATH] \
        [--timeout SECS] \
        [--output json|html|status]

Stdout (default --output=json):
    {
      "ok": <bool>,
      "backend": "agent-browser" | "cf-fetch-server",
      "status": <int|null>,
      "url": "<final url>",
      "title": "<page title>",
      "html": "<full document html>",
      "headers": {<lower-case header map>},
      "cf_detection": {
          "is_challenge": <bool>,        # true → fallback fired
          "confidence":   "high"|"medium"|"none",
          "signals":      [str, ...],    # which heuristics matched
          "reason":       "<one-line summary>"
      },
      // Only present when the sidecar fallback fired (Sub-AC 2.3):
      "fallback": {
          "fired":               true,
          "reason":              "<why fallback fired>",
          "sidecar_url":         "http://127.0.0.1:8765",
          "sidecar_backend":     "nodriver"|"stub"|"queue-full"|"unreachable",
          "sidecar_http_status": <int|null>,
          "primary_backend":     "agent-browser",
          "primary_status":      <int|null>,
          "primary_signals":     [str, ...]
      }
    }

Exit codes:
    0   success (either primary or sidecar fallback served the request)
    2   bad CLI usage
    3   both primary and (if applicable) sidecar failed unrecoverably
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Any

# Local import of the CF-challenge detector. Kept as a sibling module so
# the detection heuristics can be unit-tested without spinning up the
# whole CLI (and so install.sh's smoke-test step can exercise it via
# `python3 cf_detect.py --self-test`).
#
# Resolution order:
#   1. Relative import — works when web_fetch is loaded as part of a
#      package (e.g. pytest discovery using a conftest.py).
#   2. Sibling import — works when web_fetch.py is run directly as a
#      script: Python prepends the script's directory to sys.path.
#   3. Explicit sys.path patch — defensive fallback for unusual launch
#      contexts (zip apps, exec()'d strings, etc.).
try:
    from .cf_detect import detect_cloudflare_challenge  # type: ignore[import-not-found]
    from .sidecar_client import (  # type: ignore[import-not-found]
        fetch_via_sidecar,
        resolve_sidecar_url,
        should_fallback,
        SidecarUnavailable,
    )
    from .orchestrator import (  # type: ignore[import-not-found]
        ENV_LOG_LEVEL as _ORCH_ENV_LOG_LEVEL,
        ENV_LOG_QUIET as _ORCH_ENV_LOG_QUIET,
        EXIT_FETCH_FAILED as _ORCH_EXIT_FETCH_FAILED,
        EXIT_OK as _ORCH_EXIT_OK,
        Request as _OrchestratorRequest,
        run_fetch as _orchestrator_run,
    )
except (ImportError, ValueError):
    try:
        from cf_detect import detect_cloudflare_challenge  # type: ignore[no-redef]
        from sidecar_client import (  # type: ignore[no-redef]
            fetch_via_sidecar,
            resolve_sidecar_url,
            should_fallback,
            SidecarUnavailable,
        )
        from orchestrator import (  # type: ignore[no-redef]
            ENV_LOG_LEVEL as _ORCH_ENV_LOG_LEVEL,
            ENV_LOG_QUIET as _ORCH_ENV_LOG_QUIET,
            EXIT_FETCH_FAILED as _ORCH_EXIT_FETCH_FAILED,
            EXIT_OK as _ORCH_EXIT_OK,
            Request as _OrchestratorRequest,
            run_fetch as _orchestrator_run,
        )
    except ImportError:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from cf_detect import detect_cloudflare_challenge  # type: ignore[no-redef]
        from sidecar_client import (  # type: ignore[no-redef]
            fetch_via_sidecar,
            resolve_sidecar_url,
            should_fallback,
            SidecarUnavailable,
        )
        from orchestrator import (  # type: ignore[no-redef]
            ENV_LOG_LEVEL as _ORCH_ENV_LOG_LEVEL,
            ENV_LOG_QUIET as _ORCH_ENV_LOG_QUIET,
            EXIT_FETCH_FAILED as _ORCH_EXIT_FETCH_FAILED,
            EXIT_OK as _ORCH_EXIT_OK,
            Request as _OrchestratorRequest,
            run_fetch as _orchestrator_run,
        )

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Methods we support on the primary (agent-browser) path. GET is what the
# Seed actually requires ("Fetch-only — no interactive automation"); the
# other verbs are accepted because the LLM-facing wrapper has to look like
# a generic fetch CLI and silently fail with `ok=false` is more useful
# than rejecting the call upfront.
SUPPORTED_METHODS = {"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"}

# Default per-request budget. Picked to match cf-fetch-server's
# DEFAULT_TIMEOUT (30s); the Seed's latency budget is on the SIDECAR side
# (warm browser), the primary path is allowed to be slower because it goes
# through a fresh agent-browser session.
DEFAULT_TIMEOUT_S = 30.0

# Output formats the agent can request.
OUTPUT_JSON = "json"
OUTPUT_HTML = "html"
OUTPUT_STATUS = "status"
OUTPUT_FORMATS = {OUTPUT_JSON, OUTPUT_HTML, OUTPUT_STATUS}

# Backend label embedded in the JSON response so downstream skills can
# distinguish a primary-path response from a sidecar-fallback response.
# Sub-AC 2.3 adds the sidecar label below.
BACKEND_AGENT_BROWSER = "agent-browser"
# Sub-AC 2.3 — sidecar fallback envelope tag. Mirrors the constant in
# sidecar_client.BACKEND_SIDECAR (single source of truth lives there;
# we import the value rather than redefining so a rename is a one-line
# change in sidecar_client).
try:
    from sidecar_client import BACKEND_SIDECAR  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover — handled by the import block above
    from .sidecar_client import BACKEND_SIDECAR  # type: ignore[no-redef]

# Exit codes. These mirror the orchestrator's unified surface:
#   0 — either primary or sidecar fallback served the request.
#   2 — bad CLI usage (caught here, before the orchestrator runs).
#   3 — both primary and (if attempted) sidecar fallback failed.
# `EXIT_PRIMARY_FAILED` is preserved as a backwards-compatible alias —
# Sub-AC 2.3 used the name when only the primary tier could fail; with
# the orchestrator (Sub-AC 2.4) the same code now means "either tier
# failed". `EXIT_FETCH_FAILED` is the new, accurate name and is what
# new code should reference.
EXIT_OK = _ORCH_EXIT_OK
EXIT_USAGE = 2
EXIT_FETCH_FAILED = _ORCH_EXIT_FETCH_FAILED
EXIT_PRIMARY_FAILED = EXIT_FETCH_FAILED  # legacy alias


# ---------------------------------------------------------------------------
# CLI parsing
# ---------------------------------------------------------------------------


def _parse_args(argv: list[str]) -> argparse.Namespace:
    """Parse the wrapper's CLI surface.

    The shape mirrors `curl` deliberately so the LLM (or a human) can call
    it without thinking about which backend is running underneath. Future
    sub-ACs will not change this surface — only the resolution logic
    behind it.
    """
    p = argparse.ArgumentParser(
        prog="web-fetch",
        description=(
            "Container-side fetch wrapper. Drives agent-browser as the "
            "primary path and auto-falls-back to the container-local "
            "cf-fetch-server sidecar on Cloudflare challenges."
        ),
        # Keep argparse from grabbing -h / --help away from header values.
        add_help=True,
    )
    p.add_argument(
        "url",
        help="Absolute URL to fetch (must include scheme).",
    )
    p.add_argument(
        "--method",
        "-X",
        default="GET",
        help="HTTP method (default: GET).",
    )
    p.add_argument(
        "--header",
        "-H",
        action="append",
        default=[],
        metavar="'Key: Value'",
        help="Custom request header. Repeatable.",
    )
    body_group = p.add_mutually_exclusive_group()
    body_group.add_argument(
        "--body",
        "-d",
        default=None,
        help="Raw request body (use with non-GET methods).",
    )
    body_group.add_argument(
        "--body-file",
        default=None,
        help="Path to a file whose contents become the request body.",
    )
    p.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_S,
        help=f"Per-request timeout in seconds (default: {DEFAULT_TIMEOUT_S}).",
    )
    p.add_argument(
        "--output",
        "-o",
        choices=sorted(OUTPUT_FORMATS),
        default=OUTPUT_JSON,
        help="Output format (default: json).",
    )
    p.add_argument(
        "--agent-browser-bin",
        default=os.environ.get("AGENT_BROWSER_BIN", "agent-browser"),
        help=(
            "Path to the agent-browser CLI. Defaults to whatever is on PATH. "
            "Override via $AGENT_BROWSER_BIN for tests."
        ),
    )
    # Sub-AC 3: structured-log verbosity knobs.
    #
    # The wrapper's structured-log trail is **always on** at INFO level — every
    # request emits `fetch.start`, `primary.complete`, `fallback.decision`
    # (when fallback fires), `sidecar.start` / `sidecar.complete`, and
    # `fetch.complete` to stderr. Each event records the deciding fields the
    # AC mandates: per-attempt runtime (`elapsed_s`), the detected CF signal
    # (`cf_is_challenge` / `cf_signals` / `cf_confidence`), and the fallback
    # decision (`fallback.decision.fire` + `reason`). Verification can grep
    # the sequence from the default trail without flags.
    #
    # `--verbose` / `-v` raises the threshold to DEBUG, exposing the
    # per-attempt sidecar detail (`sidecar.attempt.start` /
    # `sidecar.attempt.end`) so an operator chasing a flaky retry can see
    # individual attempt outcomes without re-running with env vars.
    #
    # `--quiet` / `-q` mirrors `$WEB_FETCH_QUIET=1` so a caller piping the
    # JSON envelope into a parser can silence the orchestration log without
    # exporting an env var. Both flags simply rewrite the env handed to the
    # orchestrator; the underlying log-level vocabulary stays the same.
    p.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        default=False,
        help=(
            "Enable DEBUG-level structured logging on stderr "
            "(per-attempt sidecar detail). The always-on attempt trace at "
            "INFO is unaffected; this flag only adds detail."
        ),
    )
    p.add_argument(
        "--quiet",
        "-q",
        action="store_true",
        default=False,
        help=(
            "Silence the orchestration log on stderr. The response envelope "
            "on stdout is unaffected. Equivalent to $WEB_FETCH_QUIET=1. "
            "Mutually exclusive with --verbose at runtime — --verbose wins."
        ),
    )
    return p.parse_args(argv)


def _normalise_method(raw: str) -> str:
    m = (raw or "GET").strip().upper()
    if m not in SUPPORTED_METHODS:
        _die_usage(f"unsupported --method {raw!r}; supported: {sorted(SUPPORTED_METHODS)}")
    return m


def _parse_headers(raw_headers: list[str]) -> list[tuple[str, str]]:
    """Parse repeated --header 'K: V' values into [(K, V), ...].

    Whitespace around the colon is tolerated. Empty / malformed entries
    are rejected up front so the agent gets a clear usage error rather
    than a cryptic agent-browser failure later.
    """
    out: list[tuple[str, str]] = []
    for raw in raw_headers:
        if not raw or ":" not in raw:
            _die_usage(f"invalid --header value (expected 'Key: Value'): {raw!r}")
        k, _, v = raw.partition(":")
        k = k.strip()
        v = v.strip()
        if not k:
            _die_usage(f"invalid --header value (empty key): {raw!r}")
        out.append((k, v))
    return out


def _resolve_body(args: argparse.Namespace) -> str | None:
    """Resolve the request body from --body or --body-file."""
    if args.body is not None:
        return args.body
    if args.body_file:
        try:
            with open(args.body_file, "r", encoding="utf-8") as fh:
                return fh.read()
        except OSError as e:
            _die_usage(f"--body-file {args.body_file!r} unreadable: {e}")
    return None


def _die_usage(msg: str) -> None:
    print(f"web-fetch: {msg}", file=sys.stderr)
    sys.exit(EXIT_USAGE)


# ---------------------------------------------------------------------------
# Primary path: agent-browser
# ---------------------------------------------------------------------------


# Sub-AC 2.2.1 — one invocation of the agent-browser CLI.
#
# A single `web-fetch` request typically issues 2-4 agent-browser commands
# (open + eval(html) + get(title) + get(url) for the GET path; open(blank)
# + eval(fetch) for the non-GET path). Each shell-out has its own argv,
# exit code, stdout, and stderr — and the assembled "response body" of
# the user-visible request is itself the stdout (or post-decoded stdout)
# of one of those invocations.
#
# Sub-AC 2.2.1 mandates that we capture all four artefacts so downstream
# consumers — CF detection, the orchestrator's structured logger, an
# operator post-mortem, or future heuristics that want to look at
# stderr ("net::ERR_CERT_AUTHORITY_INVALID", "Proxy connection failed",
# etc.) — can inspect them without re-running the request.
#
# `response_body` is the per-invocation interpretation of stdout: it's
# the JSON-decoded eval return for `eval` calls (so the in-page fetch()'s
# response body surfaces as a string), and the raw stdout otherwise.
# Tracking it on the invocation (in addition to the assembled envelope's
# `html` field) makes per-step debugging possible.
@dataclass(frozen=True)
class _AgentBrowserInvocation:
    cli_args: tuple[str, ...]
    exit_code: int
    stdout: str
    stderr: str
    duration_s: float
    response_body: str = ""

    def to_dict(self) -> dict[str, Any]:
        """JSON-serialisable form for embedding in the envelope.

        Field ordering matches the dataclass for stable diff output;
        downstream consumers index by key, not position.
        """
        return {
            "cli_args": list(self.cli_args),
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "duration_s": self.duration_s,
            "response_body": self.response_body,
        }


# A small mutable accumulator threaded through the fetch helpers. Keeping
# it as a dataclass-with-list (rather than a bare list) means future
# fields (e.g. total agent-browser CPU time, redacted-arg counters) can
# be added without ripping up callers. The recorder is `None` outside of
# `_fetch_via_agent_browser` so unit tests of `_run_agent_browser` itself
# don't need to construct one.
@dataclass
class _AgentBrowserInvocationLog:
    invocations: list[_AgentBrowserInvocation] = field(default_factory=list)

    def record(self, inv: _AgentBrowserInvocation) -> _AgentBrowserInvocation:
        self.invocations.append(inv)
        return inv

    def to_list(self) -> list[dict[str, Any]]:
        return [inv.to_dict() for inv in self.invocations]


def _agent_browser_available(bin_path: str) -> bool:
    """Best-effort availability check.

    `which` works for a bare name on PATH; for an explicit path we just
    test executability. We accept either form so the wrapper still works
    inside a container where `agent-browser` is globally installed via
    `npm install -g agent-browser` (see container/Dockerfile).
    """
    if "/" in bin_path:
        return os.path.isfile(bin_path) and os.access(bin_path, os.X_OK)
    return shutil.which(bin_path) is not None


def _run_agent_browser(
    bin_path: str,
    cli_args: list[str],
    *,
    timeout: float,
    recorder: "_AgentBrowserInvocationLog | None" = None,
    response_body: str | None = None,
) -> _AgentBrowserInvocation:
    """Run an agent-browser subcommand and capture the full result.

    Sub-AC 2.2.1: this is the single shell-out primitive. It invokes
    agent-browser with the caller's argv (so the user's URL/options
    flow through verbatim) and captures:

      * `exit_code`     — the subprocess return code (or 124 on timeout,
                          127 on missing binary — synthesised so the
                          caller can branch uniformly).
      * `stdout`        — the captured stdout text (empty string on
                          missing-binary; partial stdout on timeout).
      * `stderr`        — the captured stderr text. On timeout we
                          synthesise a "agent-browser timed out…"
                          string here so debug output stays useful.
      * `duration_s`    — wall-clock time the invocation consumed
                          (helps pin down which sub-step blew the
                          timeout budget).
      * `response_body` — caller-supplied interpretation of stdout
                          (e.g. the JSON-decoded eval return). Defaults
                          to stdout itself; callers that strip eval-
                          quoting pass the decoded value.

    When a `recorder` is provided, the invocation is appended to it so
    `_fetch_via_agent_browser` can surface the full chain on the
    response envelope (`agent_browser_invocations`) for downstream
    inspection. Callers that don't pass a recorder (low-level tests)
    still receive the invocation object — they're free to ignore it.
    """
    started = time.time()
    try:
        proc = subprocess.run(
            [bin_path, *cli_args],
            input="",
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        partial_stdout = (e.stdout or "") if isinstance(e.stdout, str) else ""
        inv = _AgentBrowserInvocation(
            cli_args=tuple(cli_args),
            exit_code=124,
            stdout=partial_stdout,
            stderr=f"agent-browser timed out after {timeout}s",
            duration_s=round(time.time() - started, 3),
            response_body=(
                response_body if response_body is not None else partial_stdout
            ),
        )
        if recorder is not None:
            recorder.record(inv)
        return inv
    except FileNotFoundError as e:
        inv = _AgentBrowserInvocation(
            cli_args=tuple(cli_args),
            exit_code=127,
            stdout="",
            stderr=f"agent-browser binary not found: {e}",
            duration_s=round(time.time() - started, 3),
            response_body="" if response_body is None else response_body,
        )
        if recorder is not None:
            recorder.record(inv)
        return inv

    stdout = proc.stdout or ""
    stderr = proc.stderr or ""
    inv = _AgentBrowserInvocation(
        cli_args=tuple(cli_args),
        exit_code=proc.returncode,
        stdout=stdout,
        stderr=stderr,
        duration_s=round(time.time() - started, 3),
        response_body=stdout if response_body is None else response_body,
    )
    if recorder is not None:
        recorder.record(inv)
    return inv


def _fetch_via_agent_browser(
    *,
    bin_path: str,
    url: str,
    method: str,
    headers: list[tuple[str, str]],
    body: str | None,
    timeout: float,
) -> dict[str, Any]:
    """Drive agent-browser to fetch `url` and return a normalised result.

    The contract returned to the caller (and ultimately to the agent) is:
        {
          "ok": bool,
          "backend": "agent-browser",
          "status": int | None,
          "url": str,           # final URL after redirects (best effort)
          "title": str,         # document.title (best effort)
          "html": str,          # document.documentElement.outerHTML
          "headers": dict[str, str],
          "error": str | None,  # populated only when ok=false
          "elapsed_s": float,
        }

    Strategy:
      - GET: navigate via `agent-browser open <url>` so the browser
        handles redirects, cookies, and JS-based content. Then capture
        full HTML + title + final URL via `eval`.
      - Non-GET (POST/PUT/DELETE/PATCH/HEAD): we cannot 'navigate' with a
        non-GET verb, so we delegate to a same-origin `fetch()` from a
        pre-loaded blank page. This keeps the wrapper looking like a
        generic fetch CLI even though the underlying primary path is
        browser-based. Cloudflare-protected POST endpoints are out of
        scope for the primary path; Sub-AC 2.2/2.3 will divert those to
        the sidecar.

    On any subprocess failure we return ok=false with `error` set; we do
    NOT raise — the caller decides whether to fall back (Sub-AC 2.3) or
    surface the failure to the agent.
    """
    started = time.time()
    method_upper = method.upper()

    # Sub-AC 2.2.1: track every shell-out for downstream inspection.
    # The recorder is threaded into _fetch_get / _fetch_non_get and the
    # cleanup `close`, so the envelope can carry the full subprocess
    # trail (cli_args / exit_code / stdout / stderr / response_body)
    # alongside the assembled response.
    recorder = _AgentBrowserInvocationLog()

    # We pessimistically `close` at the end so a stuck browser from an
    # earlier invocation doesn't leak into the next request.
    def _close_quietly() -> None:
        _run_agent_browser(
            bin_path,
            ["close"],
            timeout=min(10.0, timeout),
            recorder=recorder,
        )

    try:
        if method_upper == "GET":
            result = _fetch_get(
                bin_path=bin_path,
                url=url,
                headers=headers,
                timeout=timeout,
                started=started,
                recorder=recorder,
            )
        else:
            result = _fetch_non_get(
                bin_path=bin_path,
                url=url,
                method=method_upper,
                headers=headers,
                body=body,
                timeout=timeout,
                started=started,
                recorder=recorder,
            )
        # Sub-AC 2.2: every primary-path envelope gets tagged with the
        # CF-detection signal so the next sub-AC's fallback can decide
        # without re-inspecting the body. Detection is best-effort —
        # never let a heuristic bug poison a successful primary fetch.
        try:
            result["cf_detection"] = detect_cloudflare_challenge(result)
        except Exception as e:  # pragma: no cover — defensive
            result["cf_detection"] = {
                "is_challenge": False,
                "confidence": "none",
                "signals": [],
                "reason": f"detector raised {e!r}",
            }
        return result
    finally:
        _close_quietly()
        # Always surface the invocation chain — even on the failure
        # path we want operators (and CF detection's future heuristics)
        # to see the raw subprocess artefacts.
        result_local = locals().get("result")
        if isinstance(result_local, dict):
            result_local["agent_browser_invocations"] = recorder.to_list()


def _fetch_get(
    *,
    bin_path: str,
    url: str,
    headers: list[tuple[str, str]],
    timeout: float,
    started: float,
    recorder: _AgentBrowserInvocationLog | None = None,
) -> dict[str, Any]:
    """Primary GET path: navigate then snapshot DOM."""
    # If the caller provided custom headers we set them as cookies/UA
    # where reasonable; arbitrary headers (Authorization, etc.) cannot
    # cleanly be applied to a top-level navigation in agent-browser, so
    # we fall back to a `fetch()` eval below in that case. This keeps
    # the simple GET case fast (no JS-fetch overhead) while still
    # honouring the LLM-supplied headers when needed.
    needs_eval_fetch = _headers_need_eval_fetch(headers)

    if needs_eval_fetch:
        # Use the non-GET path's fetch() machinery — same shape, just
        # with method=GET. This way custom Authorization/Cookie headers
        # are actually applied.
        return _fetch_non_get(
            bin_path=bin_path,
            url=url,
            method="GET",
            headers=headers,
            body=None,
            timeout=timeout,
            started=started,
            recorder=recorder,
        )

    open_inv = _run_agent_browser(
        bin_path,
        ["open", url],
        timeout=timeout,
        recorder=recorder,
    )
    if open_inv.exit_code != 0:
        return _fail(
            error=(
                f"agent-browser open failed (rc={open_inv.exit_code}): "
                f"{open_inv.stderr.strip() or 'no stderr'}"
            ),
            url=url,
            started=started,
        )

    html_inv = _run_agent_browser(
        bin_path,
        ["eval", "document.documentElement.outerHTML"],
        timeout=timeout,
        recorder=recorder,
    )
    # The recorder's stored invocation initially carries the raw
    # eval-quoted stdout as its response_body. Replace it with the
    # decoded HTML so the per-invocation view matches the assembled
    # envelope's `html` field — keeps downstream debugging consistent.
    decoded_html = _strip_eval_quotes(html_inv.stdout)
    if recorder is not None and recorder.invocations:
        recorder.invocations[-1] = _replace_response_body(
            recorder.invocations[-1], decoded_html
        )
    if html_inv.exit_code != 0:
        return _fail(
            error=(
                f"agent-browser eval(html) failed (rc={html_inv.exit_code}): "
                f"{html_inv.stderr.strip()}"
            ),
            url=url,
            started=started,
        )

    title_inv = _run_agent_browser(
        bin_path, ["get", "title"], timeout=min(10.0, timeout),
        recorder=recorder,
    )
    final_url_inv = _run_agent_browser(
        bin_path, ["get", "url"], timeout=min(10.0, timeout),
        recorder=recorder,
    )

    return {
        "ok": True,
        "backend": BACKEND_AGENT_BROWSER,
        # agent-browser does not surface the underlying HTTP status on
        # `open`. We mark status=200 on a successful navigation as the
        # informed default; Sub-AC 2.2's CF detection works off body /
        # title, not status, so this does not weaken the heuristic.
        "status": 200,
        "url": (
            final_url_inv.stdout.strip()
            if final_url_inv.exit_code == 0
            else url
        ),
        "title": (
            title_inv.stdout.strip() if title_inv.exit_code == 0 else ""
        ),
        "html": decoded_html,
        "headers": {},
        "error": None,
        "elapsed_s": round(time.time() - started, 3),
    }


def _replace_response_body(
    inv: _AgentBrowserInvocation, response_body: str
) -> _AgentBrowserInvocation:
    """Return a new invocation with `response_body` replaced.

    The dataclass is frozen for safety; this helper is the one place
    we mint a corrected copy after stdout post-processing (eval-quote
    stripping). Keeping it here rather than scattering object-replace
    logic at call sites keeps the freeze guarantee intact.
    """
    return _AgentBrowserInvocation(
        cli_args=inv.cli_args,
        exit_code=inv.exit_code,
        stdout=inv.stdout,
        stderr=inv.stderr,
        duration_s=inv.duration_s,
        response_body=response_body,
    )


def _fetch_non_get(
    *,
    bin_path: str,
    url: str,
    method: str,
    headers: list[tuple[str, str]],
    body: str | None,
    timeout: float,
    started: float,
    recorder: _AgentBrowserInvocationLog | None = None,
) -> dict[str, Any]:
    """Non-GET path (also reused for GET-with-custom-headers).

    Loads about:blank in agent-browser, then runs window.fetch() inside
    the page so the browser supplies cookies / TLS while honouring the
    LLM-supplied method, headers, and body. The response status, headers,
    and text are returned as a JSON blob via `eval`.

    This deliberately keeps the implementation primary-path-only — no
    Cloudflare-bypass logic lives here.
    """
    # Pre-navigate to the target's origin (about:blank works for cross-
    # origin too, but landing on the origin first lets cookies / state
    # apply). We use about:blank to keep the primary path's blast radius
    # minimal — Sub-AC 2.3 will not need to reuse this.
    open_inv = _run_agent_browser(
        bin_path,
        ["open", "about:blank"],
        timeout=min(15.0, timeout),
        recorder=recorder,
    )
    if open_inv.exit_code != 0:
        return _fail(
            error=(
                f"agent-browser open(about:blank) failed "
                f"(rc={open_inv.exit_code}): {open_inv.stderr.strip()}"
            ),
            url=url,
            started=started,
        )

    # Build the JS payload. JSON-encoding url/method/headers/body keeps
    # us safe from quote-injection inside the eval string.
    fetch_args = {
        "url": url,
        "method": method,
        "headers": {k: v for k, v in headers},
        "body": body,
    }
    js = (
        "(async () => {"
        "  const a = " + json.dumps(fetch_args) + ";"
        "  const init = { method: a.method, headers: a.headers, redirect: 'follow' };"
        "  if (a.body !== null && a.method !== 'GET' && a.method !== 'HEAD') {"
        "    init.body = a.body;"
        "  }"
        "  try {"
        "    const r = await fetch(a.url, init);"
        "    const text = a.method === 'HEAD' ? '' : await r.text();"
        "    const hdrs = {};"
        "    r.headers.forEach((v, k) => { hdrs[k.toLowerCase()] = v; });"
        "    return JSON.stringify({"
        "      ok: r.ok, status: r.status, url: r.url, headers: hdrs, body: text"
        "    });"
        "  } catch (e) {"
        "    return JSON.stringify({ ok: false, error: String(e) });"
        "  }"
        "})()"
    )

    fetch_inv = _run_agent_browser(
        bin_path, ["eval", js], timeout=timeout, recorder=recorder,
    )
    if fetch_inv.exit_code != 0:
        return _fail(
            error=(
                f"agent-browser eval(fetch) failed "
                f"(rc={fetch_inv.exit_code}): {fetch_inv.stderr.strip()}"
            ),
            url=url,
            started=started,
        )

    payload = _strip_eval_quotes(fetch_inv.stdout).strip()
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError as e:
        return _fail(
            error=f"agent-browser fetch returned non-JSON ({e}): {payload[:200]!r}",
            url=url,
            started=started,
        )

    if not parsed.get("ok") and "error" in parsed and "status" not in parsed:
        return _fail(
            error=f"in-page fetch() rejected: {parsed.get('error')}",
            url=url,
            started=started,
        )

    body_text = parsed.get("body") or ""

    # Patch the just-recorded invocation's response_body to be the
    # actual response body extracted from the in-page fetch() result,
    # not the JSON envelope that wraps it. This keeps the per-step
    # `response_body` aligned with the assembled envelope's `html`.
    if recorder is not None and recorder.invocations:
        recorder.invocations[-1] = _replace_response_body(
            recorder.invocations[-1], body_text
        )

    return {
        "ok": True,
        "backend": BACKEND_AGENT_BROWSER,
        "status": int(parsed.get("status") or 0) or None,
        "url": parsed.get("url") or url,
        "title": "",
        "html": body_text,
        "headers": parsed.get("headers") or {},
        "error": None,
        "elapsed_s": round(time.time() - started, 3),
    }


def _headers_need_eval_fetch(headers: list[tuple[str, str]]) -> bool:
    """Decide whether custom headers force the eval-based fetch path.

    Top-level navigation in a real browser cannot carry arbitrary request
    headers (Authorization, X-*, content-type, etc.); only User-Agent /
    Accept-Language / cookies can be coerced. To keep the wrapper honest
    we route any non-trivial header set through the in-page fetch() path.
    """
    if not headers:
        return False
    benign = {"user-agent", "accept-language"}
    for k, _ in headers:
        if k.lower() not in benign:
            return True
    return False


def _strip_eval_quotes(raw: str) -> str:
    """agent-browser's `eval` prints the JS return value with surrounding
    double-quotes when it's a string. We strip exactly one matched pair so
    JSON-decoding works regardless of the calling shell.
    """
    s = raw.rstrip("\n")
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        # The interior may contain backslash-escaped JSON; let json.loads
        # handle the unescaping — that's what agent-browser produces.
        try:
            return json.loads(s)
        except json.JSONDecodeError:
            return s[1:-1]
    return s


def _fail(*, error: str, url: str, started: float) -> dict[str, Any]:
    return {
        "ok": False,
        "backend": BACKEND_AGENT_BROWSER,
        "status": None,
        "url": url,
        "title": "",
        "html": "",
        "headers": {},
        "error": error,
        "elapsed_s": round(time.time() - started, 3),
        # Schema parity with the success path: a failed primary fetch
        # also carries a cf_detection field so downstream consumers
        # (Sub-AC 2.3) can read it unconditionally. We mark it as
        # "no signal" because there's no envelope to inspect.
        "cf_detection": {
            "is_challenge": False,
            "confidence": "none",
            "signals": [],
            "reason": "primary path failed before any response was captured",
        },
        # Sub-AC 2.2.1: schema parity for the invocation trail too.
        # `_fetch_via_agent_browser`'s finally-block will overwrite
        # this with the actual recorder.to_list() before the envelope
        # leaves the function — but if a caller invokes _fail in
        # isolation (low-level tests, defensive paths), they still
        # see a list-shaped field rather than a missing key.
        "agent_browser_invocations": [],
    }


# ---------------------------------------------------------------------------
# Output formatting
# ---------------------------------------------------------------------------


def _emit(result: dict[str, Any], output: str) -> None:
    if output == OUTPUT_JSON:
        print(json.dumps(result, ensure_ascii=False))
        return
    if output == OUTPUT_HTML:
        # Plain HTML on stdout. Errors still go to stderr so the agent
        # can pipe stdout straight into a parser.
        if not result.get("ok"):
            print(f"web-fetch: {result.get('error') or 'unknown failure'}", file=sys.stderr)
        sys.stdout.write(result.get("html") or "")
        if not (result.get("html") or "").endswith("\n"):
            sys.stdout.write("\n")
        return
    if output == OUTPUT_STATUS:
        status = result.get("status")
        print(status if status is not None else "")
        return


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _maybe_fall_back(
    *,
    primary_result: dict[str, Any],
    url: str,
    method: str,
    headers: list[tuple[str, str]],
    body: str | None,
    timeout: float,
) -> dict[str, Any]:
    """Sub-AC 2.3: decide & execute sidecar fallback.

    Decision logic lives in `sidecar_client.should_fallback`:
      - `cf_detection.is_challenge=True` ⇒ always fall back.
      - `$CF_FALLBACK_ON_PRIMARY_FAILURE=1` AND `ok=false` ⇒ fall back
        (off by default — keeps non-CF transient failures from
        silently routing through the proxy).

    Returns the fallback envelope when fallback fires, otherwise
    returns `primary_result` unchanged.

    The fallback envelope is re-tagged with `cf_detection` so the
    contract is uniform — an agent that branches on `cf_detection`
    sees the SAME shape whether the primary or the sidecar served the
    request. This is what lets the LLM call one command without
    knowing two runtimes exist.
    """
    fire, reason = should_fallback(primary_result)
    if not fire:
        return primary_result

    sidecar_url: str | None
    try:
        sidecar_url = resolve_sidecar_url()
    except SidecarUnavailable as e:
        # The env override is malformed. Surface the failure inside
        # the primary envelope so the agent can see why fallback was
        # supposed to fire but didn't — rather than silently swapping
        # backends behind its back.
        primary_result.setdefault("fallback", {
            "fired": False,
            "reason": reason,
            "error": f"sidecar URL invalid: {e}",
        })
        return primary_result

    fallback_env = fetch_via_sidecar(
        url=url,
        method=method,
        headers=headers,
        body=body,
        timeout=timeout,
        sidecar_url=sidecar_url,
        fallback_reason=reason,
        primary_result=primary_result,
    )
    # Re-run CF detection on the sidecar envelope so downstream code
    # doesn't have to special-case fallback envelopes. The detector is
    # pure / side-effect-free; failing-soft here mirrors the primary
    # path's detector wrap.
    try:
        fallback_env["cf_detection"] = detect_cloudflare_challenge(fallback_env)
    except Exception as e:  # pragma: no cover — defensive
        fallback_env["cf_detection"] = {
            "is_challenge": False,
            "confidence": "none",
            "signals": [],
            "reason": f"detector raised on fallback envelope: {e!r}",
        }
    return fallback_env


def _build_orchestrator_env(
    *,
    base_env: dict[str, str] | None = None,
    verbose: bool = False,
    quiet: bool = False,
) -> dict[str, str]:
    """Sub-AC 3 — translate the CLI's verbosity flags into the env the
    orchestrator's structured logger reads.

    The orchestrator already supports `WEB_FETCH_LOG_LEVEL` (one of
    `NONE` / `ERROR` / `WARNING` / `INFO` / `DEBUG`, default `INFO`)
    and `WEB_FETCH_QUIET=1` as a shortcut for level=NONE. We just need
    to set those keys based on `--verbose` / `--quiet` so the operator
    doesn't have to export an env var to bump verbosity for one call.

    Precedence:
      * `--verbose` wins over both `--quiet` AND any `WEB_FETCH_LOG_LEVEL`
        / `WEB_FETCH_QUIET` already in the env. The flag is the explicit
        per-call request; the env vars are persistent ambient state.
      * `--quiet` (without `--verbose`) overrides `WEB_FETCH_LOG_LEVEL`
        in the env.
      * Neither flag → the env passes through untouched, so a caller
        that already exported `WEB_FETCH_LOG_LEVEL=DEBUG` keeps that
        behaviour.

    Returns a NEW dict — we never mutate the caller's env in place.
    """
    env = dict(base_env if base_env is not None else os.environ)
    if verbose:
        # DEBUG exposes per-attempt sidecar detail
        # (`sidecar.attempt.start` / `sidecar.attempt.end`) on top of the
        # always-on attempt trace. Clear the QUIET shortcut so a
        # leftover `WEB_FETCH_QUIET=1` in the env doesn't clobber the
        # explicit per-call request.
        env[_ORCH_ENV_LOG_LEVEL] = "DEBUG"
        env.pop(_ORCH_ENV_LOG_QUIET, None)
    elif quiet:
        env[_ORCH_ENV_LOG_QUIET] = "1"
    return env


def _build_primary_runner(agent_browser_bin: str) -> Any:
    """Build the `(req, primary_timeout) -> envelope` callable the
    orchestrator calls into.

    Wraps the existing `_fetch_via_agent_browser` machinery so the
    orchestrator does NOT need to know about agent-browser binaries,
    PATH lookups, or the missing-binary case. Each of those concerns
    lives here; the orchestrator just sees a request → envelope
    function that never raises.
    """
    def _runner(req: _OrchestratorRequest, primary_budget: float) -> dict[str, Any]:
        if not _agent_browser_available(agent_browser_bin):
            # Surface as a structured _fail envelope so the orchestrator
            # can route it through should_fallback() like any other
            # primary-path failure. CF signals will be absent (there's
            # no body to inspect) so by default the sidecar will NOT
            # fire — operators who want it to fire on missing
            # agent-browser opt in via $CF_FALLBACK_ON_PRIMARY_FAILURE=1.
            return _fail(
                error=(
                    f"agent-browser binary {agent_browser_bin!r} not found on PATH; "
                    "primary fetch path unavailable."
                ),
                url=req.url,
                started=time.time(),
            )
        return _fetch_via_agent_browser(
            bin_path=agent_browser_bin,
            url=req.url,
            method=req.method,
            headers=list(req.headers),
            body=req.body,
            timeout=primary_budget,
        )
    return _runner


def main(argv: list[str] | None = None) -> int:
    """Thin CLI shell over `orchestrator.run_fetch`.

    Sub-AC 2.4: the entire decision flow (timeout split, retry policy,
    fallback decision, structured logging, exception safety, exit code
    mapping) lives in `orchestrator.run_fetch`. This function just:

      1. Parses argv (fail with EXIT_USAGE on bad input).
      2. Builds a primary-path runner closure over agent-browser.
      3. Hands a Request + the runner to the orchestrator.
      4. Emits the orchestrator's envelope in the requested format.
      5. Returns the orchestrator's unified exit code.

    Any unexpected exception during orchestration becomes a structured
    `ok=false` envelope on stdout — the agent never sees a stack trace.
    """
    args = _parse_args(argv if argv is not None else sys.argv[1:])

    method = _normalise_method(args.method)
    headers = _parse_headers(args.header)
    body = _resolve_body(args)

    request = _OrchestratorRequest(
        url=args.url,
        method=method,
        headers=tuple(headers),
        body=body,
        timeout=float(args.timeout),
        output=args.output,
    )

    primary_runner = _build_primary_runner(args.agent_browser_bin)

    # Sub-AC 3: translate `--verbose` / `--quiet` into the orchestrator's
    # log-level env. The always-on attempt trace at INFO already records
    # each attempt's runtime (`elapsed_s`), the detected CF signal
    # (`cf_is_challenge` / `cf_signals` / `cf_confidence`), and the
    # fallback decision (`fallback.decision.fire` + `reason`). `--verbose`
    # promotes the threshold to DEBUG so the per-attempt sidecar detail
    # (`sidecar.attempt.start` / `sidecar.attempt.end`) becomes visible
    # without requiring an env-var export.
    orchestrator_env = _build_orchestrator_env(
        verbose=bool(getattr(args, "verbose", False)),
        quiet=bool(getattr(args, "quiet", False)),
    )

    try:
        outcome = _orchestrator_run(
            request,
            primary_runner=primary_runner,
            env=orchestrator_env,
        )
    except Exception as e:
        # Defence-in-depth: the orchestrator already swallows tier
        # exceptions, but if its top-level state machine itself
        # raises (e.g. a misconfigured env value bypasses validation)
        # we still owe the agent a JSON envelope on stdout instead of
        # a Python traceback.
        envelope = {
            "ok": False,
            "backend": BACKEND_AGENT_BROWSER,
            "status": None,
            "url": args.url,
            "title": "",
            "html": "",
            "headers": {},
            "error": f"orchestrator failed: {e}",
            "elapsed_s": 0.0,
            "cf_detection": {
                "is_challenge": False,
                "confidence": "none",
                "signals": [],
                "reason": "orchestrator raised before any tier ran",
            },
            # Sub-AC 2.2.1: schema parity. No primary tier ran, so
            # there is no invocation trail — but the field is present
            # so downstream parsers that key into it unconditionally
            # don't need to special-case the catastrophic-failure
            # envelope.
            "agent_browser_invocations": [],
        }
        _emit(envelope, args.output)
        print(f"web-fetch: orchestrator failed: {e}", file=sys.stderr)
        return EXIT_FETCH_FAILED

    _emit(outcome.envelope, args.output)
    return outcome.exit_code


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
