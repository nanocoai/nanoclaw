#!/usr/bin/env python3
"""
Unit tests for cf_detect.detect_cloudflare_challenge.

Stdlib-only (unittest) so the container — which has no pytest by default —
can run the tests with `python3 -m unittest test_cf_detect`. Mirrors the
self-test inside cf_detect.py but adds coverage for the bookkeeping
contract (signals deduplication, header case-insensitivity, missing-field
tolerance) and the false-positive guard.

Run:
    cd container/skills/web-fetch
    python3 -m unittest test_cf_detect -v

Coverage matrix (Seed's `cf_signals` list):
  - title contains:   "Just a moment", "Attention required", "Cloudflare",
                      "Checking your browser", Korean "잠시만 기다리"
  - body contains:    "checking your browser", Korean "잠시만 기다리",
                      cdn-cgi/challenge-platform, challenge-form, etc.
  - HTTP 403/503 with cf-ray header
  - cf-mitigated header (any status)
  - cf-chl-bypass header
  - false positives:  bare "cloudflare" in body (no other signal),
                      cf-ray on a 200, naked 403 from non-CF origin
"""

from __future__ import annotations

import os
import sys
import unittest

# Make the sibling import work whether the test is run from this directory
# or from the repo root (`python3 -m unittest container.skills.web-fetch.test_cf_detect`
# does NOT work because the parent dir name has a hyphen — so we always
# patch sys.path with this file's directory).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cf_detect import detect_cloudflare_challenge  # noqa: E402


class TitleHeuristics(unittest.TestCase):
    """Title is the strongest single signal — `_looks_like_cf` parity."""

    def test_just_a_moment(self):
        out = detect_cloudflare_challenge({
            "title": "Just a moment...",
            "html": "<html></html>",
            "headers": {},
            "status": 200,
        })
        self.assertTrue(out["is_challenge"])
        self.assertEqual(out["confidence"], "high")
        self.assertIn("title:just a moment", out["signals"])

    def test_attention_required(self):
        out = detect_cloudflare_challenge({
            "title": "Attention Required! | Cloudflare",
            "html": "",
            "headers": {},
            "status": 403,
        })
        self.assertTrue(out["is_challenge"])
        self.assertEqual(out["confidence"], "high")

    def test_bare_cloudflare_in_title(self):
        out = detect_cloudflare_challenge({
            "title": "Cloudflare | Status",
            "html": "",
            "headers": {},
            "status": 200,
        })
        self.assertTrue(out["is_challenge"])

    def test_checking_your_browser_title(self):
        out = detect_cloudflare_challenge({
            "title": "Checking your browser before accessing example.com",
            "html": "",
            "headers": {},
            "status": 200,
        })
        self.assertTrue(out["is_challenge"])

    def test_korean_please_wait(self):
        out = detect_cloudflare_challenge({
            "title": "잠시만 기다리세요...",
            "html": "",
            "headers": {},
            "status": 200,
        })
        self.assertTrue(out["is_challenge"])
        self.assertIn("title:잠시만 기다리", out["signals"])

    def test_case_insensitive_title(self):
        out = detect_cloudflare_challenge({
            "title": "JUST A MOMENT...",
            "html": "",
            "headers": {},
            "status": 200,
        })
        self.assertTrue(out["is_challenge"])


class BodyHeuristics(unittest.TestCase):
    """Body markers are CF-specific tokens, not just the word 'cloudflare'."""

    def test_cdn_cgi_challenge_platform(self):
        out = detect_cloudflare_challenge({
            "title": "",
            "html": '<script src="/cdn-cgi/challenge-platform/h/g/foo.js"></script>',
            "headers": {},
            "status": 200,
        })
        self.assertTrue(out["is_challenge"])
        self.assertIn("body:cdn-cgi-challenge-platform", out["signals"])

    def test_challenge_form_id(self):
        out = detect_cloudflare_challenge({
            "title": "",
            "html": '<form id="challenge-form" action="...">',
            "headers": {},
            "status": 403,
        })
        self.assertTrue(out["is_challenge"])

    def test_cf_chl_opt(self):
        out = detect_cloudflare_challenge({
            "title": "",
            "html": "<script>window._cf_chl_opt = {cvId: '3'};</script>",
            "headers": {},
            "status": 200,
        })
        self.assertTrue(out["is_challenge"])

    def test_korean_body_please_wait(self):
        out = detect_cloudflare_challenge({
            "title": "",
            "html": "<html><body>잠시만 기다리세요</body></html>",
            "headers": {},
            "status": 200,
        })
        self.assertTrue(out["is_challenge"])

    def test_ddos_protection_phrase(self):
        out = detect_cloudflare_challenge({
            "title": "",
            "html": "<p>DDoS protection by Cloudflare</p>",
            "headers": {},
            "status": 503,
        })
        self.assertTrue(out["is_challenge"])


class HeaderHeuristics(unittest.TestCase):
    """Headers — strongest when set by Cloudflare's edge."""

    def test_cf_mitigated_alone(self):
        out = detect_cloudflare_challenge({
            "title": "",
            "html": "",
            # cf-mitigated alone is enough; status doesn't matter.
            "headers": {"cf-mitigated": "challenge"},
            "status": 200,
        })
        self.assertTrue(out["is_challenge"])
        self.assertEqual(out["confidence"], "high")
        self.assertIn("header:cf-mitigated", out["signals"])

    def test_cf_chl_bypass_alone(self):
        out = detect_cloudflare_challenge({
            "title": "",
            "html": "",
            "headers": {"CF-Chl-Bypass": "1"},   # mixed case → must lower
            "status": 200,
        })
        self.assertTrue(out["is_challenge"])
        self.assertIn("header:cf-chl-bypass", out["signals"])

    def test_cf_ray_with_403(self):
        out = detect_cloudflare_challenge({
            "title": "",
            "html": "",
            "headers": {"cf-ray": "8a1b2c3d4e5f6g7h-LAX"},
            "status": 403,
        })
        self.assertTrue(out["is_challenge"])
        # cf-ray is a paired-only signal so confidence is medium.
        self.assertEqual(out["confidence"], "medium")

    def test_server_cloudflare_with_503(self):
        out = detect_cloudflare_challenge({
            "title": "",
            "html": "",
            "headers": {"server": "cloudflare"},
            "status": 503,
        })
        self.assertTrue(out["is_challenge"])
        self.assertEqual(out["confidence"], "medium")

    def test_header_keys_normalised_to_lowercase(self):
        out = detect_cloudflare_challenge({
            "title": "",
            "html": "",
            "headers": {"CF-Mitigated": "challenge"},
            "status": 200,
        })
        self.assertTrue(out["is_challenge"])

    def test_cf_ray_on_200_does_not_trigger(self):
        # Many CF-fronted sites send cf-ray on EVERY response. That alone
        # is not a challenge — only paired with a bad status.
        out = detect_cloudflare_challenge({
            "title": "Some Site",
            "html": "<html></html>",
            "headers": {"cf-ray": "abc-LAX", "server": "cloudflare"},
            "status": 200,
        })
        self.assertFalse(out["is_challenge"])
        self.assertEqual(out["confidence"], "none")


class StatusOnlyDoesNotTrigger(unittest.TestCase):
    """Naked 4xx/5xx without CF context must NOT trigger fallback."""

    def test_naked_403_nginx(self):
        out = detect_cloudflare_challenge({
            "title": "Forbidden",
            "html": "<html><body>403 Forbidden</body></html>",
            "headers": {"server": "nginx"},
            "status": 403,
        })
        self.assertFalse(out["is_challenge"])

    def test_naked_503_no_headers(self):
        out = detect_cloudflare_challenge({
            "title": "Service Unavailable",
            "html": "",
            "headers": {},
            "status": 503,
        })
        self.assertFalse(out["is_challenge"])


class WeakBodyPairing(unittest.TestCase):
    """Weak markers ("Sorry, you have been blocked", "Ray ID:") only count
    when paired with a real CF signal (header or bad status)."""

    def test_sorry_blocked_with_403_and_cfray(self):
        out = detect_cloudflare_challenge({
            "title": "",
            "html": "<p>Sorry, you have been blocked</p>",
            "headers": {"cf-ray": "abc-LAX"},
            "status": 403,
        })
        self.assertTrue(out["is_challenge"])

    def test_sorry_blocked_alone_ignored(self):
        # Without any CF signal, the same phrase in a normal page is NOT
        # a challenge — could be an admin-banned-user page on any backend.
        out = detect_cloudflare_challenge({
            "title": "Banned",
            "html": "<p>Sorry, you have been blocked from this forum.</p>",
            "headers": {"server": "Apache"},
            "status": 200,
        })
        self.assertFalse(out["is_challenge"])

    def test_ray_id_phrase_alone_ignored(self):
        # "Ray ID:" appears in random text occasionally and would be a
        # bad sole signal — must require CF context.
        out = detect_cloudflare_challenge({
            "title": "Glossary",
            "html": "<dt>Ray ID:</dt><dd>something</dd>",
            "headers": {"server": "Apache"},
            "status": 200,
        })
        self.assertFalse(out["is_challenge"])


class FalsePositiveGuards(unittest.TestCase):
    """Guard cases — pages that mention CF-correlated strings in prose."""

    def test_blog_post_mentions_cloudflare_in_body_only(self):
        out = detect_cloudflare_challenge({
            "title": "How CDNs work",
            "html": "<p>An article about Cloudflare's CDN.</p>",
            "headers": {"content-type": "text/html"},
            "status": 200,
        })
        self.assertFalse(out["is_challenge"])

    def test_clean_example_com(self):
        out = detect_cloudflare_challenge({
            "title": "Example Domain",
            "html": "<p>This domain is for use in illustrative examples.</p>",
            "headers": {"content-type": "text/html"},
            "status": 200,
        })
        self.assertFalse(out["is_challenge"])

    def test_empty_envelope(self):
        out = detect_cloudflare_challenge({})
        self.assertFalse(out["is_challenge"])
        self.assertEqual(out["confidence"], "none")
        self.assertEqual(out["signals"], [])

    def test_failed_primary_envelope(self):
        out = detect_cloudflare_challenge({
            "ok": False,
            "status": None,
            "title": "",
            "html": "",
            "headers": {},
            "error": "agent-browser open failed",
        })
        self.assertFalse(out["is_challenge"])

    def test_url_encoded_cf_chl_tk_echo_in_analytics_referer(self):
        """A post-bypass page often contains a URL-encoded echo of the
        original challenge URL inside an analytics `ref=` parameter, e.g.
        `…%3F__cf_chl_tk%3D…`. That echo must NOT count as a CF signal —
        otherwise every successfully bypassed page would re-trigger
        fallback forever.

        Reproduces the pap.fr post-CF-bypass envelope that surfaced this
        false positive.
        """
        # Build HTML that ONLY contains URL-encoded echoes of the tokens.
        # All four URL-shaped tokens are exercised so the guard covers the
        # full set declared in `_URL_SHAPED_BODY_TOKENS`.
        html = (
            "<html><head><title>Real Page</title></head><body>"
            '<a href="https://piano.pap.fr/redirect?'
            "ref=https%3A%2F%2Fwww.pap.fr%2Fannonce%2Flocations-appartement"
            "-paris-75-g439%3F__cf_chl_tk%3DABCDEF-1.0.1.1-XYZ"
            "%26cf_chl_opt%3Dabc"
            "%26cf_chl_jschl_tk%3Dxyz"
            "%26_cf_chl_managed_tk%3Dqqq"
            '">tracker</a>'
            "<div>Listings here…</div>"
            "</body></html>"
        )
        out = detect_cloudflare_challenge({
            "status": 200,
            "title": "Real Page",
            "html": html,
            "headers": {"content-type": "text/html"},
        })
        self.assertFalse(
            out["is_challenge"],
            f"URL-encoded echo must not flag CF; signals={out['signals']}",
        )
        # And confidently — no signals at all.
        self.assertEqual(out["signals"], [])

    def test_raw_cf_chl_tk_still_detected(self):
        """The guard must NOT weaken detection of a real CF challenge:
        a raw (non-URL-encoded) `__cf_chl_tk` reference still fires the
        body signal."""
        html = (
            '<form id="challenge-form" '
            'action="/cdn-cgi/?__cf_chl_tk=REAL-TOKEN">'
            "</form>"
        )
        out = detect_cloudflare_challenge({
            "status": 403,
            "title": "Just a moment...",
            "html": html,
            "headers": {},
        })
        self.assertTrue(out["is_challenge"])
        self.assertIn("body:__cf_chl_tk", out["signals"])

    def test_mixed_raw_and_encoded_token_still_detected(self):
        """If a page has BOTH a real raw token AND a URL-encoded echo,
        the raw one must win (signal fires)."""
        html = (
            '<a href="https://tracker?ref=%3F__cf_chl_tk%3Decho">echo</a>'
            '<script>window.__cf_chl_tk = "real-token";</script>'
        )
        out = detect_cloudflare_challenge({
            "status": 200,
            "title": "",
            "html": html,
            "headers": {},
        })
        self.assertTrue(out["is_challenge"])
        self.assertIn("body:__cf_chl_tk", out["signals"])

    def test_cdn_cgi_jsd_telemetry_only_does_not_trigger(self):
        """Cloudflare's always-on JS Detection (JSD) telemetry script
        (`/cdn-cgi/challenge-platform/scripts/jsd/main.js`) ships on
        every CF-fronted cleared page. A page whose only CF-related
        substring is this telemetry must NOT be flagged as a challenge.
        """
        html = (
            "<html><head><title>Real Listings</title></head><body>"
            '<script>var a=document.createElement("script");'
            'a.src="/cdn-cgi/challenge-platform/scripts/jsd/main.js";'
            "document.head.appendChild(a);</script>"
            "<div>Listing card content</div>"
            "</body></html>"
        )
        out = detect_cloudflare_challenge({
            "status": 200,
            "title": "Real Listings",
            "html": html,
            "headers": {"content-type": "text/html"},
        })
        self.assertFalse(
            out["is_challenge"],
            f"JSD telemetry alone must not flag CF; signals={out['signals']}",
        )

    def test_cdn_cgi_real_challenge_path_still_fires(self):
        """A genuine interactive challenge serves under sub-paths like
        `/cdn-cgi/challenge-platform/h/g/…` — this MUST still fire."""
        html = (
            '<form id="challenge-form" '
            'action="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1">'
            "</form>"
        )
        out = detect_cloudflare_challenge({
            "status": 403,
            "title": "Just a moment...",
            "html": html,
            "headers": {},
        })
        self.assertTrue(out["is_challenge"])
        self.assertIn("body:cdn-cgi-challenge-platform", out["signals"])

    def test_cdn_cgi_jsd_telemetry_plus_real_challenge_fires(self):
        """If a page has BOTH JSD telemetry AND a real challenge sub-path,
        the real one wins."""
        html = (
            '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'
            '<a href="/cdn-cgi/challenge-platform/h/b/orchestrate/managed/v1">x</a>'
        )
        out = detect_cloudflare_challenge({
            "status": 200,
            "title": "",
            "html": html,
            "headers": {},
        })
        self.assertTrue(out["is_challenge"])
        self.assertIn("body:cdn-cgi-challenge-platform", out["signals"])


class ContractShape(unittest.TestCase):
    """Contract guarantees — keys, types, ordering."""

    def test_required_keys_always_present(self):
        for env in ({}, {"title": "Just a moment..."}, {"status": 403}):
            out = detect_cloudflare_challenge(env)
            for key in ("is_challenge", "confidence", "signals", "reason"):
                self.assertIn(key, out)
            self.assertIsInstance(out["is_challenge"], bool)
            self.assertIn(out["confidence"], {"high", "medium", "none"})
            self.assertIsInstance(out["signals"], list)
            self.assertIsInstance(out["reason"], str)

    def test_signals_dedupe_preserves_order(self):
        # Force two body tokens that both match — verify dedup.
        html = (
            '<form id="challenge-form" action="/cdn-cgi/challenge-platform/...">'
            '</form>'
        )
        out = detect_cloudflare_challenge({
            "title": "",
            "html": html,
            "headers": {},
            "status": 403,
        })
        self.assertEqual(len(out["signals"]), len(set(out["signals"])))

    def test_handles_non_dict_headers(self):
        out = detect_cloudflare_challenge({
            "title": "Just a moment...",
            "html": "",
            "headers": "not a dict",   # garbage from a buggy upstream
            "status": 200,
        })
        # Title still triggers; bad headers must not crash.
        self.assertTrue(out["is_challenge"])

    def test_handles_string_status(self):
        out = detect_cloudflare_challenge({
            "title": "",
            "html": "",
            "headers": {"cf-ray": "x", "server": "cloudflare"},
            "status": "403",   # string, not int
        })
        # Must coerce; cf-ray + server:cloudflare + 403 is a CF signal.
        self.assertTrue(out["is_challenge"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
