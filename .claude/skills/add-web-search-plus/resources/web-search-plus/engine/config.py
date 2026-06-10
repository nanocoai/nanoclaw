"""Configuration and credential helpers for Web Search Plus."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from env_loader import clean_env_value as _shared_clean_env_value, load_env_files
from provider_registry import DEFAULT_AUTO_ALLOW, DEFAULT_PROVIDER_PRIORITY, PROVIDER_SPECS


class ProviderConfigError(Exception):
    """Raised when a provider is missing or has an invalid API key/config."""
    pass


def _is_placeholder_env_value(value: str) -> bool:
    """Return True for template placeholders that should not count as credentials."""
    return _shared_clean_env_value(value) is None


def _clean_env_value(value: str) -> Optional[str]:
    return _shared_clean_env_value(value)


def _load_env_file():
    """Load plugin-local, legacy parent, and Hermes profile .env files."""
    load_env_files(__file__)

DEFAULT_CONFIG = {
    "version": 1,
    "default_provider": None,
    "defaults": {
        "provider": "serper",
        "max_results": 5
    },
    "auto_routing": {
        "enabled": True,
        "fallback_provider": "serper",
        # Low-trust / experimental providers can stay configured for explicit use
        # without being selected automatically.
        "provider_priority": list(DEFAULT_PROVIDER_PRIORITY),
        "disabled_providers": [],
        "auto_allow": dict(DEFAULT_AUTO_ALLOW),
        "confidence_threshold": 0.3,  # Below this, note low confidence
    },
    "serper": {
        "country": "us",
        "language": "en",
        "type": "search"
    },
    "brave": {
        "country": "US",
        "search_lang": "en",
        "safesearch": "moderate",
    },
    "tavily": {
        "depth": "basic",
        "topic": "general"
    },
    "querit": {
        "base_url": "https://api.querit.ai",
        "base_path": "/v1/search",
        "timeout": 10
    },
    "linkup": {
        "api_url": "https://api.linkup.so/v1/search",
        "depth": "standard",
        "output_type": "searchResults",
        "timeout": 30
    },
    "exa": {
        "type": "neural",
        "depth": "normal",
        "verbosity": "standard"
    },
    "perplexity": {
        "api_url": "https://api.perplexity.ai/chat/completions",
        "model": "sonar-pro"
    },
    "parallel": {
        "api_url": "https://api.parallel.ai/v1/search",
        "extract_url": "https://api.parallel.ai/v1/extract",
        "timeout": 45,
        "extract_timeout": 60,
        "client_model": None,
        "max_chars_total": 12000,
        "max_chars_per_result": 6000
    },
    "kilo-perplexity": {
        "api_url": "https://api.kilo.ai/api/gateway/chat/completions",
        "model": "perplexity/sonar-pro"
    },
    "firecrawl": {
        "api_url": "https://api.firecrawl.dev/v2/search",
        "country": "US",
        "timeout": 30000,
        "sources": ["web"],
        "ignore_invalid_urls": False
    },
    "you": {
        "country": "us",
        "safesearch": "moderate"
    },
    "serpbase": {
        "api_url": "https://api.serpbase.dev/google/search",
        "country": "us",
        "language": "en",
        "page": 1,
        "timeout": 30,
    },
    "searxng": {
        "instance_url": None,  # Required - user must set their own instance
        "safesearch": 0,  # 0=off, 1=moderate, 2=strict
        "engines": None,  # Optional list of engines to use
        "language": "en"
    }
}


def _deepcopy_default_config() -> Dict[str, Any]:
    return json.loads(json.dumps(DEFAULT_CONFIG))


_ROUTING_PROVIDER_NAMES = set(PROVIDER_SPECS)


def _normalize_routing_provider_config(provider: str) -> str:
    normalized = (provider or "").strip().lower()
    if normalized == "kilo_perplexity":
        normalized = "kilo-perplexity"
    if normalized not in _ROUTING_PROVIDER_NAMES:
        raise ValueError(f"unknown routing provider: {provider}")
    return normalized


def _normalize_routing_provider_list_config(value: Any) -> List[str]:
    if isinstance(value, str):
        raw_values = [item.strip() for item in value.split(",")]
    elif isinstance(value, list):
        raw_values = [str(item).strip() for item in value]
    else:
        raise ValueError("provider list must be a string or list")
    providers = []
    seen = set()
    for raw in raw_values:
        if not raw:
            continue
        provider = _normalize_routing_provider_config(raw)
        if provider in seen:
            continue
        seen.add(provider)
        providers.append(provider)
    if not providers:
        raise ValueError("provider list cannot be empty")
    return providers


def _append_missing_default_providers(providers: List[str]) -> List[str]:
    """Preserve user ordering while adding newly introduced default providers.

    Existing config.json files often pin provider_priority from an older plugin
    version. Without this migration, newly added explicit/guarded providers can
    be valid but invisible to fallback/auto-allow configuration until users
    manually reset config.
    """
    seen = set(providers)
    merged = list(providers)
    for provider in DEFAULT_CONFIG["auto_routing"].get("provider_priority", []):
        if provider not in seen:
            seen.add(provider)
            merged.append(provider)
    return merged


def _validate_runtime_config(config: Dict[str, Any]) -> Dict[str, Any]:
    auto = config.get("auto_routing", {})
    if not isinstance(auto, dict):
        raise ValueError("auto_routing must be an object")
    if config.get("default_provider"):
        config["default_provider"] = _normalize_routing_provider_config(str(config["default_provider"]))
    if auto.get("fallback_provider"):
        auto["fallback_provider"] = _normalize_routing_provider_config(str(auto["fallback_provider"]))
    if auto.get("provider_priority"):
        priority = _normalize_routing_provider_list_config(auto["provider_priority"])
        auto["provider_priority"] = _append_missing_default_providers(priority) if auto.get("enabled", True) is not False else priority
    if "disabled_providers" in auto:
        disabled = auto.get("disabled_providers") or []
        if disabled:
            auto["disabled_providers"] = _normalize_routing_provider_list_config(disabled)
        else:
            auto["disabled_providers"] = []
    if "auto_allow" in auto:
        raw_allow = auto.get("auto_allow") or {}
        if not isinstance(raw_allow, dict):
            raise ValueError("auto_allow must be an object mapping provider names to booleans")
        normalized_allow = dict(DEFAULT_CONFIG["auto_routing"].get("auto_allow", {}))
        for raw_provider, allowed in raw_allow.items():
            provider = _normalize_routing_provider_config(str(raw_provider))
            normalized_allow[provider] = bool(allowed)
        auto["auto_allow"] = normalized_allow
    else:
        auto["auto_allow"] = dict(DEFAULT_CONFIG["auto_routing"].get("auto_allow", {}))
    if "confidence_threshold" in auto:
        threshold = float(auto["confidence_threshold"])
        if threshold < 0.0 or threshold > 1.0:
            raise ValueError("confidence_threshold must be between 0.0 and 1.0")
        auto["confidence_threshold"] = threshold
    if config.get("default_provider") and config["default_provider"] in set(auto.get("disabled_providers", [])):
        raise ValueError("default_provider cannot be disabled")
    config["auto_routing"] = auto
    return config


def _unique_timestamped_path(path: Path, marker: str) -> Path:
    base = path.with_name(path.name + f".{marker}-{int(time.time())}")
    candidate = base
    suffix = 2
    while candidate.exists():
        candidate = base.with_name(base.name + f"-{suffix}")
        suffix += 1
    return candidate


def _quarantine_runtime_config(config_path: Path, reason: str) -> None:
    broken = _unique_timestamped_path(config_path, "broken")
    try:
        config_path.rename(broken)
        print(json.dumps({
            "warning": f"Invalid config moved to {broken}: {reason}",
            "using": "default configuration",
        }), file=sys.stderr)
    except OSError as exc:
        print(json.dumps({
            "warning": f"Invalid config could not be moved: {exc}; reason: {reason}",
            "using": "default configuration",
        }), file=sys.stderr)


def load_config() -> Dict[str, Any]:
    """Load configuration from config.json if it exists, with defaults."""
    config = _deepcopy_default_config()
    config_path = Path(os.environ.get("WEB_SEARCH_PLUS_CONFIG") or (Path(__file__).parent.parent / "config.json"))

    if config_path.exists():
        try:
            with open(config_path) as f:
                user_config = json.load(f)
                for key, value in user_config.items():
                    if isinstance(value, dict) and key in config:
                        config[key] = {**config.get(key, {}), **value}
                    else:
                        config[key] = value
            config = _validate_runtime_config(config)
        except (json.JSONDecodeError, IOError, ValueError, TypeError) as e:
            _quarantine_runtime_config(config_path, str(e))
            config = _deepcopy_default_config()

    return config


def get_api_key(provider: str, config: Dict[str, Any] = None) -> Optional[str]:
    """Get API key for provider from config.json or environment.

    Priority: config.json > .env > environment variable

    Note: SearXNG doesn't require an API key, but returns instance_url if configured.
    """
    # Special case: SearXNG uses instance_url instead of API key
    if provider == "searxng":
        return get_searxng_instance_url(config)

    # Check config.json first
    if config:
        provider_config = config.get(provider, {})
        if isinstance(provider_config, dict):
            key = provider_config.get("api_key") or provider_config.get("apiKey")
            key = _clean_env_value(str(key)) if key is not None else None
            if key:
                return key

    # Then check environment
    spec = PROVIDER_SPECS.get(provider)
    return _clean_env_value(os.environ.get(spec.env_var if spec else "", ""))


def _validate_searxng_url(url: str) -> str:
    """Validate and sanitize SearXNG instance URL to prevent SSRF.

    Enforces http/https scheme and blocks requests to private/internal networks
    including cloud metadata endpoints, loopback, link-local, and RFC1918 ranges.
    """
    import ipaddress
    import socket
    from urllib.parse import urlparse

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"SearXNG URL must use http or https scheme, got: {parsed.scheme}")
    if not parsed.hostname:
        raise ValueError("SearXNG URL must include a hostname")

    hostname = parsed.hostname

    # Block cloud metadata endpoints by hostname
    BLOCKED_HOSTS = {
        "169.254.169.254",        # AWS/GCP/Azure metadata
        "metadata.google.internal",
        "metadata.internal",
    }
    if hostname in BLOCKED_HOSTS:
        raise ValueError(f"SearXNG URL blocked: {hostname} is a cloud metadata endpoint")

    # Resolve hostname and check for private/internal IPs
    # Operators who intentionally self-host on private networks can opt out
    allow_private = os.environ.get("SEARXNG_ALLOW_PRIVATE", "").strip() == "1"
    if not allow_private:
        try:
            resolved_ips = socket.getaddrinfo(hostname, parsed.port or 80, proto=socket.IPPROTO_TCP)
            for family, _type, _proto, _canonname, sockaddr in resolved_ips:
                ip = ipaddress.ip_address(sockaddr[0])
                if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved:
                    raise ValueError(
                        f"SearXNG URL blocked: {hostname} resolves to private/internal IP {ip}. "
                        f"If this is intentional, set SEARXNG_ALLOW_PRIVATE=1 in your environment."
                    )
        except socket.gaierror:
            raise ValueError(f"SearXNG URL blocked: cannot resolve hostname {hostname}")

    return url


def get_searxng_instance_url(config: Dict[str, Any] = None) -> Optional[str]:
    """Get SearXNG instance URL from config or environment.

    SearXNG is self-hosted, so no API key needed - just the instance URL.
    Priority: config.json > SEARXNG_INSTANCE_URL environment variable

    Security: URL is validated to prevent SSRF via scheme enforcement.
    Both config sources (config.json, env var) are operator-controlled,
    not agent-controlled, so private IPs like localhost are permitted.
    """
    # Check config.json first
    if config:
        searxng_config = config.get("searxng", {})
        if isinstance(searxng_config, dict):
            url = searxng_config.get("instance_url")
            if url:
                return _validate_searxng_url(url)

    # Then check environment
    env_url = _clean_env_value(os.environ.get("SEARXNG_INSTANCE_URL", ""))
    if env_url:
        return _validate_searxng_url(env_url)
    return None


# Backward compatibility alias
def get_env_key(provider: str) -> Optional[str]:
    """Get API key for provider from environment (legacy function)."""
    return get_api_key(provider)


def validate_api_key(provider: str, config: Dict[str, Any] = None) -> str:
    """Validate and return API key (or instance URL for SearXNG), with helpful error messages."""
    key = get_api_key(provider, config)

    # Special handling for SearXNG - it needs instance URL, not API key
    if provider == "searxng":
        if not key:
            error_msg = {
                "error": "Missing SearXNG instance URL",
                "env_var": "SEARXNG_INSTANCE_URL",
                "how_to_fix": [
                    "1. Set up your own SearXNG instance: https://docs.searxng.org/admin/installation.html",
                    "2. Add to config.json: \"searxng\": {\"instance_url\": \"https://your-instance.example.com\"}",
                    "3. Or set environment variable: export SEARXNG_INSTANCE_URL=\"https://your-instance.example.com\"",
                    "Note: SearXNG requires a self-hosted instance with JSON format enabled.",
                ],
                "provider": provider
            }
            raise ProviderConfigError(json.dumps(error_msg))

        # Validate URL format
        if not key.startswith(("http://", "https://")):
            raise ProviderConfigError(json.dumps({
                "error": "SearXNG instance URL must start with http:// or https://",
                "provided": key,
                "provider": provider
            }))

        return key

    if not key:
        spec = PROVIDER_SPECS[provider]
        env_var = spec.env_var

        error_msg = {
            "error": f"Missing API key for {provider}",
            "env_var": env_var,
            "how_to_fix": [
                f"1. Get your API key from {spec.signup_url}",
                f"2. Add to config.json: \"{provider}\": {{\"api_key\": \"your-key\"}}",
                f"3. Or set environment variable: export {env_var}=\"your-key\"",
            ],
            "provider": provider
        }
        raise ProviderConfigError(json.dumps(error_msg))

    if len(key) < 10:
        raise ProviderConfigError(json.dumps({
            "error": f"API key for {provider} appears invalid (too short)",
            "provider": provider
        }))

    return key


_load_env_file()
