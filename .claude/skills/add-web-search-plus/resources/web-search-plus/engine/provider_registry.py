"""Central provider metadata registry for Web Search Plus.

This module is deliberately data-only: search, extraction, doctor diagnostics,
setup/onboarding, and config validation import it so provider metadata has one
source of truth instead of one copy per surface.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Tuple


@dataclass(frozen=True)
class ProviderSpec:
    """Public, non-secret metadata for one provider."""

    provider: str
    env_var: str
    display_name: str
    description: str
    config_section: str
    supports_search: bool
    supports_extract: bool
    capability_labels: Tuple[str, ...]
    auto_allowed_by_default: bool = True
    recommended: bool = False
    free_tier: str = "API key required"
    signup_url: str = ""
    upstream_capabilities: Tuple[str, ...] = ()


_PROVIDER_SPECS = (
    ProviderSpec(
        provider="serper",
        env_var="SERPER_API_KEY",
        display_name="Serper",
        description="Google-like SERP results for facts, shopping, local and news queries.",
        config_section="serper",
        supports_search=True,
        supports_extract=False,
        capability_labels=("search", "news", "shopping", "local"),
        free_tier="2,500 one-time credits",
        signup_url="https://serper.dev/api-key",
    ),
    ProviderSpec(
        provider="serpbase",
        env_var="SERPBASE_API_KEY",
        display_name="SerpBase",
        description="Cheap Google-like SERP fallback; WSP exposes search only, explicit/fallback-only by default.",
        config_section="serpbase",
        supports_search=True,
        supports_extract=False,
        capability_labels=("search",),
        auto_allowed_by_default=False,
        free_tier="100 free searches, paid packs available",
        signup_url="https://www.serpbase.dev",
        upstream_capabilities=("images", "news", "videos", "maps_search", "maps_detail"),
    ),
    ProviderSpec(
        provider="brave",
        env_var="BRAVE_API_KEY",
        display_name="Brave Search",
        description="Independent general web index; explicit/guarded by default after Routing v2 reliability testing.",
        config_section="brave",
        supports_search=True,
        supports_extract=False,
        capability_labels=("search", "news", "local"),
        auto_allowed_by_default=False,
        free_tier="$5 free monthly credits",
        signup_url="https://api.search.brave.com/app/keys",
    ),
    ProviderSpec(
        provider="tavily",
        env_var="TAVILY_API_KEY",
        display_name="Tavily",
        description="Research/tutorial provider in the Routing v2 default pool.",
        config_section="tavily",
        supports_search=True,
        supports_extract=True,
        capability_labels=("search", "extract", "research"),
        recommended=True,
        free_tier="1,000 free searches/month",
        signup_url="https://tavily.com",
    ),
    ProviderSpec(
        provider="querit",
        env_var="QUERIT_API_KEY",
        display_name="Querit",
        description="Multilingual and real-time search candidate.",
        config_section="querit",
        supports_search=True,
        supports_extract=False,
        capability_labels=("search", "multilingual"),
        auto_allowed_by_default=False,
        free_tier="1,000 free searches/month",
        signup_url="https://querit.com",
    ),
    ProviderSpec(
        provider="linkup",
        env_var="LINKUP_API_KEY",
        display_name="Linkup",
        description="Best starter for cheap clean extraction and citation-grounded retrieval.",
        config_section="linkup",
        supports_search=True,
        supports_extract=True,
        capability_labels=("search", "extract", "citations"),
        recommended=True,
        free_tier="€5 free monthly credits (~5,000 standard extracts)",
        signup_url="https://www.linkup.so",
    ),
    ProviderSpec(
        provider="exa",
        env_var="EXA_API_KEY",
        display_name="Exa",
        description="Semantic discovery, alternatives, docs, academic and long-form discovery.",
        config_section="exa",
        supports_search=True,
        supports_extract=True,
        capability_labels=("search", "extract", "semantic"),
        free_tier="1,000 free searches/month",
        signup_url="https://dashboard.exa.ai/api-keys",
    ),
    ProviderSpec(
        provider="firecrawl",
        env_var="FIRECRAWL_API_KEY",
        display_name="Firecrawl",
        description="Robust scraping/extraction fallback, especially for JS-heavy pages.",
        config_section="firecrawl",
        supports_search=True,
        supports_extract=True,
        capability_labels=("search", "extract", "js"),
        free_tier="500 one-time credits",
        signup_url="https://www.firecrawl.dev/app/api-keys",
    ),
    ProviderSpec(
        provider="parallel",
        env_var="PARALLEL_API_KEY",
        display_name="Parallel",
        description="LLM-ready web search and fast URL extraction with long source excerpts.",
        config_section="parallel",
        supports_search=True,
        supports_extract=True,
        capability_labels=("search", "extract", "citations"),
        auto_allowed_by_default=False,
        signup_url="https://platform.parallel.ai",
    ),
    ProviderSpec(
        provider="perplexity",
        env_var="PERPLEXITY_API_KEY",
        display_name="Perplexity",
        description="Direct answer-style search when configured directly.",
        config_section="perplexity",
        supports_search=True,
        supports_extract=False,
        capability_labels=("search", "answer"),
        auto_allowed_by_default=False,
        signup_url="https://www.perplexity.ai/settings/api",
    ),
    ProviderSpec(
        provider="kilo-perplexity",
        env_var="KILOCODE_API_KEY",
        display_name="Kilo Code Perplexity bridge",
        description="Perplexity-compatible access through Kilo Code when configured.",
        config_section="kilo-perplexity",
        supports_search=True,
        supports_extract=False,
        capability_labels=("search", "answer"),
        auto_allowed_by_default=False,
        free_tier="Depends on Kilo account",
        signup_url="https://kilo.ai",
    ),
    ProviderSpec(
        provider="you",
        env_var="YOU_API_KEY",
        display_name="You.com",
        description="Fast Routing v2 core provider for current, multilingual, and LLM-ready search.",
        config_section="you",
        supports_search=True,
        supports_extract=True,
        capability_labels=("search", "extract"),
        recommended=True,
        free_tier="Limited/API key required",
        signup_url="https://api.you.com",
    ),
    ProviderSpec(
        provider="searxng",
        env_var="SEARXNG_INSTANCE_URL",
        display_name="SearXNG",
        description="Self-hosted/privacy-preserving metasearch instance URL.",
        config_section="searxng",
        supports_search=True,
        supports_extract=False,
        capability_labels=("search", "self-hosted"),
        free_tier="Free if self-hosted",
        signup_url="https://docs.searxng.org/admin/installation.html",
    ),
)

PROVIDER_SPECS: Dict[str, ProviderSpec] = {spec.provider: spec for spec in _PROVIDER_SPECS}
SEARCH_PROVIDER_IDS = tuple(spec.provider for spec in _PROVIDER_SPECS if spec.supports_search)
EXTRACT_PROVIDER_IDS = ("tavily", "exa", "linkup", "parallel", "firecrawl", "you")
DEFAULT_PROVIDER_PRIORITY = (
    "you",
    "serper",
    "exa",
    "firecrawl",
    "tavily",
    "linkup",
    "parallel",
    "brave",
    "serpbase",
    "querit",
    "kilo-perplexity",
    "perplexity",
    "searxng",
)
DEFAULT_AUTO_ALLOW = {
    spec.provider: False
    for spec in _PROVIDER_SPECS
    if spec.supports_search and not spec.auto_allowed_by_default
}
PROVIDER_ENV_KEYS = tuple(spec.env_var for spec in _PROVIDER_SPECS)
EXTRACT_PROVIDER_ENV_KEYS = tuple(spec.env_var for spec in _PROVIDER_SPECS if spec.supports_extract)


def doctor_catalog() -> Dict[str, Dict[str, object]]:
    """Return the legacy doctor JSON metadata shape from the registry."""
    return {
        provider: {
            "env_var": spec.env_var,
            "search_capable": spec.supports_search,
            "extract_capable": spec.supports_extract,
        }
        for provider, spec in PROVIDER_SPECS.items()
    }


def plugin_catalog() -> list[Dict[str, object]]:
    """Return setup/onboarding provider metadata from the registry."""
    catalog = []
    for spec in _PROVIDER_SPECS:
        item: Dict[str, object] = {
            "provider": spec.provider,
            "env": spec.env_var,
            "display_name": spec.display_name,
            "description": spec.description,
            "free_tier": spec.free_tier,
            "signup_url": spec.signup_url,
            "capabilities": list(spec.capability_labels),
            "recommended": spec.recommended,
        }
        if spec.upstream_capabilities:
            item["upstream_capabilities"] = list(spec.upstream_capabilities)
        catalog.append(item)
    return catalog
