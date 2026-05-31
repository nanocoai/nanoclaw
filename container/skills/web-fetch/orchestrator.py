#!/usr/bin/env python3
# pyright: reportImplicitRelativeImport=false, reportArgumentType=false, reportFunctionMemberAccess=false
"""
orchestrator — end-to-end runtime glue for the web-fetch wrapper (Sub-AC 2.4).

Sub-AC 2.1 gave us a primary-path agent-browser fetch.
Sub-AC 2.2 added Cloudflare-challenge detection on the primary envelope.
Sub-AC 2.3 added the container-sidecar fallback (cf-fetch-server).

This module is the polish layer that wires them together with the policy
the LLM-facing CLI is supposed to expose:

  * **End-to-end orchestration** — one entry point (`run_fetch`) takes a
    Request, runs the right tier(s), and returns a single envelope plus
    a unified exit code. The CLI (`web_fetch.main`) is now a thin shell
    around it; tests can drive the full state machine without the CLI.

  * **Error handling** — every code path that can raise is wrapped so
    the agent always gets a wrapper-shaped envelope with `ok` and
    `error` set, and never a Python stack trace. Bad CLI usage is the
    only condition that exits non-zero with stderr text.

  * **Timeouts** — the CLI's `--timeout` is treated as a *total* budget.
    The orchestrator splits it between tiers so a slow primary cannot
    starve the sidecar. The split is configurable via env (defaults
    keep behaviour close to the previous "full timeout per tier" so
    existing tests don't regress on latency tolerance).

  * **Retry / fallback policy** — when the sidecar is the active tier
    and the network round-trip itself fails (connection refused, DNS
    failure, socket timeout — i.e. `SidecarUnavailable`), retry once
    after a short wait, but only if the remaining budget can absorb it.
    HTTP-level errors (4xx/5xx) are NOT retried because the sidecar's
    structured error body is already useful to the agent. Operators
    can turn the retry off with `WEB_FETCH_SIDECAR_RETRY=0` for tests
    that want a single shot.

  * **Structured logging** — every decision lands as a single JSON line
    on stderr (`{ts, level, event, ...}`). The agent's stdout stays
    pristine for the response envelope, so a downstream parser can read
    stdout straight while operators tail stderr for the trail. Log
    level is `WEB_FETCH_LOG_LEVEL` (default `INFO`); set it to `NONE`
    to silence the orchestrator entirely. The `fetch.complete` event
    always carries a `tier` field (`"primary"`, `"sidecar"`, or
    `"sidecar-failed"`) so operators can grep a single line per request
    to see which runtime served it.

  * **Debug opt-out** — `WEB_FETCH_DISABLE_FALLBACK=1` (also accepts
    `true`, `yes`, `on`) short-circuits the sidecar tier even when
    `cf_detection.is_challenge=True`. Useful when an operator wants to
    reproduce a primary-path bug in isolation, or confirm a CF-tagged
    page is actually a CF page — the primary envelope is returned
    untouched, with its `cf_detection` field still set so the detector's
    verdict is visible. The orchestrator emits a single
    `fallback.skipped.opt_out` event so the decision is visible in the
    structured log. The opt-out NEVER changes the envelope shape or the
    exit-code policy — it is a debugging convenience, not a runtime
    mode-switch.

  * **Unified exit codes** — `EXIT_OK=0` if either tier returned a
    usable response. `EXIT_USAGE=2` is reserved for the CLI parser.
    `EXIT_FETCH_FAILED=3` when both the primary and (if attempted) the
    sidecar produced `ok=False`. The exit code is computed once, in
    one place, regardless of which tier fired.

The module is deliberately injectable: `run_fetch` accepts callables for
the primary fetcher, the sidecar fetcher, the clock, and the log emitter
so the unit tests don't need agent-browser, the sidecar, or stderr.

Public surface:

    Request                          — frozen request descriptor
    Outcome                          — (envelope, exit_code, log_records)
    EXIT_OK / EXIT_USAGE /
        EXIT_FETCH_FAILED            — unified exit code constants
    DEFAULT_PRIMARY_TIMEOUT_PCT      — default 0.6 (60% of budget for primary)
    DEFAULT_PRIMARY_TIMEOUT_MIN_S    — primary tier never gets less than this
    DEFAULT_SIDECAR_TIMEOUT_MIN_S    — sidecar tier never gets less than this
    DEFAULT_SIDECAR_RETRY_DELAY_S    — wait between sidecar retries
    run_fetch(req, *, primary_runner=None, sidecar_runner=None,
              clock=None, log=None, env=None) -> Outcome
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

# Sibling imports follow the same dance as web_fetch.py — relative when
# loaded as a package, sibling-fallback when run as a script. Keeping
# the orchestrator package-loadable lets the unit tests import it without
# the CLI being on PATH.
try:
    from .sidecar_client import (  # type: ignore[import-not-found]
        BACKEND_SIDECAR,
        SidecarUnavailable,
        fetch_via_sidecar,
        resolve_sidecar_url,
        should_fallback,
    )
    from .cf_detect import detect_cloudflare_challenge  # type: ignore[import-not-found]
except (ImportError, ValueError):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from sidecar_client import (  # type: ignore[no-redef]
        BACKEND_SIDECAR,
        SidecarUnavailable,
        fetch_via_sidecar,
        resolve_sidecar_url,
        should_fallback,
    )
    from cf_detect import detect_cloudflare_challenge  # type: ignore[no-redef]


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_FETCH_FAILED = 3

# Default split between primary and sidecar tiers when the CLI passes a
# single `--timeout`. The number is chosen so a slow primary path can't
# starve the sidecar fallback: even with a 30s total budget, the sidecar
# is guaranteed at least DEFAULT_SIDECAR_TIMEOUT_MIN_S to do its job.
DEFAULT_PRIMARY_TIMEOUT_PCT = 0.6

# Floors so very small total budgets still give each tier room to do
# something useful. The Seed's "first request after sidecar boot under
# 5s" budget shapes the sidecar floor.
DEFAULT_PRIMARY_TIMEOUT_MIN_S = 5.0
DEFAULT_SIDECAR_TIMEOUT_MIN_S = 5.0

DEFAULT_SIDECAR_RETRY_COUNT = 1
DEFAULT_SIDECAR_RETRY_DELAY_S = 1.0

# Env var names the operator can use to tune the orchestrator without
# editing the wrapper.
ENV_PRIMARY_TIMEOUT_PCT = "WEB_FETCH_PRIMARY_TIMEOUT_PCT"
ENV_PRIMARY_TIMEOUT_MIN = "WEB_FETCH_PRIMARY_TIMEOUT_MIN_S"
ENV_SIDECAR_TIMEOUT_MIN = "WEB_FETCH_SIDECAR_TIMEOUT_MIN_S"
ENV_SIDECAR_RETRY_COUNT = "WEB_FETCH_SIDECAR_RETRY"
ENV_SIDECAR_RETRY_DELAY = "WEB_FETCH_SIDECAR_RETRY_DELAY_S"
ENV_LOG_LEVEL = "WEB_FETCH_LOG_LEVEL"
ENV_LOG_QUIET = "WEB_FETCH_QUIET"

# Debug opt-out (Sub-AC 2.2.4). When set to a truthy value the orchestrator
# skips the sidecar tier entirely, returning the primary envelope as-is
# even when `cf_detection.is_challenge=True`. This is intentionally a
# DEBUG affordance — the production agent path always benefits from
# auto-fallback. Operators reach for it when they want to reproduce a
# primary-path bug without the sidecar masking it, or to confirm a
# CF-tagged page actually is a CF page (the primary envelope still
# carries `cf_detection`, so the detector's verdict is visible). The
# opt-out NEVER changes the envelope schema and NEVER changes the
# exit-code policy — `EXIT_OK` if the primary returned `ok=True`,
# `EXIT_FETCH_FAILED` otherwise.
ENV_DISABLE_FALLBACK = "WEB_FETCH_DISABLE_FALLBACK"

# Truthy strings recognised by `_is_truthy_env`. We accept several so
# operators don't have to remember which form the wrapper expects.
_TRUTHY_ENV_VALUES = frozenset({"1", "true", "yes", "on"})

# Log level ordering. NONE silences output; DEBUG is the chattiest.
_LEVEL_ORDER = {"NONE": 100, "ERROR": 40, "WARNING": 30, "INFO": 20, "DEBUG": 10}
_DEFAULT_LEVEL = "INFO"


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Request:
    """Immutable description of one fetch request.

    The CLI parses argv into a Request; tests construct one directly.
    Keeping it frozen makes accidental mutation between tiers impossible
    — important because the same headers/body are forwarded to whichever
    tier fires.
    """
    url: str
    method: str = "GET"
    headers: tuple[tuple[str, str], ...] = ()
    body: Optional[str] = None
    timeout: float = 30.0
    # Output format only matters at emit time, but we carry it through
    # so a single Outcome can be rendered in any of the three formats
    # without reparsing argv.
    output: str = "json"


@dataclass
class Outcome:
    """What `run_fetch` returns.

    `envelope` is the wrapper-shaped JSON-ready dict the CLI prints.
    `exit_code` is the unified status the CLI hands to the OS.
    `log_records` is the in-memory log buffer (empty when stderr logging
    is enabled — populated only when callers inject a capturing emitter,
    so tests can assert on it without parsing stderr).
    """
    envelope: dict[str, Any]
    exit_code: int
    log_records: list[dict[str, Any]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Structured logging
# ---------------------------------------------------------------------------


def _is_truthy_env(raw: str | None) -> bool:
    """Return True iff `raw` is one of the recognised truthy env values.

    Used by the debug opt-out (`WEB_FETCH_DISABLE_FALLBACK`) and by any
    future boolean-shaped env knob. Centralising the parser keeps the
    accepted vocabulary consistent across the wrapper.
    """
    if raw is None:
        return False
    return raw.strip().lower() in _TRUTHY_ENV_VALUES


def _resolve_level(env: dict[str, str]) -> str:
    if (env.get(ENV_LOG_QUIET) or "").strip() in ("1", "true", "yes"):
        return "NONE"
    raw = (env.get(ENV_LOG_LEVEL) or "").strip().upper()
    if raw in _LEVEL_ORDER:
        return raw
    return _DEFAULT_LEVEL


def make_stderr_logger(env: dict[str, str] | None = None) -> Callable[..., None]:
    """Build a logger that writes one JSON line per event to stderr.

    Stderr (not stdout) so the agent can pipe stdout straight into a
    JSON parser. The logger is `(level, event, **fields)` — events have
    short stable names so a future `jq` recipe can grep them.
    """
    level_name = _resolve_level(env if env is not None else os.environ)
    threshold = _LEVEL_ORDER[level_name]

    def _emit(level: str, event: str, **fields: Any) -> None:
        if _LEVEL_ORDER.get(level, 100) < threshold:
            return
        record = {
            "ts": _now_iso(),
            "level": level,
            "component": "web-fetch",
            "event": event,
            **fields,
        }
        try:
            line = json.dumps(record, ensure_ascii=False, default=str)
        except Exception:
            # Last resort: a malformed field shouldn't take down the
            # wrapper. Drop the offending fields and re-emit a minimal
            # record so operators still see the event.
            line = json.dumps({
                "ts": record["ts"],
                "level": level,
                "component": "web-fetch",
                "event": event,
                "log_emit_error": "fields not JSON-serialisable",
            }, ensure_ascii=False)
        try:
            print(line, file=sys.stderr, flush=True)
        except Exception:
            # Even stderr can be closed mid-run (e.g. the parent has
            # already torn down). Swallow rather than raise into the
            # orchestrator.
            pass

    return _emit


def make_capture_logger() -> tuple[Callable[..., None], list[dict[str, Any]]]:
    """Build an in-memory logger for tests.

    Returns (emit, records) where `records` is the list the emitter
    appends to. Same `(level, event, **fields)` signature as the
    stderr logger so `run_fetch` doesn't care which one is wired.

    The returned emit function carries a `_capture_records` attribute
    pointing at the same list, which `run_fetch` notices so the buffer
    can be surfaced on `Outcome.log_records` without the test having
    to pass it twice.
    """
    records: list[dict[str, Any]] = []

    def _emit(level: str, event: str, **fields: Any) -> None:
        records.append({
            "ts": _now_iso(),
            "level": level,
            "component": "web-fetch",
            "event": event,
            **fields,
        })

    _emit._capture_records = records  # type: ignore[attr-defined]
    return _emit, records


def _now_iso() -> str:
    # ISO-8601 UTC, second precision is enough for log correlation.
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ---------------------------------------------------------------------------
# Timeout split policy
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TimeoutPolicy:
    primary_pct: float
    primary_min_s: float
    sidecar_min_s: float

    @classmethod
    def from_env(cls, env: dict[str, str]) -> "TimeoutPolicy":
        return cls(
            primary_pct=_parse_float(env.get(ENV_PRIMARY_TIMEOUT_PCT),
                                     DEFAULT_PRIMARY_TIMEOUT_PCT,
                                     lo=0.05, hi=0.95),
            primary_min_s=_parse_float(env.get(ENV_PRIMARY_TIMEOUT_MIN),
                                        DEFAULT_PRIMARY_TIMEOUT_MIN_S,
                                        lo=0.5, hi=600.0),
            sidecar_min_s=_parse_float(env.get(ENV_SIDECAR_TIMEOUT_MIN),
                                        DEFAULT_SIDECAR_TIMEOUT_MIN_S,
                                        lo=0.5, hi=600.0),
        )

    def primary_budget(self, total: float) -> float:
        """Time we let the primary tier consume."""
        return max(self.primary_min_s, total * self.primary_pct)

    def sidecar_budget(self, total: float, primary_elapsed: float) -> float:
        """Time we hand to the sidecar tier.

        We honour the floor (`sidecar_min_s`) even when the primary blew
        past the budget — a budget-exhausted CF-blocked primary should
        still be able to fall back, just at the floor. This trades a
        tiny over-budget risk for a much more useful fallback path.
        """
        remaining = total - primary_elapsed
        return max(self.sidecar_min_s, remaining)


def _parse_float(raw: str | None, default: float, *,
                 lo: float = 0.0, hi: float = 1e9) -> float:
    if raw is None:
        return default
    try:
        v = float(raw.strip())
    except (TypeError, ValueError, AttributeError):
        return default
    if v < lo or v > hi:
        return default
    return v


def _parse_int(raw: str | None, default: int, *,
               lo: int = 0, hi: int = 100) -> int:
    if raw is None:
        return default
    try:
        v = int(str(raw).strip())
    except (TypeError, ValueError):
        return default
    if v < lo or v > hi:
        return default
    return v


# ---------------------------------------------------------------------------
# Sidecar runner with retry policy
# ---------------------------------------------------------------------------


def _sidecar_runner_with_retry(
    *,
    req: Request,
    sidecar_url: str,
    fallback_reason: str,
    primary_envelope: dict[str, Any],
    timeout: float,
    retry_count: int,
    retry_delay: float,
    sleep: Callable[[float], None],
    clock: Callable[[], float],
    log: Callable[..., None],
    sidecar_fn: Callable[..., dict[str, Any]],
) -> dict[str, Any]:
    """Call the sidecar, retrying once on `SidecarUnavailable`-shaped failures.

    The injected `sidecar_fn` is normally `sidecar_client.fetch_via_sidecar`
    but tests pass a stub. We detect "unreachable" by inspecting the
    returned envelope (`fallback.sidecar_backend == "unreachable"`)
    rather than catching exceptions, because `fetch_via_sidecar` already
    converts SidecarUnavailable into an unreachable envelope before
    returning. Treating the envelope as the source of truth keeps the
    orchestrator decoupled from sidecar_client's internals.

    `clock` is the same injectable wall-clock the orchestrator uses
    elsewhere — passing it through here lets tests simulate a slow
    first attempt and assert the budget-exhausted retry guard fires.
    """
    attempts_made = 0
    last_envelope: dict[str, Any] | None = None
    started_total = clock()

    # `retry_count` is the number of *additional* attempts after the first.
    # So total tries = retry_count + 1.
    for attempt in range(retry_count + 1):
        attempts_made = attempt + 1
        attempt_started = clock()
        log("DEBUG", "sidecar.attempt.start",
            attempt=attempts_made, max_attempts=retry_count + 1,
            timeout=timeout, sidecar_url=sidecar_url)
        env = sidecar_fn(
            url=req.url,
            method=req.method,
            headers=list(req.headers),
            body=req.body,
            timeout=timeout,
            sidecar_url=sidecar_url,
            fallback_reason=fallback_reason,
            primary_result=primary_envelope,
        )
        last_envelope = env
        elapsed = round(clock() - attempt_started, 3)
        sidecar_backend = ((env.get("fallback") or {}).get("sidecar_backend") or "")
        ok = bool(env.get("ok"))
        log("DEBUG", "sidecar.attempt.end",
            attempt=attempts_made, ok=ok,
            sidecar_backend=sidecar_backend,
            sidecar_http_status=(env.get("fallback") or {}).get("sidecar_http_status"),
            elapsed_s=elapsed)

        # Retry only on network-level unreachable. A 503 queue-full or a
        # 200/ok=false from the sidecar already carries useful diagnostic
        # info — retrying would just double the latency without changing
        # the outcome.
        if sidecar_backend != "unreachable" or attempt >= retry_count:
            break

        # Don't retry if the budget can't absorb it.
        elapsed_total = clock() - started_total
        if elapsed_total + retry_delay >= timeout:
            log("WARNING", "sidecar.retry.skip.budget_exhausted",
                attempts_made=attempts_made,
                elapsed_s=round(elapsed_total, 3),
                budget_s=timeout)
            break

        log("INFO", "sidecar.retry.scheduled",
            attempt=attempts_made,
            delay_s=retry_delay,
            reason=env.get("error") or "unreachable")
        try:
            sleep(retry_delay)
        except Exception:
            # Defensive: a broken sleep shouldn't break the orchestrator.
            pass

    # Tag the envelope with the final attempt count so downstream parsers
    # (and operators reading logs) can see whether a retry fired.
    if last_envelope is not None:
        fb = last_envelope.setdefault("fallback", {})
        fb["sidecar_attempts"] = attempts_made
    return last_envelope or _synthetic_unreachable_envelope(
        req=req, sidecar_url=sidecar_url,
        fallback_reason=fallback_reason,
        error="sidecar_runner produced no envelope",
        primary_envelope=primary_envelope,
    )


def _synthetic_unreachable_envelope(
    *,
    req: Request,
    sidecar_url: str,
    fallback_reason: str,
    error: str,
    primary_envelope: dict[str, Any],
) -> dict[str, Any]:
    """Worst-case-only fallback. `fetch_via_sidecar` already builds an
    unreachable envelope on its own; we only land here if a stub
    sidecar_fn returns None (defensive — happens in tests).
    """
    primary_cf = primary_envelope.get("cf_detection") or {}
    return {
        "ok": False,
        "backend": BACKEND_SIDECAR,
        "status": None,
        "url": req.url,
        "title": "",
        "html": "",
        "headers": {},
        "error": error,
        "elapsed_s": 0.0,
        "fallback": {
            "fired": True,
            "reason": fallback_reason,
            "sidecar_url": sidecar_url,
            "sidecar_backend": "unreachable",
            "sidecar_http_status": None,
            "primary_backend": primary_envelope.get("backend"),
            "primary_status": primary_envelope.get("status"),
            "primary_signals": list(primary_cf.get("signals") or []),
            "method_downgraded_to_get": req.method.upper() != "GET",
            "body_dropped": bool(req.body) and req.method.upper() != "GET",
            "sidecar_attempts": 0,
        },
    }


# ---------------------------------------------------------------------------
# Top-level orchestration
# ---------------------------------------------------------------------------


def run_fetch(
    req: Request,
    *,
    primary_runner: Callable[[Request, float], dict[str, Any]],
    sidecar_runner: Callable[..., dict[str, Any]] | None = None,
    sidecar_url_resolver: Callable[[], str] | None = None,
    clock: Callable[[], float] | None = None,
    sleep: Callable[[float], None] | None = None,
    log: Callable[..., None] | None = None,
    env: dict[str, str] | None = None,
) -> Outcome:
    """End-to-end fetch orchestration.

    Args:
      req: the parsed request.
      primary_runner: callable `(req, primary_timeout) -> envelope`. Must
        return a wrapper-shaped envelope (the `_fetch_via_agent_browser`
        contract). Exceptions are caught and converted to ok=false
        envelopes so the agent never sees a stack trace.
      sidecar_runner: callable matching `sidecar_client.fetch_via_sidecar`.
        Defaults to the real one; tests inject a stub.
      sidecar_url_resolver: callable producing the sidecar's base URL.
        Defaults to `sidecar_client.resolve_sidecar_url`.
      clock: returns a monotonic wall-clock float (default `time.time`).
      sleep: blocks for N seconds (default `time.sleep`).
      log: structured-log emitter (default writes to stderr).
      env: env-var dict (default `os.environ`).

    Returns:
      Outcome(envelope, exit_code, log_records). The envelope is what
      gets emitted to stdout; exit_code is what the CLI hands to the OS.
    """
    env = env if env is not None else dict(os.environ)
    log = log or make_stderr_logger(env)
    clock = clock or time.time
    sleep = sleep or time.sleep
    sidecar_runner = sidecar_runner or fetch_via_sidecar
    sidecar_url_resolver = sidecar_url_resolver or resolve_sidecar_url

    log_records: list[dict[str, Any]] = []
    if hasattr(log, "_capture_records"):
        # Convenience for tests using make_capture_logger — let the
        # Outcome surface them directly.
        log_records = log._capture_records  # type: ignore[attr-defined]

    policy = TimeoutPolicy.from_env(env)
    total_budget = max(0.5, float(req.timeout))
    primary_budget = min(total_budget, policy.primary_budget(total_budget))

    log("INFO", "fetch.start",
        url=req.url, method=req.method,
        timeout=total_budget,
        primary_budget=round(primary_budget, 3),
        primary_pct=policy.primary_pct,
        output=req.output)

    # ----- Tier 1: primary path ---------------------------------------------
    primary_started = clock()
    primary_envelope = _safe_run_primary(
        primary_runner=primary_runner, req=req,
        primary_budget=primary_budget, log=log,
    )
    primary_elapsed = clock() - primary_started

    # The primary runner is responsible for tagging cf_detection, but
    # belt-and-braces: re-run the detector if it's missing or malformed
    # so should_fallback() never sees a None.
    cf = primary_envelope.get("cf_detection")
    if not isinstance(cf, dict):
        try:
            primary_envelope["cf_detection"] = detect_cloudflare_challenge(primary_envelope)
        except Exception as e:
            primary_envelope["cf_detection"] = {
                "is_challenge": False, "confidence": "none",
                "signals": [],
                "reason": f"detector raised in orchestrator: {e!r}",
            }

    log("INFO", "primary.complete",
        ok=bool(primary_envelope.get("ok")),
        status=primary_envelope.get("status"),
        backend=primary_envelope.get("backend"),
        elapsed_s=round(primary_elapsed, 3),
        cf_is_challenge=bool(primary_envelope["cf_detection"].get("is_challenge")),
        cf_confidence=primary_envelope["cf_detection"].get("confidence"),
        cf_signals=primary_envelope["cf_detection"].get("signals") or [])

    # ----- Sub-AC 2.2.4: debug opt-out --------------------------------------
    # The opt-out is checked BEFORE should_fallback() so an operator can
    # debug the primary path in isolation even when the CF detector would
    # otherwise have triggered a fallback. We still emit a structured log
    # event so the decision shows up in the same trail operators are
    # already tailing — silent debug knobs are a debugging anti-pattern.
    if _is_truthy_env(env.get(ENV_DISABLE_FALLBACK)):
        cf_is_challenge = bool(primary_envelope["cf_detection"].get("is_challenge"))
        log("WARNING", "fallback.skipped.opt_out",
            env_var=ENV_DISABLE_FALLBACK,
            value=env.get(ENV_DISABLE_FALLBACK),
            cf_is_challenge=cf_is_challenge,
            cf_signals=primary_envelope["cf_detection"].get("signals") or [],
            note=("operator opted out of sidecar fallback for debugging; "
                  "primary envelope returned as-is"))
        exit_code = EXIT_OK if primary_envelope.get("ok") else EXIT_FETCH_FAILED
        log("INFO", "fetch.complete",
            tier="primary",
            ok=bool(primary_envelope.get("ok")),
            exit_code=exit_code,
            elapsed_s=round(primary_elapsed, 3),
            decision=f"fallback disabled by ${ENV_DISABLE_FALLBACK}",
            served_by=primary_envelope.get("backend") or "agent-browser")
        return Outcome(envelope=primary_envelope, exit_code=exit_code,
                       log_records=log_records)

    # ----- Tier 2 decision: should_fallback() -------------------------------
    fire, reason = should_fallback(primary_envelope, env=env)
    if not fire:
        exit_code = EXIT_OK if primary_envelope.get("ok") else EXIT_FETCH_FAILED
        log("INFO", "fetch.complete",
            tier="primary",
            ok=bool(primary_envelope.get("ok")),
            exit_code=exit_code,
            elapsed_s=round(primary_elapsed, 3),
            decision=reason,
            served_by=primary_envelope.get("backend") or "agent-browser")
        return Outcome(envelope=primary_envelope, exit_code=exit_code,
                       log_records=log_records)

    log("INFO", "fallback.decision",
        fire=True, reason=reason,
        primary_signals=primary_envelope["cf_detection"].get("signals") or [])

    # ----- Tier 2: sidecar fallback -----------------------------------------
    sidecar_budget = policy.sidecar_budget(total_budget, primary_elapsed)

    try:
        sidecar_url = sidecar_url_resolver()
    except SidecarUnavailable as e:
        # Tag the primary envelope with the malformed-URL diagnostic
        # rather than swapping backends silently.
        primary_envelope.setdefault("fallback", {
            "fired": False,
            "reason": reason,
            "error": f"sidecar URL invalid: {e}",
            "sidecar_attempts": 0,
        })
        log("ERROR", "fallback.url_resolution_failed",
            error=str(e), reason=reason)
        exit_code = EXIT_OK if primary_envelope.get("ok") else EXIT_FETCH_FAILED
        log("INFO", "fetch.complete",
            tier="primary",
            ok=bool(primary_envelope.get("ok")),
            exit_code=exit_code,
            decision="fallback aborted: sidecar URL unresolvable",
            served_by=primary_envelope.get("backend") or "agent-browser")
        return Outcome(envelope=primary_envelope, exit_code=exit_code,
                       log_records=log_records)

    retry_count = _parse_int(env.get(ENV_SIDECAR_RETRY_COUNT),
                             DEFAULT_SIDECAR_RETRY_COUNT, lo=0, hi=5)
    retry_delay = _parse_float(env.get(ENV_SIDECAR_RETRY_DELAY),
                               DEFAULT_SIDECAR_RETRY_DELAY_S,
                               lo=0.0, hi=30.0)

    log("INFO", "sidecar.start",
        sidecar_url=sidecar_url,
        sidecar_budget=round(sidecar_budget, 3),
        retry_count=retry_count,
        retry_delay=retry_delay)

    sidecar_started = clock()
    sidecar_envelope = _safe_run_sidecar(
        req=req,
        sidecar_url=sidecar_url,
        fallback_reason=reason,
        primary_envelope=primary_envelope,
        timeout=sidecar_budget,
        retry_count=retry_count,
        retry_delay=retry_delay,
        sleep=sleep,
        clock=clock,
        log=log,
        sidecar_fn=sidecar_runner,
    )
    sidecar_elapsed = clock() - sidecar_started

    # Re-detect on the fallback envelope so the contract is uniform —
    # an agent that branches on `cf_detection.is_challenge` sees the
    # same shape regardless of which tier served the request.
    try:
        sidecar_envelope["cf_detection"] = detect_cloudflare_challenge(sidecar_envelope)
    except Exception as e:
        sidecar_envelope["cf_detection"] = {
            "is_challenge": False, "confidence": "none",
            "signals": [],
            "reason": f"detector raised on fallback envelope: {e!r}",
        }

    sidecar_ok = bool(sidecar_envelope.get("ok"))
    fb = sidecar_envelope.get("fallback") or {}
    log("INFO", "sidecar.complete",
        ok=sidecar_ok,
        sidecar_backend=fb.get("sidecar_backend"),
        sidecar_http_status=fb.get("sidecar_http_status"),
        sidecar_attempts=fb.get("sidecar_attempts"),
        elapsed_s=round(sidecar_elapsed, 3))

    # Final exit code: if either tier produced a usable response, that's
    # success. The sidecar tier is the one whose envelope we emit (the
    # primary envelope is preserved inside fallback.* for diagnostics).
    if sidecar_ok:
        exit_code = EXIT_OK
        tier = "sidecar"
        served_by = fb.get("sidecar_backend") or BACKEND_SIDECAR
    else:
        exit_code = EXIT_FETCH_FAILED
        tier = "sidecar-failed"
        served_by = "none"
        # Sub-AC 2.2.4: surface both-paths-failed as a single, greppable
        # event with both tiers' error strings side by side. Operators
        # tailing the structured log should never have to correlate two
        # separate events to know that the wrapper exhausted every
        # available runtime — that's the whole point of having the
        # orchestrator own the decision.
        log("ERROR", "both_paths_failed",
            primary_ok=bool(primary_envelope.get("ok")),
            primary_backend=primary_envelope.get("backend"),
            primary_status=primary_envelope.get("status"),
            primary_error=primary_envelope.get("error"),
            primary_signals=primary_envelope.get("cf_detection", {}).get("signals") or [],
            sidecar_backend=fb.get("sidecar_backend"),
            sidecar_http_status=fb.get("sidecar_http_status"),
            sidecar_attempts=fb.get("sidecar_attempts"),
            sidecar_error=sidecar_envelope.get("error"),
            note=("both primary and sidecar fallback failed — "
                  "EXIT_FETCH_FAILED returned to caller"))

    log("INFO", "fetch.complete",
        tier=tier,
        ok=sidecar_ok,
        exit_code=exit_code,
        served_by=served_by,
        primary_elapsed_s=round(primary_elapsed, 3),
        sidecar_elapsed_s=round(sidecar_elapsed, 3),
        total_elapsed_s=round(primary_elapsed + sidecar_elapsed, 3))

    return Outcome(envelope=sidecar_envelope, exit_code=exit_code,
                   log_records=log_records)


# ---------------------------------------------------------------------------
# Tier-runner exception safety
# ---------------------------------------------------------------------------


def _safe_run_primary(
    *,
    primary_runner: Callable[[Request, float], dict[str, Any]],
    req: Request,
    primary_budget: float,
    log: Callable[..., None],
) -> dict[str, Any]:
    """Run the primary runner, catching any exception.

    The runner is supposed to return a wrapper-shaped envelope itself
    (and never raise — it has its own _fail() path). But we still wrap
    it because the orchestrator must NEVER let an exception escape past
    `run_fetch`: the agent's contract is "always get a JSON envelope on
    stdout". A surprised KeyError during refactoring should be visible
    in logs but never leak to the agent.
    """
    started = time.time()
    try:
        env = primary_runner(req, primary_budget)
    except Exception as e:
        log("ERROR", "primary.exception",
            error=str(e),
            error_type=type(e).__name__,
            traceback=traceback.format_exc(limit=4))
        return _primary_exception_envelope(req=req, error=str(e), started=started)

    if not isinstance(env, dict):
        log("ERROR", "primary.bad_return",
            error_type=type(env).__name__)
        return _primary_exception_envelope(
            req=req,
            error=f"primary runner returned non-dict: {type(env).__name__}",
            started=started,
        )
    return env


def _primary_exception_envelope(*, req: Request, error: str,
                                started: float) -> dict[str, Any]:
    """Synthesise a primary-tier failure envelope from an unexpected error."""
    return {
        "ok": False,
        "backend": "agent-browser",
        "status": None,
        "url": req.url,
        "title": "",
        "html": "",
        "headers": {},
        "error": f"primary path raised: {error}",
        "elapsed_s": round(time.time() - started, 3),
        "cf_detection": {
            "is_challenge": False,
            "confidence": "none",
            "signals": [],
            "reason": "primary path raised before any response was captured",
        },
        # Sub-AC 2.2.1: schema parity with the runner's normal-path
        # envelope. The runner attaches the actual list; here we have
        # no recorder (the runner raised before it could attach), so
        # an empty list is the most-honest value for downstream
        # inspectors that index this key unconditionally.
        "agent_browser_invocations": [],
    }


def _safe_run_sidecar(
    *,
    req: Request,
    sidecar_url: str,
    fallback_reason: str,
    primary_envelope: dict[str, Any],
    timeout: float,
    retry_count: int,
    retry_delay: float,
    sleep: Callable[[float], None],
    clock: Callable[[], float],
    log: Callable[..., None],
    sidecar_fn: Callable[..., dict[str, Any]],
) -> dict[str, Any]:
    """Run the sidecar with retry, catching any exception that escapes
    the runner. Same rationale as `_safe_run_primary`.
    """
    try:
        return _sidecar_runner_with_retry(
            req=req,
            sidecar_url=sidecar_url,
            fallback_reason=fallback_reason,
            primary_envelope=primary_envelope,
            timeout=timeout,
            retry_count=retry_count,
            retry_delay=retry_delay,
            sleep=sleep,
            clock=clock,
            log=log,
            sidecar_fn=sidecar_fn,
        )
    except Exception as e:
        log("ERROR", "sidecar.exception",
            error=str(e),
            error_type=type(e).__name__,
            traceback=traceback.format_exc(limit=4))
        return _synthetic_unreachable_envelope(
            req=req,
            sidecar_url=sidecar_url,
            fallback_reason=fallback_reason,
            error=f"sidecar runner raised: {e}",
            primary_envelope=primary_envelope,
        )
