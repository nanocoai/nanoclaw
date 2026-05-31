#!/usr/bin/env python3
"""
Unit tests for the agent-browser invocation step (Sub-AC 2.2.1).

Goal under test
---------------
The wrapper CLI must shell out to the existing agent-browser command
with the user's URL/options and capture stdout, stderr, exit code, and
response body so downstream consumers (CF detection, the orchestrator's
structured logger, operator post-mortems, future heuristics) can inspect
them without re-running the request.

These tests pin down that contract:

  * `_AgentBrowserInvocation`           — frozen dataclass shape
  * `_AgentBrowserInvocationLog.record` — accumulator semantics
  * `_run_agent_browser`                — captures all four artefacts
                                          on success, timeout, and
                                          missing-binary paths; threads
                                          the invocation into a recorder
                                          when one is supplied
  * `_fetch_via_agent_browser`          — surfaces the full chain on the
                                          envelope under the
                                          `agent_browser_invocations`
                                          key (success and fail paths)

The tests mock `subprocess.run` so they never spawn agent-browser; they
also avoid hitting the real clock by patching `time.time` where the
duration_s field is asserted.

Run with:
    cd container/skills/web-fetch
    python3 -m unittest test_web_fetch -v
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
import unittest
from dataclasses import FrozenInstanceError
from unittest import mock

# Sibling-import dance so the test runs whether or not the directory is
# on PYTHONPATH (consistent with test_orchestrator / test_sidecar_client).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import web_fetch  # noqa: E402
from web_fetch import (  # noqa: E402
    BACKEND_AGENT_BROWSER,
    _AgentBrowserInvocation,
    _AgentBrowserInvocationLog,
    _fetch_via_agent_browser,
    _replace_response_body,
    _run_agent_browser,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_completed_process(*, returncode: int, stdout: str, stderr: str) -> mock.Mock:
    """Build a fake `subprocess.CompletedProcess` for `subprocess.run` patches."""
    fake = mock.Mock(spec=subprocess.CompletedProcess)
    fake.returncode = returncode
    fake.stdout = stdout
    fake.stderr = stderr
    return fake


# ---------------------------------------------------------------------------
# Dataclass shape
# ---------------------------------------------------------------------------


class InvocationDataclass(unittest.TestCase):
    """The captured-artefact contract is a frozen dataclass — guard
    against accidental mutation and missing fields."""

    def test_all_required_fields_present(self) -> None:
        inv = _AgentBrowserInvocation(
            cli_args=("open", "https://example.com"),
            exit_code=0,
            stdout="ok",
            stderr="",
            duration_s=0.1,
            response_body="ok",
        )
        d = inv.to_dict()
        for key in ("cli_args", "exit_code", "stdout", "stderr",
                    "duration_s", "response_body"):
            self.assertIn(key, d, f"missing required key: {key}")

    def test_cli_args_serialises_as_list(self) -> None:
        inv = _AgentBrowserInvocation(
            cli_args=("open", "https://example.com"),
            exit_code=0, stdout="", stderr="", duration_s=0.0,
        )
        # Tuple in memory (immutable, hashable), list on the wire (JSON).
        self.assertIsInstance(inv.cli_args, tuple)
        self.assertIsInstance(inv.to_dict()["cli_args"], list)

    def test_invocation_is_frozen(self) -> None:
        inv = _AgentBrowserInvocation(
            cli_args=("open",), exit_code=0, stdout="", stderr="",
            duration_s=0.0,
        )
        with self.assertRaises(FrozenInstanceError):
            inv.exit_code = 1  # type: ignore[misc]

    def test_replace_response_body_returns_new_object(self) -> None:
        inv = _AgentBrowserInvocation(
            cli_args=("eval",), exit_code=0,
            stdout="\"<html></html>\"", stderr="",
            duration_s=0.0, response_body="\"<html></html>\"",
        )
        new = _replace_response_body(inv, "<html></html>")
        self.assertIsNot(new, inv)
        self.assertEqual(new.response_body, "<html></html>")
        # Other fields preserved.
        self.assertEqual(new.cli_args, inv.cli_args)
        self.assertEqual(new.stdout, inv.stdout)


# ---------------------------------------------------------------------------
# Recorder accumulator
# ---------------------------------------------------------------------------


class InvocationLog(unittest.TestCase):
    def test_record_appends_in_order(self) -> None:
        log = _AgentBrowserInvocationLog()
        a = _AgentBrowserInvocation(("open",), 0, "", "", 0.0)
        b = _AgentBrowserInvocation(("close",), 0, "", "", 0.0)
        log.record(a)
        log.record(b)
        self.assertEqual(log.invocations, [a, b])

    def test_to_list_returns_dict_serialisations(self) -> None:
        log = _AgentBrowserInvocationLog()
        log.record(_AgentBrowserInvocation(("get", "title"), 0, "Hi", "",
                                           0.0, response_body="Hi"))
        out = log.to_list()
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["cli_args"], ["get", "title"])
        self.assertEqual(out[0]["stdout"], "Hi")
        self.assertEqual(out[0]["response_body"], "Hi")


# ---------------------------------------------------------------------------
# _run_agent_browser — captures the four required artefacts
# ---------------------------------------------------------------------------


class RunAgentBrowserCaptures(unittest.TestCase):

    def test_captures_stdout_stderr_exit_code_on_success(self) -> None:
        with mock.patch.object(
            web_fetch.subprocess, "run",
            return_value=_make_completed_process(
                returncode=0, stdout="hello\n", stderr="warn\n",
            ),
        ):
            inv = _run_agent_browser(
                "agent-browser", ["get", "title"], timeout=5.0,
            )
        self.assertEqual(inv.exit_code, 0)
        self.assertEqual(inv.stdout, "hello\n")
        self.assertEqual(inv.stderr, "warn\n")
        self.assertEqual(inv.cli_args, ("get", "title"))
        # response_body defaults to stdout when caller doesn't override.
        self.assertEqual(inv.response_body, "hello\n")
        # duration_s is a non-negative float.
        self.assertIsInstance(inv.duration_s, float)
        self.assertGreaterEqual(inv.duration_s, 0.0)

    def test_records_into_recorder_when_supplied(self) -> None:
        log = _AgentBrowserInvocationLog()
        with mock.patch.object(
            web_fetch.subprocess, "run",
            return_value=_make_completed_process(
                returncode=0, stdout="x", stderr="",
            ),
        ):
            inv = _run_agent_browser(
                "agent-browser", ["open", "https://example.com"],
                timeout=5.0, recorder=log,
            )
        self.assertEqual(len(log.invocations), 1)
        self.assertIs(log.invocations[0], inv)

    def test_does_not_record_when_recorder_is_none(self) -> None:
        with mock.patch.object(
            web_fetch.subprocess, "run",
            return_value=_make_completed_process(
                returncode=0, stdout="x", stderr="",
            ),
        ):
            inv = _run_agent_browser(
                "agent-browser", ["open", "u"], timeout=5.0,
            )
        self.assertEqual(inv.exit_code, 0)
        # No assertion needed — just that we got an invocation back.

    def test_timeout_is_surfaced_as_synthetic_124(self) -> None:
        log = _AgentBrowserInvocationLog()
        timeout_exc = subprocess.TimeoutExpired(
            cmd=["agent-browser", "open"], timeout=1.0,
        )
        timeout_exc.stdout = "partial"
        with mock.patch.object(
            web_fetch.subprocess, "run", side_effect=timeout_exc,
        ):
            inv = _run_agent_browser(
                "agent-browser", ["open", "https://slow"],
                timeout=1.0, recorder=log,
            )
        self.assertEqual(inv.exit_code, 124)
        self.assertEqual(inv.stdout, "partial")
        self.assertIn("timed out after 1.0s", inv.stderr)
        self.assertEqual(log.invocations[-1].exit_code, 124)

    def test_missing_binary_is_surfaced_as_synthetic_127(self) -> None:
        log = _AgentBrowserInvocationLog()
        with mock.patch.object(
            web_fetch.subprocess, "run",
            side_effect=FileNotFoundError(2, "No such file"),
        ):
            inv = _run_agent_browser(
                "/nonexistent/agent-browser", ["open"],
                timeout=5.0, recorder=log,
            )
        self.assertEqual(inv.exit_code, 127)
        self.assertEqual(inv.stdout, "")
        self.assertIn("agent-browser binary not found", inv.stderr)
        self.assertEqual(log.invocations[-1], inv)

    def test_caller_supplied_response_body_is_preserved(self) -> None:
        with mock.patch.object(
            web_fetch.subprocess, "run",
            return_value=_make_completed_process(
                returncode=0, stdout='"<html></html>"', stderr="",
            ),
        ):
            inv = _run_agent_browser(
                "agent-browser", ["eval", "x"], timeout=5.0,
                response_body="<html></html>",
            )
        self.assertEqual(inv.stdout, '"<html></html>"')
        self.assertEqual(inv.response_body, "<html></html>")

    def test_user_url_and_options_flow_through_verbatim(self) -> None:
        """The Seed mandates the user's URL/options reach agent-browser
        unmodified — no escaping, no substitution. We verify by capturing
        the argv handed to subprocess.run."""
        captured: dict[str, object] = {}

        def _capture_run(argv, **kwargs):
            captured["argv"] = list(argv)
            captured["timeout"] = kwargs.get("timeout")
            return _make_completed_process(returncode=0, stdout="", stderr="")

        with mock.patch.object(web_fetch.subprocess, "run",
                               side_effect=_capture_run):
            _run_agent_browser(
                "agent-browser",
                ["open", "https://utoon.net/?a=1&b=2"],
                timeout=12.0,
            )
        self.assertEqual(
            captured["argv"],
            ["agent-browser", "open", "https://utoon.net/?a=1&b=2"],
        )
        self.assertEqual(captured["timeout"], 12.0)


# ---------------------------------------------------------------------------
# _fetch_via_agent_browser — envelope surfaces the invocation chain
# ---------------------------------------------------------------------------


class EnvelopeSurfacesInvocations(unittest.TestCase):
    """The assembled envelope must carry the full subprocess trail under
    `agent_browser_invocations` so CF detection, structured logging, and
    post-mortems can read every shell-out's stdout/stderr/exit_code/body
    without re-running the request."""

    def _make_get_path_run(self, *, html: str, title: str = "Example",
                           final_url: str = "https://example.com/"):
        """Build a side_effect that returns the four canned responses
        the GET path expects: open → eval(html) → get(title) → get(url)
        → close.
        """
        responses = iter([
            _make_completed_process(returncode=0, stdout="", stderr=""),
            # eval returns a JS-quoted string; web_fetch strips the
            # quoting via _strip_eval_quotes(json.loads).
            _make_completed_process(
                returncode=0,
                stdout='"' + html.replace('"', r'\"') + '"',
                stderr="",
            ),
            _make_completed_process(returncode=0, stdout=title,
                                    stderr=""),
            _make_completed_process(returncode=0, stdout=final_url,
                                    stderr=""),
            _make_completed_process(returncode=0, stdout="", stderr=""),
        ])

        def _fake_run(argv, **kwargs):
            return next(responses)

        return _fake_run

    def test_get_path_envelope_carries_invocation_chain(self) -> None:
        with mock.patch.object(
            web_fetch.subprocess, "run",
            side_effect=self._make_get_path_run(
                html="<html><body>Hi</body></html>",
            ),
        ):
            env = _fetch_via_agent_browser(
                bin_path="agent-browser",
                url="https://example.com/",
                method="GET",
                headers=[],
                body=None,
                timeout=10.0,
            )
        self.assertTrue(env["ok"])
        self.assertEqual(env["backend"], BACKEND_AGENT_BROWSER)
        self.assertEqual(env["html"], "<html><body>Hi</body></html>")

        invocations = env["agent_browser_invocations"]
        self.assertIsInstance(invocations, list)
        # GET path issues: open, eval(html), get(title), get(url), close.
        self.assertEqual(len(invocations), 5)
        argv_chain = [tuple(inv["cli_args"]) for inv in invocations]
        self.assertEqual(argv_chain[0], ("open", "https://example.com/"))
        self.assertEqual(argv_chain[1][0], "eval")
        self.assertEqual(argv_chain[2], ("get", "title"))
        self.assertEqual(argv_chain[3], ("get", "url"))
        self.assertEqual(argv_chain[4], ("close",))

        # Each invocation has the full four-tuple of artefacts.
        for inv in invocations:
            self.assertIn("exit_code", inv)
            self.assertIn("stdout", inv)
            self.assertIn("stderr", inv)
            self.assertIn("response_body", inv)
            self.assertEqual(inv["exit_code"], 0)

        # The eval's response_body has the eval-quoting stripped to
        # match the envelope's `html` field — keeps debugging consistent.
        eval_inv = invocations[1]
        self.assertEqual(eval_inv["response_body"], env["html"])
        self.assertNotEqual(eval_inv["stdout"], env["html"])  # raw stdout still has quotes

    def test_failed_open_envelope_still_carries_invocations(self) -> None:
        responses = iter([
            _make_completed_process(returncode=2, stdout="",
                                    stderr="connection refused"),
            _make_completed_process(returncode=0, stdout="", stderr=""),
        ])
        with mock.patch.object(
            web_fetch.subprocess, "run", side_effect=lambda *a, **k: next(responses),
        ):
            env = _fetch_via_agent_browser(
                bin_path="agent-browser",
                url="https://example.com/",
                method="GET",
                headers=[],
                body=None,
                timeout=10.0,
            )
        self.assertFalse(env["ok"])
        self.assertIn("agent-browser open failed", env["error"])
        # Invocations still surfaced — failure path captures the open
        # invocation with exit_code=2 plus the cleanup `close`.
        invocations = env["agent_browser_invocations"]
        self.assertGreaterEqual(len(invocations), 1)
        self.assertEqual(invocations[0]["exit_code"], 2)
        self.assertEqual(invocations[0]["stderr"], "connection refused")

    def test_non_get_path_envelope_carries_invocation_chain(self) -> None:
        # Non-GET path: open(about:blank) + eval(fetch) + close.
        # The eval returns a JSON-stringified envelope.
        import json
        in_page = json.dumps({
            "ok": True, "status": 201, "url": "https://api.example.com/",
            "headers": {"content-type": "application/json"},
            "body": '{"id":42}',
        })
        # eval-quoted: the eval CLI prints the JS return value as a
        # JSON string literal, so the inner double-quotes get escaped.
        eval_stdout = json.dumps(in_page)
        responses = iter([
            _make_completed_process(returncode=0, stdout="",
                                    stderr=""),  # open about:blank
            _make_completed_process(returncode=0, stdout=eval_stdout,
                                    stderr=""),  # eval(fetch)
            _make_completed_process(returncode=0, stdout="",
                                    stderr=""),  # close
        ])
        with mock.patch.object(
            web_fetch.subprocess, "run", side_effect=lambda *a, **k: next(responses),
        ):
            env = _fetch_via_agent_browser(
                bin_path="agent-browser",
                url="https://api.example.com/",
                method="POST",
                headers=[("Authorization", "Bearer x")],
                body='{"key":"value"}',
                timeout=10.0,
            )
        self.assertTrue(env["ok"])
        self.assertEqual(env["status"], 201)
        self.assertEqual(env["html"], '{"id":42}')

        invocations = env["agent_browser_invocations"]
        argv_chain = [tuple(inv["cli_args"]) for inv in invocations]
        self.assertEqual(argv_chain[0], ("open", "about:blank"))
        self.assertEqual(argv_chain[1][0], "eval")
        self.assertEqual(argv_chain[-1], ("close",))

        # The eval invocation's response_body is the actual fetch()
        # response body, not the JSON envelope around it.
        eval_inv = invocations[1]
        self.assertEqual(eval_inv["response_body"], '{"id":42}')

    def test_invocations_are_json_serialisable(self) -> None:
        """The envelope is JSON-emitted to stdout — every invocation's
        captured artefacts must round-trip through json.dumps without
        loss (no datetimes, no objects, just primitives)."""
        import json
        with mock.patch.object(
            web_fetch.subprocess, "run",
            side_effect=self._make_get_path_run(html="<html/>"),
        ):
            env = _fetch_via_agent_browser(
                bin_path="agent-browser",
                url="https://example.com/",
                method="GET",
                headers=[],
                body=None,
                timeout=10.0,
            )
        # Must round-trip cleanly.
        roundtrip = json.loads(json.dumps(env))
        self.assertEqual(
            roundtrip["agent_browser_invocations"],
            env["agent_browser_invocations"],
        )


# ---------------------------------------------------------------------------
# Schema parity for failure envelopes
# ---------------------------------------------------------------------------


class FailureEnvelopeSchemaParity(unittest.TestCase):
    """`_fail` is also called from defensive paths — make sure the
    `agent_browser_invocations` field is always present (even if empty)
    so downstream parsers don't need to special-case the missing key."""

    def test_fail_envelope_has_invocations_key(self) -> None:
        env = web_fetch._fail(
            error="boom", url="https://x.test/", started=time.time(),
        )
        self.assertIn("agent_browser_invocations", env)
        self.assertEqual(env["agent_browser_invocations"], [])


# ---------------------------------------------------------------------------
# Sub-AC 3 — structured-log verbosity flags
# ---------------------------------------------------------------------------


class VerbosityFlagsCli(unittest.TestCase):
    """Sub-AC 3: the wrapper CLI must expose `--verbose` (and `--quiet`)
    that translate into the orchestrator's existing `WEB_FETCH_LOG_LEVEL`
    / `WEB_FETCH_QUIET` env vars.

    The structured-log trail at INFO is **always on** (those events are
    proved out by `test_orchestrator.py`); these tests pin the CLI
    surface and the env-translation policy so verification can:

      * default invocation         → ambient env passes through; the
                                     always-on attempt trace fires.
      * `--verbose`                → bumps the threshold to DEBUG so
                                     `sidecar.attempt.start` /
                                     `sidecar.attempt.end` show up.
      * `--quiet`                  → silences stderr while leaving the
                                     stdout envelope untouched.
      * `--verbose` + `--quiet`    → `--verbose` wins (explicit per-call
                                     opt-in beats the silencer).
      * ambient `WEB_FETCH_*` env  → preserved when neither flag fires;
                                     overridden by `--verbose`.
    """

    def test_default_no_flags_preserves_ambient_env(self) -> None:
        # No --verbose, no --quiet, no env interference: the env we
        # build matches os.environ-equivalent (we pass an explicit base
        # to keep the test hermetic).
        base = {"WEB_FETCH_LOG_LEVEL": "INFO", "PATH": "/usr/bin"}
        env = web_fetch._build_orchestrator_env(
            base_env=base, verbose=False, quiet=False,
        )
        # Untouched: caller's INFO threshold survives.
        self.assertEqual(env["WEB_FETCH_LOG_LEVEL"], "INFO")
        self.assertNotIn("WEB_FETCH_QUIET", env)
        # Original env is not mutated (defensive).
        self.assertEqual(base["WEB_FETCH_LOG_LEVEL"], "INFO")

    def test_verbose_bumps_log_level_to_debug(self) -> None:
        env = web_fetch._build_orchestrator_env(
            base_env={}, verbose=True, quiet=False,
        )
        self.assertEqual(env["WEB_FETCH_LOG_LEVEL"], "DEBUG")
        self.assertNotIn("WEB_FETCH_QUIET", env)

    def test_quiet_sets_quiet_env(self) -> None:
        env = web_fetch._build_orchestrator_env(
            base_env={}, verbose=False, quiet=True,
        )
        self.assertEqual(env.get("WEB_FETCH_QUIET"), "1")

    def test_verbose_wins_over_quiet(self) -> None:
        """An operator who passed both flags clearly wants the detail —
        --verbose is the explicit per-call opt-in. We honour it and
        scrub the QUIET shortcut so a stale env doesn't muzzle the log.
        """
        env = web_fetch._build_orchestrator_env(
            base_env={"WEB_FETCH_QUIET": "1"},
            verbose=True, quiet=True,
        )
        self.assertEqual(env["WEB_FETCH_LOG_LEVEL"], "DEBUG")
        self.assertNotIn("WEB_FETCH_QUIET", env)

    def test_verbose_overrides_ambient_log_level(self) -> None:
        env = web_fetch._build_orchestrator_env(
            base_env={"WEB_FETCH_LOG_LEVEL": "WARNING"},
            verbose=True, quiet=False,
        )
        # The CLI flag is more specific than the persistent env — it
        # represents what the operator typed for THIS invocation.
        self.assertEqual(env["WEB_FETCH_LOG_LEVEL"], "DEBUG")

    def test_argparse_exposes_verbose_and_quiet_short_forms(self) -> None:
        ns = web_fetch._parse_args(["https://example.com/", "-v"])
        self.assertTrue(ns.verbose)
        self.assertFalse(ns.quiet)
        ns = web_fetch._parse_args(["https://example.com/", "-q"])
        self.assertFalse(ns.verbose)
        self.assertTrue(ns.quiet)
        # Default: neither set.
        ns = web_fetch._parse_args(["https://example.com/"])
        self.assertFalse(ns.verbose)
        self.assertFalse(ns.quiet)

    def test_main_threads_verbose_to_orchestrator_env(self) -> None:
        """End-to-end: when `--verbose` is on the CLI, `_orchestrator_run`
        sees `WEB_FETCH_LOG_LEVEL=DEBUG` in its env arg.

        We stub the orchestrator at module level so this test never
        touches agent-browser, the sidecar, or stderr.
        """
        captured: dict[str, object] = {}

        class _StubOutcome:
            envelope = {
                "ok": True, "backend": "agent-browser", "status": 200,
                "url": "https://example.com/", "title": "", "html": "",
                "headers": {}, "error": None, "elapsed_s": 0.0,
                "cf_detection": {
                    "is_challenge": False, "confidence": "none",
                    "signals": [], "reason": "",
                },
            }
            exit_code = 0

        def _stub_run(req, *, primary_runner, env=None, **kw):
            captured["env"] = env
            captured["request"] = req
            return _StubOutcome()

        with mock.patch.object(web_fetch, "_orchestrator_run", _stub_run):
            rc = web_fetch.main(["https://example.com/", "--verbose"])
        self.assertEqual(rc, 0)
        env = captured["env"]
        self.assertIsInstance(env, dict)
        self.assertEqual(env.get("WEB_FETCH_LOG_LEVEL"), "DEBUG")
        self.assertNotIn("WEB_FETCH_QUIET", env)

    def test_main_threads_quiet_to_orchestrator_env(self) -> None:
        captured: dict[str, object] = {}

        class _StubOutcome:
            envelope = {
                "ok": True, "backend": "agent-browser", "status": 200,
                "url": "https://example.com/", "title": "", "html": "",
                "headers": {}, "error": None, "elapsed_s": 0.0,
                "cf_detection": {
                    "is_challenge": False, "confidence": "none",
                    "signals": [], "reason": "",
                },
            }
            exit_code = 0

        def _stub_run(req, *, primary_runner, env=None, **kw):
            captured["env"] = env
            return _StubOutcome()

        with mock.patch.object(web_fetch, "_orchestrator_run", _stub_run):
            web_fetch.main(["https://example.com/", "--quiet"])
        env = captured["env"]
        self.assertEqual(env.get("WEB_FETCH_QUIET"), "1")

    def test_help_text_advertises_verbose_and_quiet(self) -> None:
        """Operators must be able to discover the flags without reading
        the source. Both flags appear in `--help` output with their
        documented short forms.
        """
        # argparse writes the help text to stdout and SystemExit(0)s.
        import io
        buf = io.StringIO()
        with mock.patch.object(sys, "stdout", buf), self.assertRaises(SystemExit):
            web_fetch._parse_args(["--help"])
        text = buf.getvalue()
        self.assertIn("--verbose", text)
        self.assertIn("-v", text)
        self.assertIn("--quiet", text)
        self.assertIn("-q", text)


# ---------------------------------------------------------------------------
# Sub-AC 3 — always-on attempt trace contract
# ---------------------------------------------------------------------------


class AlwaysOnAttemptTraceContract(unittest.TestCase):
    """Sub-AC 3 says the attempt trace is **always on**. We verify the
    contract end-to-end:

      * INFO-level events (the always-on trace) record each attempt's
        runtime (`elapsed_s`), the detected CF signal (`cf_is_challenge`
        / `cf_signals` / `cf_confidence`), and the fallback decision
        (`fallback.decision.fire` + `reason`).
      * `--verbose` adds DEBUG events (`sidecar.attempt.start` /
        `sidecar.attempt.end`) WITHOUT removing any of the always-on
        events.

    These tests drive `orchestrator.run_fetch` directly with the env
    `_build_orchestrator_env` would have produced, so they exercise the
    same wiring the CLI exercises.
    """

    def _make_envelopes(self):
        """Build a CF-blocked primary + a successful sidecar pair so the
        full trail (primary → cf detect → fallback decision → sidecar)
        runs.
        """
        cf_blocked_primary = {
            "ok": True, "backend": "agent-browser", "status": 403,
            "url": "https://utoon.net/", "title": "Just a moment...",
            "html": "<html><body>checking your browser</body></html>",
            "headers": {"server": "cloudflare", "cf-ray": "abc-LAX"},
            "error": None, "elapsed_s": 1.0,
            "cf_detection": {
                "is_challenge": True, "confidence": "high",
                "signals": ["title:just a moment"],
                "reason": "title contains 'just a moment'",
            },
        }
        sidecar_ok = {
            "ok": True, "backend": "cf-fetch-server", "status": 200,
            "url": "https://utoon.net/", "title": "유툰",
            "html": "<html>resolved</html>",
            "headers": {"content-type": "text/html"},
            "error": None, "elapsed_s": 0.5,
            "fallback": {
                "fired": True,
                "reason": "cf_detection.is_challenge=True",
                "sidecar_url": "http://127.0.0.1:8765",
                "sidecar_backend": "nodriver",
                "sidecar_http_status": 200,
                "primary_backend": "agent-browser",
                "primary_status": 403,
                "primary_signals": ["title:just a moment"],
                "method_downgraded_to_get": False,
                "body_dropped": False,
            },
        }
        return cf_blocked_primary, sidecar_ok

    def _drive_run_fetch_with_stderr_logger(
        self, env: dict[str, str], cf_primary: dict, sidecar_ok: dict,
    ) -> list[dict]:
        """Helper: run the orchestrator with the env's threshold actually
        applied (via `make_stderr_logger`) and return the parsed JSON
        log lines.

        `make_capture_logger` is level-agnostic (it appends every event
        a caller emits regardless of threshold), so it can't prove
        "DEBUG events are filtered out at INFO". The stderr logger is
        the one that consults `WEB_FETCH_LOG_LEVEL`, which is exactly
        the contract the CLI's --verbose flag manipulates.
        """
        from orchestrator import (
            Request, run_fetch, make_stderr_logger,
        )
        import io as _io

        def _primary(req, timeout):
            import copy
            return copy.deepcopy(cf_primary)

        def _sidecar(**kwargs):
            import copy
            return copy.deepcopy(sidecar_ok)

        buf = _io.StringIO()
        with mock.patch.object(sys, "stderr", buf):
            log = make_stderr_logger(env)
            run_fetch(
                Request(url="https://utoon.net/"),
                primary_runner=_primary, sidecar_runner=_sidecar,
                sleep=lambda _s: None, log=log, env=env,
            )
        import json as _json
        records: list[dict] = []
        for line in buf.getvalue().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                records.append(_json.loads(line))
            except _json.JSONDecodeError:
                continue
        return records

    def test_default_trace_records_runtime_cf_signal_and_decision(self) -> None:
        cf_primary, sidecar_ok = self._make_envelopes()
        # Build the env the CLI would build with no flags — passes
        # through. The default level is INFO.
        env = web_fetch._build_orchestrator_env(
            base_env={}, verbose=False, quiet=False,
        )
        records = self._drive_run_fetch_with_stderr_logger(
            env, cf_primary, sidecar_ok,
        )
        events = [r["event"] for r in records]

        # Always-on attempt trace fires at INFO.
        self.assertIn("fetch.start", events)
        self.assertIn("primary.complete", events)
        self.assertIn("fallback.decision", events)
        self.assertIn("sidecar.complete", events)
        self.assertIn("fetch.complete", events)

        # Per-attempt runtime recorded.
        prim = next(r for r in records if r["event"] == "primary.complete")
        self.assertIn("elapsed_s", prim)
        self.assertIsInstance(prim["elapsed_s"], (int, float))
        sidecar = next(r for r in records if r["event"] == "sidecar.complete")
        self.assertIn("elapsed_s", sidecar)

        # CF signal recorded on primary.complete.
        self.assertEqual(prim["cf_is_challenge"], True)
        self.assertEqual(prim["cf_confidence"], "high")
        self.assertEqual(prim["cf_signals"], ["title:just a moment"])

        # Fallback decision recorded.
        decision = next(r for r in records if r["event"] == "fallback.decision")
        self.assertTrue(decision["fire"])
        self.assertIn("cf_detection.is_challenge", decision["reason"])

        # DEBUG events (sidecar.attempt.*) NOT present at default INFO —
        # this is the threshold filtering we needed the stderr logger to
        # exercise.
        self.assertNotIn("sidecar.attempt.start", events)
        self.assertNotIn("sidecar.attempt.end", events)

    def test_verbose_adds_per_attempt_detail_without_dropping_default_trace(self) -> None:
        cf_primary, sidecar_ok = self._make_envelopes()
        env = web_fetch._build_orchestrator_env(
            base_env={}, verbose=True, quiet=False,
        )
        # Sanity: --verbose must have produced LOG_LEVEL=DEBUG.
        self.assertEqual(env.get("WEB_FETCH_LOG_LEVEL"), "DEBUG")

        records = self._drive_run_fetch_with_stderr_logger(
            env, cf_primary, sidecar_ok,
        )
        events = [r["event"] for r in records]

        # Default trace still present (always-on).
        for must in ("fetch.start", "primary.complete",
                     "fallback.decision", "sidecar.complete",
                     "fetch.complete"):
            self.assertIn(must, events,
                          f"--verbose dropped always-on event {must!r}")
        # DEBUG-level per-attempt detail now visible.
        self.assertIn("sidecar.attempt.start", events)
        self.assertIn("sidecar.attempt.end", events)

    def test_quiet_silences_the_attempt_trace(self) -> None:
        cf_primary, sidecar_ok = self._make_envelopes()
        env = web_fetch._build_orchestrator_env(
            base_env={}, verbose=False, quiet=True,
        )
        # Sanity: --quiet must have set WEB_FETCH_QUIET=1.
        self.assertEqual(env.get("WEB_FETCH_QUIET"), "1")

        records = self._drive_run_fetch_with_stderr_logger(
            env, cf_primary, sidecar_ok,
        )
        # No log lines emitted — stdout (envelope) is unaffected, but
        # the orchestration trail is silenced.
        self.assertEqual(records, [],
                         "--quiet must silence the orchestration log")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
