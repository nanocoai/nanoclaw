#!/usr/bin/env python3
"""
Unit tests for sidecar_client (Sub-AC 2.3).

Stdlib-only (`unittest`) so the container — which has no pytest by default
— can run them with `python3 -m unittest test_sidecar_client`. Mirrors
`test_cf_detect.py`'s self-contained style.

Coverage:

  - resolve_sidecar_url: env override, default, malformed override
  - should_fallback: cf_detection-driven, env-flag opt-in, no-op path
  - fetch_via_sidecar (envelope reshape):
      * happy path                       — sidecar returns 200/ok=true
      * sidecar non-ok (queue-full/503)  — preserves error + fallback diag
      * sidecar unreachable              — synthesises ok=false envelope
      * non-GET method                   — downgrade flag set
      * resolves URL from env override   — CF_FETCH_SIDECAR_URL respected
      * preserves primary diagnostics    — primary_signals & primary_status

The HTTP layer is stubbed via the `opener` injection point on
`fetch_via_sidecar` so no network calls fire during the tests.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from unittest import mock

# Make the sibling import work regardless of cwd (mirrors test_cf_detect.py).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sidecar_client import (  # noqa: E402
    BACKEND_SIDECAR,
    DEFAULT_SIDECAR_URL,
    ENV_FALLBACK_ON_PRIMARY_FAILURE,
    ENV_SIDECAR_URL,
    SidecarUnavailable,
    fetch_via_sidecar,
    resolve_sidecar_url,
    should_fallback,
)


# ---------------------------------------------------------------------------
# resolve_sidecar_url
# ---------------------------------------------------------------------------


class ResolveSidecarUrl(unittest.TestCase):
    def test_default_when_env_unset(self):
        self.assertEqual(resolve_sidecar_url(env={}), DEFAULT_SIDECAR_URL)

    def test_env_override_respected(self):
        self.assertEqual(
            resolve_sidecar_url(env={ENV_SIDECAR_URL: "http://localhost:9999"}),
            "http://localhost:9999",
        )

    def test_trailing_slash_stripped(self):
        self.assertEqual(
            resolve_sidecar_url(env={ENV_SIDECAR_URL: "http://example:8080/"}),
            "http://example:8080",
        )

    def test_malformed_override_raises(self):
        with self.assertRaises(SidecarUnavailable):
            resolve_sidecar_url(env={ENV_SIDECAR_URL: "not-a-url"})

    def test_unsupported_scheme_raises(self):
        with self.assertRaises(SidecarUnavailable):
            resolve_sidecar_url(env={ENV_SIDECAR_URL: "ftp://example:21"})


# ---------------------------------------------------------------------------
# should_fallback
# ---------------------------------------------------------------------------


class ShouldFallback(unittest.TestCase):
    def test_no_fallback_on_clean_primary(self):
        fire, reason = should_fallback(
            {
                "ok": True,
                "cf_detection": {
                    "is_challenge": False,
                    "confidence": "none",
                    "signals": [],
                    "reason": "no Cloudflare challenge signals detected",
                },
            },
            env={},
        )
        self.assertFalse(fire)
        self.assertIn("no fallback", reason)

    def test_fallback_when_cf_detection_true(self):
        fire, reason = should_fallback(
            {
                "ok": True,
                "cf_detection": {
                    "is_challenge": True,
                    "confidence": "high",
                    "signals": ["title:just a moment"],
                    "reason": "title contains 'just a moment'",
                },
            },
            env={},
        )
        self.assertTrue(fire)
        self.assertIn("cf_detection.is_challenge=True", reason)
        self.assertIn("title:just a moment", reason)

    def test_no_fallback_on_primary_fail_by_default(self):
        # Primary failed for non-CF reasons (e.g. agent-browser missing).
        # Default: do NOT fall back — would surprise operators with
        # extra proxy traffic on every transient failure.
        fire, _reason = should_fallback(
            {
                "ok": False,
                "error": "agent-browser binary not found",
                "cf_detection": {"is_challenge": False, "signals": []},
            },
            env={},
        )
        self.assertFalse(fire)

    def test_fallback_on_primary_fail_when_env_opted_in(self):
        fire, reason = should_fallback(
            {
                "ok": False,
                "error": "agent-browser binary not found",
                "cf_detection": {"is_challenge": False, "signals": []},
            },
            env={ENV_FALLBACK_ON_PRIMARY_FAILURE: "1"},
        )
        self.assertTrue(fire)
        self.assertIn("agent-browser binary not found", reason)

    def test_fallback_decision_tolerates_missing_cf_detection(self):
        # Primary envelope without a cf_detection block should not crash.
        fire, _ = should_fallback({"ok": True}, env={})
        self.assertFalse(fire)


# ---------------------------------------------------------------------------
# fetch_via_sidecar (envelope reshape) — fully mocked
# ---------------------------------------------------------------------------


def _make_opener(*, status: int, payload: dict, capture: list | None = None):
    """Return a stub `opener` callable matching `_open_sidecar`'s signature.

    `capture` (if given) accumulates the urllib Request objects seen so a
    test can assert on the wire body / headers / method.
    """
    def _opener(req, *, read_timeout):
        if capture is not None:
            capture.append(req)
        return status, {"content-type": "application/json"}, json.dumps(payload).encode()
    return _opener


def _unreachable_opener(exc: Exception):
    def _opener(_req, *, read_timeout):
        raise SidecarUnavailable(str(exc))
    return _opener


class FetchViaSidecarHappyPath(unittest.TestCase):
    def test_returns_wrapper_envelope_shape(self):
        captured = []
        opener = _make_opener(
            status=200,
            payload={
                "ok": True,
                "status": 200,
                "url": "https://utoon.net/",
                "title": "유툰",
                "html": "<html>hello</html>",
                "headers": {"content-type": "text/html"},
                "backend": "nodriver",
                "proxy_auth_wired": True,
            },
            capture=captured,
        )
        result = fetch_via_sidecar(
            url="https://utoon.net/",
            method="GET",
            headers=[("User-Agent", "test/1.0")],
            timeout=15.0,
            sidecar_url="http://127.0.0.1:8765",
            fallback_reason="cf_detection.is_challenge=True (signals=[title:cloudflare])",
            primary_result={
                "backend": "agent-browser",
                "status": 200,
                "cf_detection": {
                    "is_challenge": True,
                    "confidence": "high",
                    "signals": ["title:cloudflare"],
                },
            },
            opener=opener,
        )

        # Wrapper-envelope keys all present
        for k in ("ok", "backend", "status", "url", "title", "html",
                  "headers", "error", "elapsed_s", "fallback"):
            self.assertIn(k, result, f"missing key {k!r}")

        self.assertTrue(result["ok"])
        self.assertEqual(result["backend"], BACKEND_SIDECAR)
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["html"], "<html>hello</html>")
        self.assertEqual(result["title"], "유툰")
        self.assertEqual(result["headers"], {"content-type": "text/html"})
        self.assertIsNone(result["error"])

        # fallback diagnostics record the trail
        fb = result["fallback"]
        self.assertTrue(fb["fired"])
        self.assertEqual(fb["sidecar_url"], "http://127.0.0.1:8765")
        self.assertEqual(fb["sidecar_backend"], "nodriver")
        self.assertEqual(fb["sidecar_http_status"], 200)
        self.assertEqual(fb["primary_backend"], "agent-browser")
        self.assertEqual(fb["primary_status"], 200)
        self.assertEqual(fb["primary_signals"], ["title:cloudflare"])
        self.assertFalse(fb["method_downgraded_to_get"])
        self.assertFalse(fb["body_dropped"])
        self.assertTrue(fb["proxy_auth_wired"])

        # The wire request should have hit POST /fetch with the expected body
        req = captured[0]
        self.assertEqual(req.get_method(), "POST")
        self.assertTrue(req.full_url.endswith("/fetch"),
                        f"unexpected endpoint {req.full_url!r}")
        body = json.loads(req.data.decode("utf-8"))
        self.assertEqual(body["url"], "https://utoon.net/")
        self.assertEqual(body["timeout"], 15.0)
        self.assertEqual(body["headers"], {"User-Agent": "test/1.0"})

    def test_passes_no_headers_field_when_no_custom_headers(self):
        captured = []
        fetch_via_sidecar(
            url="https://example.com/",
            method="GET",
            headers=[],
            timeout=10.0,
            sidecar_url="http://127.0.0.1:8765",
            opener=_make_opener(
                status=200,
                payload={"ok": True, "status": 200, "url": "https://example.com/",
                         "html": "", "headers": {}, "backend": "nodriver"},
                capture=captured,
            ),
        )
        body = json.loads(captured[0].data.decode())
        # The sidecar should not see a `headers` key at all when the
        # caller didn't pass one. This avoids triggering the sidecar's
        # `headers must be an object of string→string` validator with
        # an empty dict that would be a no-op anyway.
        self.assertNotIn("headers", body)


class FetchViaSidecarErrorPaths(unittest.TestCase):
    def test_sidecar_returns_503_queue_full(self):
        result = fetch_via_sidecar(
            url="https://utoon.net/",
            method="GET",
            timeout=30.0,
            sidecar_url="http://127.0.0.1:8765",
            opener=_make_opener(
                status=503,
                payload={
                    "ok": False,
                    "status": 503,
                    "url": "https://utoon.net/",
                    "html": "",
                    "headers": {},
                    "error": "sidecar busy: 3 active / 3 max, queued 30s without slot",
                    "backend": "queue-full",
                    "queue": {"max": 3, "active": 3, "waiting": 1,
                              "total_served": 100, "rejected_total": 5},
                },
            ),
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["backend"], BACKEND_SIDECAR)
        self.assertEqual(result["status"], 503)
        self.assertIn("queued 30s without slot", result["error"])
        self.assertEqual(result["fallback"]["sidecar_backend"], "queue-full")
        self.assertEqual(result["fallback"]["sidecar_http_status"], 503)
        # Sidecar diag fields preserved verbatim:
        self.assertEqual(result["fallback"]["queue"]["active"], 3)

    def test_sidecar_unreachable(self):
        result = fetch_via_sidecar(
            url="https://utoon.net/",
            method="GET",
            timeout=30.0,
            sidecar_url="http://127.0.0.1:8765",
            opener=_unreachable_opener(SidecarUnavailable("connection refused")),
            primary_result={
                "backend": "agent-browser",
                "status": 200,
                "cf_detection": {"is_challenge": True, "signals": ["title:cloudflare"]},
            },
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["backend"], BACKEND_SIDECAR)
        self.assertIsNone(result["status"])
        self.assertIn("connection refused", result["error"])
        self.assertEqual(result["fallback"]["sidecar_backend"], "unreachable")
        self.assertEqual(result["fallback"]["primary_signals"], ["title:cloudflare"])

    def test_sidecar_returns_garbage_body(self):
        def _bad_body_opener(_req, *, read_timeout):
            return 200, {"content-type": "application/json"}, b"<<<not json>>>"

        result = fetch_via_sidecar(
            url="https://utoon.net/",
            method="GET",
            timeout=10.0,
            sidecar_url="http://127.0.0.1:8765",
            opener=_bad_body_opener,
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["fallback"]["sidecar_backend"], "unreachable")
        self.assertIn("non-JSON", result["error"])

    def test_sidecar_returns_empty_body(self):
        def _empty_opener(_req, *, read_timeout):
            return 200, {}, b""

        result = fetch_via_sidecar(
            url="https://utoon.net/",
            method="GET",
            timeout=10.0,
            sidecar_url="http://127.0.0.1:8765",
            opener=_empty_opener,
        )
        self.assertFalse(result["ok"])
        self.assertIn("empty body", result["error"])


class FetchViaSidecarMethodDowngrade(unittest.TestCase):
    def test_post_method_downgrades_to_get_with_body_dropped(self):
        captured = []
        result = fetch_via_sidecar(
            url="https://utoon.net/api",
            method="POST",
            headers=[("Content-Type", "application/json")],
            body='{"hello": "world"}',
            timeout=20.0,
            sidecar_url="http://127.0.0.1:8765",
            opener=_make_opener(
                status=200,
                payload={
                    "ok": True, "status": 200, "url": "https://utoon.net/api",
                    "html": "{}", "headers": {}, "backend": "nodriver",
                },
                capture=captured,
            ),
        )
        self.assertTrue(result["ok"])
        fb = result["fallback"]
        self.assertTrue(fb["method_downgraded_to_get"],
                        "POST→GET downgrade must be flagged")
        self.assertTrue(fb["body_dropped"],
                        "non-empty body must be marked dropped")
        # The sidecar's POST /fetch contract has no method or body
        # field, so the wire body must NOT contain them.
        body = json.loads(captured[0].data.decode())
        self.assertNotIn("method", body)
        self.assertNotIn("body", body)


class FetchViaSidecarUrlResolution(unittest.TestCase):
    def test_resolves_url_from_env_when_not_supplied(self):
        captured = []
        with mock.patch.dict(os.environ, {ENV_SIDECAR_URL: "http://localhost:7777"}):
            fetch_via_sidecar(
                url="https://utoon.net/",
                method="GET",
                timeout=10.0,
                sidecar_url=None,  # explicit — force resolution from env
                opener=_make_opener(
                    status=200,
                    payload={"ok": True, "status": 200, "url": "https://utoon.net/",
                             "html": "", "headers": {}, "backend": "nodriver"},
                    capture=captured,
                ),
            )
        self.assertTrue(captured[0].full_url.startswith("http://localhost:7777/fetch"))

    def test_invalid_env_override_returns_unreachable_envelope(self):
        with mock.patch.dict(os.environ, {ENV_SIDECAR_URL: "garbage"}):
            result = fetch_via_sidecar(
                url="https://utoon.net/",
                method="GET",
                timeout=10.0,
                sidecar_url=None,
                # opener intentionally absent — we should never reach it.
            )
        self.assertFalse(result["ok"])
        self.assertEqual(result["backend"], BACKEND_SIDECAR)
        self.assertIn("invalid sidecar URL", result["error"])


# ---------------------------------------------------------------------------
# Contract-level checks — the wrapper relies on these holding regardless
# of which branch fired.
# ---------------------------------------------------------------------------


class FetchViaSidecarContract(unittest.TestCase):
    """Every fetch_via_sidecar return value MUST be wrapper-envelope shaped."""

    def _assert_envelope(self, env: dict):
        for k, t in (
            ("ok", bool), ("backend", str), ("url", str),
            ("title", str), ("html", str), ("headers", dict),
            ("elapsed_s", (int, float)),
        ):
            self.assertIn(k, env)
            self.assertIsInstance(env[k], t, f"{k} type {type(env[k]).__name__}")
        self.assertEqual(env["backend"], BACKEND_SIDECAR)
        self.assertIn("fallback", env)
        self.assertTrue(env["fallback"]["fired"])

    def test_happy_path_envelope_shape(self):
        result = fetch_via_sidecar(
            url="https://utoon.net/",
            method="GET",
            timeout=10.0,
            sidecar_url="http://127.0.0.1:8765",
            opener=_make_opener(
                status=200,
                payload={"ok": True, "status": 200, "url": "https://utoon.net/",
                         "html": "<html></html>", "title": "title",
                         "headers": {"x": "1"}, "backend": "nodriver"},
            ),
        )
        self._assert_envelope(result)

    def test_unreachable_envelope_shape(self):
        result = fetch_via_sidecar(
            url="https://utoon.net/",
            method="GET",
            timeout=10.0,
            sidecar_url="http://127.0.0.1:8765",
            opener=_unreachable_opener(SidecarUnavailable("nope")),
        )
        self._assert_envelope(result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
