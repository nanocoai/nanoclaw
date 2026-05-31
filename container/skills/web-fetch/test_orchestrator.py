#!/usr/bin/env python3
"""
Unit tests for orchestrator.run_fetch (Sub-AC 2.4).

Stdlib-only (`unittest`) so the container — which has no pytest by
default — can run them with `python3 -m unittest test_orchestrator`.
The orchestrator is fully injectable, so these tests never spawn
agent-browser, never open a socket, and never sleep on real time.

Coverage matrix (Sub-AC 2.4 deliverables):

  end-to-end orchestration:
    - primary-only path (cf_detection.is_challenge=False) → no sidecar call
    - primary-CF-detected path             → sidecar fires, envelope has
                                              backend=cf-fetch-server
    - opt-in fallback on primary failure   → sidecar fires when env=1
    - sidecar-only failure                 → exit_code=EXIT_FETCH_FAILED

  error handling:
    - primary runner raises                → wrapper-shaped envelope, no
                                              stack trace
    - primary returns non-dict             → ditto
    - sidecar runner raises                → ditto
    - sidecar URL resolver raises          → primary envelope returned
                                              with diagnostic note

  timeouts:
    - primary timeout split                → primary_budget = pct * total
    - sidecar floor honoured               → sidecar gets >= floor even
                                              when primary blew budget
    - env override honoured                → WEB_FETCH_PRIMARY_TIMEOUT_PCT

  retry / fallback policy:
    - sidecar unreachable then succeeds    → 1 retry, ok=true,
                                              sidecar_attempts=2
    - sidecar unreachable both attempts    → ok=false, sidecar_attempts=2
    - sidecar 503 (queue-full)             → no retry,
                                              sidecar_attempts=1
    - retry disabled via env=0             → no retry,
                                              sidecar_attempts=1
    - retry skipped when budget exhausted

  structured logging:
    - JSON-shaped records emitted at each tier event
    - log level threshold honoured (DEBUG vs INFO)
    - WEB_FETCH_QUIET=1 silences output

  unified exit code:
    - primary ok → EXIT_OK
    - primary failed, fallback off → EXIT_FETCH_FAILED
    - primary CF-blocked, sidecar ok → EXIT_OK
    - primary CF-blocked, sidecar failed → EXIT_FETCH_FAILED
"""

from __future__ import annotations

import io
import json
import os
import sys
import time
import unittest
from unittest import mock

# Sibling-import dance.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from orchestrator import (  # noqa: E402
    EXIT_FETCH_FAILED,
    EXIT_OK,
    DEFAULT_PRIMARY_TIMEOUT_PCT,
    DEFAULT_PRIMARY_TIMEOUT_MIN_S,
    DEFAULT_SIDECAR_TIMEOUT_MIN_S,
    ENV_DISABLE_FALLBACK,
    ENV_LOG_LEVEL,
    ENV_LOG_QUIET,
    ENV_PRIMARY_TIMEOUT_PCT,
    ENV_SIDECAR_RETRY_COUNT,
    ENV_SIDECAR_RETRY_DELAY,
    Outcome,
    Request,
    TimeoutPolicy,
    _is_truthy_env,
    make_capture_logger,
    make_stderr_logger,
    run_fetch,
)
from sidecar_client import (  # noqa: E402
    BACKEND_SIDECAR,
    ENV_FALLBACK_ON_PRIMARY_FAILURE,
    SidecarUnavailable,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


CLEAN_PRIMARY_ENVELOPE = {
    "ok": True,
    "backend": "agent-browser",
    "status": 200,
    "url": "https://example.com/",
    "title": "Example Domain",
    "html": "<html><body>example</body></html>",
    "headers": {},
    "error": None,
    "elapsed_s": 0.5,
    "cf_detection": {
        "is_challenge": False,
        "confidence": "none",
        "signals": [],
        "reason": "no Cloudflare challenge signals detected",
    },
}

CF_BLOCKED_PRIMARY_ENVELOPE = {
    "ok": True,
    "backend": "agent-browser",
    "status": 403,
    "url": "https://utoon.net/",
    "title": "Just a moment...",
    "html": "<html><body>checking your browser before accessing</body></html>",
    "headers": {"server": "cloudflare", "cf-ray": "abc-LAX"},
    "error": None,
    "elapsed_s": 1.0,
    "cf_detection": {
        "is_challenge": True,
        "confidence": "high",
        "signals": ["title:just a moment"],
        "reason": "title contains 'just a moment'",
    },
}

PRIMARY_FAIL_ENVELOPE = {
    "ok": False,
    "backend": "agent-browser",
    "status": None,
    "url": "https://utoon.net/",
    "title": "",
    "html": "",
    "headers": {},
    "error": "agent-browser binary not found",
    "elapsed_s": 0.01,
    "cf_detection": {
        "is_challenge": False,
        "confidence": "none",
        "signals": [],
        "reason": "primary path failed before any response was captured",
    },
}


def _make_request(**overrides) -> Request:
    base = dict(
        url="https://utoon.net/",
        method="GET",
        headers=(("User-Agent", "test/1.0"),),
        body=None,
        timeout=20.0,
        output="json",
    )
    base.update(overrides)
    return Request(**base)


def _primary_runner_returning(envelope: dict):
    """Stub primary runner that always returns the given envelope."""
    calls = []

    def _runner(req: Request, timeout: float) -> dict:
        calls.append({"req": req, "timeout": timeout})
        # Return a deep copy so tests asserting on the wrapper envelope
        # don't accidentally mutate the fixture for later tests.
        import copy
        return copy.deepcopy(envelope)

    _runner._calls = calls  # type: ignore[attr-defined]
    return _runner


def _sidecar_runner_returning(envelopes):
    """Stub sidecar runner that returns envelopes[i] on the i-th call.

    `envelopes` may be a list (one envelope per attempt) or a single
    dict (returned every call).
    """
    if isinstance(envelopes, dict):
        sequence = [envelopes]
        single = True
    else:
        sequence = list(envelopes)
        single = False

    calls = []

    def _runner(**kwargs):
        calls.append(kwargs)
        idx = len(calls) - 1
        if single:
            return _shallow_copy(sequence[0])
        if idx >= len(sequence):
            return _shallow_copy(sequence[-1])
        return _shallow_copy(sequence[idx])

    _runner._calls = calls  # type: ignore[attr-defined]
    return _runner


def _shallow_copy(d: dict) -> dict:
    """Deep-enough copy for our envelopes."""
    import copy
    return copy.deepcopy(d)


def _sidecar_envelope(*, ok=True, status=200, sidecar_backend="nodriver",
                      http_status=200, url="https://utoon.net/",
                      html="<html>resolved</html>", error=None,
                      title="", headers=None):
    return {
        "ok": ok,
        "backend": BACKEND_SIDECAR,
        "status": status,
        "url": url,
        "title": title,
        "html": html,
        "headers": headers if headers is not None else {"content-type": "text/html"},
        "error": error,
        "elapsed_s": 0.5,
        "fallback": {
            "fired": True,
            "reason": "cf_detection.is_challenge=True",
            "sidecar_url": "http://127.0.0.1:8765",
            "sidecar_backend": sidecar_backend,
            "sidecar_http_status": http_status,
            "primary_backend": "agent-browser",
            "primary_status": 403,
            "primary_signals": ["title:just a moment"],
            "method_downgraded_to_get": False,
            "body_dropped": False,
        },
    }


# ---------------------------------------------------------------------------
# End-to-end orchestration
# ---------------------------------------------------------------------------


class PrimaryOnlyPath(unittest.TestCase):
    """When CF is not detected and primary OK, sidecar must NOT fire."""

    def test_clean_primary_no_sidecar(self):
        primary = _primary_runner_returning(CLEAN_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())
        log, records = make_capture_logger()

        outcome = run_fetch(
            _make_request(url="https://example.com/"),
            primary_runner=primary,
            sidecar_runner=sidecar,
            sleep=lambda _s: None,
            log=log,
            env={},
        )

        self.assertEqual(outcome.exit_code, EXIT_OK)
        self.assertEqual(outcome.envelope["backend"], "agent-browser")
        self.assertTrue(outcome.envelope["ok"])
        # Sidecar must NOT have been called.
        self.assertEqual(len(sidecar._calls), 0)
        # Decision logged.
        events = [r["event"] for r in records]
        self.assertIn("primary.complete", events)
        self.assertIn("fetch.complete", events)
        self.assertNotIn("fallback.decision", events)
        self.assertNotIn("sidecar.complete", events)

    def test_primary_failed_no_fallback_by_default(self):
        primary = _primary_runner_returning(PRIMARY_FAIL_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())
        log, records = make_capture_logger()

        outcome = run_fetch(
            _make_request(),
            primary_runner=primary,
            sidecar_runner=sidecar,
            sleep=lambda _s: None,
            log=log,
            env={},
        )

        self.assertEqual(outcome.exit_code, EXIT_FETCH_FAILED)
        self.assertFalse(outcome.envelope["ok"])
        self.assertEqual(len(sidecar._calls), 0)


class FallbackFiredPath(unittest.TestCase):
    """When cf_detection.is_challenge=True, sidecar must fire."""

    def test_cf_blocked_primary_routes_to_sidecar(self):
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())
        log, records = make_capture_logger()

        outcome = run_fetch(
            _make_request(),
            primary_runner=primary,
            sidecar_runner=sidecar,
            sleep=lambda _s: None,
            log=log,
            env={},
        )

        self.assertEqual(outcome.exit_code, EXIT_OK)
        self.assertEqual(outcome.envelope["backend"], BACKEND_SIDECAR)
        self.assertTrue(outcome.envelope["ok"])
        self.assertEqual(len(sidecar._calls), 1)
        # The diagnostic trail should preserve the primary signals.
        fb = outcome.envelope["fallback"]
        self.assertEqual(fb["primary_signals"], ["title:just a moment"])
        # Sidecar attempts recorded.
        self.assertEqual(fb["sidecar_attempts"], 1)
        # cf_detection re-run on sidecar envelope (clean HTML → not challenge).
        self.assertFalse(outcome.envelope["cf_detection"]["is_challenge"])
        # Logged events include the full trail.
        events = [r["event"] for r in records]
        self.assertIn("fallback.decision", events)
        self.assertIn("sidecar.start", events)
        self.assertIn("sidecar.complete", events)
        self.assertIn("fetch.complete", events)

    def test_opt_in_fallback_on_primary_failure(self):
        primary = _primary_runner_returning(PRIMARY_FAIL_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())

        outcome = run_fetch(
            _make_request(),
            primary_runner=primary,
            sidecar_runner=sidecar,
            sleep=lambda _s: None,
            env={ENV_FALLBACK_ON_PRIMARY_FAILURE: "1"},
        )
        self.assertEqual(outcome.exit_code, EXIT_OK)
        self.assertEqual(outcome.envelope["backend"], BACKEND_SIDECAR)
        self.assertEqual(len(sidecar._calls), 1)

    def test_sidecar_failure_yields_unified_failure_exit(self):
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope(
            ok=False, sidecar_backend="queue-full", http_status=503,
            error="sidecar busy: 3 active / 3 max",
        ))

        outcome = run_fetch(
            _make_request(),
            primary_runner=primary,
            sidecar_runner=sidecar,
            sleep=lambda _s: None,
            env={ENV_SIDECAR_RETRY_COUNT: "0"},  # no retry on a 503
        )
        self.assertEqual(outcome.exit_code, EXIT_FETCH_FAILED)
        self.assertEqual(outcome.envelope["backend"], BACKEND_SIDECAR)
        self.assertFalse(outcome.envelope["ok"])
        self.assertEqual(outcome.envelope["fallback"]["sidecar_backend"], "queue-full")


# ---------------------------------------------------------------------------
# Error handling — exceptions never escape run_fetch
# ---------------------------------------------------------------------------


class ExceptionSafety(unittest.TestCase):
    def test_primary_runner_raising_yields_envelope(self):
        def _exploding(req, timeout):
            raise RuntimeError("boom")
        log, records = make_capture_logger()

        outcome = run_fetch(
            _make_request(),
            primary_runner=_exploding,
            sleep=lambda _s: None,
            log=log,
            env={},
        )
        # No fallback fires (cf_detection is "none"), so we get the
        # synthesised primary-fail envelope and a unified failure code.
        self.assertEqual(outcome.exit_code, EXIT_FETCH_FAILED)
        self.assertEqual(outcome.envelope["backend"], "agent-browser")
        self.assertFalse(outcome.envelope["ok"])
        self.assertIn("boom", outcome.envelope["error"])
        # Exception was logged structurally — no traceback on stdout.
        events = [r["event"] for r in records]
        self.assertIn("primary.exception", events)

    def test_primary_runner_returning_non_dict_yields_envelope(self):
        def _bad_runner(req, timeout):
            return "not a dict"

        outcome = run_fetch(
            _make_request(),
            primary_runner=_bad_runner,
            sleep=lambda _s: None,
            env={},
        )
        self.assertEqual(outcome.exit_code, EXIT_FETCH_FAILED)
        self.assertFalse(outcome.envelope["ok"])
        self.assertIn("non-dict", outcome.envelope["error"])

    def test_sidecar_runner_raising_yields_envelope(self):
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)

        def _exploding_sidecar(**kwargs):
            raise RuntimeError("sidecar boom")
        log, records = make_capture_logger()

        outcome = run_fetch(
            _make_request(),
            primary_runner=primary,
            sidecar_runner=_exploding_sidecar,
            sleep=lambda _s: None,
            log=log,
            env={},
        )
        self.assertEqual(outcome.exit_code, EXIT_FETCH_FAILED)
        self.assertEqual(outcome.envelope["backend"], BACKEND_SIDECAR)
        self.assertEqual(outcome.envelope["fallback"]["sidecar_backend"], "unreachable")
        self.assertIn("sidecar boom", outcome.envelope["error"])
        events = [r["event"] for r in records]
        self.assertIn("sidecar.exception", events)

    def test_sidecar_url_resolver_raising_returns_primary(self):
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())

        def _bad_resolver():
            raise SidecarUnavailable("env override garbage")
        log, records = make_capture_logger()

        outcome = run_fetch(
            _make_request(),
            primary_runner=primary,
            sidecar_runner=sidecar,
            sidecar_url_resolver=_bad_resolver,
            sleep=lambda _s: None,
            log=log,
            env={},
        )
        # Sidecar should NOT have been called.
        self.assertEqual(len(sidecar._calls), 0)
        # Primary envelope returned, with a fallback diagnostic.
        self.assertEqual(outcome.envelope["backend"], "agent-browser")
        self.assertIn("fallback", outcome.envelope)
        self.assertIn("env override garbage", outcome.envelope["fallback"]["error"])
        events = [r["event"] for r in records]
        self.assertIn("fallback.url_resolution_failed", events)


# ---------------------------------------------------------------------------
# Timeout split policy
# ---------------------------------------------------------------------------


class TimeoutSplit(unittest.TestCase):
    def test_default_split_caps_primary_at_pct(self):
        primary = _primary_runner_returning(CLEAN_PRIMARY_ENVELOPE)
        run_fetch(
            _make_request(timeout=20.0),
            primary_runner=primary,
            sleep=lambda _s: None,
            env={},
        )
        # primary_budget = max(min, pct * 20) = max(5, 12) = 12.
        self.assertEqual(len(primary._calls), 1)
        self.assertAlmostEqual(primary._calls[0]["timeout"],
                               20.0 * DEFAULT_PRIMARY_TIMEOUT_PCT, places=3)

    def test_primary_floor_honoured_for_tiny_budget(self):
        primary = _primary_runner_returning(CLEAN_PRIMARY_ENVELOPE)
        run_fetch(
            _make_request(timeout=2.0),  # below the floor
            primary_runner=primary,
            sleep=lambda _s: None,
            env={},
        )
        # primary_budget = max(5, 0.6*2) = 5 — but capped at total (2).
        # We documented `primary_budget = min(total, max(min, pct*total))`.
        self.assertLessEqual(primary._calls[0]["timeout"], 2.0 + 1e-6)
        self.assertGreater(primary._calls[0]["timeout"], 0.0)

    def test_env_override_primary_pct(self):
        primary = _primary_runner_returning(CLEAN_PRIMARY_ENVELOPE)
        run_fetch(
            _make_request(timeout=20.0),
            primary_runner=primary,
            sleep=lambda _s: None,
            env={ENV_PRIMARY_TIMEOUT_PCT: "0.25"},
        )
        # primary_budget = max(5, 0.25 * 20) = max(5, 5) = 5
        self.assertAlmostEqual(primary._calls[0]["timeout"], 5.0, places=3)

    def test_sidecar_floor_when_primary_blew_budget(self):
        # Primary takes 25s of a 20s budget. Sidecar should still get
        # at least DEFAULT_SIDECAR_TIMEOUT_MIN_S.
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())

        # Inject a fake clock so primary "took" 25s.
        clock_now = [1000.0]
        primary_started = [False]

        def _clock():
            return clock_now[0]
        # Advance the clock 25 seconds between primary start and end.
        original_runner = primary

        def _slow_primary(req, timeout):
            primary_started[0] = True
            clock_now[0] += 25.0  # primary "ran" for 25s
            return original_runner(req, timeout)

        outcome = run_fetch(
            _make_request(timeout=20.0),
            primary_runner=_slow_primary,
            sidecar_runner=sidecar,
            clock=_clock,
            sleep=lambda _s: None,
            env={},
        )
        self.assertEqual(len(sidecar._calls), 1)
        sidecar_timeout = sidecar._calls[0]["timeout"]
        # remaining = 20 - 25 = -5 → floored to DEFAULT_SIDECAR_TIMEOUT_MIN_S
        self.assertGreaterEqual(sidecar_timeout, DEFAULT_SIDECAR_TIMEOUT_MIN_S - 1e-6)


# ---------------------------------------------------------------------------
# Retry policy
# ---------------------------------------------------------------------------


def _unreachable_envelope(*, error="connection refused"):
    return {
        "ok": False,
        "backend": BACKEND_SIDECAR,
        "status": None,
        "url": "https://utoon.net/",
        "title": "",
        "html": "",
        "headers": {},
        "error": error,
        "elapsed_s": 0.05,
        "fallback": {
            "fired": True,
            "reason": "cf_detection.is_challenge=True",
            "sidecar_url": "http://127.0.0.1:8765",
            "sidecar_backend": "unreachable",
            "sidecar_http_status": None,
            "primary_backend": "agent-browser",
            "primary_status": 403,
            "primary_signals": ["title:just a moment"],
            "method_downgraded_to_get": False,
            "body_dropped": False,
        },
    }


class RetryPolicy(unittest.TestCase):
    def test_unreachable_then_success_retries_once(self):
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning([
            _unreachable_envelope(),
            _sidecar_envelope(),
        ])
        sleep_calls = []
        log, records = make_capture_logger()

        outcome = run_fetch(
            _make_request(timeout=30.0),
            primary_runner=primary,
            sidecar_runner=sidecar,
            sleep=lambda s: sleep_calls.append(s),
            log=log,
            env={},  # default retry_count=1
        )
        self.assertEqual(outcome.exit_code, EXIT_OK)
        self.assertTrue(outcome.envelope["ok"])
        self.assertEqual(len(sidecar._calls), 2)
        self.assertEqual(outcome.envelope["fallback"]["sidecar_attempts"], 2)
        self.assertEqual(len(sleep_calls), 1)
        events = [r["event"] for r in records]
        self.assertIn("sidecar.retry.scheduled", events)

    def test_unreachable_both_attempts_yields_failure(self):
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning([
            _unreachable_envelope(),
            _unreachable_envelope(),
        ])
        outcome = run_fetch(
            _make_request(timeout=30.0),
            primary_runner=primary,
            sidecar_runner=sidecar,
            sleep=lambda _s: None,
            env={},
        )
        self.assertEqual(outcome.exit_code, EXIT_FETCH_FAILED)
        self.assertFalse(outcome.envelope["ok"])
        self.assertEqual(len(sidecar._calls), 2)
        self.assertEqual(outcome.envelope["fallback"]["sidecar_attempts"], 2)

    def test_503_queue_full_does_not_retry(self):
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope(
            ok=False, sidecar_backend="queue-full", http_status=503,
            error="sidecar busy",
        ))

        outcome = run_fetch(
            _make_request(timeout=30.0),
            primary_runner=primary,
            sidecar_runner=sidecar,
            sleep=lambda _s: None,
            env={},
        )
        self.assertEqual(len(sidecar._calls), 1)
        self.assertEqual(outcome.envelope["fallback"]["sidecar_attempts"], 1)

    def test_retry_disabled_via_env(self):
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning([
            _unreachable_envelope(),
            _sidecar_envelope(),  # would succeed if retried
        ])

        outcome = run_fetch(
            _make_request(timeout=30.0),
            primary_runner=primary,
            sidecar_runner=sidecar,
            sleep=lambda _s: None,
            env={ENV_SIDECAR_RETRY_COUNT: "0"},
        )
        self.assertEqual(len(sidecar._calls), 1)
        self.assertEqual(outcome.exit_code, EXIT_FETCH_FAILED)

    def test_retry_skipped_when_budget_exhausted(self):
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)

        # Sidecar always returns "unreachable", and the retry delay is
        # set so that retry+delay would exceed the sidecar budget. With
        # timeout=1.0 the sidecar floor (5.0) wins, but the orchestrator
        # uses a fake clock to simulate the first sidecar attempt taking
        # most of the budget — the next retry can't fit.
        sidecar = _sidecar_runner_returning([
            _unreachable_envelope(),
            _sidecar_envelope(),  # never reached
        ])
        log, records = make_capture_logger()

        # Inject a clock that advances by 10s during the first sidecar
        # call, so when we evaluate the retry delay (clamped to ≤30s)
        # against `total_started` the budget is already gone.
        clock_now = [1000.0]

        def _clock():
            return clock_now[0]

        original_sidecar = sidecar

        def _slow_sidecar(**kwargs):
            clock_now[0] += 25.0  # consume most of the sidecar budget
            return original_sidecar(**kwargs)

        # `_sidecar_runner_returning` exposes calls via the closure;
        # rebuild calls list passthrough so the assertion still works.
        _slow_sidecar._calls = sidecar._calls  # type: ignore[attr-defined]

        outcome = run_fetch(
            _make_request(timeout=20.0),
            primary_runner=primary,
            sidecar_runner=_slow_sidecar,
            clock=_clock,
            sleep=lambda _s: None,
            log=log,
            env={ENV_SIDECAR_RETRY_DELAY: "20.0"},  # 20+25 > 20 budget
        )
        # Only one sidecar call.
        self.assertEqual(len(sidecar._calls), 1)
        events = [r["event"] for r in records]
        self.assertIn("sidecar.retry.skip.budget_exhausted", events)


# ---------------------------------------------------------------------------
# Structured logging
# ---------------------------------------------------------------------------


class StructuredLogging(unittest.TestCase):
    def test_log_records_are_json_serialisable_dicts(self):
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())
        log, records = make_capture_logger()

        run_fetch(
            _make_request(),
            primary_runner=primary,
            sidecar_runner=sidecar,
            sleep=lambda _s: None,
            log=log,
            env={},
        )
        # Every record must JSON-roundtrip and have the canonical
        # five-key shape (ts, level, component, event, +payload).
        for r in records:
            line = json.dumps(r, default=str)
            roundtrip = json.loads(line)
            for k in ("ts", "level", "component", "event"):
                self.assertIn(k, roundtrip)
            self.assertEqual(roundtrip["component"], "web-fetch")

    def test_quiet_env_silences_stderr_logger(self):
        buf = io.StringIO()
        with mock.patch.object(sys, "stderr", buf):
            log = make_stderr_logger({ENV_LOG_QUIET: "1"})
            log("INFO", "should.not.appear", k="v")
        self.assertEqual(buf.getvalue(), "")

    def test_log_level_threshold_drops_lower_levels(self):
        buf = io.StringIO()
        with mock.patch.object(sys, "stderr", buf):
            log = make_stderr_logger({ENV_LOG_LEVEL: "WARNING"})
            log("DEBUG", "drop.me")
            log("INFO", "drop.me.too")
            log("WARNING", "keep.me")
            log("ERROR", "keep.me.also")
        lines = [l for l in buf.getvalue().splitlines() if l.strip()]
        self.assertEqual(len(lines), 2)
        events = [json.loads(l)["event"] for l in lines]
        self.assertEqual(events, ["keep.me", "keep.me.also"])

    def test_stderr_logger_writes_to_stderr_not_stdout(self):
        # The wrapper's contract is that stdout carries the response
        # envelope and only stderr carries the orchestration log. A
        # regression here would corrupt the agent's JSON parser.
        out_buf, err_buf = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "stdout", out_buf), \
             mock.patch.object(sys, "stderr", err_buf):
            log = make_stderr_logger({ENV_LOG_LEVEL: "INFO"})
            log("INFO", "marker", k="v")
        self.assertEqual(out_buf.getvalue(), "")
        self.assertIn("marker", err_buf.getvalue())

    def test_stderr_logger_handles_unserialisable_field(self):
        class WeirdObject:
            def __repr__(self):
                raise RuntimeError("can't repr me")
        buf = io.StringIO()
        with mock.patch.object(sys, "stderr", buf):
            log = make_stderr_logger({ENV_LOG_LEVEL: "INFO"})
            log("INFO", "weird", payload=WeirdObject())
        # Should NOT raise; should still emit a line.
        line = buf.getvalue().strip()
        self.assertTrue(line, "logger swallowed the event entirely")
        # Parses as JSON.
        parsed = json.loads(line)
        self.assertEqual(parsed["event"], "weird")


# ---------------------------------------------------------------------------
# TimeoutPolicy unit tests
# ---------------------------------------------------------------------------


class TimeoutPolicyParsing(unittest.TestCase):
    def test_defaults_when_env_missing(self):
        p = TimeoutPolicy.from_env({})
        self.assertEqual(p.primary_pct, DEFAULT_PRIMARY_TIMEOUT_PCT)
        self.assertEqual(p.primary_min_s, DEFAULT_PRIMARY_TIMEOUT_MIN_S)
        self.assertEqual(p.sidecar_min_s, DEFAULT_SIDECAR_TIMEOUT_MIN_S)

    def test_garbage_env_falls_back_to_defaults(self):
        p = TimeoutPolicy.from_env({ENV_PRIMARY_TIMEOUT_PCT: "garbage"})
        self.assertEqual(p.primary_pct, DEFAULT_PRIMARY_TIMEOUT_PCT)

    def test_out_of_range_env_falls_back_to_defaults(self):
        p = TimeoutPolicy.from_env({ENV_PRIMARY_TIMEOUT_PCT: "1.5"})  # > 0.95
        self.assertEqual(p.primary_pct, DEFAULT_PRIMARY_TIMEOUT_PCT)

    def test_sidecar_budget_floor_kicks_in(self):
        p = TimeoutPolicy.from_env({})
        # primary used 100s of a 30s budget → remaining = -70 → floored.
        self.assertEqual(p.sidecar_budget(30.0, 100.0), DEFAULT_SIDECAR_TIMEOUT_MIN_S)

    def test_sidecar_budget_takes_max_of_remaining_and_floor(self):
        p = TimeoutPolicy.from_env({})
        # primary used 5s of 30s → remaining = 25 → above floor → 25.
        self.assertEqual(p.sidecar_budget(30.0, 5.0), 25.0)


# ---------------------------------------------------------------------------
# Outcome / Request data classes
# ---------------------------------------------------------------------------


class DataClasses(unittest.TestCase):
    def test_request_is_frozen(self):
        r = _make_request()
        with self.assertRaises(Exception):
            r.url = "https://example.com/"  # type: ignore[misc]

    def test_outcome_default_log_records_is_empty_list(self):
        outcome = Outcome(envelope={"ok": True}, exit_code=EXIT_OK)
        self.assertEqual(outcome.log_records, [])
        # Independent across instances.
        outcome.log_records.append({"x": 1})
        outcome2 = Outcome(envelope={}, exit_code=0)
        self.assertEqual(outcome2.log_records, [])


# ---------------------------------------------------------------------------
# Latency budget — repeats under 2s when both tiers are warm
# ---------------------------------------------------------------------------


class LatencyBudget(unittest.TestCase):
    """The Seed says repeated requests should land under 2s. Wall time
    isn't predictable in CI, but we can at least assert the orchestrator
    itself adds essentially no overhead — every wait is gated on
    sleep / clock injection so a fast-runner test must finish in ms.
    """

    def test_orchestrator_overhead_is_minimal(self):
        primary = _primary_runner_returning(CLEAN_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())
        started = time.perf_counter()
        outcome = run_fetch(
            _make_request(),
            primary_runner=primary,
            sidecar_runner=sidecar,
            sleep=lambda _s: None,
            env={},
        )
        elapsed = time.perf_counter() - started
        self.assertEqual(outcome.exit_code, EXIT_OK)
        self.assertLess(elapsed, 0.5,
                        f"orchestrator overhead too high: {elapsed:.3f}s")


# ---------------------------------------------------------------------------
# Sub-AC 2.2.3 — transparent sidecar fallback path
# ---------------------------------------------------------------------------


class SubAc223TransparentFallback(unittest.TestCase):
    """Focused tests for Sub-AC 2.2.3.

    The AC says the wrapper must, when the CF signal is true, re-issue
    the same request against the container-local sidecar HTTP service and return
    its response in the same output format as the agent-browser path,
    with no manual flag required.

    These tests pin each clause:

      a) "when the CF signal is true"
            cf_detection.is_challenge=True is the only trigger needed —
            no env or flag prods the sidecar.
      b) "re-issues the same request"
            url / method / headers / body forwarded verbatim to the
            sidecar runner.
      c) "in the same output format as the agent-browser path"
            envelope key set is identical (modulo `backend` value and
            the additive `fallback` diagnostic record).
      d) "no manual flag required"
            the CLI surface (web_fetch._parse_args) does NOT expose a
            flag that selects the sidecar; falling back is purely the
            orchestrator's decision.
    """

    # --- a) cf_detection.is_challenge=True is the ONLY trigger -------------

    def test_cf_signal_true_triggers_fallback_with_no_flags(self):
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())
        outcome = run_fetch(
            _make_request(),
            primary_runner=primary,
            sidecar_runner=sidecar,
            sleep=lambda _s: None,
            env={},  # critically: NO opt-in env var, NO log knobs
        )
        self.assertEqual(outcome.exit_code, EXIT_OK)
        self.assertEqual(outcome.envelope["backend"], BACKEND_SIDECAR)
        self.assertEqual(len(sidecar._calls), 1,
                         "sidecar must fire when cf_detection.is_challenge=True")

    def test_cf_signal_false_never_triggers_fallback(self):
        primary = _primary_runner_returning(CLEAN_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())
        outcome = run_fetch(
            _make_request(url="https://example.com/"),
            primary_runner=primary,
            sidecar_runner=sidecar,
            sleep=lambda _s: None,
            env={},
        )
        self.assertEqual(outcome.exit_code, EXIT_OK)
        self.assertEqual(outcome.envelope["backend"], "agent-browser")
        self.assertEqual(len(sidecar._calls), 0,
                         "sidecar must NOT fire on a non-CF response")

    # --- b) the sidecar receives the SAME request -------------------------

    def test_request_is_reissued_verbatim_to_sidecar(self):
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())
        req = Request(
            url="https://utoon.net/page?x=1",
            method="GET",
            headers=(("User-Agent", "agent/1.0"),
                     ("Accept-Language", "ko,en;q=0.9")),
            body=None,
            timeout=20.0,
            output="json",
        )
        outcome = run_fetch(
            req,
            primary_runner=primary,
            sidecar_runner=sidecar,
            sleep=lambda _s: None,
            env={},
        )
        self.assertEqual(outcome.exit_code, EXIT_OK)
        # The orchestrator hands the sidecar runner the URL, method,
        # headers and body verbatim. Anything else would mean the
        # request was rewritten in flight, which would violate the AC.
        call = sidecar._calls[0]
        self.assertEqual(call["url"], "https://utoon.net/page?x=1")
        self.assertEqual(call["method"], "GET")
        self.assertEqual(list(call["headers"]),
                         [("User-Agent", "agent/1.0"),
                          ("Accept-Language", "ko,en;q=0.9")])
        self.assertIsNone(call["body"])

    # --- c) envelope-shape parity between primary & fallback paths --------

    def test_fallback_envelope_has_same_key_set_as_primary(self):
        """The agent gets one parser to write — primary and fallback
        envelopes carry the same top-level keys (modulo the additive
        `fallback` diagnostic record on the sidecar path).
        """
        # Primary path
        primary_clean = _primary_runner_returning(CLEAN_PRIMARY_ENVELOPE)
        sidecar_unused = _sidecar_runner_returning(_sidecar_envelope())
        primary_outcome = run_fetch(
            _make_request(url="https://example.com/"),
            primary_runner=primary_clean,
            sidecar_runner=sidecar_unused,
            sleep=lambda _s: None,
            env={},
        )

        # Sidecar path
        primary_blocked = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())
        sidecar_outcome = run_fetch(
            _make_request(),
            primary_runner=primary_blocked,
            sidecar_runner=sidecar,
            sleep=lambda _s: None,
            env={},
        )

        # The agent's parser keys: ok, backend, status, url, title,
        # html, headers, error, elapsed_s, cf_detection. These MUST
        # appear on both envelopes with the same Python types.
        canonical_keys = {
            "ok": bool, "backend": str, "url": str, "title": str,
            "html": str, "headers": dict,
            "elapsed_s": (int, float),
            "cf_detection": dict,
        }
        for key, expected_type in canonical_keys.items():
            self.assertIn(key, primary_outcome.envelope,
                          f"primary envelope missing {key!r}")
            self.assertIn(key, sidecar_outcome.envelope,
                          f"sidecar envelope missing {key!r}")
            self.assertIsInstance(primary_outcome.envelope[key], expected_type)
            self.assertIsInstance(sidecar_outcome.envelope[key], expected_type)
        # status is int|None on both — assert the union explicitly.
        for env in (primary_outcome.envelope, sidecar_outcome.envelope):
            self.assertTrue(env["status"] is None or isinstance(env["status"], int))
            self.assertTrue(env["error"] is None or isinstance(env["error"], str))

        # The only top-level key that distinguishes them is `fallback`,
        # which is additive on the sidecar path.
        self.assertNotIn("fallback", primary_outcome.envelope,
                         "primary envelope must NOT carry a fallback record")
        self.assertIn("fallback", sidecar_outcome.envelope)
        self.assertTrue(sidecar_outcome.envelope["fallback"]["fired"])

        # And `backend` is the only field whose value is different.
        self.assertEqual(primary_outcome.envelope["backend"], "agent-browser")
        self.assertEqual(sidecar_outcome.envelope["backend"], BACKEND_SIDECAR)

    def test_fallback_envelope_carries_uniform_cf_detection(self):
        """An agent that branches on cf_detection.is_challenge sees the
        SAME shape regardless of which tier served the request.
        """
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope(
            html="<html><body>resolved page text</body></html>",
            title="resolved",
        ))
        outcome = run_fetch(
            _make_request(),
            primary_runner=primary,
            sidecar_runner=sidecar,
            sleep=lambda _s: None,
            env={},
        )
        cf = outcome.envelope["cf_detection"]
        # Same four required keys as on the primary path.
        for k in ("is_challenge", "confidence", "signals", "reason"):
            self.assertIn(k, cf)
        # Sidecar successfully resolved the page → not a challenge.
        self.assertFalse(cf["is_challenge"])

    # --- d) "no manual flag required" — CLI surface contract -------------

    def test_cli_surface_has_no_sidecar_selector_flag(self):
        """The web_fetch CLI exposes ZERO arguments that let a caller
        pick the sidecar path. Fallback is the orchestrator's decision,
        not the agent's.
        """
        # Import lazily so this test is independent of the orchestrator
        # module import order.
        import web_fetch
        parser_args = web_fetch._parse_args(["https://example.com/"])
        # Inspect the argparse namespace keys.
        attrs = vars(parser_args)
        forbidden = {
            "use_sidecar", "force_sidecar", "via_sidecar",
            "backend", "sidecar", "fallback", "cf_bypass",
        }
        for name in forbidden:
            self.assertNotIn(name, attrs,
                             f"CLI must not expose --{name.replace('_', '-')}")
        # The recognised CLI surface is exactly the documented set.
        # Sub-AC 3 added --verbose / --quiet for structured-log
        # verbosity; they are tagged below so a future audit can tell
        # them apart from the original Sub-AC 2.x argument shape.
        recognised = {
            # Sub-AC 2.1–2.4 surface (request shape):
            "url", "method", "header", "body", "body_file",
            "timeout", "output", "agent_browser_bin",
            # Sub-AC 3 surface (verbosity knobs — never select a
            # backend, only the structured-log threshold):
            "verbose", "quiet",
        }
        self.assertEqual(set(attrs.keys()), recognised,
                         "CLI surface drifted from the Seed-mandated set")


class SubAc224ControlFlowEntrypoint(unittest.TestCase):
    """Sub-AC 2.2.4 — Wire the three steps (primary → CF detect → sidecar
    fallback) into a single control-flow entrypoint with:

      * structured logging of which runtime served the request,
      * error propagation when both paths fail,
      * an opt-out env var for debugging.

    These tests target the verbatim AC clauses and are deliberately
    independent of the existing class-level coverage so a future refactor
    can land the same Sub-AC again from scratch.
    """

    # -- single control-flow entrypoint -------------------------------------

    def test_run_fetch_is_the_only_orchestration_entrypoint(self):
        """The wrapper must expose ONE function that runs all three steps.

        We assert the public surface: `run_fetch` is callable, and the
        thin CLI shell `web_fetch.main` calls into it exactly once. No
        alternate entrypoint may exist for "primary only" or "sidecar
        only" — that would split the agent's contract in two.
        """
        # Single callable.
        self.assertTrue(callable(run_fetch))

        # The thin CLI shell delegates to run_fetch.
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import web_fetch  # noqa: E402

        # The web_fetch module must surface the orchestrator's run_fetch
        # under the alias the CLI uses; if a future refactor decouples
        # them this test will catch the drift.
        self.assertTrue(hasattr(web_fetch, "_orchestrator_run"))
        self.assertIs(web_fetch._orchestrator_run, run_fetch)

    def test_three_steps_run_in_order_in_a_single_call(self):
        """A single `run_fetch` invocation must drive all three steps:
        primary → cf detect → sidecar fallback. The structured-log trail
        is the proof: the events appear in the documented order, and no
        other public entrypoint had to be threaded by the caller.
        """
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())
        log, records = make_capture_logger()

        outcome = run_fetch(
            _make_request(),
            primary_runner=primary,
            sidecar_runner=sidecar,
            sleep=lambda _s: None,
            log=log,
            env={},
        )

        # All three steps observable in the trail, in order.
        events = [r["event"] for r in records]
        self.assertEqual(
            [e for e in events if e in {
                "fetch.start", "primary.complete",
                "fallback.decision", "sidecar.complete",
                "fetch.complete",
            }],
            ["fetch.start", "primary.complete",
             "fallback.decision", "sidecar.complete",
             "fetch.complete"],
        )
        self.assertEqual(outcome.exit_code, EXIT_OK)

    # -- structured logging of which runtime served -------------------------

    def test_fetch_complete_logs_tier_and_served_by_primary(self):
        """Primary-only path: `fetch.complete` must carry tier=primary
        AND a `served_by` field naming the primary backend label so a
        single grep (`event=fetch.complete | served_by`) tells the
        operator which runtime served the request.
        """
        primary = _primary_runner_returning(CLEAN_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())
        log, records = make_capture_logger()

        run_fetch(
            _make_request(url="https://example.com/"),
            primary_runner=primary, sidecar_runner=sidecar,
            sleep=lambda _s: None, log=log, env={},
        )

        completes = [r for r in records if r["event"] == "fetch.complete"]
        self.assertEqual(len(completes), 1)
        complete = completes[0]
        self.assertEqual(complete["tier"], "primary")
        self.assertEqual(complete["served_by"], "agent-browser")
        self.assertEqual(complete["exit_code"], EXIT_OK)
        self.assertTrue(complete["ok"])

    def test_fetch_complete_logs_tier_and_served_by_sidecar(self):
        """Sidecar fallback path: `fetch.complete` must carry tier=sidecar
        AND served_by reflecting the sidecar's reported backend (e.g.
        nodriver / stub / queue-full / unreachable). The agent's logging
        contract: ONE event = ONE line that says which runtime served.
        """
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope(sidecar_backend="nodriver"))
        log, records = make_capture_logger()

        run_fetch(
            _make_request(),
            primary_runner=primary, sidecar_runner=sidecar,
            sleep=lambda _s: None, log=log, env={},
        )

        completes = [r for r in records if r["event"] == "fetch.complete"]
        self.assertEqual(len(completes), 1)
        complete = completes[0]
        self.assertEqual(complete["tier"], "sidecar")
        self.assertEqual(complete["served_by"], "nodriver")
        self.assertEqual(complete["exit_code"], EXIT_OK)
        self.assertTrue(complete["ok"])

    def test_envelope_backend_field_matches_served_by_log_field(self):
        """Schema cross-check: the response envelope's `backend` field is
        the LLM-readable signal of which runtime served, and the log's
        `served_by` field is the operator-readable signal. They must
        agree — the wrapper cannot tell the agent one runtime and the
        operator another.
        """
        # Sidecar served — envelope.backend=cf-fetch-server,
        # log.served_by=nodriver (the sidecar's *internal* backend).
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope(sidecar_backend="nodriver"))
        log, records = make_capture_logger()

        outcome = run_fetch(
            _make_request(),
            primary_runner=primary, sidecar_runner=sidecar,
            sleep=lambda _s: None, log=log, env={},
        )

        complete = next(r for r in records if r["event"] == "fetch.complete")
        # The envelope's backend label tells the agent "the sidecar
        # served this." The log's served_by tells the operator the
        # sidecar's internal backend (nodriver vs stub vs queue-full).
        # Both pieces of information are necessary, and both must be
        # consistent: served_by must NOT report the primary's label
        # when the sidecar served.
        self.assertEqual(outcome.envelope["backend"], BACKEND_SIDECAR)
        self.assertNotEqual(complete["served_by"], "agent-browser")

    # -- error propagation when both paths fail -----------------------------

    def test_both_paths_failed_logs_dedicated_event(self):
        """When the primary's failure was the reason fallback fired AND
        the sidecar then also failed, the orchestrator must emit a
        single, greppable `both_paths_failed` event so an operator
        scanning the structured log finds the outage instantly without
        having to correlate two separate events.
        """
        # Primary fails AND opt-in fallback is enabled so the sidecar
        # actually runs; sidecar then also fails.
        primary = _primary_runner_returning(PRIMARY_FAIL_ENVELOPE)
        sidecar = _sidecar_runner_returning(
            _sidecar_envelope(ok=False, status=503, sidecar_backend="queue-full",
                              http_status=503,
                              error="sidecar refused: queue full")
        )
        log, records = make_capture_logger()

        outcome = run_fetch(
            _make_request(),
            primary_runner=primary, sidecar_runner=sidecar,
            sleep=lambda _s: None, log=log,
            env={ENV_FALLBACK_ON_PRIMARY_FAILURE: "1"},
        )

        # Exit code propagates the failure.
        self.assertEqual(outcome.exit_code, EXIT_FETCH_FAILED)
        self.assertFalse(outcome.envelope["ok"])

        # The dedicated event is present and carries BOTH tiers' errors.
        events = [r for r in records if r["event"] == "both_paths_failed"]
        self.assertEqual(len(events), 1, "exactly one both_paths_failed event")
        ev = events[0]
        self.assertEqual(ev["level"], "ERROR")
        self.assertFalse(ev["primary_ok"])
        self.assertEqual(ev["primary_backend"], "agent-browser")
        self.assertIn("agent-browser binary not found", ev["primary_error"] or "")
        self.assertEqual(ev["sidecar_backend"], "queue-full")
        self.assertEqual(ev["sidecar_http_status"], 503)
        self.assertIn("queue full", ev["sidecar_error"] or "")

    def test_both_paths_failed_not_emitted_when_sidecar_succeeds(self):
        """The both_paths_failed event must be emitted ONLY when both
        paths failed. A successful sidecar fallback after a CF-blocked
        primary is the happy path — it must NOT trip the alarm event.
        """
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope(ok=True))
        log, records = make_capture_logger()

        run_fetch(
            _make_request(),
            primary_runner=primary, sidecar_runner=sidecar,
            sleep=lambda _s: None, log=log, env={},
        )

        self.assertNotIn("both_paths_failed", [r["event"] for r in records])

    def test_exit_code_propagates_failure_when_both_paths_fail(self):
        """The unified exit code must reflect the combined outcome:
        EXIT_FETCH_FAILED when both paths failed. The CLI's process
        return value is the agent's primary error-propagation channel
        when running under shell composition.
        """
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(
            _sidecar_envelope(ok=False, status=503,
                              sidecar_backend="unreachable",
                              http_status=None,
                              error="sidecar unreachable: connection refused")
        )
        log, records = make_capture_logger()

        outcome = run_fetch(
            _make_request(),
            primary_runner=primary, sidecar_runner=sidecar,
            sleep=lambda _s: None, log=log, env={},
        )

        self.assertEqual(outcome.exit_code, EXIT_FETCH_FAILED)
        self.assertFalse(outcome.envelope["ok"])
        # The error is preserved on the envelope so a JSON-parsing agent
        # also sees the failure (not just shell-level $?).
        self.assertIn("connection refused", outcome.envelope.get("error") or "")

    # -- opt-out env var for debugging --------------------------------------

    def test_disable_fallback_env_skips_sidecar_even_when_cf_detected(self):
        """`WEB_FETCH_DISABLE_FALLBACK=1` is the debug opt-out. Even when
        the primary's `cf_detection.is_challenge=True` (which would
        normally fire fallback), the orchestrator must return the
        primary envelope as-is so the operator can debug the primary
        path in isolation.
        """
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())
        log, records = make_capture_logger()

        outcome = run_fetch(
            _make_request(),
            primary_runner=primary, sidecar_runner=sidecar,
            sleep=lambda _s: None, log=log,
            env={ENV_DISABLE_FALLBACK: "1"},
        )

        # Sidecar must NOT have been called.
        self.assertEqual(len(sidecar._calls), 0)
        # Envelope is the primary's (with backend=agent-browser).
        self.assertEqual(outcome.envelope["backend"], "agent-browser")
        # The CF detection signal is preserved so the operator can
        # SEE the verdict that would have fired fallback.
        self.assertTrue(outcome.envelope["cf_detection"]["is_challenge"])
        # Exit code follows the primary's ok.
        self.assertEqual(outcome.exit_code, EXIT_OK)
        # The opt-out is logged as a WARNING with the env var name and
        # value so an operator scanning the trail sees why fallback was
        # skipped without having to re-run with logging at DEBUG.
        opt_out_events = [r for r in records if r["event"] == "fallback.skipped.opt_out"]
        self.assertEqual(len(opt_out_events), 1)
        ev = opt_out_events[0]
        self.assertEqual(ev["level"], "WARNING")
        self.assertEqual(ev["env_var"], ENV_DISABLE_FALLBACK)
        self.assertEqual(ev["value"], "1")
        self.assertTrue(ev["cf_is_challenge"])
        # And the fetch.complete event records the served runtime as
        # primary so the structured log answer to "which runtime served?"
        # is unambiguous.
        complete = next(r for r in records if r["event"] == "fetch.complete")
        self.assertEqual(complete["tier"], "primary")
        self.assertEqual(complete["served_by"], "agent-browser")
        self.assertIn(ENV_DISABLE_FALLBACK, complete["decision"])

    def test_disable_fallback_accepts_truthy_strings(self):
        """The opt-out env var accepts the same truthy vocabulary as
        the rest of the wrapper (`1`, `true`, `yes`, `on`) so an
        operator doesn't have to remember which form the wrapper
        wants. Empty / unset / `0` / `false` keep fallback enabled.
        """
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)

        for truthy in ("1", "true", "True", "TRUE", "yes", "on"):
            with self.subTest(value=truthy):
                sidecar = _sidecar_runner_returning(_sidecar_envelope())
                run_fetch(
                    _make_request(),
                    primary_runner=primary, sidecar_runner=sidecar,
                    sleep=lambda _s: None, log=lambda *_a, **_k: None,
                    env={ENV_DISABLE_FALLBACK: truthy},
                )
                self.assertEqual(
                    len(sidecar._calls), 0,
                    f"truthy value {truthy!r} must disable fallback",
                )

        for falsy in ("", "0", "false", "no", "off", "  "):
            with self.subTest(value=falsy):
                sidecar = _sidecar_runner_returning(_sidecar_envelope())
                run_fetch(
                    _make_request(),
                    primary_runner=primary, sidecar_runner=sidecar,
                    sleep=lambda _s: None, log=lambda *_a, **_k: None,
                    env={ENV_DISABLE_FALLBACK: falsy},
                )
                self.assertEqual(
                    len(sidecar._calls), 1,
                    f"falsy value {falsy!r} must NOT disable fallback",
                )

    def test_disable_fallback_default_off(self):
        """When the env var is unset, the orchestrator must default to
        production behaviour — fallback fires on CF detection. The
        debug opt-out NEVER becomes the production default by accident.
        """
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())

        run_fetch(
            _make_request(),
            primary_runner=primary, sidecar_runner=sidecar,
            sleep=lambda _s: None, log=lambda *_a, **_k: None,
            env={},  # explicitly empty — no opt-out
        )

        self.assertEqual(len(sidecar._calls), 1, "fallback must fire by default")

    def test_is_truthy_env_helper(self):
        """The truthy-env helper accepts the documented vocabulary and
        rejects everything else. Centralising the parser keeps the
        accepted vocabulary consistent across env knobs.
        """
        for truthy in ("1", "true", "yes", "on", "True", " on "):
            self.assertTrue(_is_truthy_env(truthy), f"expected truthy: {truthy!r}")
        for falsy in (None, "", "0", "false", "no", "off", "maybe", "2"):
            self.assertFalse(_is_truthy_env(falsy), f"expected falsy: {falsy!r}")

    def test_disable_fallback_does_not_change_envelope_schema(self):
        """The opt-out must NEVER change the envelope schema — it is a
        debugging convenience, not a runtime mode-switch. The agent's
        parser must work identically regardless of whether the
        operator opted out.
        """
        primary = _primary_runner_returning(CF_BLOCKED_PRIMARY_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())

        # With opt-out: envelope is the primary's, with all primary keys.
        out_with = run_fetch(
            _make_request(),
            primary_runner=primary, sidecar_runner=sidecar,
            sleep=lambda _s: None, log=lambda *_a, **_k: None,
            env={ENV_DISABLE_FALLBACK: "1"},
        )
        # The fields a primary envelope must always carry.
        for k in ("ok", "backend", "status", "url", "title", "html",
                  "headers", "error", "elapsed_s", "cf_detection"):
            self.assertIn(k, out_with.envelope,
                          f"opt-out envelope missing {k!r}")

    def test_disable_fallback_propagates_primary_failure_exit_code(self):
        """When the opt-out is on AND the primary failed, the exit code
        must still be EXIT_FETCH_FAILED — the opt-out turns OFF the
        fallback, not the failure-propagation contract.
        """
        primary = _primary_runner_returning(PRIMARY_FAIL_ENVELOPE)
        sidecar = _sidecar_runner_returning(_sidecar_envelope())
        log, records = make_capture_logger()

        outcome = run_fetch(
            _make_request(),
            primary_runner=primary, sidecar_runner=sidecar,
            sleep=lambda _s: None, log=log,
            env={ENV_DISABLE_FALLBACK: "1"},
        )

        self.assertEqual(outcome.exit_code, EXIT_FETCH_FAILED)
        self.assertFalse(outcome.envelope["ok"])
        # No sidecar call.
        self.assertEqual(len(sidecar._calls), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
