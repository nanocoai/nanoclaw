#!/usr/bin/env python3
"""
cf_detect — Cloudflare-challenge detector for the web-fetch wrapper.

Sub-AC 2.2 deliverable. The wrapper's primary path (Sub-AC 2.1) drives
agent-browser to fetch a URL; this module inspects the resulting envelope
(status / title / html / headers) and tells the wrapper whether the
response is a Cloudflare challenge or block — i.e. whether the next
sub-AC (2.3) should auto-fall-back to the container-local cf-fetch-server
sidecar.

Heuristic surface (matches the Seed's `container_wrapper.cf_signals`
list):

  Title (high-confidence — these strings basically only appear in CF
  interstitials):
    - "Just a moment..."
    - "Attention Required! | Cloudflare"
    - "Cloudflare"          (any-case substring)
    - "Checking your browser"
    - "잠시만 기다리"        (Korean: "Please wait a moment")

  Body (high-confidence — CF-specific tokens that benign pages do NOT
  embed by accident):
    - "/cdn-cgi/challenge-platform/"
    - "cf_chl_opt", "cf_chl_jschl_tk", "__cf_chl_tk",
      "_cf_chl_managed_tk"
    - 'id="challenge-form"' / 'id="challenge-running"'
    - "DDoS protection by Cloudflare"
    - "Sorry, you have been blocked"   (when paired with a CF marker)
    - The literal phrase "checking your browser before accessing"
    - The literal Korean phrase "잠시만 기다리" (in body, not just title)

  Headers (high-confidence — set by Cloudflare's edge):
    - "cf-mitigated"                   (value usually "challenge")
    - "cf-chl-bypass"                  (set on challenge responses)
    - "server: cloudflare" + 403/503   (block / interstitial pair)
    - "cf-ray" header + 403/503        (CF-handled HTTP error)

  Status:
    - 403 or 503 alone is NOT enough — many sites legitimately return
      these. Status only counts when paired with a CF header / body
      marker.

False-positive guard — what we deliberately do NOT trigger on:
    - the bare word "cloudflare" in body text (a blog post mentioning CF
      should pass through clean)
    - a "cf-ray" header with a 200 OK (CF served a normal page)
    - 403/503 with no CF header AND no CF body marker

Public API:
    detect_cloudflare_challenge(result: dict) -> dict
        Inspects {status, title, html, headers} and returns:
            {
              "is_challenge":  bool,        # True ⇒ caller should fall back
              "confidence":    "high" | "medium" | "none",
              "signals":       [str, ...],  # which heuristics fired (for logs)
              "reason":        str,         # one-line human summary
            }

The detector is pure and side-effect-free so it can be tested
independently of agent-browser / nodriver.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

# ---------------------------------------------------------------------------
# Heuristic tables
# ---------------------------------------------------------------------------

# Title tokens that are essentially CF-only. Matched case-insensitively
# (the title is forced to lower() before comparison).
_TITLE_TOKENS_LOWER: tuple[str, ...] = (
    "just a moment",
    "attention required",
    "cloudflare",
    "checking your browser",
)

# Title tokens that are NOT lower-cased before comparison — primarily
# non-ASCII strings whose case semantics differ.
_TITLE_TOKENS_RAW: tuple[str, ...] = (
    "잠시만 기다리",  # Korean CF interstitial: "Please wait a moment"
)

# Body markers that are unambiguously CF challenge / block infrastructure.
# Each entry is (token, label) where the label gets surfaced on the
# `signals` list so an operator can see which heuristic fired.
#
# Tokens are matched as plain substrings (case-insensitive on ASCII
# tokens, raw on the Korean string). They were picked from real CF
# interstitial source so a legitimate page that merely mentions
# "Cloudflare" in prose does NOT match.
#
# URL-shaped tokens (cf_chl_*, __cf_chl_tk, _cf_chl_managed_tk) get a
# false-positive guard — see `_URL_SHAPED_BODY_TOKENS` and
# `_token_has_raw_occurrence` below. These tokens commonly bleed into
# analytics / Piano referrer parameters as URL-encoded echoes
# (e.g. `%3F__cf_chl_tk%3D…` inside a `ref=` query value) once a real
# page successfully loads through CF; counting those echoes as a CF
# signal would force every post-bypass listing page to keep falling
# back forever. The guard only honours an occurrence that appears in a
# RAW (non-URL-encoded) context, where the preceding three characters
# do NOT look like a URL-encoded byte (`%[0-9a-f]{2}$`). A genuine
# challenge page emits the token in script source, form action, or
# inline JS — all of which are raw. A post-bypass analytics referer
# only ever contains the URL-encoded form, which the guard rejects.
_BODY_TOKENS_LOWER: tuple[tuple[str, str], ...] = (
    ("/cdn-cgi/challenge-platform/", "body:cdn-cgi-challenge-platform"),
    ("cf_chl_opt", "body:cf_chl_opt"),
    ("cf_chl_jschl_tk", "body:cf_chl_jschl_tk"),
    ("__cf_chl_tk", "body:__cf_chl_tk"),
    ("_cf_chl_managed_tk", "body:_cf_chl_managed_tk"),
    ('id="challenge-form"', "body:challenge-form"),
    ("id='challenge-form'", "body:challenge-form"),
    ('id="challenge-running"', "body:challenge-running"),
    ("ddos protection by cloudflare", "body:ddos-protection"),
    ("checking your browser before accessing", "body:checking-your-browser"),
    ("cf-browser-verification", "body:cf-browser-verification"),
    ("cf-please-wait", "body:cf-please-wait"),
    ("cf-error-details", "body:cf-error-details"),
)

# Subset of `_BODY_TOKENS_LOWER` that need the URL-encoded-echo guard.
# Anything in this set is only counted as a CF signal when at least one
# occurrence appears in a raw (non-URL-encoded) context.
_URL_SHAPED_BODY_TOKENS: frozenset[str] = frozenset({
    "cf_chl_opt",
    "cf_chl_jschl_tk",
    "__cf_chl_tk",
    "_cf_chl_managed_tk",
})

# Pre-compiled URL-encoded byte pattern (`%` followed by two hex digits)
# used by `_token_has_raw_occurrence` to reject double-URL-encoded
# analytics-referer echoes of CF challenge tokens.
_URL_ENCODED_BYTE_RE = re.compile(r"%[0-9a-f]{2}\Z")

# Cloudflare emits a JavaScript-Detection (JSD) telemetry script under
# `/cdn-cgi/challenge-platform/scripts/jsd/main.js` on EVERY page it
# fronts — including fully cleared, post-bypass pages. The bare
# substring `/cdn-cgi/challenge-platform/` therefore is NOT specific to
# an active challenge: a CF-fronted site that the user is allowed to
# read still ships this telemetry. Real interactive challenges live
# under sub-paths like `/cdn-cgi/challenge-platform/h/g/…` or
# `/cdn-cgi/challenge-platform/h/b/…` (the `h/…` family) — those should
# still fire detection.
#
# `_CDN_CGI_BENIGN_SUBPATHS` is the allow-list of suffixes that follow
# `/cdn-cgi/challenge-platform/` on cleared pages. An occurrence of the
# token followed by ANY of these suffixes is treated as benign and does
# not, on its own, count as a CF signal. The match needs at least one
# occurrence whose suffix is NOT in this list to fire — same shape as
# the URL-encoded-echo guard.
_CDN_CGI_BENIGN_SUBPATHS: tuple[str, ...] = (
    "scripts/jsd/",  # JavaScript Detection telemetry (always-on)
    "scripts/invisible.js",  # legacy invisible-challenge telemetry
)
_BODY_TOKENS_RAW: tuple[tuple[str, str], ...] = (
    ("잠시만 기다리", "body:cf-korean-please-wait"),
)

# Body markers that are CF-correlated but not exclusive on their own
# (they only count when paired with another CF signal). Kept separate so
# we never trigger on a benign blog post saying "you have been blocked".
_BODY_WEAK_TOKENS_LOWER: tuple[tuple[str, str], ...] = (
    ("sorry, you have been blocked", "body:weak:sorry-blocked"),
    ("ray id:", "body:weak:ray-id-label"),
)

# Header signals. Each entry is (header_name_lowercase,
# value_substring_lowercase_or_None, label, requires_bad_status).
#
#   value_substring=None  → presence of the header is enough
#   requires_bad_status=True → only counts when status ∈ {403, 503}
_HEADER_SIGNALS: tuple[tuple[str, str | None, str, bool], ...] = (
    ("cf-mitigated", None, "header:cf-mitigated", False),
    ("cf-chl-bypass", None, "header:cf-chl-bypass", False),
    # `cf-ray` is set on EVERY response from a CF-fronted origin, so on
    # its own it's only a hint. Pair it with a 4xx/5xx and it becomes a
    # strong fallback signal.
    ("cf-ray", None, "header:cf-ray+bad-status", True),
    ("server", "cloudflare", "header:server-cloudflare+bad-status", True),
)

# HTTP statuses that count as "bad" for the header pairing rule.
_BAD_STATUSES: frozenset[int] = frozenset({403, 503, 429, 520, 521, 522, 523, 524, 525, 526, 527})


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def detect_cloudflare_challenge(result: dict[str, Any]) -> dict[str, Any]:
    """Inspect a primary-path fetch envelope for Cloudflare-challenge signals.

    `result` is the dict returned by web_fetch._fetch_via_agent_browser:
        { ok, backend, status, url, title, html, headers, error, ... }

    The detector is tolerant of missing fields — anything absent is
    treated as "no signal". This means a primary-path that already
    failed hard (`ok=False`, no html) will simply produce
    is_challenge=False, leaving the upstream caller to decide whether
    the failure itself warrants fallback.

    Returns a stable contract:
        {
          "is_challenge": bool,
          "confidence":   "high" | "medium" | "none",
          "signals":      [str, ...],   # ordered, deduplicated
          "reason":       str,
        }
    """
    title = _safe_str(result.get("title"))
    html = _safe_str(result.get("html"))
    headers = _normalise_headers(result.get("headers"))
    status = _safe_status(result.get("status"))

    signals: list[str] = []
    reasons: list[str] = []

    # ---- Title heuristics ------------------------------------------------
    title_hit = _title_hits(title)
    if title_hit:
        signals.append(f"title:{title_hit}")
        reasons.append(f"title contains {title_hit!r}")

    # ---- Body heuristics -------------------------------------------------
    strong_body = _body_strong_hits(html)
    weak_body = _body_weak_hits(html)
    signals.extend(strong_body)
    if strong_body:
        reasons.append(f"body matched {strong_body[0]}")

    # ---- Header heuristics -----------------------------------------------
    header_hits = _header_hits(headers, status)
    signals.extend(header_hits)
    if header_hits:
        reasons.append(f"headers matched {header_hits[0]}")

    # ---- Decision --------------------------------------------------------
    # Strong signals (any of these alone trigger fallback):
    #   - title token
    #   - body strong token
    #   - cf-mitigated / cf-chl-bypass header (status-independent)
    #   - bad-status + cf-ray / server:cloudflare
    strong_header_signals = [s for s in header_hits if not s.startswith("header:cf-ray+")
                             and not s.startswith("header:server-cloudflare+")]
    paired_header_signals = [s for s in header_hits if s.startswith("header:cf-ray+")
                             or s.startswith("header:server-cloudflare+")]

    has_strong = bool(title_hit or strong_body or strong_header_signals or paired_header_signals)

    # Weak body signals (e.g. "Sorry, you have been blocked", "Ray ID:")
    # only escalate to fallback when paired with ANOTHER CF signal —
    # otherwise a page that mentions either string in prose would
    # mis-trigger.
    if weak_body:
        # Pair weak body with: (a) any header CF signal (even unpaired
        # cf-ray on a 200 isn't enough — that's why cf-ray needs bad
        # status above) — but the presence of `server: cloudflare` on a
        # 4xx/5xx is exactly the case we want to catch; or (b) a
        # bad_status, since a "Sorry, you have been blocked" page from
        # CF returns 403.
        cf_header_present = any(
            h in headers for h in ("cf-ray", "cf-mitigated", "cf-chl-bypass")
        ) or headers.get("server", "").lower() == "cloudflare"
        bad_status = status in _BAD_STATUSES
        if cf_header_present or bad_status:
            signals.extend(weak_body)
            reasons.append(f"weak body marker {weak_body[0]} paired with CF context")
            has_strong = True

    is_challenge = has_strong
    confidence = _classify_confidence(
        title_hit=title_hit,
        strong_body=strong_body,
        strong_header=strong_header_signals,
        paired_header=paired_header_signals,
        weak_body_promoted=bool(weak_body) and has_strong,
    )

    if not is_challenge:
        reason = "no Cloudflare challenge signals detected"
    else:
        reason = "; ".join(reasons) if reasons else "Cloudflare challenge signals matched"

    return {
        "is_challenge": is_challenge,
        "confidence": confidence,
        "signals": _dedupe_preserve_order(signals),
        "reason": reason,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _safe_str(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    try:
        return str(v)
    except Exception:
        return ""


def _safe_status(v: Any) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _normalise_headers(raw: Any) -> dict[str, str]:
    """Lower-case keys, stringify values. Tolerates missing / wrong types."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in raw.items():
        if not isinstance(k, str):
            continue
        out[k.lower()] = "" if v is None else str(v)
    return out


def _title_hits(title: str) -> str | None:
    """Return the first matched token (label form) or None."""
    if not title:
        return None
    tl = title.lower()
    for tok in _TITLE_TOKENS_LOWER:
        if tok in tl:
            return tok
    for tok in _TITLE_TOKENS_RAW:
        if tok in title:
            return tok
    return None


def _body_strong_hits(html: str) -> list[str]:
    """Return labels of every strong body token that matched.

    URL-shaped CF tokens (`__cf_chl_tk`, `cf_chl_opt`, `cf_chl_jschl_tk`,
    `_cf_chl_managed_tk`) are filtered through `_token_has_raw_occurrence`
    so that double-URL-encoded analytics-referer echoes (e.g.
    `%3F__cf_chl_tk%3D…` inside a Piano `ref=` parameter on a fully
    loaded post-bypass page) do NOT count as a CF signal. A real CF
    challenge always emits the token raw in script source / form action /
    inline JS, which the guard accepts. The guard never weakens detection
    of an actual CF challenge — it only rejects benign URL-encoded
    echoes.
    """
    if not html:
        return []
    body_lower = html.lower()
    hits: list[str] = []
    for tok, label in _BODY_TOKENS_LOWER:
        if tok not in body_lower:
            continue
        if tok in _URL_SHAPED_BODY_TOKENS and not _token_has_raw_occurrence(
            body_lower, tok
        ):
            # All occurrences are URL-encoded analytics echoes — skip.
            continue
        if tok == "/cdn-cgi/challenge-platform/" and not _cdn_cgi_has_challenge_occurrence(
            body_lower
        ):
            # Every occurrence is the always-on JSD telemetry script that
            # CF injects on cleared pages — not an active challenge.
            continue
        hits.append(label)
    for tok, label in _BODY_TOKENS_RAW:
        if tok in html:
            hits.append(label)
    return hits


def _cdn_cgi_has_challenge_occurrence(body_lower: str) -> bool:
    """Return True when at least one `/cdn-cgi/challenge-platform/`
    occurrence is followed by something OTHER than CF's always-on
    telemetry sub-paths (`scripts/jsd/`, `scripts/invisible.js`).

    A real interactive challenge serves additional sub-paths under
    `/cdn-cgi/challenge-platform/` (typically `h/g/…`, `h/b/…`, or a
    bare query-string-only URL), and a fully cleared page only carries
    the JSD telemetry script. This guard suppresses the latter so a
    successfully bypassed CF-fronted page does not re-trigger fallback
    forever.
    """
    token = "/cdn-cgi/challenge-platform/"
    n = len(token)
    idx = 0
    while True:
        i = body_lower.find(token, idx)
        if i < 0:
            return False
        suffix = body_lower[i + n: i + n + 32]
        if not any(suffix.startswith(b) for b in _CDN_CGI_BENIGN_SUBPATHS):
            return True
        idx = i + n


def _token_has_raw_occurrence(body_lower: str, token: str) -> bool:
    """Return True when at least one occurrence of `token` in `body_lower`
    appears outside a URL-encoded byte sequence.

    A "raw" occurrence is one whose preceding 3 characters do NOT match
    the URL-encoded-byte pattern `%[0-9a-f]{2}` — i.e. it's not the tail
    of a `%xx` triplet.

    The guard exists to suppress false positives from analytics referer
    echoes (e.g. Piano's `ref=https%3A%2F%2F…%3F__cf_chl_tk%3D…`) that
    a legit page emits AFTER a CF bypass succeeds. Such echoes only ever
    appear in URL-encoded form. A genuine CF challenge page emits the
    token raw in script source / form action / inline JS, which always
    has a non-URL-encoded preceding context.

    Body must already be lower-cased (caller's responsibility) since the
    URL-encoded-byte regex is lower-case-only.
    """
    idx = 0
    n = len(token)
    while True:
        i = body_lower.find(token, idx)
        if i < 0:
            return False
        prev = body_lower[max(0, i - 3): i]
        if not _URL_ENCODED_BYTE_RE.search(prev):
            return True
        idx = i + n


def _body_weak_hits(html: str) -> list[str]:
    if not html:
        return []
    body_lower = html.lower()
    hits: list[str] = []
    for tok, label in _BODY_WEAK_TOKENS_LOWER:
        if tok in body_lower:
            hits.append(label)
    return hits


def _header_hits(headers: dict[str, str], status: int | None) -> list[str]:
    if not headers:
        return []
    bad_status = status is not None and status in _BAD_STATUSES
    out: list[str] = []
    for name, expected_value, label, requires_bad in _HEADER_SIGNALS:
        if name not in headers:
            continue
        if requires_bad and not bad_status:
            continue
        if expected_value is None:
            out.append(label)
            continue
        # Substring (case-insensitive) match on the value, e.g.
        # "server: cloudflare" matching "cloudflare".
        if expected_value in headers[name].lower():
            out.append(label)
    return out


def _classify_confidence(
    *,
    title_hit: str | None,
    strong_body: Iterable[str],
    strong_header: Iterable[str],
    paired_header: Iterable[str],
    weak_body_promoted: bool,
) -> str:
    """Return 'high' / 'medium' / 'none'.

    high   — at least one DEFINITIVE signal:
                title match, strong body marker, or unpaired CF header
                (cf-mitigated / cf-chl-bypass).
    medium — only paired signals (bad status + cf-ray / server:cloudflare),
                or a weak body marker promoted by paired CF context.
    none   — no signals at all.
    """
    if title_hit or any(strong_body) or any(strong_header):
        return "high"
    if any(paired_header) or weak_body_promoted:
        return "medium"
    return "none"


def _dedupe_preserve_order(items: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for it in items:
        if it not in seen:
            seen.add(it)
            out.append(it)
    return out


# ---------------------------------------------------------------------------
# Self-test (executed when run as a script: `python3 cf_detect.py --self-test`)
# ---------------------------------------------------------------------------


def _self_test() -> int:  # pragma: no cover — exercised manually / in CI
    """Lightweight built-in test runner so the detector can be sanity-checked
    without pytest installed in the container.

    Returns 0 on success, 1 on the first failure. Designed to be cheap so
    the install.sh / build pipeline can run it as a smoke test.
    """
    cases: list[tuple[str, dict[str, Any], bool, str]] = [
        # --- positives (must trigger fallback) -------------------------
        (
            "title:just-a-moment",
            {
                "status": 200,
                "title": "Just a moment...",
                "html": "<html><body>...</body></html>",
                "headers": {},
            },
            True,
            "high",
        ),
        (
            "title:attention-required-cloudflare",
            {
                "status": 403,
                "title": "Attention Required! | Cloudflare",
                "html": "<html></html>",
                "headers": {"server": "cloudflare"},
            },
            True,
            "high",
        ),
        (
            "title:korean-please-wait",
            {
                "status": 200,
                "title": "잠시만 기다리세요...",
                "html": "<html></html>",
                "headers": {},
            },
            True,
            "high",
        ),
        (
            "body:cdn-cgi-challenge-platform",
            {
                "status": 200,
                "title": "Loading",
                "html": "<script src='/cdn-cgi/challenge-platform/h/g/foo.js'></script>",
                "headers": {},
            },
            True,
            "high",
        ),
        (
            "body:challenge-form",
            {
                "status": 403,
                "title": "",
                "html": '<form id="challenge-form" action="/cdn-cgi/...">',
                "headers": {},
            },
            True,
            "high",
        ),
        (
            "header:cf-mitigated",
            {
                "status": 200,  # cf-mitigated alone is enough — status doesn't matter
                "title": "",
                "html": "",
                "headers": {"Cf-Mitigated": "challenge"},
            },
            True,
            "high",
        ),
        (
            "header:cf-ray-with-403",
            {
                "status": 403,
                "title": "",
                "html": "",
                "headers": {"cf-ray": "8a1b2c3d4e5f6g7h-LAX", "server": "cloudflare"},
            },
            True,
            # cf-ray needs status pairing, server:cloudflare also pairs;
            # both are "paired-only" header signals so confidence=medium.
            "medium",
        ),
        (
            "weak-body:sorry-blocked-with-403",
            {
                "status": 403,
                "title": "",
                "html": "<html><body>Sorry, you have been blocked</body></html>",
                "headers": {"cf-ray": "abc-LAX"},
            },
            True,
            # cf-ray + 403 already paired (medium), weak body just adds context
            "medium",
        ),
        (
            "korean-body-please-wait",
            {
                "status": 200,
                "title": "",
                "html": "<html><body>잠시만 기다리세요</body></html>",
                "headers": {},
            },
            True,
            "high",
        ),
        # --- negatives (must NOT trigger fallback) ---------------------
        (
            "clean-example.com",
            {
                "status": 200,
                "title": "Example Domain",
                "html": "<html><body>This domain is for use in illustrative examples...</body></html>",
                "headers": {"content-type": "text/html"},
            },
            False,
            "none",
        ),
        (
            "blog-post-mentions-cloudflare-in-body-but-not-title",
            {
                "status": 200,
                "title": "How Cloudflare's CDN works",
                # Title contains "Cloudflare" — this IS a true positive of
                # our heuristic. Cloudflare appearing in a TITLE is rare
                # outside CF interstitials. We document this trade-off:
                # the user's CLAUDE.md / SKILL.md will note that pages
                # whose title literally contains "Cloudflare" will be
                # routed through the sidecar fallback, which is safe
                # (just slower). Keep this case OUT of the negative set.
                "html": "<html><body>An article about <b>Cloudflare</b>'s CDN.</body></html>",
                "headers": {"content-type": "text/html"},
            },
            True,  # title contains "Cloudflare"
            "high",
        ),
        (
            "blog-post-cloudflare-only-in-body",
            {
                "status": 200,
                "title": "How a CDN works",
                "html": "<html><body>An article about Cloudflare's CDN. The cf-ray header...</body></html>",
                "headers": {"content-type": "text/html"},
            },
            False,
            "none",
        ),
        (
            "cf-ray-on-200-OK-passes-through",
            {
                "status": 200,
                "title": "Some Site",
                "html": "<html></html>",
                "headers": {"cf-ray": "abc-LAX", "server": "cloudflare"},
            },
            False,
            "none",
        ),
        (
            "naked-403-no-cf-context",
            {
                "status": 403,
                "title": "Forbidden",
                "html": "<html><body>403 Forbidden</body></html>",
                "headers": {"server": "nginx"},
            },
            False,
            "none",
        ),
        (
            "naked-503-no-cf-context",
            {
                "status": 503,
                "title": "Service Unavailable",
                "html": "<html></html>",
                "headers": {"server": "nginx"},
            },
            False,
            "none",
        ),
        (
            "primary-path-failed-empty-envelope",
            {
                "ok": False,
                "status": None,
                "title": "",
                "html": "",
                "headers": {},
                "error": "agent-browser open failed",
            },
            False,
            "none",
        ),
        (
            "missing-fields-tolerated",
            {},
            False,
            "none",
        ),
    ]

    failed = 0
    for name, env, expect_challenge, expect_conf in cases:
        out = detect_cloudflare_challenge(env)
        ok = (out["is_challenge"] is expect_challenge) and (out["confidence"] == expect_conf)
        marker = "OK  " if ok else "FAIL"
        print(f"[{marker}] {name}: is_challenge={out['is_challenge']} "
              f"confidence={out['confidence']} signals={out['signals']}")
        if not ok:
            failed += 1
            print(
                f"       expected is_challenge={expect_challenge} "
                f"confidence={expect_conf}; reason={out['reason']!r}"
            )
    if failed:
        print(f"\n{failed} self-test case(s) failed")
        return 1
    print(f"\nAll {len(cases)} self-test cases passed")
    return 0


if __name__ == "__main__":  # pragma: no cover
    import sys

    if "--self-test" in sys.argv:
        sys.exit(_self_test())
    print(__doc__)
