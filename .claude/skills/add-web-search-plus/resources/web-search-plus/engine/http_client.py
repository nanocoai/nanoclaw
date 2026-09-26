"""Shared HTTP client helpers for Web Search Plus providers."""

from __future__ import annotations

from email.utils import parsedate_to_datetime
from http.client import IncompleteRead
import gzip
import json
import socket
import time
import zlib
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


TRANSIENT_HTTP_CODES = {429, 503}
DEFAULT_USER_AGENT = "ClawdBot-WebSearchPlus/2.8.1"


class ProviderRequestError(Exception):
    """Structured provider error with retry/cooldown metadata."""

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        transient: bool = False,
        retry_after: float | None = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.transient = transient
        # Provider-requested wait (seconds) from a Retry-After header, if any.
        self.retry_after = retry_after


def _response_header(response, name: str) -> str:
    """Return an HTTP response header from urllib response/error objects."""
    if hasattr(response, "getheader"):
        value = response.getheader(name)
        if value is not None:
            return str(value)
    headers = getattr(response, "headers", None)
    if headers is not None:
        try:
            value = headers.get(name)
        except AttributeError:
            value = None
        if value is not None:
            return str(value)
    return ""


def _read_response_body(response) -> bytes:
    """Read an urllib response body and decode supported Content-Encoding values."""
    raw = response.read()
    encoding = _response_header(response, "Content-Encoding").strip().lower()

    if encoding in {"gzip", "x-gzip"} or raw.startswith(b"\x1f\x8b"):
        try:
            return gzip.decompress(raw)
        except (OSError, EOFError, zlib.error):
            raise ProviderRequestError(
                "Provider sent a corrupted gzip response body. Please retry.",
                transient=True,
            )
    if encoding == "deflate":
        try:
            return zlib.decompress(raw)
        except zlib.error:
            # Some servers send raw deflate without the zlib wrapper.
            try:
                return zlib.decompress(raw, -zlib.MAX_WBITS)
            except zlib.error:
                raise ProviderRequestError(
                    "Provider sent a corrupted deflate response body. Please retry.",
                    transient=True,
                )
    if encoding == "br":
        raise ProviderRequestError(
            "Brotli-compressed response received, but web-search-plus does not bundle brotli support. "
            "Disable brotli for this provider or install a brotli-capable transport.",
            transient=False,
        )
    return raw


def _read_json_response(response) -> dict:
    """Read an urllib response as UTF-8 JSON with Content-Encoding handling."""
    body = _read_response_body(response)
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        raise ProviderRequestError(
            "Provider sent a non-UTF-8 response body. Please retry.",
            transient=True,
        )
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise ProviderRequestError(
            "Provider sent an invalid JSON response. Please retry.",
            transient=True,
        )


def _friendly_http_error(code: int, error_detail: str) -> str:
    error_messages = {
        401: "Invalid or expired API key. Please check your credentials.",
        403: "Access forbidden. Your API key may not have permission for this operation.",
        429: "Rate limit exceeded. Please wait a moment and try again.",
        500: "Server error. The search provider is experiencing issues.",
        503: "Service unavailable. The search provider may be down.",
    }
    return error_messages.get(code, f"API error: {error_detail}")


def _extract_http_error_detail(error: HTTPError) -> str:
    try:
        error_body = _read_response_body(error).decode("utf-8", errors="replace") if error.fp else str(error)
    except (ProviderRequestError, OSError):
        # A corrupted error body must not mask the HTTP status we are reporting.
        return str(error)
    try:
        error_json = json.loads(error_body)
        return error_json.get("error") or error_json.get("message") or error_body
    except json.JSONDecodeError:
        return error_body[:500]


def _parse_retry_after(error: HTTPError) -> float | None:
    """Parse a Retry-After header (delta-seconds or HTTP-date) into seconds."""
    value = _response_header(error, "Retry-After").strip()
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        retry_at = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if retry_at is None:
        return None
    return max(0.0, retry_at.timestamp() - time.time())


def _raise_provider_http_error(error: HTTPError) -> None:
    error_detail = _extract_http_error_detail(error)
    friendly_msg = _friendly_http_error(error.code, error_detail)
    raise ProviderRequestError(
        f"{friendly_msg} (HTTP {error.code})",
        status_code=error.code,
        transient=error.code in TRANSIENT_HTTP_CODES,
        retry_after=_parse_retry_after(error) if error.code == 429 else None,
    )


def make_request(url: str, headers: dict, body: dict, timeout: int = 30) -> dict:
    """Make HTTP POST request and return JSON response."""
    # Ensure User-Agent is set (required by some APIs like Exa/Cloudflare)
    if "User-Agent" not in headers:
        headers["User-Agent"] = DEFAULT_USER_AGENT
    data = json.dumps(body).encode("utf-8")
    req = Request(url, data=data, headers=headers, method="POST")

    try:
        with urlopen(req, timeout=timeout) as response:
            return _read_json_response(response)
    except HTTPError as e:
        _raise_provider_http_error(e)
        raise
    except URLError as e:
        reason = str(getattr(e, "reason", e))
        is_timeout = isinstance(getattr(e, "reason", None), socket.timeout) or "timed out" in reason.lower()
        raise ProviderRequestError(f"Network error: {reason}. Check your internet connection.", transient=is_timeout)
    except IncompleteRead as e:
        partial_len = len(getattr(e, "partial", b"") or b"")
        raise ProviderRequestError(
            f"Connection interrupted while reading response ({partial_len} bytes received). Please retry.",
            transient=True,
        )
    except (TimeoutError, socket.timeout):
        # socket.timeout only becomes a TimeoutError alias in Python 3.10;
        # catching both keeps read timeouts transient on 3.8/3.9.
        raise ProviderRequestError(f"Request timed out after {timeout}s. Try again or reduce max_results.", transient=True)


def make_get_request(url: str, headers: dict, timeout: int = 30) -> dict:
    """Make HTTP GET request and return JSON response."""
    if "User-Agent" not in headers:
        headers["User-Agent"] = DEFAULT_USER_AGENT
    req = Request(url, headers=headers, method="GET")

    try:
        with urlopen(req, timeout=timeout) as response:
            return _read_json_response(response)
    except HTTPError as e:
        _raise_provider_http_error(e)
        raise
    except URLError as e:
        reason = str(getattr(e, "reason", e))
        is_timeout = isinstance(getattr(e, "reason", None), socket.timeout) or "timed out" in reason.lower()
        raise ProviderRequestError(f"Network error: {reason}. Check your internet connection.", transient=is_timeout)
    except IncompleteRead as e:
        partial_len = len(getattr(e, "partial", b"") or b"")
        raise ProviderRequestError(
            f"Connection interrupted while reading response ({partial_len} bytes received). Please retry.",
            transient=True,
        )
    except (TimeoutError, socket.timeout):
        # socket.timeout only becomes a TimeoutError alias in Python 3.10;
        # catching both keeps read timeouts transient on 3.8/3.9.
        raise ProviderRequestError(f"Request timed out after {timeout}s. Try again or reduce max_results.", transient=True)
