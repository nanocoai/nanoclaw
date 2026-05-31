#!/usr/bin/env python3
# pyright: reportMissingTypeArgument=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportAttributeAccessIssue=false, reportIncompatibleMethodOverride=false
"""
cf-fetch-server — container-local Cloudflare-bypass fetch sidecar for NanoClaw.

Binds 127.0.0.1 only (loopback — never exposed beyond the container) and is
started by the Docker entrypoint before the agent runner.

Endpoints:
- GET  /healthz      — liveness probe (pid, host, port, uptime, backend)
- POST /fetch        — JSON body {url, timeout?, headers?} → {status, html, headers, ...}
- GET  /fetch?url=…  — convenience GET form (kept so curl-style probes still work)

Backend (Sub-AC 1.1.2):
- A persistent nodriver Browser is launched at startup on a dedicated asyncio
  event-loop thread. The browser stays warm between requests so that the
  first request after sidecar boot lands under 5s and repeats land under 2s
  (cold-start per-request is rejected by the Seed's latency budget).
- Webshare residential-proxy credentials are loaded from `HTTP_PROXY_URL`,
  which may be passed into the container as a key-only secret passthrough.
- Cloudflare challenges are detected via title heuristics (Just a moment /
  Attention required / Cloudflare) and resolved via nodriver's verify_cf()
  helper. The pattern is ported from
  .claude/skills/request-proxy/request_proxy.py::_visit_page_async.
- If nodriver / pyvirtualdisplay are not importable, the sidecar degrades to
  a stub backend (backend="stub") so the HTTP contract remains stable.
"""

import json
import os
import sys
import signal
import time
import threading
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HOST = os.environ.get("CF_FETCH_SERVER_HOST", "127.0.0.1")
PORT = int(os.environ.get("CF_FETCH_SERVER_PORT", "8765"))
ENV_FILE = os.environ.get("CF_FETCH_SERVER_ENV_FILE", "")

# Cap on the JSON body the POST /fetch endpoint will read. The body is small
# by design — just {url, timeout, headers} — so anything larger is malformed
# or hostile. 256 KiB leaves generous headroom for big custom-headers maps.
MAX_BODY_BYTES = int(os.environ.get("CF_FETCH_SERVER_MAX_BODY", str(256 * 1024)))

# Default per-request timeout if the client doesn't pass one. The real
# nodriver-backed _do_fetch() honours this; the stub just round-trips it.
DEFAULT_TIMEOUT_S = float(os.environ.get("CF_FETCH_SERVER_DEFAULT_TIMEOUT", "30"))

# Time we'll wait for the warm browser to launch on startup before giving up
# and degrading to stub mode.
BROWSER_LAUNCH_TIMEOUT_S = float(os.environ.get("CF_FETCH_SERVER_BROWSER_LAUNCH_TIMEOUT", "60"))

# ---------------------------------------------------------------------------
# Sub-AC 1.1.4 — Long-lived process management knobs
# ---------------------------------------------------------------------------
#
# (a) Concurrency / queueing
#
# nodriver drives a single Chromium process on a single asyncio loop, so
# unbounded /fetch concurrency would just queue inside the loop with no
# backpressure to the HTTP client (the requesting agent in the container
# would time out without ever knowing it was queued). MAX_CONCURRENT caps
# the number of /fetch operations that can be in-flight on the warm browser
# simultaneously; QUEUE_WAIT_S is how long an arriving request will block
# for a slot before the sidecar returns 503 and lets the client decide.
#
# Default (3) is conservative on purpose: each in-flight tab is its own
# CDP session against the same Chromium process and CF challenge-solving
# briefly drives the renderer hot, so over-parallelising hurts latency
# more than serial requests do.
MAX_CONCURRENT = max(1, int(os.environ.get("CF_FETCH_SERVER_MAX_CONCURRENT", "3")))
QUEUE_WAIT_S = float(os.environ.get("CF_FETCH_SERVER_QUEUE_WAIT", "30"))

# (b) Browser watchdog
#
# Period (seconds) at which a background thread checks whether the warm
# browser is still alive and restarts it if it isn't. 0 disables the
# watchdog (useful for tests / foreground debugging where you want a
# crash to be permanent so it surfaces).
WATCHDOG_INTERVAL_S = float(os.environ.get("CF_FETCH_SERVER_WATCHDOG_INTERVAL", "30"))

# (c) Shutdown drain
#
# When SIGTERM/SIGINT arrives we let in-flight /fetch requests finish for
# up to this long before forcing the HTTP server to close.
SHUTDOWN_DRAIN_S = float(os.environ.get("CF_FETCH_SERVER_SHUTDOWN_DRAIN", "10"))

# (d) Per-fetch retry-after-crash budget
#
# If _do_fetch detects the warm browser crashed mid-request we attempt one
# automatic restart + retry. Capped to one because verify_cf can take many
# seconds and we don't want a hung browser to multiply that out.
FETCH_RETRY_AFTER_RESTART = True

# Single shutdown signal shared by the HTTP server, the watchdog thread,
# and any future long-lived helpers. Set in _install_signal_handlers.
_SHUTDOWN_EVENT = threading.Event()


def _log(msg: str) -> None:
    print(f"[cf-fetch-server] {msg}", flush=True)


def _load_env_file(path: str) -> None:
    """Tiny dotenv loader. Only sets vars that are not already in os.environ.

    This loader is kept for foreground/dev runs where the user explicitly
    passes CF_FETCH_SERVER_ENV_FILE.

    Webshare proxy creds MUST NOT be hardcoded in source.
    """
    if not path or not os.path.isfile(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
        _log(f"loaded env from {path}")
    except Exception as e:
        _log(f"env load failed ({path}): {e}")


# ---------------------------------------------------------------------------
# Webshare proxy wiring (Sub-AC 1.1.3)
# ---------------------------------------------------------------------------
#
# A single Webshare residential-proxy URL can be wired into the nodriver
# browser context so every request leaves the host through the rotating
# proxy. The raw URL is read from HTTP_PROXY_URL and never returned to the
# wrapper, health response, or Docker command arguments.
#
# Rotation strategy:
#   - Webshare's residential proxy rotates exit IPs per TCP connection.
#   - Each /fetch opens a NEW tab on the warm browser (`browser.get(...,
#     new_tab=True)`), so each request gets fresh sockets and therefore a
#     fresh exit IP without restarting the browser. This satisfies the Seed
#     latency budget (warm browser stays up between requests, <2s repeats).
#   - For sticky-session use cases (e.g. login flows) the operator can put a
#     `-session-{id}` suffix in the username portion of HTTP_PROXY_URL —
#     no code change needed; we pass the parsed user/pass through verbatim
#     to the CDP Fetch.continueWithAuth handler.
#
# Per-tab proxy auth is wired via the Chrome DevTools Protocol's Fetch
# domain (`Fetch.enable(handle_auth_requests=True)` + `Fetch.requestPaused`
# + `Fetch.authRequired`). Chromium's `--proxy-server` flag does not accept
# embedded credentials in the proxy URL — the
# credentials must be supplied at runtime via this CDP auth handshake.


def _parse_proxy_url(raw: str) -> dict | None:
    """Parse HTTP_PROXY_URL into the components nodriver needs.

    Returns a dict {scheme, host, port, user, pass, browser_arg} or None if
    the URL is empty / unparseable. The returned `browser_arg` is the
    Chromium `--proxy-server=...` value WITHOUT credentials — Chromium
    rejects embedded creds and leaks them to logs anyway. Creds get fed in
    at runtime through the CDP `Fetch.continueWithAuth` handler.
    """
    s = (raw or "").strip()
    if not s:
        return None
    try:
        from urllib.parse import urlparse
        p = urlparse(s)
    except Exception:
        return None
    host = p.hostname
    port = p.port
    if not host or not port:
        return None
    scheme = (p.scheme or "http").lower()
    if scheme not in {"http", "https", "socks5", "socks4"}:
        # Unknown scheme — assume http so Chromium understands it.
        scheme = "http"
    return {
        "scheme": scheme,
        "host": host,
        "port": int(port),
        "user": p.username,
        "pass": p.password,
        "browser_arg": f"{scheme}://{host}:{port}",
    }


def _redact_proxy(parsed: dict | None) -> str:
    """Format a proxy info dict for logs without leaking credentials."""
    if not parsed:
        return "(none)"
    user = parsed.get("user")
    user_disp = f"{user[:2]}***" if user else "(no-auth)"
    return f"{parsed['scheme']}://{user_disp}@{parsed['host']}:{parsed['port']}"


# ---------------------------------------------------------------------------
# Persistent nodriver browser lifecycle
# ---------------------------------------------------------------------------

class _BrowserState:
    """Holds the warm nodriver browser and its dedicated asyncio loop.

    Mirrors the RequestProxy._global_browser pattern: a daemon thread runs an
    asyncio loop, all browser ops are scheduled onto it via
    asyncio.run_coroutine_threadsafe. HTTP request threads call into it
    serially-safe because each /fetch opens its own tab.
    """

    def __init__(self) -> None:
        self.browser = None  # nodriver.Browser | None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.thread: threading.Thread | None = None
        self.xvfb = None
        self.proxy_user: str | None = None
        self.proxy_pass: str | None = None
        self.proxy_url: str | None = None
        self.proxy_parsed: dict | None = None
        self.start_error: str | None = None
        # Long-lived-process bookkeeping (Sub-AC 1.1.4):
        #  - last_started_ts: when the current warm browser came up. Surfaced
        #    on /healthz so an operator can tell "browser uptime" from
        #    "process uptime".
        #  - restart_count: how many times the watchdog (or _do_fetch's
        #    on-crash retry) has had to bring the browser back. Surfaced on
        #    /healthz so a noisy underlying crash gets caught before it
        #    becomes a Verification G regression.
        #  - missing_deps: True iff nodriver/pyvirtualdisplay aren't
        #    importable. Lets the watchdog skip restart attempts that would
        #    just thrash.
        self.last_started_ts: float | None = None
        self.restart_count: int = 0
        self.missing_deps: bool = False
        # Serialise startup/shutdown; concurrent /fetch calls do not need a
        # lock here because each request opens its own tab on the warm
        # browser (the underlying loop is single-threaded and naturally
        # serialises CDP I/O).
        self._lock = threading.Lock()

    @property
    def ready(self) -> bool:
        return self.browser is not None and self.loop is not None and self.loop.is_running()

    def is_alive(self) -> bool:
        """Best-effort liveness check used by the watchdog and the on-crash
        retry path in _do_fetch.

        nodriver's Browser exposes a `stopped` boolean once the underlying
        Chromium process has exited (or been killed). That, plus the
        usual ready/loop checks, catches the common crash modes (Chromium
        OOM, SIGSEGV, manual `kill -9`).
        """
        if not self.ready:
            return False
        if self.browser is None:
            return False
        try:
            if bool(getattr(self.browser, "stopped", False)):
                return False
        except Exception:
            return False
        if self.thread is not None and not self.thread.is_alive():
            return False
        return True

    def start(self) -> None:
        with self._lock:
            if self.ready:
                return
            self._start_locked()

    def restart(self) -> bool:
        """Tear down the warm browser (if any) and bring up a fresh one.

        Used by the watchdog thread on a detected crash and by _do_fetch's
        on-crash retry path. Returns True iff the browser is ready after
        the cycle. Safe to call concurrently — _lock serialises it with
        start()/stop()/other restart() calls.
        """
        with self._lock:
            self.restart_count += 1
            n = self.restart_count
            _log(f"restarting warm browser (restart #{n})")
            self._stop_locked()
            # Reset any previous start_error so /healthz reflects the new
            # attempt's outcome rather than a stale failure message.
            self.start_error = None
            self._start_locked()
            ok = self.ready
        _log(f"restart #{n} {'succeeded' if ok else 'failed'}")
        return ok

    def _start_locked(self) -> None:
        try:
            import nodriver as uc  # noqa: F401 — import-check only
            from pyvirtualdisplay import Display  # noqa: F401
            self.missing_deps = False
        except ImportError as e:
            self.missing_deps = True
            self.start_error = (
                f"nodriver/pyvirtualdisplay not importable on this Python "
                f"({sys.executable}): {e}. Backend will run in stub mode."
            )
            _log(self.start_error)
            return

        # Resolve webshare proxy URL from env. HTTP_PROXY_URL may be injected
        # as a key-only container env passthrough; unparseable values fall
        # through to "no proxy" rather than crashing browser launch.
        raw_proxy = os.getenv("HTTP_PROXY_URL") or ""
        self.proxy_url = raw_proxy.strip() or None
        self.proxy_parsed = _parse_proxy_url(raw_proxy)
        browser_args: list[str] = []
        if self.proxy_parsed:
            self.proxy_user = self.proxy_parsed.get("user")
            self.proxy_pass = self.proxy_parsed.get("pass")
            # Chromium: --proxy-server gets host:port only; creds get injected
            # later via CDP Fetch.continueWithAuth (per-tab in
            # _visit_page_async). Chrome already keeps loopback and link-local
            # traffic direct via its implicit proxy-bypass rules.
            browser_args.append(f"--proxy-server={self.proxy_parsed['browser_arg']}")
            _log(
                f"proxy configured (rotating per-tab): "
                f"{_redact_proxy(self.proxy_parsed)}"
            )
            if not (self.proxy_user and self.proxy_pass):
                _log("proxy has no credentials embedded; auth handler will be skipped")
        elif self.proxy_url:
            # Raw env var was set but didn't parse — surface the failure
            # loudly so `/healthz`'s proxy_configured=false isn't a silent
            # mystery.
            _log("proxy parse failed: HTTP_PROXY_URL is malformed; continuing without proxy")
            self.proxy_user = None
            self.proxy_pass = None
        else:
            _log("no HTTP_PROXY_URL set; running without proxy (CF bypass disabled)")

        # XVFB is Linux-only. macOS launches headed (no display server needed).
        # The Seed accepts macOS-only deployment, so this path mirrors
        # RequestProxy's `if sys.platform == 'darwin': use_xvfb = False`.
        use_xvfb_env = (os.getenv("NODRIVER_USE_XVFB") or "").lower()
        use_xvfb = use_xvfb_env not in {"0", "false", "no"}
        if sys.platform == "darwin":
            use_xvfb = False
        if use_xvfb:
            try:
                from pyvirtualdisplay import Display
                xvfb_w = int(os.getenv("XVFB_WIDTH", "1920"))
                xvfb_h = int(os.getenv("XVFB_HEIGHT", "1080"))
                xvfb_d = int(os.getenv("XVFB_DEPTH", "24"))
                self.xvfb = Display(visible=False, size=(xvfb_w, xvfb_h), color_depth=xvfb_d)
                self.xvfb.start()
                _log(f"xvfb started DISPLAY={os.getenv('DISPLAY')}")
            except Exception as e:
                _log(f"xvfb start failed: {e}; continuing without xvfb")
                self.xvfb = None

        # Spin up the dedicated event loop.
        self.loop = asyncio.new_event_loop()

        def _runner() -> None:
            asyncio.set_event_loop(self.loop)
            try:
                self.loop.run_forever()
            finally:
                # Drain any remaining scheduled callbacks before close().
                try:
                    pending = asyncio.all_tasks(self.loop)
                    for t in pending:
                        t.cancel()
                except Exception:
                    pass

        self.thread = threading.Thread(
            target=_runner, name="cf-fetch-nodriver-loop", daemon=True
        )
        self.thread.start()

        async def _launch():
            import nodriver as uc
            try:
                return await uc.start(headless=False, browser_args=browser_args, sandbox=False)
            except TypeError:
                # Older nodriver builds use `args=` instead of `browser_args=`.
                return await uc.start(headless=False, args=browser_args, sandbox=False)

        try:
            fut = asyncio.run_coroutine_threadsafe(_launch(), self.loop)
            self.browser = fut.result(timeout=BROWSER_LAUNCH_TIMEOUT_S)
        except Exception as e:
            self.start_error = f"nodriver browser launch failed: {e!r}"
            _log(self.start_error)
            self._teardown_loop()
            return

        # Open a keep-alive tab so the browser doesn't auto-close when the
        # last fetch tab is closed (mirrors RequestProxy._ensure_keepalive).
        async def _keepalive():
            try:
                await self.browser.get("about:blank")
            except Exception:
                pass

        try:
            asyncio.run_coroutine_threadsafe(_keepalive(), self.loop).result(timeout=10)
        except Exception as e:
            _log(f"keep-alive tab failed (non-fatal): {e}")

        self.last_started_ts = time.time()
        _log(f"nodriver browser ready (proxy={'on' if self.proxy_url else 'off'})")

    def _teardown_loop(self) -> None:
        if self.loop:
            try:
                self.loop.call_soon_threadsafe(self.loop.stop)
            except Exception:
                pass
        if self.thread:
            self.thread.join(timeout=5)
            self.thread = None
        self.loop = None

    def stop(self) -> None:
        with self._lock:
            self._stop_locked()

    def _stop_locked(self) -> None:
        """Lock-held variant of stop(). Reused by restart() so we don't
        deadlock on self._lock by calling stop() then start()."""
        if self.browser and self.loop:
            async def _close():
                try:
                    await self.browser.close()
                except Exception:
                    pass
                # nodriver versions: some expose .crush(), others .stop()
                for closer in ("crush", "stop"):
                    fn = getattr(self.browser, closer, None)
                    if callable(fn):
                        try:
                            res = fn()
                            if asyncio.iscoroutine(res):
                                await res
                        except Exception:
                            pass
                        break
            try:
                asyncio.run_coroutine_threadsafe(_close(), self.loop).result(timeout=10)
            except Exception:
                pass
        self.browser = None
        self._teardown_loop()
        if self.xvfb:
            try:
                self.xvfb.stop()
            except Exception:
                pass
            self.xvfb = None
        self.last_started_ts = None
        _log("nodriver browser stopped")


_BROWSER = _BrowserState()


# ---------------------------------------------------------------------------
# Concurrency gate (Sub-AC 1.1.4 — request queueing / concurrency limits)
# ---------------------------------------------------------------------------

class _ConcurrencyGate:
    """Bounded semaphore wrapper with introspection for /healthz.

    Each /fetch handler acquires a slot before driving the warm browser.
    If MAX_CONCURRENT slots are already in use the handler blocks for up
    to QUEUE_WAIT_S; if the slot still isn't available it returns 503 to
    the caller so the container wrapper can decide whether to retry.

    Why a gate at all when the browser already serialises CDP I/O?
      - Each /fetch opens a fresh tab, so without a cap N concurrent
        requests spawn N concurrent tabs and N concurrent verify_cf()
        loops. That fans out CPU on the host AND eats N proxy-rotation
        slots on Webshare. Capping this protects both budgets.
      - Without backpressure to the HTTP client, the requesting agent in
        the container would never know it was queued — it would just
        time out waiting on a hung response. Returning 503 after
        QUEUE_WAIT_S lets the agent degrade gracefully (e.g. fall back
        to the agent-browser path or retry later).

    `total_served` and `rejected_total` are monotonic counters surfaced
    on /healthz so an operator can spot pile-ups before they become
    user-visible.
    """

    def __init__(self, max_concurrent: int):
        self.max = max_concurrent
        self._sem = threading.BoundedSemaphore(max_concurrent)
        self._lock = threading.Lock()
        self.active = 0
        self.waiting = 0
        self.total_served = 0
        self.rejected_total = 0

    def acquire(self, timeout: float) -> bool:
        with self._lock:
            self.waiting += 1
        try:
            ok = self._sem.acquire(timeout=timeout)
        except Exception:
            ok = False
        with self._lock:
            self.waiting -= 1
            if ok:
                self.active += 1
                self.total_served += 1
            else:
                self.rejected_total += 1
        return ok

    def release(self) -> None:
        try:
            self._sem.release()
        except ValueError:
            # release() called more than acquire() — should not happen but
            # don't crash the request thread if it does.
            return
        with self._lock:
            self.active = max(0, self.active - 1)

    def stats(self) -> dict:
        with self._lock:
            return {
                "max": self.max,
                "active": self.active,
                "waiting": self.waiting,
                "total_served": self.total_served,
                "rejected_total": self.rejected_total,
            }


_GATE = _ConcurrencyGate(MAX_CONCURRENT)


def _drain_inflight(timeout: float) -> int:
    """Wait up to `timeout` seconds for in-flight /fetch requests to finish.

    Returns the number still in flight after the wait. Polled (not signalled)
    because the gate's release path is synchronous to request-handler
    completion and the cost of a 200ms poll is negligible during shutdown.
    """
    deadline = time.time() + max(0.0, timeout)
    while time.time() < deadline:
        active = _GATE.stats()["active"]
        if active <= 0:
            return 0
        time.sleep(0.2)
    return _GATE.stats()["active"]


# ---------------------------------------------------------------------------
# Browser watchdog (Sub-AC 1.1.4 — crash recovery)
# ---------------------------------------------------------------------------

def _watchdog_loop() -> None:
    """Periodically check warm-browser liveness and restart on death.

    Runs as a daemon thread, exits when _SHUTDOWN_EVENT is set. Skips
    restart attempts when the backend is in stub mode (nodriver missing)
    so that a Python with no deps doesn't spin forever trying to bootstrap
    a browser that can never launch.
    """
    if WATCHDOG_INTERVAL_S <= 0:
        _log("watchdog disabled (CF_FETCH_SERVER_WATCHDOG_INTERVAL <= 0)")
        return
    _log(f"watchdog started (interval={WATCHDOG_INTERVAL_S}s)")
    while not _SHUTDOWN_EVENT.is_set():
        # wait() returns True early if the event got set — that's our exit.
        if _SHUTDOWN_EVENT.wait(timeout=WATCHDOG_INTERVAL_S):
            break
        if _BROWSER.missing_deps:
            # Stub mode: no point watchdogging a missing dep.
            continue
        if _BROWSER.is_alive():
            continue
        _log("watchdog: warm browser appears dead; attempting restart")
        try:
            _BROWSER.restart()
        except Exception as e:
            _log(f"watchdog: restart raised: {e!r}")
    _log("watchdog stopped")


def _start_watchdog() -> threading.Thread | None:
    if WATCHDOG_INTERVAL_S <= 0:
        return None
    t = threading.Thread(target=_watchdog_loop, name="cf-fetch-watchdog", daemon=True)
    t.start()
    return t


# ---------------------------------------------------------------------------
# Cloudflare detection + page-visit logic (ported from RequestProxy)
# ---------------------------------------------------------------------------

_CF_TITLE_TOKENS_LOWER = (
    "just a moment",
    "attention required",
    "cloudflare",
    "checking your browser",
)
# Korean (and other non-ASCII) tokens are matched against the raw title
# rather than the lower-cased copy because casing semantics differ.
_CF_TITLE_TOKENS_RAW = (
    "잠시만 기다리",   # "Please wait a moment" — CF Korean interstitial
)


def _looks_like_cf(title: str) -> bool:
    if not title:
        return False
    tl = title.lower()
    if any(tok in tl for tok in _CF_TITLE_TOKENS_LOWER):
        return True
    if any(tok in title for tok in _CF_TITLE_TOKENS_RAW):
        return True
    return False


async def _visit_page_async(browser, url: str, timeout: float,
                            extra_headers: dict,
                            proxy_user: str | None,
                            proxy_pass: str | None) -> dict:
    """Open a fresh tab, navigate, resolve CF challenge, return rendered HTML.

    Returns a dict in the cf-fetch-server response shape (status/html/headers
    plus diagnostic fields). Raises on hard failure — caller maps to 500.
    """
    tab = None
    page = None
    try:
        if browser.stopped:
            raise RuntimeError("nodriver browser is stopped")

        # Always open a NEW tab so the keep-alive tab is preserved and
        # concurrent /fetch calls don't trample each other's navigation.
        tab = await browser.get("about:blank", new_tab=True)

        # Wire CDP fetch-auth handler if the browser is talking to an
        # authenticated webshare proxy. Per-request handler (per tab) so
        # rotation works: a new tab → new TCP connections → fresh exit IP.
        # Pattern matches RequestProxy._visit_page_async.
        proxy_auth_wired = False
        if proxy_user and proxy_pass:
            try:
                from nodriver.cdp import fetch as cdp_fetch

                async def _on_auth(event):
                    await tab.send(
                        cdp_fetch.continue_with_auth(
                            request_id=event.request_id,
                            auth_challenge_response=cdp_fetch.AuthChallengeResponse(
                                response="ProvideCredentials",
                                username=proxy_user,
                                password=proxy_pass,
                            ),
                        )
                    )

                async def _on_paused(event):
                    await tab.send(cdp_fetch.continue_request(request_id=event.request_id))

                tab.add_handler(cdp_fetch.RequestPaused,
                                lambda ev: asyncio.create_task(_on_paused(ev)))
                tab.add_handler(cdp_fetch.AuthRequired,
                                lambda ev: asyncio.create_task(_on_auth(ev)))
                await tab.send(cdp_fetch.enable(handle_auth_requests=True))
                proxy_auth_wired = True
            except Exception as e:
                _log(f"proxy auth wiring failed (non-fatal): {e}")

        # Optional extra headers: best-effort via CDP setExtraHTTPHeaders.
        if extra_headers:
            try:
                from nodriver.cdp import network as cdp_network
                await tab.send(cdp_network.set_extra_http_headers(headers=extra_headers))
            except Exception as e:
                _log(f"extra headers wiring failed (non-fatal): {e}")

        # Use tab.get rather than browser.get so we stay in this tab's context.
        page = await tab.get(url)

        # Cloudflare-resolution loop. Budget = min(timeout, NODRIVER_MAX_WAIT).
        # Only entered when CF is actually detected — otherwise we extract
        # immediately. The Seed budget is <5s for the first request, <2s for
        # repeats, so we cannot afford an unconditional 5s sleep on the
        # happy path.
        max_wait = float(os.getenv("NODRIVER_MAX_WAIT", "20"))
        max_wait = min(max_wait, max(1.0, timeout - 5.0))
        step = 5.0
        try:
            title_now = await page.evaluate("document.title || ''")
        except Exception:
            title_now = ""

        if _looks_like_cf(title_now):
            try:
                _log(f"CF challenge detected; title='{title_now}'. Running verify_cf()...")
                try:
                    await page.verify_cf()
                except TypeError:
                    await page.verify_cf(True)
                _log("verify_cf() returned")
            except Exception as e:
                _log(f"verify_cf failed (will keep polling): {e}")

            waited = 0.0
            while waited < max_wait:
                await asyncio.sleep(step)
                try:
                    title_now = await page.evaluate("document.title || ''")
                except Exception:
                    title_now = ""
                if not _looks_like_cf(title_now):
                    _log(f"CF cleared after {waited:.1f}s; title='{title_now}'")
                    break
                waited += step
                _log(f"still behind CF after {waited:.1f}s; title='{title_now}'")
                try:
                    try:
                        await page.verify_cf(flash=True)
                    except TypeError:
                        await page.verify_cf(True)
                except Exception as e:
                    _log(f"verify_cf retry failed: {e}")

        # Final extraction.
        page_title = ""
        try:
            page_title = await page.title()
        except Exception:
            try:
                page_title = await page.evaluate("document.title || ''")
            except Exception:
                page_title = ""

        html = ""
        try:
            html = await page.evaluate(
                "document.documentElement ? document.documentElement.outerHTML : ''"
            )
        except Exception:
            try:
                html = await page.evaluate("new XMLSerializer().serializeToString(document)")
            except Exception:
                html = ""

        # Status: 200 if we got body or title, 503 if the page came up empty
        # (typical of a still-pending CF challenge or proxy auth failure).
        # If the final title still looks like CF, surface that as 503 so the
        # container wrapper knows the bypass didn't clear.
        if html or page_title:
            status = 503 if _looks_like_cf(page_title) else 200
        else:
            status = 503
        ok = (status == 200)

        return {
            "ok": ok,
            "status": status,
            "url": url,
            "title": page_title,
            "html": html or "",
            "headers": {
                "Content-Type": "text/html; charset=utf-8",
                "X-Page-Title": page_title,
            },
            "backend": "nodriver",
            "proxy_auth_wired": proxy_auth_wired,
        }

    finally:
        # Tab cleanup — never raise out of finally.
        if tab is not None:
            try:
                await tab.close()
            except Exception:
                pass
        if page is not None and page is not tab:
            try:
                await page.close()
            except Exception:
                pass


def _looks_like_browser_crash(exc: BaseException) -> bool:
    """Classify a _do_fetch exception as a probable browser-process crash.

    On a real crash nodriver tends to surface ConnectionResetError /
    ConnectionAbortedError / RuntimeError("websocket is closed"). We
    err on the side of restarting (false positives just cost one extra
    browser launch) because the alternative — silently falling back to
    stub mode for the rest of the sidecar's lifetime — is worse.
    """
    if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
        return True
    msg = (str(exc) or repr(exc)).lower()
    crash_tokens = (
        "websocket",
        "connection closed",
        "connection lost",
        "browser closed",
        "browser stopped",
        "browser is stopped",
        "browser process died",
        "target closed",
        "session closed",
    )
    return any(tok in msg for tok in crash_tokens)


def _do_fetch_once(url: str, timeout: float, headers: dict) -> dict:
    """Single attempt at the warm-browser fetch path. Caller handles retry."""
    fut = asyncio.run_coroutine_threadsafe(
        _visit_page_async(
            _BROWSER.browser, url, timeout, headers or {},
            _BROWSER.proxy_user, _BROWSER.proxy_pass,
        ),
        _BROWSER.loop,
    )
    # Add a small buffer over the per-request timeout to cover the
    # CF-resolution polling loop's last sleep.
    return fut.result(timeout=max(timeout + 10.0, 30.0))


def _do_fetch(url: str, timeout: float, headers: dict) -> dict:
    """Fetch `url` through the warm nodriver browser, with CF resolution.

    Falls back to a structured stub envelope if the browser is unavailable
    (e.g. nodriver isn't installed) so the sidecar stays useful and the
    contract shape is preserved.

    Sub-AC 1.1.4 crash recovery:
      - If the warm browser isn't ready and the deps ARE installed, we ask
        for one restart attempt before bailing out (covers the "watchdog
        hasn't ticked yet" race).
      - If a fetch raises something that looks like a browser-process
        crash, we restart the browser and retry the fetch ONCE. Repeated
        crashes degrade to the failure envelope so the caller can decide.
    """
    # Fast-path stub: deps not importable, no point trying to restart.
    if _BROWSER.missing_deps:
        return {
            "ok": False,
            "status": 503,
            "url": url,
            "title": "",
            "html": "",
            "headers": {},
            "timeout": timeout,
            "request_headers": headers or {},
            "error": _BROWSER.start_error or "nodriver browser not importable",
            "backend": "stub",
        }

    # Browser temporarily down (e.g. crash between watchdog ticks). Try a
    # restart inline so the caller doesn't see a transient 503.
    if not _BROWSER.ready:
        _log("backend not ready at fetch time; attempting inline restart")
        _BROWSER.restart()
        if not _BROWSER.ready:
            return {
                "ok": False,
                "status": 503,
                "url": url,
                "title": "",
                "html": "",
                "headers": {},
                "timeout": timeout,
                "request_headers": headers or {},
                "error": _BROWSER.start_error or "nodriver browser not ready",
                "backend": "stub",
            }

    try:
        return _do_fetch_once(url, timeout, headers)
    except Exception as e:
        crashed = _looks_like_browser_crash(e) or not _BROWSER.is_alive()
        if FETCH_RETRY_AFTER_RESTART and crashed:
            _log(f"_do_fetch: crash detected ({e!r}); restarting and retrying once")
            try:
                _BROWSER.restart()
            except Exception as e2:
                _log(f"_do_fetch: restart raised: {e2!r}")
            if _BROWSER.ready:
                try:
                    return _do_fetch_once(url, timeout, headers)
                except Exception as e3:
                    _log(f"_do_fetch retry-after-restart raised: {e3!r}")
                    return {
                        "ok": False,
                        "status": 502,
                        "url": url,
                        "title": "",
                        "html": "",
                        "headers": {},
                        "error": f"nodriver fetch failed twice (post-restart): {e3}",
                        "backend": "nodriver-error",
                        "retried_after_restart": True,
                    }
        _log(f"_do_fetch backend raised: {e!r}")
        return {
            "ok": False,
            "status": 502,
            "url": url,
            "title": "",
            "html": "",
            "headers": {},
            "error": f"nodriver fetch failed: {e}",
            "backend": "nodriver-error",
        }


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------

class _Handler(BaseHTTPRequestHandler):
    server_version = "cf-fetch-server/0.2"

    def log_message(self, fmt, *args):  # noqa: N802 — stdlib hook
        # Route stdlib's access log through our prefix.
        sys.stderr.write("[cf-fetch-server.access] %s - %s\n" %
                         (self.address_string(), fmt % args))
        sys.stderr.flush()

    # ---------- response helpers ----------

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # Client gave up before we wrote — don't crash the server thread.
            pass

    def _read_json_body(self) -> tuple[dict | None, str | None]:
        """Read & parse the JSON request body. Returns (parsed, error_msg)."""
        raw_len = self.headers.get("Content-Length", "")
        try:
            length = int(raw_len) if raw_len else 0
        except ValueError:
            return None, "invalid Content-Length header"
        if length <= 0:
            return None, "empty request body"
        if length > MAX_BODY_BYTES:
            return None, f"body too large (>{MAX_BODY_BYTES} bytes)"
        try:
            raw = self.rfile.read(length)
        except Exception as e:
            return None, f"read failed: {e}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except UnicodeDecodeError as e:
            return None, f"body is not utf-8: {e}"
        except json.JSONDecodeError as e:
            return None, f"invalid json: {e}"
        if not isinstance(data, dict):
            return None, "json body must be an object"
        return data, None

    # ---------- payload normalisers ----------

    @staticmethod
    def _coerce_timeout(raw, default: float) -> tuple[float | None, str | None]:
        if raw is None:
            return default, None
        try:
            t = float(raw)
        except (TypeError, ValueError):
            return None, "timeout must be a number (seconds)"
        if t <= 0:
            return None, "timeout must be > 0"
        # Hard cap so a runaway client can't pin the warm browser forever.
        if t > 300:
            t = 300.0
        return t, None

    @staticmethod
    def _coerce_headers(raw) -> tuple[dict | None, str | None]:
        if raw is None:
            return {}, None
        if not isinstance(raw, dict):
            return None, "headers must be an object of string→string"
        out: dict[str, str] = {}
        for k, v in raw.items():
            if not isinstance(k, str):
                return None, "header keys must be strings"
            if not isinstance(v, (str, int, float)):
                return None, f"header value for {k!r} must be a string"
            out[k] = str(v)
        return out, None

    def _backend_label(self) -> str:
        return "nodriver" if _BROWSER.ready else "stub"

    def _gated_fetch(self, url: str, timeout: float, headers: dict) -> tuple[int, dict]:
        """Acquire a concurrency slot, run _do_fetch, release. Returns
        (http_status, json_body)."""
        # During shutdown drain we refuse new work — otherwise a flood of
        # late requests could keep the server alive past the drain budget.
        if _SHUTDOWN_EVENT.is_set():
            return 503, {
                "ok": False,
                "status": 503,
                "url": url,
                "html": "",
                "headers": {},
                "error": "sidecar is shutting down",
                "backend": "shutdown",
            }
        if not _GATE.acquire(timeout=QUEUE_WAIT_S):
            stats = _GATE.stats()
            _log(
                f"queue full: rejecting {url!r} "
                f"(active={stats['active']}, waiting={stats['waiting']}, "
                f"max={stats['max']})"
            )
            return 503, {
                "ok": False,
                "status": 503,
                "url": url,
                "html": "",
                "headers": {},
                "error": (
                    f"sidecar busy: {stats['active']} active / "
                    f"{stats['max']} max, queued {QUEUE_WAIT_S}s without slot"
                ),
                "backend": "queue-full",
                "queue": stats,
            }
        try:
            try:
                result = _do_fetch(url, timeout, headers)
            except Exception as e:
                _log(f"_gated_fetch: backend raised: {e!r}")
                return 500, {
                    "ok": False,
                    "status": 500,
                    "url": url,
                    "html": "",
                    "headers": {},
                    "error": f"fetch backend raised: {e}",
                    "backend": "error",
                }
        finally:
            _GATE.release()

        result.setdefault("status", 200 if result.get("ok") else 503)
        result.setdefault("html", "")
        result.setdefault("headers", {})
        if result.get("ok"):
            http_status = 200
        else:
            http_status = int(result.get("status") or 503)
        return http_status, result

    # ---------- request dispatch ----------

    def do_GET(self):  # noqa: N802 — stdlib hook
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            # Proxy diagnostics: surface enough for the operator to verify the
            # wiring (host + scheme + has_auth) WITHOUT leaking the user/pass.
            # Sub-AC 1.1.3 — credential isolation principle from the Seed.
            pp = _BROWSER.proxy_parsed
            proxy_diag = None
            if pp:
                proxy_diag = {
                    "scheme": pp["scheme"],
                    "host": pp["host"],
                    "port": pp["port"],
                    "has_auth": bool(pp.get("user") and pp.get("pass")),
                }
            # Sub-AC 1.1.4 diagnostics: surface restart counter + queue
            # stats so an operator (or a watchdog) can spot pile-ups before
            # they become user-visible. browser_uptime_s is None iff the
            # browser isn't currently up.
            browser_uptime = None
            if _BROWSER.last_started_ts is not None:
                browser_uptime = round(time.time() - _BROWSER.last_started_ts, 3)
            self._send_json(200, {
                "ok": True,
                "service": "cf-fetch-server",
                "pid": os.getpid(),
                "host": HOST,
                "port": PORT,
                "uptime_s": round(time.time() - _START_TS, 3),
                "backend": self._backend_label(),
                "browser_ready": _BROWSER.ready,
                "browser_error": _BROWSER.start_error,
                "browser_uptime_s": browser_uptime,
                "browser_restarts": _BROWSER.restart_count,
                "proxy_configured": bool(_BROWSER.proxy_url),
                "proxy": proxy_diag,
                "concurrency": _GATE.stats(),
                "shutting_down": _SHUTDOWN_EVENT.is_set(),
            })
            return
        if parsed.path == "/fetch":
            qs = parse_qs(parsed.query)
            url = (qs.get("url") or [""])[0]
            if not url:
                self._send_json(400, {
                    "ok": False,
                    "status": 400,
                    "html": "",
                    "headers": {},
                    "error": "missing ?url=",
                })
                return
            timeout = DEFAULT_TIMEOUT_S
            try:
                if "timeout" in qs:
                    timeout = float(qs["timeout"][0])
            except ValueError:
                self._send_json(400, {
                    "ok": False,
                    "status": 400,
                    "html": "",
                    "headers": {},
                    "error": "timeout must be a number",
                })
                return
            http_status, result = self._gated_fetch(url, timeout, {})
            self._send_json(http_status, result)
            return
        self._send_json(404, {"ok": False, "error": f"unknown path {parsed.path}"})

    def do_POST(self):  # noqa: N802 — stdlib hook
        parsed = urlparse(self.path)
        if parsed.path != "/fetch":
            self._send_json(404, {
                "ok": False,
                "error": f"unknown path {parsed.path}",
            })
            return

        data, err = self._read_json_body()
        if err is not None:
            self._send_json(400, {
                "ok": False,
                "status": 400,
                "html": "",
                "headers": {},
                "error": err,
            })
            return

        url = data.get("url")
        if not isinstance(url, str) or not url.strip():
            self._send_json(400, {
                "ok": False,
                "status": 400,
                "html": "",
                "headers": {},
                "error": "missing or empty 'url' field",
            })
            return
        url = url.strip()

        timeout, terr = self._coerce_timeout(data.get("timeout"), DEFAULT_TIMEOUT_S)
        if terr is not None:
            self._send_json(400, {
                "ok": False,
                "status": 400,
                "html": "",
                "headers": {},
                "error": terr,
            })
            return

        headers, herr = self._coerce_headers(data.get("headers"))
        if herr is not None:
            self._send_json(400, {
                "ok": False,
                "status": 400,
                "html": "",
                "headers": {},
                "error": herr,
            })
            return

        http_status, result = self._gated_fetch(url, timeout, headers)
        self._send_json(http_status, result)


_START_TS = time.time()


def _install_signal_handlers(server: ThreadingHTTPServer) -> None:
    """Wire SIGTERM/SIGINT/SIGHUP to a graceful shutdown sequence.

    Shutdown sequence (Sub-AC 1.1.4):
      1. Set _SHUTDOWN_EVENT — signals the watchdog thread to exit and
         tells the /fetch handler to refuse new work.
      2. Drain in-flight /fetch requests for up to SHUTDOWN_DRAIN_S.
      3. Call server.shutdown() to break out of serve_forever().
      4. main()'s finally block then closes the socket and stops the
         warm browser (kills Chromium, drops xvfb on Linux).

    Re-entry is guarded by _SHUTDOWN_EVENT so a double-Ctrl-C doesn't
    spawn two shutdown threads.
    """
    def _shutdown(signum, _frame):
        if _SHUTDOWN_EVENT.is_set():
            _log(f"received signal {signum} again; ignoring (already shutting down)")
            return
        _log(f"received signal {signum}, draining in-flight /fetch requests")
        _SHUTDOWN_EVENT.set()

        def _do_shutdown():
            remaining = _drain_inflight(SHUTDOWN_DRAIN_S)
            if remaining:
                _log(
                    f"shutdown: {remaining} request(s) still in flight after "
                    f"{SHUTDOWN_DRAIN_S}s; forcing server close"
                )
            else:
                _log("shutdown: all in-flight requests drained cleanly")
            try:
                server.shutdown()
            except Exception as e:
                _log(f"shutdown: server.shutdown() raised: {e!r}")

        # Run off-thread because shutdown() blocks if called from the
        # same thread serve_forever runs on.
        threading.Thread(target=_do_shutdown, name="cf-fetch-shutdown",
                         daemon=True).start()

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        try:
            signal.signal(sig, _shutdown)
        except (ValueError, OSError):
            # SIGHUP may not be settable in some environments
            pass


def main() -> int:
    _load_env_file(ENV_FILE)

    # Launch the warm browser BEFORE accepting requests so the first request
    # after sidecar boot doesn't pay cold-start (Seed latency budget: <5s
    # first / <2s repeat). If the launch fails we still serve in stub mode.
    _log("launching persistent nodriver browser...")
    t0 = time.time()
    _BROWSER.start()
    if _BROWSER.ready:
        _log(f"warm browser ready in {time.time() - t0:.1f}s")
    else:
        _log(f"warm browser NOT ready ({_BROWSER.start_error}); serving in stub mode")

    # Sub-AC 1.1.4: long-lived process management. The watchdog thread
    # polls _BROWSER.is_alive() every WATCHDOG_INTERVAL_S and triggers a
    # restart on detected crash. Starting it here (after the initial
    # _BROWSER.start) means the first launch attempt has already had its
    # full timeout and the watchdog isn't competing with it.
    _start_watchdog()
    _log(
        f"concurrency gate: max={MAX_CONCURRENT}, "
        f"queue_wait={QUEUE_WAIT_S}s, drain={SHUTDOWN_DRAIN_S}s"
    )

    _log(f"starting on http://{HOST}:{PORT} (pid={os.getpid()})")
    server = ThreadingHTTPServer((HOST, PORT), _Handler)
    _install_signal_handlers(server)
    try:
        server.serve_forever()
    finally:
        # Belt-and-braces: even if we got here without a signal (e.g. a
        # panic in serve_forever) make sure the watchdog and any future
        # event-driven helpers see the shutdown signal so they exit too.
        _SHUTDOWN_EVENT.set()
        try:
            server.server_close()
        except Exception:
            pass
        try:
            _BROWSER.stop()
        except Exception as e:
            _log(f"browser stop failed: {e}")
        _log("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
