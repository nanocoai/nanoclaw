#!/usr/bin/env python3
"""
Web Search Plus — Unified Multi-Provider Search and Extraction with Intelligent Auto-Routing
Version: 2.4.0
Supports search providers: You.com, Serper, Exa, Firecrawl, Tavily, Linkup,
Brave Search, SerpBase, Querit, Parallel, Perplexity, Kilo Perplexity, SearXNG.
Supports extract providers: Firecrawl, Linkup, Parallel, Tavily, Exa, You.com.

Smart Routing uses multi-signal analysis:
  - Routing v2 language/script and query-class detection
  - Query intent classification (shopping, research, discovery)
  - Linguistic pattern detection (how much vs how does)
  - Product/brand recognition
  - URL detection
  - Confidence scoring

Usage:
    python3 search.py --query "..."                    # Auto-route based on query
    python3 search.py --provider [you|serper|exa|firecrawl|tavily|linkup|brave|serpbase|querit|perplexity|kilo-perplexity|searxng|auto] --query "..." [options]

Examples:
    python3 search.py -q "東京 AI ニュース 今日"              # → You.com (multilingual current)
    python3 search.py -q "arXiv 2024 LLM scaling laws"      # → Exa (academic discovery)
    python3 search.py -q "latest OpenSSH CVE mitigation"    # → Serper (security/current)
"""

import argparse
import json
import os
import sys
import time
from typing import List, Dict, Any, Optional, Tuple
from http_client import (  # noqa: F401 - re-exported for backward-compatible tests/imports
    ProviderRequestError,
    TRANSIENT_HTTP_CODES,
    _read_json_response,
    _read_response_body,
    make_get_request,
    make_request,
)
from cache import (
    CACHE_DIR,
    DEFAULT_CACHE_TTL,
    cache_clear,
    cache_get,
    cache_put,
    cache_stats,
)
from config import (  # noqa: F401 - re-exported for backward-compatible tests/imports
    DEFAULT_CONFIG,
    ProviderConfigError,
    _clean_env_value,
    _deepcopy_default_config,
    _validate_runtime_config,
    _validate_searxng_url,
    get_api_key,
    load_config,
    validate_api_key,
)
from provider_health import (  # noqa: F401 - re-exported for backward-compatible tests/imports
    RETRY_BACKOFF_SECONDS,
    RETRY_JITTER_FRACTION,
    COOLDOWN_STEPS_SECONDS,
    execute_provider_with_retry,
    mark_provider_failure,
    provider_in_cooldown,
    reset_provider_health,
)
from quality import (  # noqa: F401 - re-exported for backward-compatible tests/imports
    _choose_tie_winner,
    _domain_matches_rule,
    build_authority_signals,
    build_quality_report,
    deduplicate_results_across_providers,
    rerank_results_for_intent,
    select_research_providers,
)
from provider_registry import SEARCH_PROVIDER_IDS, doctor_catalog
from env_loader import load_env_files
from research import run_research_mode
import providers as _providers
import routing as _routing
import extract as _extract

# Backward-compatible cache helper aliases for older imports/tests.
get_cached_result = cache_get
cache_search_result = cache_put
clear_cache = cache_clear
get_cache_stats = cache_stats


def _load_env_file():
    """Load plugin-local, legacy parent, and Hermes profile .env files."""
    load_env_files(__file__)


ROUTING_POLICY = "routing-v2"

COMPATIBILITY_SHIM_DEPRECATION = {
    "public_surface": [
        "QueryAnalyzer",
        "auto_route_provider",
        "search_provider",
        "extract_plus",
        "get_cached_result",
        "cache_search_result",
        "clear_cache",
        "get_cache_stats",
    ],
    "internal_shims": [
        "_sync_routing_dependencies",
        "_sync_provider_dependencies",
        "_sync_extract_dependencies",
        "provider function wrappers",
    ],
    "removal_target": "after ProviderSpec registry stabilization and one documented minor release window",
    "tracking_issue": "#34",
    "policy": "Keep search.py imports working while tests/users migrate to module-level seams; do not remove wrappers in feature PRs.",
}


def get_compatibility_shim_policy() -> Dict[str, Any]:
    """Return the documented compatibility-shim policy for tests and release notes."""
    return {
        key: value.copy() if isinstance(value, list) else value
        for key, value in COMPATIBILITY_SHIM_DEPRECATION.items()
    }


def _sync_routing_dependencies() -> None:
    """Keep moved routing implementation compatible with search.py monkeypatches.

    Removal target: after ProviderSpec registry stabilization and one documented minor release window.
    """
    _routing.get_api_key = get_api_key


class QueryAnalyzer(_routing.QueryAnalyzer):
    def __init__(self, *args, **kwargs):
        _sync_routing_dependencies()
        super().__init__(*args, **kwargs)


def auto_route_provider(*args, **kwargs):
    _sync_routing_dependencies()
    return _routing.auto_route_provider(*args, **kwargs)


def explain_routing(*args, **kwargs):
    _sync_routing_dependencies()
    return _routing.explain_routing(*args, **kwargs)


def _provider_auto_allowed(*args, **kwargs):
    return _routing._provider_auto_allowed(*args, **kwargs)






# =============================================================================
# Intelligent Auto-Routing Engine
# =============================================================================













# ProviderRequestError and TRANSIENT_HTTP_CODES live in http_client.py.
# Provider cooldown/backoff constants live in provider_health.py.






# =============================================================================
# HTTP Client
# =============================================================================



# HTTP request helpers live in http_client.py and are imported above for backward-compatible monkeypatching.


# =============================================================================
# Serper (Google Search API)
# =============================================================================



# =============================================================================
# SerpBase (Google SERP API)
# =============================================================================







# =============================================================================
# Brave Search
# =============================================================================



# =============================================================================
# Tavily (Research Search)
# =============================================================================



# =============================================================================
# Querit (Multi-lingual search API for AI, with rich metadata and real-time information)
# =============================================================================





# =============================================================================
# Linkup Search
# =============================================================================



# =============================================================================
# Firecrawl Search
# =============================================================================





# =============================================================================
# Extract Plus (URL Content Extraction)
# =============================================================================


















def _sync_provider_dependencies() -> None:
    """Keep moved provider implementations compatible with search.py monkeypatches.

    Removal target: after ProviderSpec registry stabilization and one documented minor release window.
    """
    _providers.make_request = make_request
    _providers.make_get_request = make_get_request
    _providers.get_api_key = get_api_key
    _providers.load_config = load_config
    _providers.provider_in_cooldown = provider_in_cooldown
    _providers.mark_provider_failure = mark_provider_failure
    _providers.reset_provider_health = reset_provider_health
    _providers.execute_provider_with_retry = execute_provider_with_retry


def search_serper(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.search_serper(*args, **kwargs)


def _strip_tracking_params(*args, **kwargs):
    return _providers._strip_tracking_params(*args, **kwargs)


def _serpbase_related_search_query(*args, **kwargs):
    return _providers._serpbase_related_search_query(*args, **kwargs)


def search_serpbase(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.search_serpbase(*args, **kwargs)


def search_brave(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.search_brave(*args, **kwargs)


def search_tavily(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.search_tavily(*args, **kwargs)


def _map_querit_time_range(*args, **kwargs):
    return _providers._map_querit_time_range(*args, **kwargs)


def search_querit(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.search_querit(*args, **kwargs)


def search_linkup(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.search_linkup(*args, **kwargs)


def _map_firecrawl_time_range(*args, **kwargs):
    return _providers._map_firecrawl_time_range(*args, **kwargs)


def search_firecrawl(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.search_firecrawl(*args, **kwargs)


def _normalize_extract_result(*args, **kwargs):
    return _providers._normalize_extract_result(*args, **kwargs)


def extract_firecrawl(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.extract_firecrawl(*args, **kwargs)


def extract_linkup(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.extract_linkup(*args, **kwargs)


def extract_tavily(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.extract_tavily(*args, **kwargs)


def extract_exa(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.extract_exa(*args, **kwargs)


def extract_you(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.extract_you(*args, **kwargs)


def extract_parallel(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.extract_parallel(*args, **kwargs)


def search_exa(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.search_exa(*args, **kwargs)


def search_parallel(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.search_parallel(*args, **kwargs)


def search_perplexity(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.search_perplexity(*args, **kwargs)


def search_you(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.search_you(*args, **kwargs)


def search_searxng(*args, **kwargs):
    _sync_provider_dependencies()
    return _providers.search_searxng(*args, **kwargs)



# =============================================================================
# Exa (Neural/Semantic/Deep Search)
# =============================================================================



# =============================================================================
# Parallel (LLM-ready web search)
# =============================================================================



# =============================================================================
# Perplexity-compatible Direct Answers
# =============================================================================




# =============================================================================
# You.com (LLM-Ready Web & News Search)
# =============================================================================



# =============================================================================
# SearXNG (Privacy-First Meta-Search)
# =============================================================================



# =============================================================================
# CLI
# =============================================================================


def _sync_extract_dependencies() -> None:
    """Keep moved extract orchestrator compatible with search.py monkeypatches.

    Removal target: after ProviderSpec registry stabilization and one documented minor release window.
    """
    _extract.get_api_key = get_api_key
    _extract.load_config = load_config
    _extract.provider_in_cooldown = provider_in_cooldown
    _extract.mark_provider_failure = mark_provider_failure
    _extract.reset_provider_health = reset_provider_health
    _extract.execute_provider_with_retry = execute_provider_with_retry
    _extract.extract_firecrawl = extract_firecrawl
    _extract.extract_linkup = extract_linkup
    _extract.extract_tavily = extract_tavily
    _extract.extract_exa = extract_exa
    _extract.extract_you = extract_you
    _extract.extract_parallel = extract_parallel


EXTRACT_PROVIDER_PRIORITY = _extract.EXTRACT_PROVIDER_PRIORITY


PROVIDER_DOCTOR_CATALOG = doctor_catalog()


def extract_plus(*args, **kwargs):
    _sync_extract_dependencies()
    return _extract.extract_plus(*args, **kwargs)


def _doctor_error(error_type: str, message: str) -> Dict[str, str]:
    """Return a deliberately sanitized doctor error.

    Doctor output is often pasted into issues/support chats. Keep it useful without
    echoing private URLs, filesystem paths, tokens, or corrupt raw cache values.
    """
    safe_messages = {
        "config": "Provider configuration is invalid; inspect local config/env for this provider.",
        "cooldown": "Provider health cache has an invalid cooldown entry; reset provider health cache if it persists.",
    }
    return {"type": error_type, "message": safe_messages.get(error_type, "Provider diagnostic failed.")}


def _doctor_provider_has_error_type(provider_report: Dict[str, Any], error_type: str) -> bool:
    error = provider_report.get("error")
    if isinstance(error, dict):
        return error.get("type") == error_type
    if isinstance(error, list):
        return any(isinstance(item, dict) and item.get("type") == error_type for item in error)
    return False


def _build_doctor_report(config: Dict[str, Any], *, live: bool = False) -> Dict[str, Any]:
    auto_config = config.get("auto_routing", {})
    disabled = set(auto_config.get("disabled_providers", []) or [])
    providers = []
    for provider, spec in PROVIDER_DOCTOR_CATALOG.items():
        errors = []
        try:
            in_cooldown, remaining = provider_in_cooldown(provider)
            cooldown = {"active": bool(in_cooldown), "remaining_seconds": int(remaining)}
        except (TypeError, ValueError):
            cooldown = {"active": False, "remaining_seconds": 0}
            errors.append(_doctor_error("cooldown", "invalid provider health cache value"))

        try:
            key_present = bool(get_api_key(provider, config))
        except (ProviderConfigError, ValueError):
            key_present = False
            errors.append(_doctor_error("config", "invalid provider configuration"))

        provider_report = {
            "provider": provider,
            "env_var": spec["env_var"],
            "search_capable": spec["search_capable"],
            "extract_capable": spec["extract_capable"],
            "key_present": key_present,
            "auto_allowed": _provider_auto_allowed(provider, auto_config),
            "disabled": provider in disabled,
            "cooldown": cooldown,
        }
        if errors:
            provider_report["error"] = errors[0] if len(errors) == 1 else errors
        providers.append(provider_report)

    usable = [p for p in providers if p["key_present"] and not p["disabled"]]
    config_errors = [p for p in providers if _doctor_provider_has_error_type(p, "config")]
    return {
        "ok": bool(usable) and not config_errors,
        "mode": "live" if live else "offline",
        "config": {
            "auto_routing_enabled": auto_config.get("enabled", True),
            "default_provider": config.get("default_provider"),
            "fallback_provider": auto_config.get("fallback_provider"),
            "disabled_providers": sorted(disabled),
        },
        "cache": {
            "dir": str(CACHE_DIR),
            "exists": CACHE_DIR.exists(),
            "writable": os.access(CACHE_DIR if CACHE_DIR.exists() else CACHE_DIR.parent, os.W_OK),
            "provider_health_file": str(CACHE_DIR / "provider_health.json"),
        },
        "providers": providers,
    }


def _format_doctor_text(report: Dict[str, Any]) -> str:
    lines = ["Web Search Plus Doctor", f"Mode: {report['mode']}", f"OK: {report['ok']}", "", "Providers:"]
    for provider in report["providers"]:
        capabilities = []
        if provider["search_capable"]:
            capabilities.append("search")
        if provider["extract_capable"]:
            capabilities.append("extract")
        cooldown = provider["cooldown"]
        cooldown_text = f"cooldown {cooldown['remaining_seconds']}s" if cooldown["active"] else "no cooldown"
        lines.append(
            f"- {provider['provider']}: env={provider['env_var']} "
            f"key={'yes' if provider['key_present'] else 'no'} "
            f"capabilities={','.join(capabilities)} "
            f"auto_allowed={'yes' if provider['auto_allowed'] else 'no'} "
            f"disabled={'yes' if provider['disabled'] else 'no'} "
            f"{cooldown_text}"
        )
    lines.extend(["", f"Cache: {report['cache']['dir']} (writable={report['cache']['writable']})"])
    return "\n".join(lines)


def build_parser_for_tests() -> argparse.ArgumentParser:
    """Return a minimal parser exposing registry-backed provider choices for drift tests."""
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument(
        "--provider",
        "-p",
        choices=[*SEARCH_PROVIDER_IDS, "auto"],
        help="Search provider (auto=intelligent routing)",
    )
    return parser


def build_parser(config: Dict[str, Any]) -> argparse.ArgumentParser:
    """Build the search.py CLI argument parser.

    Shared by the CLI ``main()`` entry and the in-process ``run_search_request``
    helper so the Hermes plugin can route argv through the exact same parsing and
    defaults without spawning a subprocess.
    """
    parser = argparse.ArgumentParser(
        description="Web Search Plus — Intelligent multi-provider search with smart auto-routing",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Intelligent Auto-Routing:
  The query is analyzed using multi-signal detection to find the optimal provider:
  
  Shopping Intent → Serper (Google)
    "how much", "price of", "buy", product+brand combos, deals, specs
  
  Research Intent → Tavily  
    "how does", "explain", "what is", analysis, pros/cons, tutorials

  Multilingual + Real-Time AI Search → Querit
    multilingual search, metadata-rich results, current information for AI workflows
  
  Discovery Intent → Exa (Neural)
    "similar to", "companies like", "alternatives", URLs, startups, papers

  Direct Answer Intent → Perplexity (via Kilo Gateway)
    "what is", "current status", local events, synthesized up-to-date answers

Examples:
  python3 search.py -q "iPhone 16 Pro Max price"          # → Serper (shopping)
  python3 search.py -q "how does HTTPS encryption work"   # → Tavily (research)
  python3 search.py -q "startups similar to Notion"       # → Exa (discovery)
  python3 search.py --explain-routing -q "your query"     # Debug routing

Full docs: See README.md and SKILL.md
        """,
    )
    
    # Command arguments
    parser.add_argument(
        "command",
        nargs="?",
        choices=["doctor"],
        help="Run a maintenance command such as 'doctor'",
    )
    parser.add_argument("--json", action="store_true", help="Emit JSON for maintenance commands")
    parser.add_argument("--live", action="store_true", help="Allow doctor to run live provider smokes (reserved; offline by default)")

    # Common arguments
    parser.add_argument(
        "--provider", "-p", 
        choices=[*SEARCH_PROVIDER_IDS, "auto"],
        help="Search provider (auto=intelligent routing)"
    )
    parser.add_argument(
        "--query", "-q", 
        help="Search query"
    )
    parser.add_argument(
        "--extract-urls",
        nargs="*",
        help="Extract content from one or more URLs instead of running a search"
    )
    parser.add_argument(
        "--format",
        dest="output_format",
        default="markdown",
        choices=["markdown", "html"],
        help="Extraction output format"
    )
    parser.add_argument("--extract-images", action="store_true", help="Extract image metadata when supported")
    parser.add_argument("--include-raw-html", action="store_true", help="Include raw HTML when supported")
    parser.add_argument("--render-js", action="store_true", help="Render JavaScript before extraction when supported")
    parser.add_argument(
        "--max-results", "-n", 
        type=int, 
        default=config.get("defaults", {}).get("max_results", 5),
        help="Maximum results (default: 5)"
    )
    parser.add_argument(
        "--images", 
        action="store_true",
        help="Include images (Serper/Tavily)"
    )
    
    # Auto-routing options
    parser.add_argument(
        "--auto", "-a",
        action="store_true",
        help="Use intelligent auto-routing (default when no provider specified)"
    )
    parser.add_argument(
        "--allow-fallback",
        action="store_true",
        help="Allow explicit --provider calls to fall back to other configured providers on failure. Auto-routing already uses fallback."
    )
    parser.add_argument(
        "--explain-routing",
        action="store_true",
        help="Show detailed routing analysis (debug mode)"
    )
    
    # Serper-specific
    serper_config = config.get("serper", {})
    parser.add_argument("--country", default=serper_config.get("country", "us"))
    parser.add_argument("--language", default=serper_config.get("language", "en"))
    parser.add_argument(
        "--type", 
        dest="search_type", 
        default=serper_config.get("type", "search"),
        choices=["search", "news", "images", "videos", "places", "shopping"]
    )
    parser.add_argument(
        "--time-range", 
        choices=["hour", "day", "week", "month", "year"]
    )
    
    # Tavily-specific
    tavily_config = config.get("tavily", {})
    parser.add_argument(
        "--depth", 
        default=tavily_config.get("depth", "basic"), 
        choices=["basic", "advanced"]
    )
    parser.add_argument(
        "--topic", 
        default=tavily_config.get("topic", "general"), 
        choices=["general", "news"]
    )
    parser.add_argument("--raw-content", action="store_true")
    
    # Querit-specific
    querit_config = config.get("querit", {})
    parser.add_argument(
        "--querit-base-url",
        default=querit_config.get("base_url", "https://api.querit.ai"),
        help="Querit API base URL"
    )
    parser.add_argument(
        "--querit-base-path",
        default=querit_config.get("base_path", "/v1/search"),
        help="Querit API path"
    )

    # Linkup-specific
    linkup_config = config.get("linkup", {})
    parser.add_argument(
        "--linkup-depth",
        default=linkup_config.get("depth", "standard"),
        choices=["fast", "standard", "deep"],
        help="Linkup search depth: fast, standard, or deep"
    )
    parser.add_argument(
        "--linkup-output-type",
        default=linkup_config.get("output_type", "searchResults"),
        choices=["searchResults", "sourcedAnswer"],
        help="Linkup output type"
    )

    # Exa-specific
    exa_config = config.get("exa", {})
    parser.add_argument(
        "--exa-type",
        default=exa_config.get("type", "neural"),
        choices=["neural", "fast", "auto", "keyword", "instant"],
        help="Exa search type (for standard search, ignored when --exa-depth is set)"
    )
    parser.add_argument(
        "--exa-depth",
        default=exa_config.get("depth", "normal"),
        choices=["normal", "deep", "deep-reasoning"],
        help="Exa search depth: deep (synthesized, 4-12s), deep-reasoning (cross-reference, 12-50s)"
    )
    parser.add_argument(
        "--exa-verbosity",
        default=exa_config.get("verbosity", "standard"),
        choices=["compact", "standard", "full"],
        help="Exa text verbosity for content extraction"
    )
    parser.add_argument(
        "--category",
        choices=[
            "company", "research paper", "news", "pdf", "github", 
            "tweet", "personal site", "linkedin profile"
        ]
    )
    parser.add_argument("--start-date")
    parser.add_argument("--end-date")
    parser.add_argument("--similar-url")

    # Firecrawl-specific
    firecrawl_config = config.get("firecrawl", {})
    parser.add_argument(
        "--firecrawl-scrape",
        action="store_true",
        help="Firecrawl: scrape result pages and include markdown as raw_content"
    )
    parser.add_argument(
        "--firecrawl-sources",
        nargs="+",
        default=firecrawl_config.get("sources", ["web"]),
        choices=["web", "news", "images"],
        help="Firecrawl result sources"
    )
    
    # You.com-specific
    you_config = config.get("you", {})
    parser.add_argument(
        "--you-safesearch",
        default=you_config.get("safesearch", "moderate"),
        choices=["off", "moderate", "strict"],
        help="You.com SafeSearch filter"
    )
    parser.add_argument(
        "--freshness",
        choices=["day", "week", "month", "year"],
        help="Filter results by recency (You.com/Serper)"
    )
    parser.add_argument(
        "--livecrawl",
        choices=["web", "news", "all"],
        help="You.com: fetch full page content"
    )
    parser.add_argument(
        "--no-news",
        action="store_true",
        help="You.com: exclude news results (included by default)"
    )
    
    # SearXNG-specific
    searxng_config = config.get("searxng", {})
    parser.add_argument(
        "--searxng-url",
        default=searxng_config.get("instance_url"),
        help="SearXNG instance URL (e.g., https://searx.example.com)"
    )
    parser.add_argument(
        "--searxng-safesearch",
        type=int,
        default=searxng_config.get("safesearch", 0),
        choices=[0, 1, 2],
        help="SearXNG SafeSearch: 0=off, 1=moderate, 2=strict"
    )
    parser.add_argument(
        "--engines",
        nargs="+",
        default=searxng_config.get("engines"),
        help="SearXNG: specific engines to use (e.g., google bing duckduckgo)"
    )
    parser.add_argument(
        "--categories",
        nargs="+",
        help="SearXNG: search categories (general, images, news, videos, etc.)"
    )
    
    # Domain filters
    parser.add_argument("--include-domains", nargs="+")
    parser.add_argument("--exclude-domains", nargs="+")
    
    # Output
    parser.add_argument("--compact", action="store_true")
    parser.add_argument(
        "--quality-report",
        action="store_true",
        help="Attach transparent routing/result diagnostics to the JSON output"
    )
    parser.add_argument(
        "--mode",
        default="normal",
        choices=["normal", "research"],
        help="Search mode: normal single-provider route or research multi-provider + extraction"
    )
    parser.add_argument(
        "--research-providers",
        nargs="+",
        help="Explicit provider list for --mode research"
    )
    parser.add_argument(
        "--research-extract-count",
        type=int,
        default=3,
        help="Number of top research-mode URLs to extract for grounding"
    )
    parser.add_argument(
        "--research-time-budget",
        type=float,
        default=55.0,
        help="Best-effort wall-clock budget for research mode; skips remaining providers/extraction between calls when exhausted"
    )
    
    # Caching options
    parser.add_argument(
        "--cache-ttl",
        type=int,
        default=DEFAULT_CACHE_TTL,
        help=f"Cache TTL in seconds (default: {DEFAULT_CACHE_TTL} = 1 hour)"
    )
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="Bypass cache (always fetch fresh results)"
    )
    parser.add_argument(
        "--clear-cache",
        action="store_true",
        help="Clear all cached results and exit"
    )
    parser.add_argument(
        "--cache-stats",
        action="store_true",
        help="Show cache statistics and exit"
    )

    return parser


def main():
    config = load_config()
    parser = build_parser(config)
    args = parser.parse_args()

    if args.command == "doctor":
        report = _build_doctor_report(config, live=args.live)
        if args.json or args.compact:
            indent = None if args.compact else 2
            print(json.dumps(report, indent=indent, ensure_ascii=False))
        else:
            print(_format_doctor_text(report))
        return
    
    # Handle cache management commands first (before query validation)
    if args.clear_cache:
        result = cache_clear()
        indent = None if args.compact else 2
        print(json.dumps(result, indent=indent, ensure_ascii=False))
        return
    
    if args.cache_stats:
        result = cache_stats()
        indent = None if args.compact else 2
        print(json.dumps(result, indent=indent, ensure_ascii=False))
        return

    if args.extract_urls is not None:
        result = extract_plus(
            urls=args.extract_urls,
            provider=args.provider or "auto",
            output_format=args.output_format,
            include_images=args.extract_images,
            include_raw_html=args.include_raw_html,
            render_js=args.render_js,
            config=config,
        )
        indent = None if args.compact else 2
        print(json.dumps(result, indent=indent, ensure_ascii=False))
        return
    
    if not args.query and not args.similar_url:
        parser.error("--query is required (unless using --similar-url with Exa)")
    
    # Handle --explain-routing
    if args.explain_routing:
        if not args.query:
            parser.error("--query is required for --explain-routing")
        explanation = explain_routing(args.query, config)
        indent = None if args.compact else 2
        print(json.dumps(explanation, indent=indent, ensure_ascii=False))
        return

    payload, exit_code = execute_search_request(args, config)
    if exit_code == 0:
        indent = None if args.compact else 2
        print(json.dumps(payload, indent=indent, ensure_ascii=False))
    else:
        print(json.dumps(payload, indent=2), file=sys.stderr)
        sys.exit(1)


def execute_search_request(args, config: Dict[str, Any]) -> Tuple[Dict[str, Any], int]:
    """Run the search/research pipeline for parsed args.

    Returns ``(payload, exit_code)`` where exit_code 0 means a success payload bound
    for stdout and 1 means an error payload bound for stderr. This function never
    prints or calls ``sys.exit`` so the Hermes plugin can invoke it in-process
    instead of spawning a subprocess.
    """
    # Determine provider
    if args.provider == "auto" or (args.provider is None and not args.similar_url):
        if args.query:
            routing = auto_route_provider(args.query, config)
            provider = routing["provider"]
            routing_info = {
                "auto_routed": True,
                "provider": provider,
                "confidence": routing["confidence"],
                "confidence_level": routing["confidence_level"],
                "reason": routing["reason"],
                "routing_policy": routing.get("routing_policy", ROUTING_POLICY),
                "top_signals": routing["top_signals"],
                "scores": routing["scores"],
                "auto_allow_excluded": routing.get("auto_allow_excluded", []),
                "analysis_summary": routing.get("analysis_summary", {}),
            }
        else:
            provider = "exa"
            routing_info = {
                "auto_routed": True,
                "provider": "exa",
                "confidence": 1.0,
                "confidence_level": "high",
                "reason": "similar_url_specified",
                "routing_policy": ROUTING_POLICY,
            }
    else:
        provider = args.provider or "serper"
        routing_info = {"auto_routed": False, "provider": provider, "routing_policy": ROUTING_POLICY}
    
    # Build provider fallback list
    auto_config = config.get("auto_routing", {})
    provider_priority = auto_config.get("provider_priority", list(SEARCH_PROVIDER_IDS))
    disabled_providers = auto_config.get("disabled_providers", [])

    # Start with the selected provider, then try others in priority order.
    # Explicit provider calls are strict by default: requested provider must be
    # the actual provider. Use --allow-fallback to opt into legacy fallback.
    # Fixed-provider mode is intentionally strict: if auto-routing is disabled
    # and the saved default was selected via provider=auto, do not silently
    # fall back to other providers. Users who want fallback should keep
    # auto-routing enabled and tune priority/fallback instead.
    explicit_provider_mode = args.provider not in (None, "auto")
    fixed_provider_mode = (
        auto_config.get("enabled", True) is False
        and provider == config.get("default_provider")
        and (args.provider == "auto" or (args.provider is None and not args.similar_url))
    )
    strict_provider_mode = fixed_provider_mode or (explicit_provider_mode and not args.allow_fallback)
    providers_to_try = [provider] if provider else []
    if not strict_provider_mode:
        for p in provider_priority:
            if p not in providers_to_try and p not in disabled_providers and _provider_auto_allowed(p, auto_config) and get_api_key(p, config):
                providers_to_try.append(p)

    # Skip providers currently in cooldown
    eligible_providers = []
    cooldown_skips = []
    for p in providers_to_try:
        in_cd, remaining = provider_in_cooldown(p)
        if in_cd:
            cooldown_skips.append({"provider": p, "cooldown_remaining_seconds": remaining})
        else:
            eligible_providers.append(p)

    if not eligible_providers:
        eligible_providers = providers_to_try[:1]

    # Helper function to execute search for a provider
    def execute_search(prov: str) -> Dict[str, Any]:
        key = validate_api_key(prov, config)
        if prov == "serper":
            return search_serper(
                query=args.query,
                api_key=key,
                max_results=args.max_results,
                country=args.country,
                language=args.language,
                search_type=args.search_type,
                time_range=args.time_range,
                include_images=args.images,
            )
        elif prov == "serpbase":
            serpbase_config = config.get("serpbase", {})
            return search_serpbase(
                query=args.query,
                api_key=key,
                max_results=args.max_results,
                country=serpbase_config.get("country", args.country),
                language=serpbase_config.get("language", args.language),
                page=int(serpbase_config.get("page", 1)),
                api_url=serpbase_config.get("api_url", "https://api.serpbase.dev/google/search"),
                timeout=int(serpbase_config.get("timeout", 30)),
            )
        elif prov == "brave":
            brave_config = config.get("brave", {})
            return search_brave(
                query=args.query,
                api_key=key,
                max_results=args.max_results,
                country=brave_config.get("country", args.country),
                language=brave_config.get("search_lang", args.language),
                time_range=args.time_range or args.freshness,
                safesearch=brave_config.get("safesearch", "moderate"),
            )
        elif prov == "tavily":
            return search_tavily(
                query=args.query,
                api_key=key,
                max_results=args.max_results,
                depth=args.depth,
                topic=args.topic,
                include_domains=args.include_domains,
                exclude_domains=args.exclude_domains,
                include_images=args.images,
                include_raw_content=args.raw_content,
            )
        elif prov == "linkup":
            linkup_config = config.get("linkup", {})
            return search_linkup(
                query=args.query,
                api_key=key,
                max_results=args.max_results,
                depth=args.linkup_depth,
                output_type=args.linkup_output_type,
                include_domains=args.include_domains,
                exclude_domains=args.exclude_domains,
                api_url=linkup_config.get("api_url", "https://api.linkup.so/v1/search"),
                timeout=int(linkup_config.get("timeout", 30)),
            )
        elif prov == "querit":
            querit_config = config.get("querit", {})
            return search_querit(
                query=args.query,
                api_key=key,
                max_results=args.max_results,
                language=args.language,
                country=args.country,
                time_range=args.time_range or args.freshness,
                include_domains=args.include_domains,
                exclude_domains=args.exclude_domains,
                base_url=args.querit_base_url,
                base_path=args.querit_base_path,
                timeout=int(querit_config.get("timeout", 30)),
            )
        elif prov == "exa":
            # CLI --exa-depth overrides; fallback to auto-routing suggestion
            exa_depth = args.exa_depth
            if exa_depth == "normal" and routing_info.get("exa_depth") in ("deep", "deep-reasoning"):
                exa_depth = routing_info["exa_depth"]
            return search_exa(
                query=args.query or "",
                api_key=key,
                max_results=args.max_results,
                search_type=args.exa_type,
                exa_depth=exa_depth,
                category=args.category,
                start_date=args.start_date,
                end_date=args.end_date,
                similar_url=args.similar_url,
                include_domains=args.include_domains,
                exclude_domains=args.exclude_domains,
                text_verbosity=args.exa_verbosity,
            )
        elif prov == "firecrawl":
            firecrawl_config = config.get("firecrawl", {})
            return search_firecrawl(
                query=args.query,
                api_key=key,
                max_results=args.max_results,
                country=firecrawl_config.get("country", args.country),
                time_range=args.time_range or args.freshness,
                sources=args.firecrawl_sources,
                include_domains=args.include_domains,
                exclude_domains=args.exclude_domains,
                scrape_markdown=args.firecrawl_scrape or args.raw_content,
                ignore_invalid_urls=firecrawl_config.get("ignore_invalid_urls", False),
                api_url=firecrawl_config.get("api_url", "https://api.firecrawl.dev/v2/search"),
                timeout_ms=int(firecrawl_config.get("timeout", 30000)),
            )
        elif prov == "parallel":
            parallel_config = config.get("parallel", {})
            return search_parallel(
                query=args.query,
                api_key=key,
                max_results=args.max_results,
                include_domains=args.include_domains,
                exclude_domains=args.exclude_domains,
                api_url=parallel_config.get("api_url", "https://api.parallel.ai/v1/search"),
                timeout=int(parallel_config.get("timeout", 45)),
                client_model=parallel_config.get("client_model"),
            )
        elif prov in {"perplexity", "kilo-perplexity"}:
            perplexity_config = config.get(prov, {})
            defaults = DEFAULT_CONFIG.get(prov, {})
            return search_perplexity(
                query=args.query,
                api_key=key,
                max_results=args.max_results,
                model=perplexity_config.get("model", defaults.get("model", "sonar-pro")),
                api_url=perplexity_config.get("api_url", defaults.get("api_url", "https://api.perplexity.ai/chat/completions")),
                freshness=getattr(args, "freshness", None),
                provider_name=prov,
            )
        elif prov == "you":
            return search_you(
                query=args.query,
                api_key=key,
                max_results=args.max_results,
                country=args.country,
                language=args.language,
                freshness=args.freshness,
                safesearch=args.you_safesearch,
                include_news=not args.no_news,
                livecrawl=args.livecrawl,
            )
        elif prov == "searxng":
            # For SearXNG, 'key' is actually the instance URL
            instance_url = args.searxng_url or key
            if instance_url:
                instance_url = _validate_searxng_url(instance_url)
            return search_searxng(
                query=args.query,
                instance_url=instance_url,
                max_results=args.max_results,
                categories=args.categories,
                engines=args.engines,
                language=args.language,
                time_range=args.time_range,
                safesearch=args.searxng_safesearch,
            )
        else:
            raise ValueError(f"Unknown provider: {prov}")

    def execute_with_retry(prov: str) -> Dict[str, Any]:
        return execute_provider_with_retry(prov, lambda: execute_search(prov))

    cache_context = {
        "locale": f"{args.country}:{args.language}",
        "freshness": args.freshness,
        "time_range": args.time_range,
        "include_domains": sorted(args.include_domains) if args.include_domains else None,
        "exclude_domains": sorted(args.exclude_domains) if args.exclude_domains else None,
        "topic": args.topic,
        "search_engines": sorted(args.engines) if args.engines else None,
        "include_news": not args.no_news,
        "search_type": args.search_type,
        "exa_type": args.exa_type,
        "exa_depth": args.exa_depth,
        "exa_verbosity": args.exa_verbosity,
        "category": args.category,
        "similar_url": args.similar_url,
        "mode": args.mode,
        "quality_report": args.quality_report,
    }

    providers_considered = providers_to_try.copy()

    if args.mode == "research":
        available_research_providers = {
            p for p in providers_to_try
            if p not in disabled_providers and _provider_auto_allowed(p, auto_config) and get_api_key(p, config) and not provider_in_cooldown(p)[0]
        }
        if provider and get_api_key(provider, config) and not provider_in_cooldown(provider)[0]:
            available_research_providers.add(provider)
        if args.research_providers:
            research_providers = [
                p for p in args.research_providers
                if p not in disabled_providers and _provider_auto_allowed(p, auto_config) and get_api_key(p, config) and not provider_in_cooldown(p)[0]
            ]
        else:
            research_providers = select_research_providers(
                primary_provider=provider,
                provider_priority=provider_priority,
                available_providers=available_research_providers,
                max_providers=3,
            )

        if not research_providers:
            error_result = {
                "error": "No configured providers available for research mode",
                "provider": provider,
                "query": args.query,
                "routing": routing_info,
                "cooldown_skips": cooldown_skips,
            }
            return error_result, 1

        result = run_research_mode(
            query=args.query,
            research_providers=research_providers,
            execute_search=execute_with_retry,
            extract_urls=lambda urls: extract_plus(
                urls=urls,
                provider="auto",
                output_format="markdown",
                config=config,
            ),
            max_results=args.max_results,
            max_extract_urls=args.research_extract_count,
            time_budget_seconds=args.research_time_budget,
        )
        routing_info["mode"] = "research"
        routing_info["provider"] = "research"
        result["routing"].update(routing_info)
        result["quality_report"] = build_quality_report(
            query=args.query,
            result=result,
            routing_info=routing_info,
            providers_considered=providers_considered,
            eligible_providers=research_providers,
            cooldown_skips=cooldown_skips,
            errors=result.get("routing", {}).get("provider_errors", []),
        )
        return result, 0

    # Check cache first (unless --no-cache is set)
    cached_result = None
    cache_hit = False
    if not args.no_cache and args.query:
        cached_result = cache_get(
            query=args.query,
            provider=provider,
            max_results=args.max_results,
            ttl=args.cache_ttl,
            params=cache_context,
        )
        if cached_result:
            cache_hit = True
            result = {k: v for k, v in cached_result.items() if not k.startswith("_cache_")}
            result["cached"] = True
            result["cache_age_seconds"] = int(time.time() - cached_result.get("_cache_timestamp", 0))

    errors = []
    successful_provider = None
    successful_results: List[Tuple[str, Dict[str, Any]]] = []
    result = None if not cache_hit else result

    for idx, current_provider in enumerate(eligible_providers):
        if cache_hit:
            successful_provider = provider
            break
        try:
            provider_result = execute_with_retry(current_provider)
            reset_provider_health(current_provider)
            successful_results.append((current_provider, provider_result))
            successful_provider = current_provider

            # If we have enough results, stop.
            if len(provider_result.get("results", [])) >= args.max_results:
                break

            # Only continue collecting from lower-priority providers when fallback was needed.
            if not errors:
                break
        except Exception as e:
            error_msg = str(e)
            cooldown_info = mark_provider_failure(current_provider, error_msg)
            errors.append({
                "provider": current_provider,
                "error": error_msg,
                "cooldown_seconds": cooldown_info.get("cooldown_seconds"),
            })
            if len(eligible_providers) > 1:
                remaining = eligible_providers[idx + 1:]
                if remaining:
                    print(json.dumps({
                        "fallback": True,
                        "failed_provider": current_provider,
                        "error": error_msg,
                        "trying_next": remaining[0],
                    }), file=sys.stderr)
            continue

    if successful_results:
        if len(successful_results) == 1:
            result = successful_results[0][1]
        else:
            primary = successful_results[0][1].copy()
            deduped_results, dedup_count = deduplicate_results_across_providers(successful_results, args.max_results)
            primary["results"] = deduped_results
            primary["deduplicated"] = dedup_count > 0
            primary.setdefault("metadata", {})
            primary["metadata"]["dedup_count"] = dedup_count
            primary["metadata"]["providers_merged"] = [p for p, _ in successful_results]
            result = primary

    if result is not None:
        if successful_provider != provider:
            routing_info["fallback_used"] = True
            routing_info["original_provider"] = provider
            routing_info["provider"] = successful_provider
            routing_info["fallback_errors"] = errors

        if cooldown_skips:
            routing_info["cooldown_skips"] = cooldown_skips

        routing_class = routing_info.get("analysis_summary", {}).get("routing_class", "general")
        if not cache_hit and isinstance(result.get("results"), list):
            reranked, rerank_metadata = rerank_results_for_intent(args.query or "", routing_class, result.get("results", []))
            result["results"] = reranked
            if rerank_metadata.get("reranked"):
                result.setdefault("metadata", {})["intent_rerank"] = rerank_metadata

        result["routing"] = routing_info

        if not cache_hit and not args.no_cache and args.query:
            cache_put(
                query=args.query,
                provider=successful_provider or provider,
                max_results=args.max_results,
                result=result,
                params=cache_context,
            )

        result["cached"] = bool(cache_hit)
        if "deduplicated" not in result:
            result["deduplicated"] = False
            result.setdefault("metadata", {})
            result["metadata"].setdefault("dedup_count", 0)

        if args.quality_report:
            result["quality_report"] = build_quality_report(
                query=args.query,
                result=result,
                routing_info=routing_info,
                providers_considered=providers_considered,
                eligible_providers=eligible_providers,
                cooldown_skips=cooldown_skips,
                errors=errors,
            )

        return result, 0
    else:
        error_result = {
            "error": "All providers failed",
            "provider": provider,
            "query": args.query,
            "routing": routing_info,
            "provider_errors": errors,
            "cooldown_skips": cooldown_skips,
        }
        return error_result, 1


def run_search_request(
    *,
    query: str,
    provider: str = "auto",
    count: int = 5,
    exa_depth: str = "normal",
    time_range: Optional[str] = None,
    include_domains: Optional[List[str]] = None,
    exclude_domains: Optional[List[str]] = None,
    mode: str = "normal",
    quality_report: bool = False,
    research_time_budget: float = 55.0,
    language: Optional[str] = None,
    country: Optional[str] = None,
    config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Run a search in-process and return the result dict the CLI would emit.

    Mirrors the argv the Hermes plugin used to pass to the subprocess, then routes
    it through the same parser and pipeline so behaviour is identical without the
    interpreter-startup and JSON round-trip cost of spawning ``search.py``.
    """
    if not query and not (include_domains or exclude_domains):
        return {"error": "query is required", "provider": provider, "query": query, "results": []}
    config = config or load_config()
    argv: List[str] = [
        "--query", query or "",
        "--provider", provider or "auto",
        "--max-results", str(count),
    ]
    if exa_depth and exa_depth != "normal":
        argv += ["--exa-depth", exa_depth]
    if time_range and time_range != "none":
        argv += ["--time-range", time_range]
    if include_domains:
        argv += ["--include-domains", *include_domains]
    if exclude_domains:
        argv += ["--exclude-domains", *exclude_domains]
    if mode and mode != "normal":
        argv += ["--mode", mode, "--research-time-budget", str(research_time_budget)]
    if quality_report:
        argv += ["--quality-report"]
    if language and language != "auto":
        argv += ["--language", language]
    if country and country != "auto":
        argv += ["--country", country]

    parser = build_parser(config)
    args = parser.parse_args(argv)
    payload, _exit_code = execute_search_request(args, config)
    return payload


def run_extract_request(
    urls: List[str],
    *,
    provider: str = "auto",
    output_format: str = "markdown",
    include_images: bool = False,
    include_raw_html: bool = False,
    render_js: bool = False,
    config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Run URL extraction in-process and return the result dict."""
    config = config or load_config()
    return extract_plus(
        urls=urls,
        provider=provider or "auto",
        output_format=output_format,
        include_images=include_images,
        include_raw_html=include_raw_html,
        render_js=render_js,
        config=config,
    )


if __name__ == "__main__":
    main()
