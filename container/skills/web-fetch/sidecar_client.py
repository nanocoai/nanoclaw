#!/usr/bin/env python3
"""
sidecar_client — container-local cf-fetch-server fallback for web-fetch.

Sub-AC 2.3 deliverable. The wrapper's primary path (Sub-AC 2.1) drives
agent-browser, and Sub-AC 2.2's `cf_detect.detect_cloudflare_challenge()`
tags every primary-path envelope with a Cloudflare verdict. This module
turns that verdict into action: it forwards the request to the container-local
`cf-fetch-server` sidecar (running at `http://127.0.0.1:8765`) and reshapes the sidecar response
into the same envelope the primary path returns, so the LLM-facing
contract stays uniform.

Design constraints (from the Seed):

  - The agent must NOT have to choose between two runtimes — the wrapper
    decides automatically based on cf_detection signals.
  - Webshare proxy credentials are consumed only by the sidecar process.
    This module therefore NEVER reads HTTP_PROXY_URL, NEVER receives webshare
    credentials over the wire, and NEVER prints credential material.
  - The sidecar lives in the same container by default. For tests or custom
    deployments the address is overridable via $CF_FETCH_SIDECAR_URL.
  - Fetch-only — no interactive automation. The sidecar's /fetch endpoint
    only supports GET semantics, so non-GET methods downgrade to GET on
    the fallback path with the body silently dropped (and a clear note
    in the response envelope so the agent can see what happened).
  - Latency budget — sidecar's warm browser is supposed to land repeats
    under 2s. We stay out of that budget by keeping the network round-trip
    minimal: a single POST /fetch call, no retries, no probing, the
    request timeout we receive plus a few seconds of socket headroom.

Public surface:

    SidecarUnavailable               Exception raised when the sidecar URL
                                     cannot be resolved or the HTTP call
                                     fails before yielding a useful body.
    resolve_sidecar_url(default=...) -> str
    should_fallback(primary_result, *, env=None) -> tuple[bool, str]
    fetch_via_sidecar(*, url, method, headers, body, timeout, sidecar_url,
                      primary_result=None) -> dict

The returned envelope from `fetch_via_sidecar` matches the primary path's
shape exactly (`ok`, `backend`, `status`, `url`, `title`, `html`,
`headers`, `error`, `elapsed_s`, `cf_detection`) plus a `fallback` field
that records why the fallback fired and which sidecar served the request.
The wrapper then re-runs `cf_detect.detect_cloudflare_challenge()` on the
sidecar envelope so the contract is consistent end-to-end.
"""

from __future__ import annotations

import json
import os
import socket
import time
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlparse

# The sidecar lives on the loopback host alias and must NOT be tunnelled
# through any HTTP_PROXY/HTTPS_PROXY the surrounding harness (e.g. OneCLI
# credential gateway) injects into the container. Use an opener with an
# empty ProxyHandler so urllib bypasses env-based proxies for every call.
_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_SIDECAR_URL = "http://127.0.0.1:8765"

ENV_SIDECAR_URL = "CF_FETCH_SIDECAR_URL"

# Env flag that lets the operator opt-in to falling back even when the
# primary path failed for non-CF reasons (e.g. agent-browser binary missing
# in the container). Off by default — the Seed makes CF detection the
# primary trigger so we don't surprise the operator with extra proxy
# traffic on every transient failure.
ENV_FALLBACK_ON_PRIMARY_FAILURE = "CF_FALLBACK_ON_PRIMARY_FAILURE"

# Backend label embedded in the JSON response for fallback results. The
# downstream agent / log scrapers use this to distinguish primary-path
# from sidecar responses. Keep in lock-step with web_fetch.BACKEND_AGENT_BROWSER.
BACKEND_SIDECAR = "cf-fetch-server"

# Connection-establish timeout. We don't want to block the wrapper for
# the full per-request timeout if the sidecar is simply down — fail fast
# so the agent gets a clear "sidecar unreachable" error envelope instead
# of a 30s wall.
DEFAULT_CONNECT_TIMEOUT_S = 5.0

# Headroom we add on top of the per-request timeout to cover the sidecar's
# own internal CF-resolution polling. The sidecar runs verify_cf() with
# its own polling loop so the HTTP-level read timeout has to be larger
# than the requested fetch timeout. 10s matches server.py's
# `_do_fetch_once` buffer.
READ_TIMEOUT_HEADROOM_S = 10.0


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class SidecarUnavailable(RuntimeError):
    """Raised when the sidecar HTTP endpoint cannot be reached at all.

    Distinct from "sidecar replied with a 503" — a 503 still carries a
    structured envelope we can show the agent. SidecarUnavailable means
    the network round-trip failed (connection refused, DNS unresolved,
    socket timeout) and we have nothing useful to forward.
    """


# ---------------------------------------------------------------------------
# URL resolution + fallback decision
# ---------------------------------------------------------------------------


def resolve_sidecar_url(*, default: str = DEFAULT_SIDECAR_URL,
                        env: dict[str, str] | None = None) -> str:
    """Return the sidecar's base URL.

    Resolution order:
      1. $CF_FETCH_SIDECAR_URL  — explicit operator/test override
      2. `default`              — 127.0.0.1:8765

    The returned URL has no trailing slash. We deliberately do NOT probe
    the sidecar here — the caller may legitimately want to construct a
    URL for diagnostics without paying a network round-trip.
    """
    src = env if env is not None else os.environ
    raw = (src.get(ENV_SIDECAR_URL) or "").strip()
    url = raw or default
    if url.endswith("/"):
        url = url.rstrip("/")
    # Sanity-check the URL shape so a malformed env override surfaces as
    # a usage error (with a clean message) rather than as a cryptic
    # urllib failure later.
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise SidecarUnavailable(
            f"invalid sidecar URL {url!r} "
            f"(set ${ENV_SIDECAR_URL} to e.g. http://127.0.0.1:8765)"
        )
    return url


def should_fallback(primary_result: dict[str, Any], *,
                    env: dict[str, str] | None = None) -> tuple[bool, str]:
    """Decide whether to fall back to the sidecar.

    The contract is intentionally narrow:

      - `cf_detection.is_challenge=True` ⇒ fallback (the Seed's auto-
        detection is the whole reason this code exists).
      - $CF_FALLBACK_ON_PRIMARY_FAILURE=1 AND `ok=false` ⇒ fallback.
        Off by default. Useful for environments where agent-browser is
        intentionally unavailable (e.g. a container without the npm
        package installed) and the sidecar should be the de-facto
        primary path.

    Returns (fire, reason) so the caller can log a single line that
    explains the decision regardless of which branch fired.
    """
    src = env if env is not None else os.environ

    cf = primary_result.get("cf_detection") or {}
    if cf.get("is_challenge") is True:
        signals = cf.get("signals") or []
        # Keep the reason terse — it's used in the fallback record and
        # in operator logs. Trim very long signal lists so a noisy CF
        # response doesn't bloat the envelope.
        sig_str = ", ".join(str(s) for s in signals[:4])
        return True, (
            f"cf_detection.is_challenge=True (confidence={cf.get('confidence')!r}, "
            f"signals=[{sig_str}])"
        )

    if (src.get(ENV_FALLBACK_ON_PRIMARY_FAILURE) or "").strip() in ("1", "true", "yes"):
        if primary_result.get("ok") is False:
            err = primary_result.get("error") or "primary path failed without an error message"
            return True, f"primary path failed and ${ENV_FALLBACK_ON_PRIMARY_FAILURE}=1 ({err})"

    return False, "no fallback condition matched"


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------


def _build_request(*, sidecar_url: str, url: str,
                   timeout: float, headers: list[tuple[str, str]] | dict[str, str],
                   user_agent: str) -> urllib.request.Request:
    """Construct the urllib Request that hits the sidecar's POST /fetch.

    The sidecar's POST contract is `{url, timeout?, headers?}`. We
    serialise the LLM-supplied request headers into the `headers` field
    so the sidecar can replay them via CDP setExtraHTTPHeaders. The
    sidecar does NOT need (and does NOT receive) the webshare proxy URL.
    """
    endpoint = sidecar_url.rstrip("/") + "/fetch"

    # Coerce headers to {str: str}. The wrapper's CLI already validated
    # keys are strings, but we accept either the list-of-pairs form
    # (`web_fetch._parse_headers`) or a plain dict for callers who
    # construct envelopes programmatically.
    if isinstance(headers, dict):
        hdr_pairs = list(headers.items())
    else:
        hdr_pairs = list(headers)
    hdr_dict = {str(k): str(v) for k, v in hdr_pairs if k}

    body = json.dumps({
        "url": url,
        "timeout": float(timeout),
        # Forward only if non-empty so the sidecar's body validator
        # (which rejects an empty headers map's keys) doesn't get a
        # spurious payload.
        **({"headers": hdr_dict} if hdr_dict else {}),
    }).encode("utf-8")

    req = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            # User-Agent identifies traffic in /tmp/cf-fetch-server.log so
            # an operator can tell sidecar requests sourced from the
            # container wrapper apart from manual curl probes.
            "User-Agent": user_agent,
        },
    )
    return req


def _open_sidecar(req: urllib.request.Request, *,
                  read_timeout: float) -> tuple[int, dict[str, str], bytes]:
    """POST to the sidecar and return (status, headers_lower, body_bytes).

    Network errors raise SidecarUnavailable. HTTP errors (4xx/5xx) are
    NOT raised — we still want to surface the structured error body the
    sidecar returns (e.g. queue-full 503).
    """
    try:
        resp = _NO_PROXY_OPENER.open(req, timeout=read_timeout)
    except urllib.error.HTTPError as e:
        # The sidecar returned a non-2xx with a JSON body. Read it so we
        # can preserve its `error`/`backend` fields in the wrapper
        # envelope.
        try:
            body = e.read()
        except Exception:
            body = b""
        hdrs = {k.lower(): v for k, v in (e.headers.items() if e.headers else [])}
        return int(e.code), hdrs, body
    except urllib.error.URLError as e:
        # Connection refused, DNS failure, etc. — wrap and let the caller
        # produce a structured error envelope.
        raise SidecarUnavailable(f"sidecar URL unreachable: {e.reason}") from e
    except (TimeoutError, socket.timeout) as e:
        raise SidecarUnavailable(f"sidecar request timed out after {read_timeout}s: {e}") from e
    except OSError as e:
        # Includes ConnectionResetError / ConnectionAbortedError /
        # BrokenPipeError on some platforms when the sidecar dies
        # mid-handshake.
        raise SidecarUnavailable(f"sidecar request failed: {e}") from e

    try:
        body = resp.read()
    except Exception as e:
        raise SidecarUnavailable(f"sidecar response read failed: {e}") from e
    finally:
        try:
            resp.close()
        except Exception:
            pass

    hdrs = {k.lower(): v for k, v in resp.headers.items()} if resp.headers else {}
    return int(resp.status), hdrs, body


def _parse_sidecar_body(raw: bytes) -> tuple[dict[str, Any] | None, str | None]:
    """Decode the sidecar's JSON body. Returns (parsed, error_msg)."""
    if not raw:
        return None, "sidecar returned an empty body"
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        return None, f"sidecar body is not utf-8: {e}"
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        return None, f"sidecar returned non-JSON ({e}): {text[:200]!r}"
    if not isinstance(parsed, dict):
        return None, f"sidecar JSON body is not an object: type={type(parsed).__name__}"
    return parsed, None


# ---------------------------------------------------------------------------
# Envelope reshape
# ---------------------------------------------------------------------------


def _reshape_to_wrapper_envelope(
    *,
    sidecar_payload: dict[str, Any],
    http_status: int,
    requested_url: str,
    method: str,
    body_dropped: bool,
    started: float,
    sidecar_url: str,
    fallback_reason: str,
    primary_result: dict[str, Any] | None,
) -> dict[str, Any]:
    """Translate the sidecar's POST /fetch response shape into the wrapper's
    canonical envelope.

    Sidecar shape:
        { ok, status, url, title, html, headers, backend, error?, ... }

    Wrapper shape (matches web_fetch._fetch_via_agent_browser):
        { ok, backend, status, url, title, html, headers, error,
          elapsed_s, cf_detection?, fallback }

    `cf_detection` is intentionally NOT computed here — the caller
    re-runs cf_detect.detect_cloudflare_challenge() on the reshape
    output so the contract stays single-sourced. We just preserve the
    sidecar's own diagnostic fields (proxy_auth_wired, queue) inside
    the `fallback` record so an operator can debug end-to-end without
    cross-referencing logs.
    """
    sidecar_status = sidecar_payload.get("status")
    if sidecar_status is None:
        sidecar_status = http_status
    try:
        status_int: int | None = int(sidecar_status)
    except (TypeError, ValueError):
        status_int = None

    sidecar_ok = bool(sidecar_payload.get("ok"))
    error = sidecar_payload.get("error")
    if not sidecar_ok and not error:
        error = f"sidecar returned non-ok response (status={status_int}, http={http_status})"

    primary_cf = (primary_result or {}).get("cf_detection") or {}
    primary_signals = list(primary_cf.get("signals") or [])
    primary_status = (primary_result or {}).get("status")
    primary_backend = (primary_result or {}).get("backend")

    fallback_record = {
        "fired": True,
        "reason": fallback_reason,
        "sidecar_url": sidecar_url,
        "sidecar_backend": sidecar_payload.get("backend"),
        "sidecar_http_status": http_status,
        "primary_backend": primary_backend,
        "primary_status": primary_status,
        "primary_signals": primary_signals,
        "method_downgraded_to_get": method.upper() != "GET",
        "body_dropped": body_dropped,
    }
    # Optional sidecar diagnostics — surface only if the sidecar set them.
    for diag_key in ("proxy_auth_wired", "queue", "retried_after_restart"):
        if diag_key in sidecar_payload:
            fallback_record[diag_key] = sidecar_payload[diag_key]

    headers_out = sidecar_payload.get("headers") or {}
    if not isinstance(headers_out, dict):
        headers_out = {}

    envelope = {
        "ok": sidecar_ok,
        "backend": BACKEND_SIDECAR,
        "status": status_int,
        "url": sidecar_payload.get("url") or requested_url,
        "title": sidecar_payload.get("title") or "",
        "html": sidecar_payload.get("html") or "",
        "headers": headers_out,
        "error": error,
        "elapsed_s": round(time.time() - started, 3),
        "fallback": fallback_record,
    }
    return envelope


def _build_unreachable_envelope(
    *,
    requested_url: str,
    method: str,
    body_dropped: bool,
    started: float,
    sidecar_url: str,
    fallback_reason: str,
    primary_result: dict[str, Any] | None,
    error: str,
) -> dict[str, Any]:
    """Envelope returned when the sidecar can't be reached at all.

    Same shape as a normal sidecar reply so the agent's parser does NOT
    need to special-case "the sidecar is down" — it just sees ok=false
    with a clear error string and `fallback.fired=true`.
    """
    primary_cf = (primary_result or {}).get("cf_detection") or {}
    return {
        "ok": False,
        "backend": BACKEND_SIDECAR,
        "status": None,
        "url": requested_url,
        "title": "",
        "html": "",
        "headers": {},
        "error": error,
        "elapsed_s": round(time.time() - started, 3),
        "fallback": {
            "fired": True,
            "reason": fallback_reason,
            "sidecar_url": sidecar_url,
            "sidecar_backend": "unreachable",
            "sidecar_http_status": None,
            "primary_backend": (primary_result or {}).get("backend"),
            "primary_status": (primary_result or {}).get("status"),
            "primary_signals": list(primary_cf.get("signals") or []),
            "method_downgraded_to_get": method.upper() != "GET",
            "body_dropped": body_dropped,
        },
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def fetch_via_sidecar(
    *,
    url: str,
    method: str = "GET",
    headers: list[tuple[str, str]] | dict[str, str] | None = None,
    body: str | None = None,
    timeout: float = 30.0,
    sidecar_url: str | None = None,
    fallback_reason: str = "fallback fired",
    primary_result: dict[str, Any] | None = None,
    user_agent: str = "nanoclaw-web-fetch/2.3 (+sidecar-client)",
    opener: Any = None,  # for tests — drop-in replacement for _open_sidecar
) -> dict[str, Any]:
    """Forward a fetch to the container-local cf-fetch-server sidecar and return
    a wrapper-shaped envelope.

    The caller is expected to have already decided that fallback is
    appropriate (via `should_fallback`) — this function does NOT inspect
    the primary result to second-guess that decision. It does record
    `primary_result` inside the `fallback` field for diagnostics.

    Non-GET methods are accepted (so the wrapper's CLI surface stays
    uniform) but downgraded to GET on the sidecar — the sidecar's
    /fetch endpoint is GET-shaped only. The downgrade is recorded in
    `fallback.method_downgraded_to_get`.

    Network failures produce an `ok=false` envelope with the same shape
    as a normal sidecar reply so the agent has one parser to write.

    `opener` exists purely for unit tests: pass a callable
    `(req, *, read_timeout) -> (status, headers, body_bytes)` to bypass
    the urllib path entirely.
    """
    started = time.time()

    if sidecar_url is None:
        try:
            sidecar_url = resolve_sidecar_url()
        except SidecarUnavailable as e:
            return _build_unreachable_envelope(
                requested_url=url,
                method=method,
                body_dropped=bool(body),
                started=started,
                sidecar_url="(unset)",
                fallback_reason=fallback_reason,
                primary_result=primary_result,
                error=str(e),
            )

    method_upper = (method or "GET").upper()
    body_dropped = method_upper != "GET" and bool(body)

    req = _build_request(
        sidecar_url=sidecar_url,
        url=url,
        timeout=timeout,
        headers=headers or [],
        user_agent=user_agent,
    )

    # The sidecar runs verify_cf() internally with its own polling loop,
    # so the HTTP read timeout has to leave room for that. We mirror the
    # `max(timeout + 10, 30)` budget server.py uses internally.
    read_timeout = max(timeout + READ_TIMEOUT_HEADROOM_S, 30.0)

    runner = opener if opener is not None else _open_sidecar
    try:
        http_status, _resp_headers, raw_body = runner(req, read_timeout=read_timeout)
    except SidecarUnavailable as e:
        return _build_unreachable_envelope(
            requested_url=url,
            method=method,
            body_dropped=body_dropped,
            started=started,
            sidecar_url=sidecar_url,
            fallback_reason=fallback_reason,
            primary_result=primary_result,
            error=f"sidecar unreachable: {e}",
        )

    parsed, parse_err = _parse_sidecar_body(raw_body)
    if parsed is None:
        return _build_unreachable_envelope(
            requested_url=url,
            method=method,
            body_dropped=body_dropped,
            started=started,
            sidecar_url=sidecar_url,
            fallback_reason=fallback_reason,
            primary_result=primary_result,
            error=parse_err or "sidecar returned an unparseable body",
        )

    return _reshape_to_wrapper_envelope(
        sidecar_payload=parsed,
        http_status=http_status,
        requested_url=url,
        method=method_upper,
        body_dropped=body_dropped,
        started=started,
        sidecar_url=sidecar_url,
        fallback_reason=fallback_reason,
        primary_result=primary_result,
    )
