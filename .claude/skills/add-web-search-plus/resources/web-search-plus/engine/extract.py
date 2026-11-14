"""Extraction orchestrator for Web Search Plus."""

import ipaddress
import socket
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from config import get_api_key, keyless_public_allowed, load_config
from provider_health import (
    execute_provider_with_retry,
    mark_provider_failure,
    provider_in_cooldown,
    reset_provider_health,
)
from providers import (
    extract_exa,
    extract_firecrawl,
    extract_keenable,
    extract_linkup,
    extract_parallel,
    extract_tavily,
    extract_you,
)
from provider_registry import EXTRACT_PROVIDER_IDS


EXTRACT_PROVIDER_PRIORITY = list(EXTRACT_PROVIDER_IDS)


class ExtractUrlSecurityError(ValueError):
    """Raised when an extraction target URL points at an internal resource."""


_BLOCKED_EXTRACT_HOSTS = {
    "localhost",
    "metadata.google.internal",
    "metadata.internal",
}


def _extract_allows_private_urls(config: Dict[str, Any]) -> bool:
    extract_config = config.get("extract", {}) if isinstance(config, dict) else {}
    if not isinstance(extract_config, dict):
        return False
    return extract_config.get("allow_private_urls") is True


def _is_private_or_internal_ip(value: str) -> bool:
    ip = ipaddress.ip_address(value)
    return (not ip.is_global) or ip.is_multicast


def _validate_extract_urls(urls: List[str], config: Optional[Dict[str, Any]] = None) -> List[str]:
    """Validate extraction target URLs before handing them to remote/local fetchers.

    Provider endpoint URLs are operator-controlled config and are intentionally
    not checked here. This guard only covers user/agent-controlled target URLs.
    """
    config = config or {}
    invalid = [u for u in urls if not (isinstance(u, str) and u.startswith(("http://", "https://")))]
    if invalid:
        raise ValueError(f"Invalid URL(s) — must start with http:// or https://: {invalid}")
    if _extract_allows_private_urls(config):
        return urls

    for url in urls:
        parsed = urlparse(url)
        hostname = (parsed.hostname or "").strip().lower().rstrip(".")
        if not hostname:
            raise ValueError(f"Invalid URL — hostname is required: {url}")
        if hostname in _BLOCKED_EXTRACT_HOSTS:
            raise ExtractUrlSecurityError(f"Extraction URL blocked: {hostname} is private/internal")

        try:
            ipaddress.ip_address(hostname)
        except ValueError:
            pass
        else:
            if _is_private_or_internal_ip(hostname):
                raise ExtractUrlSecurityError(f"Extraction URL blocked: {hostname} is private/internal")
            continue

        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        try:
            resolved_ips = socket.getaddrinfo(hostname, port, proto=socket.IPPROTO_TCP)
        except socket.gaierror as exc:
            raise ExtractUrlSecurityError(f"Extraction URL blocked: cannot resolve hostname {hostname}") from exc
        for _family, _type, _proto, _canonname, sockaddr in resolved_ips:
            ip = ipaddress.ip_address(sockaddr[0])
            if _is_private_or_internal_ip(str(ip)):
                raise ExtractUrlSecurityError(
                    f"Extraction URL blocked: {hostname} resolves to private/internal IP {ip}"
                )
    return urls


def extract_plus(
    urls: List[str],
    provider: str = "auto",
    output_format: str = "markdown",
    include_images: bool = False,
    include_raw_html: bool = False,
    render_js: bool = False,
    config: Optional[Dict[str, Any]] = None,
) -> dict:
    """Extract URL content with provider fallback."""
    config = config or load_config()
    selected = provider or "auto"
    if not urls:
        return {"provider": selected, "results": [], "error": "No URLs provided", "requested_provider": selected}
    try:
        urls = _validate_extract_urls(urls, config)
    except (ValueError, ExtractUrlSecurityError) as exc:
        return {
            "provider": selected,
            "results": [],
            "error": str(exc),
            "requested_provider": selected,
        }
    auto_config = config.get("auto_routing", {})
    disabled_providers = set(auto_config.get("disabled_providers", []))
    base_providers = EXTRACT_PROVIDER_PRIORITY if selected == "auto" else [selected] + [p for p in EXTRACT_PROVIDER_PRIORITY if p != selected]
    providers = [p for p in base_providers if p == selected or p not in disabled_providers]
    errors = []
    cooldown_skips = []
    for prov in providers:
        if prov not in EXTRACT_PROVIDER_PRIORITY:
            errors.append({"provider": prov, "error": f"Provider {prov} does not support extraction"})
            continue
        key = get_api_key(prov, config)
        keyless_allowed = keyless_public_allowed(prov, config)
        if not key and not keyless_allowed:
            errors.append({"provider": prov, "error": "missing_api_key"})
            continue
        in_cooldown, remaining = provider_in_cooldown(prov)
        if in_cooldown and not (selected != "auto" and prov == selected):
            cooldown_skips.append({"provider": prov, "cooldown_remaining_seconds": remaining})
            continue
        try:
            def execute_extract() -> Dict[str, Any]:
                if prov == "firecrawl":
                    fc = config.get("firecrawl", {})
                    return extract_firecrawl(urls, key, output_format, include_images, include_raw_html, render_js, api_url=fc.get("scrape_url", "https://api.firecrawl.dev/v2/scrape"), timeout=int(fc.get("extract_timeout", 60)))
                if prov == "linkup":
                    lu = config.get("linkup", {})
                    return extract_linkup(urls, key, output_format, include_images, include_raw_html, render_js, api_url=lu.get("fetch_url", "https://api.linkup.so/v1/fetch"), timeout=int(lu.get("timeout", 30)))
                if prov == "tavily":
                    tv = config.get("tavily", {})
                    return extract_tavily(urls, key, output_format, include_images, include_raw_html, render_js, api_url=tv.get("extract_url", "https://api.tavily.com/extract"), timeout=int(tv.get("timeout", 30)))
                if prov == "exa":
                    exa = config.get("exa", {})
                    return extract_exa(urls, key, output_format, include_images, include_raw_html, render_js, api_url=exa.get("contents_url", "https://api.exa.ai/contents"), timeout=int(exa.get("timeout", 30)))
                if prov == "parallel":
                    parallel = config.get("parallel", {})
                    return extract_parallel(
                        urls, key, output_format, include_images, include_raw_html, render_js,
                        api_url=parallel.get("extract_url", "https://api.parallel.ai/v1/extract"),
                        timeout=int(parallel.get("extract_timeout", parallel.get("timeout", 60))),
                        client_model=parallel.get("client_model"),
                        max_chars_total=int(parallel.get("max_chars_total", 12000)),
                        max_chars_per_result=int(parallel.get("max_chars_per_result", 6000)),
                    )
                if prov == "keenable":
                    kn = config.get("keenable", {})
                    return extract_keenable(urls, key, output_format, include_images, include_raw_html, render_js, public=keyless_allowed, api_url=kn.get("fetch_url", "https://api.keenable.ai/v1/fetch"), timeout=int(kn.get("timeout", 30)))
                you = config.get("you", {})
                return extract_you(urls, key, output_format, include_images, include_raw_html, render_js, api_url=you.get("contents_url", "https://ydc-index.io/v1/contents"), timeout=int(you.get("timeout", 30)))

            result = execute_provider_with_retry(prov, execute_extract)
            res_list = result.get("results") or []
            all_failed = bool(res_list) and all(r.get("error") for r in res_list)
            if all_failed:
                errors.append({
                    "provider": prov,
                    "error": "all_urls_failed",
                    "details": [r.get("error") for r in res_list],
                })
                continue
            reset_provider_health(prov)
            result["routing"] = {"provider": prov, "requested_provider": selected, "fallback_used": bool(errors) or bool(cooldown_skips), "fallback_errors": errors}
            if cooldown_skips:
                result["routing"]["cooldown_skips"] = cooldown_skips
            return result
        except Exception as e:
            error_msg = str(e)
            cooldown_info = mark_provider_failure(prov, error_msg, retry_after=getattr(e, "retry_after", None))
            errors.append({"provider": prov, "error": error_msg, "cooldown_seconds": cooldown_info.get("cooldown_seconds")})
            continue
    error_result = {"provider": selected, "results": [], "error": "All extraction providers failed", "fallback_errors": errors}
    if cooldown_skips:
        error_result["cooldown_skips"] = cooldown_skips
    return error_result
