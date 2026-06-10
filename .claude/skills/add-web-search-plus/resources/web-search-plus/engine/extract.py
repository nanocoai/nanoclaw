"""Extraction orchestrator for Web Search Plus."""

from typing import Any, Dict, List, Optional

from config import get_api_key, load_config
from provider_health import (
    execute_provider_with_retry,
    mark_provider_failure,
    provider_in_cooldown,
    reset_provider_health,
)
from providers import (
    extract_exa,
    extract_firecrawl,
    extract_linkup,
    extract_parallel,
    extract_tavily,
    extract_you,
)
from provider_registry import EXTRACT_PROVIDER_IDS


EXTRACT_PROVIDER_PRIORITY = list(EXTRACT_PROVIDER_IDS)


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
    invalid = [u for u in urls if not (isinstance(u, str) and u.startswith(("http://", "https://")))]
    if invalid:
        return {
            "provider": selected,
            "results": [],
            "error": f"Invalid URL(s) — must start with http:// or https://: {invalid}",
            "requested_provider": selected,
        }
    providers = EXTRACT_PROVIDER_PRIORITY if selected == "auto" else [selected] + [p for p in EXTRACT_PROVIDER_PRIORITY if p != selected]
    errors = []
    cooldown_skips = []
    for prov in providers:
        if prov not in EXTRACT_PROVIDER_PRIORITY:
            errors.append({"provider": prov, "error": f"Provider {prov} does not support extraction"})
            continue
        key = get_api_key(prov, config)
        if not key:
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
            cooldown_info = mark_provider_failure(prov, error_msg)
            errors.append({"provider": prov, "error": error_msg, "cooldown_seconds": cooldown_info.get("cooldown_seconds")})
            continue
    error_result = {"provider": selected, "results": [], "error": "All extraction providers failed", "fallback_errors": errors}
    if cooldown_skips:
        error_result["cooldown_skips"] = cooldown_skips
    return error_result
