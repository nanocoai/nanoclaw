"""
web-search-plus — Hermes Plugin v2.8.1
Multi-provider web search, URL extraction, quality reports, and opt-in research mode.
Ported from robbyczgw-cla/web-search-plus-plugin (OpenClaw) to Hermes Plugin API.
"""
from __future__ import annotations

__version__ = "2.8.1"

import argparse
import getpass
import importlib.util
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import sys
import threading
import time
import webbrowser
from concurrent.futures import TimeoutError as FuturesTimeout
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional

# Hermes standalone plugin discovery can execute this flat plugin from outside
# the plugin directory. Keep sibling-module fallback imports cwd-independent
# without shadowing host/other-plugin modules ahead of normal sys.path entries.
_PLUGIN_DIR = Path(__file__).resolve().parent
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.append(str(_PLUGIN_DIR))

try:  # Package load path used by Hermes plugin discovery.
    from .provider_registry import (
        DEFAULT_AUTO_ALLOW,
        DEFAULT_PROVIDER_PRIORITY,
        EXTRACT_PROVIDER_ENV_KEYS,
        KEYLESS_EXTRACT_PROVIDER_IDS,
        KEYLESS_PROVIDER_IDS,
        PROVIDER_ENV_KEYS,
        PROVIDER_SPECS,
        keyless_public_env_var,
        plugin_catalog,
    )
    from .env_loader import clean_env_value as _shared_clean_env_value, get_hermes_env_path, is_truthy, load_env_files
    from .cache import MAX_STORED_TEXT_CHARS, store_web_text
    from .config import load_config
except ImportError:  # Direct script/test imports from the plugin directory.
    from provider_registry import (
        DEFAULT_AUTO_ALLOW,
        DEFAULT_PROVIDER_PRIORITY,
        EXTRACT_PROVIDER_ENV_KEYS,
        KEYLESS_EXTRACT_PROVIDER_IDS,
        KEYLESS_PROVIDER_IDS,
        PROVIDER_ENV_KEYS,
        PROVIDER_SPECS,
        keyless_public_env_var,
        plugin_catalog,
    )
    from env_loader import clean_env_value as _shared_clean_env_value, get_hermes_env_path, is_truthy, load_env_files
    from cache import MAX_STORED_TEXT_CHARS, store_web_text
    from config import load_config

try:
    from .daemon_tasks import DaemonTask
except ImportError:
    from daemon_tasks import DaemonTask

_SEARCH_SCRIPT = Path(__file__).parent / "search.py"
_TOOLSET_NAME = "web-search-plus"
_PROVIDER_ENV_KEYS = list(PROVIDER_ENV_KEYS)
_EXTRACT_PROVIDER_ENV_KEYS = list(EXTRACT_PROVIDER_ENV_KEYS)
_KEYLESS_EXTRACT_PROVIDER_IDS = list(KEYLESS_EXTRACT_PROVIDER_IDS)
_KEYLESS_PROVIDER_IDS = list(KEYLESS_PROVIDER_IDS)

logger = logging.getLogger(__name__)


def _clean_env_value(value: str) -> Optional[str]:
    """Return a real env value, or None for empty/template placeholders."""
    return _shared_clean_env_value(value)


_PROVIDER_CATALOG = plugin_catalog()


def _load_plugin_env() -> None:
    """Load plugin-local, legacy parent, and Hermes profile .env files."""
    load_env_files(__file__)

# Load plugin .env on import
_load_plugin_env()


def _get_provider_catalog() -> List[Dict[str, Any]]:
    """Return provider onboarding metadata without exposing secrets."""
    return [dict(item) for item in _PROVIDER_CATALOG]


def _read_env_file(path: Path) -> Dict[str, str]:
    """Read simple KEY=VALUE entries from an env file without exposing secrets."""
    values: Dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        value = _clean_env_value(value)
        if key.strip() and value:
            values[key.strip()] = value
    return values


def _provider_config_status(env: Optional[Mapping[str, str]] = None) -> Dict[str, Any]:
    """Describe configured providers by capability tier.

    No single provider key is globally required. Search and extraction are
    capability-based: one search provider enables web_search_plus; one
    extraction-capable provider enables web_extract_plus.
    """
    env = env if env is not None else os.environ
    providers: Dict[str, Dict[str, Any]] = {}
    configured_count = 0
    configured_search_count = 0
    configured_extract_count = 0
    for item in _PROVIDER_CATALOG:
        key = item["env"]
        configured = _clean_env_value(env.get(key) or "") is not None
        configured_count += int(configured)
        capabilities = item.get("capabilities", [])
        if configured and "search" in capabilities:
            configured_search_count += 1
        if configured and "extract" in capabilities:
            configured_extract_count += 1
        providers[item["provider"]] = {
            "env": key,
            "display_name": item["display_name"],
            "configured": configured,
            "recommended": item.get("recommended", False),
            "capabilities": capabilities,
        }
    return {
        "configured": configured_count > 0,
        "search_configured": configured_search_count > 0,
        "extract_configured": configured_extract_count > 0,
        "configured_count": configured_count,
        "configured_search_count": configured_search_count,
        "configured_extract_count": configured_extract_count,
        "total": len(_PROVIDER_CATALOG),
        "providers": providers,
    }


def _get_hermes_env_path() -> Path:
    """Return Hermes' profile-aware .env path when available."""
    return get_hermes_env_path()




_SETUP_PROVIDER_NAMES = set(PROVIDER_SPECS)
_DEFAULT_PROVIDER_PRIORITY = list(DEFAULT_PROVIDER_PRIORITY)
_DEFAULT_AUTO_ALLOW = dict(DEFAULT_AUTO_ALLOW)
_ROUTING_PROVIDER_NAMES = set(PROVIDER_SPECS)


def _get_plugin_config_path() -> Path:
    """Return the behavior config path shared with search.py."""
    override = os.environ.get("WEB_SEARCH_PLUS_CONFIG")
    if override:
        return Path(override)
    return Path(__file__).parent.parent / "config.json"


def _get_hermes_config_path() -> Path:
    """Return the default Hermes config path inspected by the fast-path doctor."""
    return Path(os.environ.get("HERMES_CONFIG", Path.home() / ".hermes" / "config.yaml"))


def _yamlish_has_list_item(text: str, key: str, item: str) -> bool:
    """Tiny dependency-free YAML-ish list checker for Hermes config hints.

    This intentionally avoids PyYAML because the setup helper is stdlib-only. It
    handles the two forms users normally write in config.yaml:

    - key: [a, b]
    - key:
      - a
      - b
    """
    escaped_key = re.escape(key)
    escaped_item = re.escape(item)
    inline = re.search(rf"(?m)^\s*{escaped_key}\s*:\s*\[[^\]]*\b{escaped_item}\b", text)
    if inline:
        return True

    lines = text.splitlines()
    for idx, line in enumerate(lines):
        match = re.match(rf"^(\s*){escaped_key}\s*:\s*$", line)
        if not match:
            continue
        base_indent = len(match.group(1))
        for child in lines[idx + 1:]:
            if not child.strip() or child.lstrip().startswith("#"):
                continue
            indent = len(child) - len(child.lstrip())
            is_list_item = child.lstrip().startswith("-")
            if indent < base_indent or (indent == base_indent and not is_list_item):
                break
            if re.match(rf"^\s*-\s*{escaped_item}\s*(?:#.*)?$", child):
                return True
    return False


def _yamlish_nested_list_item(text: str, parent: str, key: str, item: str) -> bool:
    """Best-effort check for parent.key containing item in simple YAML config."""
    escaped_parent = re.escape(parent)
    escaped_key = re.escape(key)
    escaped_item = re.escape(item)
    lines = text.splitlines()
    for idx, line in enumerate(lines):
        match = re.match(rf"^(\s*){escaped_parent}\s*:\s*$", line)
        if not match:
            continue
        parent_indent = len(match.group(1))
        block: List[str] = []
        for child in lines[idx + 1:]:
            if not child.strip() or child.lstrip().startswith("#"):
                block.append(child)
                continue
            indent = len(child) - len(child.lstrip())
            if indent <= parent_indent:
                break
            block.append(child[parent_indent + 1:] if len(child) > parent_indent else child)
        block_text = "\n".join(block)
        if _yamlish_has_list_item(block_text, key, item):
            return True
        if re.search(rf"(?m)^\s*{escaped_key}\s*:\s*\[[^\]]*\b{escaped_item}\b", block_text):
            return True
    return False


def _build_fastpath_report(config_path: Optional[Path] = None) -> Dict[str, Any]:
    """Inspect local plugin/Hermes hints that affect perceived WSP latency."""
    config_path = config_path or _get_hermes_config_path()
    plugin_yaml = Path(__file__).resolve().parent / "plugin.yaml"
    setup_script = Path(__file__).resolve().parent / "setup.py"
    checks: List[Dict[str, Any]] = []

    plugin_text = ""
    try:
        plugin_text = plugin_yaml.read_text()
    except OSError:
        pass
    checks.append({
        "id": "plugin_tools_declared",
        "ok": all(name in plugin_text for name in ["provides_tools", "web_search_plus", "web_extract_plus"]),
        "detail": "plugin.yaml declares both WSP tools for direct Hermes registration",
    })
    checks.append({
        "id": "standalone_setup_available",
        "ok": setup_script.exists(),
        "detail": "setup.py works without unreleased Hermes core plugin-CLI support",
    })

    config_text = ""
    config_exists = config_path.exists()
    if config_exists:
        try:
            config_text = config_path.read_text()
        except OSError:
            config_text = ""
    legacy_web_disabled = _yamlish_nested_list_item(config_text, "agent", "disabled_toolsets", "web")

    checks.extend([
        {
            "id": "hermes_config_found",
            "ok": config_exists,
            "detail": f"Hermes config inspected at {config_path}",
        },
        {
            "id": "legacy_web_toolset_disabled",
            "ok": legacy_web_disabled,
            "detail": "agent.disabled_toolsets includes web, reducing legacy web-tool ambiguity on current Hermes builds",
            "recommendation": "On current public Hermes builds, set agent.disabled_toolsets: [web] when you want Web Search Plus to be the preferred web path.",
        },
    ])
    ok = all(check["ok"] for check in checks if check["id"] in {"plugin_tools_declared", "standalone_setup_available"})
    preferred = ok and legacy_web_disabled
    return {
        "ok": ok,
        "preferred_web_path_configured": preferred,
        "hermes_config": str(config_path),
        "checks": checks,
        "recommended_hermes_config": {
            "agent.disabled_toolsets": ["web"],
        },
        "notes": [
            "Current public Hermes builds can register plugin tools directly, but may still route large tool catalogs through Tool Search when enabled.",
            "Provider latency still depends on keys, cache, provider health, and whether the agent chooses normal search or research/extract mode.",
            "No local Hermes core patches are required; this doctor only recommends config that exists in current Hermes.",
        ],
    }


def _render_fastpath_report(report: Mapping[str, Any]) -> str:
    lines = [
        "Web Search Plus Fast-Path Doctor",
        f"Status: {'preferred web path configured' if report.get('preferred_web_path_configured') else 'plugin ok; Hermes config can improve routing'}",
        f"Hermes config: {report.get('hermes_config')}",
        "",
        "Checks:",
    ]
    for check in report.get("checks", []):
        marker = "✓" if check.get("ok") else "•"
        lines.append(f"  {marker} {check.get('id')}: {check.get('detail')}")
        if not check.get("ok") and check.get("recommendation"):
            lines.append(f"    Tip: {check.get('recommendation')}")
    lines.extend([
        "",
        "Recommended Hermes config for current public Hermes builds:",
        "  agent:",
        "    disabled_toolsets: [web]",
        "",
        "Note: this plugin does not require local Hermes core patches. If your Hermes build",
        "supports additional tool-pinning options, those may further reduce routing latency,",
        "but they are not required for this doctor or the plugin to work.",
    ])
    return "\n".join(lines)


def _keyless_public_opted_in(provider: str, config_path: Optional[Path] = None) -> bool:
    """Registration-path mirror of config.keyless_public_allowed (env var or config.json, default off)."""
    if is_truthy(os.environ.get(keyless_public_env_var(provider))):
        return True
    try:
        config_path = config_path or _get_plugin_config_path()
        if config_path.exists():
            with open(config_path) as f:
                section = json.load(f).get(PROVIDER_SPECS[provider].config_section, {})
            return isinstance(section, dict) and is_truthy(section.get("allow_public"))
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
        pass
    return False


def _default_behavior_config() -> Dict[str, Any]:
    return {
        "version": 1,
        "default_provider": None,
        "auto_routing": {
            "enabled": True,
            "fallback_provider": "serper",
            "provider_priority": list(_DEFAULT_PROVIDER_PRIORITY),
            "disabled_providers": [],
            "auto_allow": dict(_DEFAULT_AUTO_ALLOW),
            "confidence_threshold": 0.3,
        },
    }


def _normalize_provider_name(provider: str) -> str:
    """Normalize a setup-provider name from the onboarding catalog."""
    normalized = (provider or "").strip().lower()
    if normalized not in _SETUP_PROVIDER_NAMES:
        valid = ", ".join(sorted(_SETUP_PROVIDER_NAMES))
        print(f"Unknown provider: {provider}. Valid providers: {valid}", file=sys.stderr)
        raise SystemExit(2)
    return normalized


def _normalize_routing_provider(provider: str) -> str:
    """Normalize a provider that search.py can actually route to."""
    normalized = (provider or "").strip().lower()
    if normalized == "kilo_perplexity":
        normalized = "kilo-perplexity"
    if normalized not in _ROUTING_PROVIDER_NAMES:
        valid = ", ".join(sorted(_ROUTING_PROVIDER_NAMES))
        print(f"Unknown routing provider: {provider}. Valid routing providers: {valid}", file=sys.stderr)
        raise SystemExit(2)
    return normalized


def _normalize_provider_csv(value: str, *, routing: bool = True) -> List[str]:
    providers: List[str] = []
    seen = set()
    for raw in (value or "").split(","):
        if not raw.strip():
            continue
        provider = _normalize_routing_provider(raw) if routing else _normalize_provider_name(raw)
        if provider in seen:
            print(f"warning: duplicate provider ignored: {provider}", file=sys.stderr)
            continue
        seen.add(provider)
        providers.append(provider)
    if not providers:
        raise SystemExit("At least one provider is required.")
    return providers


def _append_missing_default_providers(providers: List[str]) -> List[str]:
    seen = set(providers)
    merged = list(providers)
    for provider in _DEFAULT_PROVIDER_PRIORITY:
        if provider not in seen:
            seen.add(provider)
            merged.append(provider)
    return merged


def _merge_behavior_config(user_config: Mapping[str, Any]) -> Dict[str, Any]:
    config = _default_behavior_config()
    if not isinstance(user_config, Mapping):
        return config
    config["version"] = int(user_config.get("version", 1) or 1)
    default_provider = user_config.get("default_provider")
    if default_provider:
        config["default_provider"] = _normalize_routing_provider(str(default_provider))
    auto_user = user_config.get("auto_routing", {}) if isinstance(user_config.get("auto_routing", {}), Mapping) else {}
    auto = dict(config["auto_routing"])
    if "enabled" in auto_user:
        auto["enabled"] = bool(auto_user.get("enabled"))
    if auto_user.get("fallback_provider"):
        auto["fallback_provider"] = _normalize_routing_provider(str(auto_user["fallback_provider"]))
    if auto_user.get("provider_priority"):
        if isinstance(auto_user["provider_priority"], str):
            priority = _normalize_provider_csv(auto_user["provider_priority"], routing=True)
        else:
            priority = _normalize_provider_csv(",".join(str(p) for p in auto_user["provider_priority"]), routing=True)
        auto["provider_priority"] = _append_missing_default_providers(priority) if auto.get("enabled", True) is not False else priority
    if "disabled_providers" in auto_user:
        disabled = auto_user.get("disabled_providers") or []
        if isinstance(disabled, str):
            auto["disabled_providers"] = _normalize_provider_csv(disabled, routing=True) if disabled.strip() else []
        else:
            auto["disabled_providers"] = _normalize_provider_csv(",".join(str(p) for p in disabled), routing=True) if disabled else []
    if "auto_allow" in auto_user:
        raw_allow = auto_user.get("auto_allow") or {}
        if not isinstance(raw_allow, Mapping):
            raise SystemExit("auto_allow must be an object mapping provider names to booleans")
        normalized_allow = dict(_DEFAULT_AUTO_ALLOW)
        for raw_provider, allowed in raw_allow.items():
            normalized_allow[_normalize_routing_provider(str(raw_provider))] = bool(allowed)
        auto["auto_allow"] = normalized_allow
    if "confidence_threshold" in auto_user:
        threshold = float(auto_user["confidence_threshold"])
        if threshold < 0.0 or threshold > 1.0:
            raise SystemExit("confidence_threshold must be between 0.0 and 1.0")
        auto["confidence_threshold"] = threshold
    config["auto_routing"] = auto
    if config["default_provider"] and config["default_provider"] in set(auto.get("disabled_providers", [])):
        raise SystemExit("default_provider cannot be disabled")
    return config


def _unique_timestamped_path(path: Path, marker: str) -> Path:
    base = path.with_name(path.name + f".{marker}-{int(time.time())}")
    candidate = base
    suffix = 2
    while candidate.exists():
        candidate = base.with_name(base.name + f"-{suffix}")
        suffix += 1
    return candidate


def _quarantine_behavior_config(path: Path, reason: str) -> None:
    broken = _unique_timestamped_path(path, "broken")
    try:
        path.rename(broken)
        print(f"warning: invalid config moved to {broken}: {reason}", file=sys.stderr)
    except OSError as exc:
        print(f"warning: invalid config could not be moved: {exc}; reason: {reason}", file=sys.stderr)


def _load_behavior_config(path: Optional[Path] = None) -> Dict[str, Any]:
    path = path or _get_plugin_config_path()
    if not path.exists():
        return _default_behavior_config()
    try:
        raw = json.loads(path.read_text() or "{}")
        return _merge_behavior_config(raw)
    except json.JSONDecodeError as exc:
        _quarantine_behavior_config(path, str(exc))
        return _default_behavior_config()
    except (SystemExit, ValueError, TypeError) as exc:
        _quarantine_behavior_config(path, str(exc))
        return _default_behavior_config()


def _atomic_write_json(path: Path, data: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _write_behavior_config(path: Path, data: Mapping[str, Any], *, dry_run: bool = False, backup: bool = False) -> None:
    merged: Dict[str, Any] = {}
    if path.exists():
        try:
            existing = json.loads(path.read_text() or "{}")
            if isinstance(existing, Mapping):
                merged = dict(existing)
        except (json.JSONDecodeError, OSError):
            merged = {}
    for key, value in data.items():
        if isinstance(value, Mapping) and isinstance(merged.get(key), Mapping):
            merged[key] = {**merged[key], **value}
        else:
            merged[key] = value
    rendered = json.dumps(merged, indent=2, sort_keys=True) + "\n"
    if dry_run:
        print(rendered, end="")
        return
    if backup and path.exists():
        backup_path = _unique_timestamped_path(path, "bak")
        shutil.copy2(path, backup_path)
        print(f"Backup written: {backup_path}")
    _atomic_write_json(path, merged)


def _routing_summary(config: Mapping[str, Any]) -> str:
    auto = config.get("auto_routing", {}) if isinstance(config.get("auto_routing"), Mapping) else {}
    lines = [
        "Routing:",
        f"  auto-routing: {'on' if auto.get('enabled', True) else 'off'}",
        f"  default provider: {config.get('default_provider') or 'none'}",
        f"  fallback provider: {auto.get('fallback_provider', 'serper')}",
        "  priority: " + ", ".join(auto.get("provider_priority", _DEFAULT_PROVIDER_PRIORITY)),
        "  disabled: " + (", ".join(auto.get("disabled_providers", [])) or "none"),
        "  auto-allow false: " + (
            ", ".join(p for p, allowed in sorted((auto.get("auto_allow") or {}).items()) if allowed is False) or "none"
        ),
        f"  confidence threshold: {auto.get('confidence_threshold', 0.3)}",
    ]
    return "\n".join(lines)


def _status_payload(env: Optional[Mapping[str, str]] = None, config: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    return {"providers": _provider_config_status(env), "routing": dict(config or _default_behavior_config())}

def _setup_state_path() -> Path:
    return Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")) / "state" / "web-search-plus-onboarding.json"


def _supports_color() -> bool:
    """Return whether ANSI color should be used for the standalone CLI."""
    if os.environ.get("NO_COLOR"):
        return False
    if os.environ.get("FORCE_COLOR"):
        return True
    return bool(getattr(sys.stdout, "isatty", lambda: False)())


def _style(text: str, code: str, *, color: Optional[bool] = None) -> str:
    if color is None:
        color = _supports_color()
    return f"\033[{code}m{text}\033[0m" if color else text


def _capability_badge(enabled: bool, label: str, *, color: Optional[bool] = None) -> str:
    mark = "✓" if enabled else "•"
    rendered = f"{mark} {label}"
    return _style(rendered, "32;1" if enabled else "2", color=color)


def _render_setup_guidance(env: Optional[Mapping[str, str]] = None, *, fancy: bool = False) -> str:
    """Return concise user-facing onboarding guidance."""
    status = _provider_config_status(env)
    if fancy:
        return _render_status_dashboard(status)

    if status["configured"]:
        configured = [
            meta["display_name"]
            for meta in status["providers"].values()
            if meta["configured"]
        ]
        lines = ["web-search-plus is configured. Providers: " + ", ".join(configured)]
        lines.append(
            "Capabilities: "
            f"search={'yes' if status['search_configured'] else 'no'}, "
            f"extraction={'yes' if status['extract_configured'] else 'no'}"
        )
        if status["search_configured"] and not status["extract_configured"]:
            lines.append(
                "Tip: add LINKUP_API_KEY or another extraction key for web_extract_plus."
            )
        return "\n".join(lines)

    lines = [
        "web-search-plus is installed but no provider keys are configured.",
        "No single key is mandatory, but at least one search-capable provider is needed for web_search_plus.",
        "Add LINKUP_API_KEY or another extraction-capable provider for web_extract_plus.",
        "Run `python ~/.hermes/plugins/web-search-plus/setup.py setup` to walk through every supported provider, or add `--preset starter` for the short path.",
        "",
        "Recommended starter providers:",
    ]
    for item in _PROVIDER_CATALOG:
        if item.get("recommended"):
            lines.append(
                f"- {item['display_name']} ({item['env']}): {item['description']} "
                f"Free tier: {item['free_tier']}. Signup: {item['signup_url']}"
            )
    return "\n".join(lines)


def _render_status_dashboard(status: Optional[Dict[str, Any]] = None, *, color: Optional[bool] = None) -> str:
    """Render a compact, premium-feeling status dashboard for humans."""
    status = status or _provider_config_status()
    if color is None:
        color = _supports_color()
    configured = [
        meta["display_name"]
        for meta in status["providers"].values()
        if meta["configured"]
    ]
    title = _style("web-search-plus", "36;1", color=color)
    subtitle = "provider setup"
    lines = [
        f"╭─ {title} {subtitle} " + "─" * 28,
        "│ " + "  ".join([
            _capability_badge(status["search_configured"], "search", color=color),
            _capability_badge(status["extract_configured"], "extraction", color=color),
        ]),
        f"│ Providers: {status['configured_count']}/{status['total']} configured",
    ]
    if configured:
        lines.append("│ Active: " + ", ".join(configured))
    else:
        lines.append("│ Active: none yet — add one search provider to unlock the tools")
    if status["search_configured"] and not status["extract_configured"]:
        lines.append("│ Tip: add Linkup for clean web_extract_plus markdown.")
    elif not status["search_configured"]:
        lines.append("│ Starter: You + Serper + Linkup is the best first setup.")
    lines.extend([
        "╰─ Next commands",
        "   python ~/.hermes/plugins/web-search-plus/setup.py setup",
        "   python ~/.hermes/plugins/web-search-plus/setup.py list",
        "   python ~/.hermes/plugins/web-search-plus/search.py --query \"Hermes Agent latest release\" --quality-report",
    ])
    return "\n".join(lines)


def _render_provider_catalog(*, json_output: bool = False, color: Optional[bool] = None) -> str:
    """Render provider metadata for either scripts or humans."""
    catalog = _get_provider_catalog()
    if json_output:
        return json.dumps(catalog, indent=2)
    if color is None:
        color = _supports_color()
    lines = [_style("Providers", "36;1", color=color)]
    for item in catalog:
        star = _style("★", "33;1", color=color) if item.get("recommended") else " "
        caps = ", ".join(item.get("capabilities", []))
        lines.append(f"{star} {item['provider']:<10} {item['display_name']}")
        lines.append(f"    env: {item['env']}  caps: {caps}")
        lines.append(f"    {item['description']}")
        lines.append(f"    free: {item['free_tier']}  signup: {item['signup_url']}")
    lines.append("\n★ recommended starter providers")
    return "\n".join(lines)


def _providers_for_preset(preset: str) -> List[Dict[str, Any]]:
    """Return provider catalog entries for a named setup preset."""
    preset = preset.lower().strip()
    if preset == "starter":
        names = {"you", "serper", "linkup"}
    elif preset == "lean":
        names = {"you", "linkup"}
    elif preset == "search":
        names = {"you", "serper", "exa", "firecrawl", "tavily", "linkup"}
    elif preset == "extract":
        names = {"linkup", "firecrawl", "tavily"}
    elif preset == "all":
        names = {item["provider"] for item in _PROVIDER_CATALOG}
    else:
        raise SystemExit(f"Unknown preset: {preset}. Choose starter, lean, search, extract, or all.")
    return [item for item in _PROVIDER_CATALOG if item["provider"] in names]


def _upsert_env_values(env_path: Path, values: Mapping[str, str]) -> Dict[str, List[str]]:
    """Insert/update env values in a .env file. Caller owns secret prompting."""
    env_path.parent.mkdir(parents=True, exist_ok=True)
    existing_lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    keys = set(values)
    seen = set()
    added: List[str] = []
    updated: List[str] = []
    output: List[str] = []

    for line in existing_lines:
        if "=" not in line or line.lstrip().startswith("#"):
            output.append(line)
            continue
        key, _, _old = line.partition("=")
        clean_key = key.strip()
        if clean_key in keys:
            output.append(f"{clean_key}={values[clean_key]}")
            updated.append(clean_key)
            seen.add(clean_key)
        else:
            output.append(line)

    for key, value in values.items():
        if key not in seen:
            output.append(f"{key}={value}")
            added.append(key)

    # The .env holds plaintext API keys: create it 0600 and re-tighten an
    # existing file before writing so other local users cannot read secrets.
    env_path.touch(mode=0o600, exist_ok=True)
    try:
        os.chmod(env_path, 0o600)
    except OSError:
        pass
    env_path.write_text("\n".join(output).rstrip() + "\n", encoding="utf-8")
    return {"updated": updated, "added": added}


def _unconfigured_session_hint(
    env: Optional[Mapping[str, str]] = None,
    state_path: Optional[Path] = None,
) -> Optional[Dict[str, str]]:
    """Return a one-shot unconfigured hint payload, recording acknowledgement in state."""
    if _provider_config_status(env)["configured"]:
        return None
    state_path = state_path or _setup_state_path()
    try:
        if state_path.exists():
            data = json.loads(state_path.read_text() or "{}")
            if data.get("unconfigured_hint_shown"):
                return None
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps({"unconfigured_hint_shown": True}, indent=2) + "\n")
    except Exception as exc:
        logger.debug("web-search-plus onboarding state write failed: %s", exc)
    return {
        "action": "hint",
        "message": "web-search-plus loaded but no provider keys are configured. Run `python ~/.hermes/plugins/web-search-plus/setup.py setup`.",
    }


def _web_search_plus_cli_setup(parser: argparse.ArgumentParser) -> None:
    parser.description = "Configure web-search-plus provider keys with a tiny, secret-safe wizard."
    parser.epilog = (
        "Default setup prompts every provider. Presets: starter=You+Serper+Linkup, lean=You+Linkup, "
        "search=You+Serper+Exa+Firecrawl+Tavily+Linkup, extract=Linkup+Firecrawl+Tavily."
    )
    subs = parser.add_subparsers(dest="web_search_plus_command")
    status = subs.add_parser("status", help="Show a setup dashboard without printing secrets")
    status.add_argument("--plain", action="store_true", help="Print compact legacy text instead of the dashboard")
    status.add_argument("--json", action="store_true", help="Print status as JSON")
    status.add_argument("--env-path", help="Override Hermes .env path for status checks")
    status.add_argument("--config-path", help="Override web-search-plus config.json path")

    setup = subs.add_parser("setup", help="Run the provider-key setup wizard")
    setup.add_argument("providers", nargs="*", help="Provider names to configure (overrides --preset)")
    setup.add_argument("--preset", default="all", help="starter, lean, search, extract, or all (default: all)")
    setup.add_argument("--open", action="store_true", help="Open signup URLs in a browser before prompting")
    setup.add_argument("--env-path", help="Override Hermes .env path")
    setup.add_argument("--config-path", help="Override web-search-plus config.json path")
    setup.add_argument("--show-values", action="store_true", help="Use visible input instead of hidden secret prompts")
    setup.add_argument("--keyless-public", action="store_true", help="Opt into the keyless public tier (no API key) for any keyless provider, skipping its confirmation prompt")
    setup.add_argument("--dry-run", action="store_true", help="Show the setup/routing plan without writing files")
    setup.add_argument("--routing", choices=["auto", "fixed"], help="Persist routing mode after key setup")
    setup.add_argument("--default-provider", help="Provider to use when routing is fixed/off")
    setup.add_argument("--provider-priority", help="Comma-separated auto-routing priority")
    setup.add_argument("--disable-providers", help="Comma-separated providers to exclude from auto-routing")
    setup.add_argument("--auto-allow", help="Comma-separated providers allowed in auto-routing")
    setup.add_argument("--auto-deny", help="Comma-separated providers blocked from auto-routing but still usable explicitly")
    setup.add_argument("--fallback-provider", help="Fallback provider when no route is available")
    setup.add_argument("--confidence-threshold", type=float, help="Auto-routing confidence threshold 0.0-1.0")

    list_cmd = subs.add_parser("list", help="List supported providers, capabilities, and signup URLs")
    list_cmd.add_argument("--json", action="store_true", help="Print provider catalog as JSON")

    fastpath = subs.add_parser("fastpath", help="Inspect WSP setup and Hermes config hints for low-latency tool routing")
    fastpath.add_argument("--json", action="store_true", help="Print fast-path report as JSON")
    fastpath.add_argument("--config-path", help="Hermes config.yaml path to inspect")

    bench_cmd = subs.add_parser(
        "bench",
        help="Benchmark configured search providers with a fixed live query suite and recommend an auto-routing priority (spends real provider quota)",
    )
    bench_cmd.add_argument("--json", action="store_true", help="Print the bench report as JSON")

    config_cmd = subs.add_parser("config", help="Inspect or change routing preferences")
    config_subs = config_cmd.add_subparsers(dest="config_command")
    show = config_subs.add_parser("show", help="Show routing config")
    show.add_argument("--json", action="store_true")
    show.add_argument("--config-path")
    set_routing = config_subs.add_parser("set-routing", help="Turn auto-routing on or off")
    set_routing.add_argument("mode", choices=["on", "off"])
    set_routing.add_argument("--config-path")
    set_routing.add_argument("--dry-run", action="store_true")
    set_default = config_subs.add_parser("set-default", help="Use one fixed provider when auto-routing is off")
    set_default.add_argument("provider")
    set_default.add_argument("--config-path")
    set_default.add_argument("--dry-run", action="store_true")
    set_fallback = config_subs.add_parser("set-fallback", help="Set fallback provider")
    set_fallback.add_argument("provider")
    set_fallback.add_argument("--config-path")
    set_fallback.add_argument("--dry-run", action="store_true")
    set_priority = config_subs.add_parser("set-priority", help="Set comma-separated auto-routing priority")
    set_priority.add_argument("providers")
    set_priority.add_argument("--config-path")
    set_priority.add_argument("--dry-run", action="store_true")
    disable = config_subs.add_parser("disable", help="Disable a provider for auto-routing")
    disable.add_argument("provider")
    disable.add_argument("--config-path")
    disable.add_argument("--dry-run", action="store_true")
    enable = config_subs.add_parser("enable", help="Re-enable a provider for auto-routing")
    enable.add_argument("provider")
    enable.add_argument("--config-path")
    enable.add_argument("--dry-run", action="store_true")
    allow_auto = config_subs.add_parser("set-auto-allow", help="Allow or block a provider from automatic routing/fallback")
    allow_auto.add_argument("provider")
    allow_auto.add_argument("mode", choices=["on", "off", "true", "false", "yes", "no"])
    allow_auto.add_argument("--config-path")
    allow_auto.add_argument("--dry-run", action="store_true")
    threshold = config_subs.add_parser("set-threshold", help="Set routing confidence threshold")
    threshold.add_argument("value", type=float)
    threshold.add_argument("--config-path")
    threshold.add_argument("--dry-run", action="store_true")
    reset = config_subs.add_parser("reset", help="Reset routing config to defaults and back up existing config")
    reset.add_argument("--config-path")
    reset.add_argument("--dry-run", action="store_true")
    reset.add_argument("--yes", action="store_true")
    parser.set_defaults(func=_web_search_plus_cli_command)


def _apply_setup_routing_args(config: Dict[str, Any], args: Any) -> Dict[str, Any]:
    updated = _merge_behavior_config(config)
    auto = dict(updated["auto_routing"])
    if getattr(args, "routing", None):
        auto["enabled"] = getattr(args, "routing") == "auto"
    if getattr(args, "default_provider", None):
        updated["default_provider"] = _normalize_routing_provider(getattr(args, "default_provider"))
        auto["enabled"] = False
    if getattr(args, "provider_priority", None):
        auto["provider_priority"] = _normalize_provider_csv(getattr(args, "provider_priority"), routing=True)
    if getattr(args, "disable_providers", None):
        auto["disabled_providers"] = _normalize_provider_csv(getattr(args, "disable_providers"), routing=True)
    auto_allow = dict(auto.get("auto_allow") or _DEFAULT_AUTO_ALLOW)
    if getattr(args, "auto_allow", None):
        for provider in _normalize_provider_csv(getattr(args, "auto_allow"), routing=True):
            auto_allow[provider] = True
    if getattr(args, "auto_deny", None):
        for provider in _normalize_provider_csv(getattr(args, "auto_deny"), routing=True):
            auto_allow[provider] = False
    auto["auto_allow"] = auto_allow
    if getattr(args, "fallback_provider", None):
        auto["fallback_provider"] = _normalize_routing_provider(getattr(args, "fallback_provider"))
    if getattr(args, "confidence_threshold", None) is not None:
        value = float(getattr(args, "confidence_threshold"))
        if value < 0.0 or value > 1.0:
            raise SystemExit("confidence threshold must be between 0.0 and 1.0")
        auto["confidence_threshold"] = value
    updated["auto_routing"] = auto
    return _merge_behavior_config(updated)


def _handle_config_command(args: Any) -> None:
    subcommand = getattr(args, "config_command", None) or "show"
    path = Path(getattr(args, "config_path", None) or _get_plugin_config_path())
    config = _load_behavior_config(path)
    dry_run = bool(getattr(args, "dry_run", False))

    if subcommand == "show":
        if getattr(args, "json", False):
            print(json.dumps(config, indent=2, sort_keys=True))
        else:
            print(_routing_summary(config))
        return

    if subcommand == "set-routing":
        config["auto_routing"]["enabled"] = getattr(args, "mode") == "on"
    elif subcommand == "set-default":
        provider = _normalize_routing_provider(getattr(args, "provider"))
        config["default_provider"] = provider
        config["auto_routing"]["enabled"] = False
    elif subcommand == "set-fallback":
        config["auto_routing"]["fallback_provider"] = _normalize_routing_provider(getattr(args, "provider"))
    elif subcommand == "set-priority":
        config["auto_routing"]["provider_priority"] = _normalize_provider_csv(getattr(args, "providers"), routing=True)
    elif subcommand == "disable":
        provider = _normalize_routing_provider(getattr(args, "provider"))
        disabled = list(config["auto_routing"].get("disabled_providers", []))
        if provider == config.get("default_provider"):
            raise SystemExit("default_provider cannot be disabled")
        if provider not in disabled:
            disabled.append(provider)
        config["auto_routing"]["disabled_providers"] = disabled
    elif subcommand == "enable":
        provider = _normalize_routing_provider(getattr(args, "provider"))
        config["auto_routing"]["disabled_providers"] = [p for p in config["auto_routing"].get("disabled_providers", []) if p != provider]
    elif subcommand == "set-auto-allow":
        provider = _normalize_routing_provider(getattr(args, "provider"))
        mode = str(getattr(args, "mode")).lower()
        auto_allow = dict(config["auto_routing"].get("auto_allow") or _DEFAULT_AUTO_ALLOW)
        auto_allow[provider] = mode in {"on", "true", "yes"}
        config["auto_routing"]["auto_allow"] = auto_allow
    elif subcommand == "set-threshold":
        value = float(getattr(args, "value"))
        if value < 0.0 or value > 1.0:
            raise SystemExit("confidence threshold must be between 0.0 and 1.0")
        config["auto_routing"]["confidence_threshold"] = value
    elif subcommand == "reset":
        if not getattr(args, "yes", False) and not dry_run:
            raise SystemExit("Refusing to reset without --yes. Use --dry-run to preview.")
        config = _default_behavior_config()
        _write_behavior_config(path, config, dry_run=dry_run, backup=True)
        if not dry_run:
            print(f"✓ Reset routing config: {path}")
        return
    else:
        raise SystemExit(f"Unknown config command: {subcommand}")

    config = _merge_behavior_config(config)
    _write_behavior_config(path, config, dry_run=dry_run)
    if not dry_run:
        print(f"✓ Updated routing config: {path}")
        print(_routing_summary(config))


def _web_search_plus_cli_command(args: Any) -> None:
    command = getattr(args, "web_search_plus_command", None) or "status"
    if command == "list":
        print(_render_provider_catalog(json_output=getattr(args, "json", False)))
        return

    if command == "fastpath":
        config_arg = getattr(args, "config_path", None)
        report = _build_fastpath_report(Path(config_arg) if config_arg else None)
        if getattr(args, "json", False):
            print(json.dumps(report, indent=2, sort_keys=True))
        else:
            print(_render_fastpath_report(report))
        return

    if command == "bench":
        search = _load_search_module()
        if search is None:
            raise SystemExit(
                "web-search-plus: in-process search engine unavailable; "
                "run `python3 search.py --bench` from the plugin directory instead."
            )
        report = search.run_provider_bench(search.load_config())
        if getattr(args, "json", False):
            print(json.dumps(report, indent=2, ensure_ascii=False))
        else:
            print(search.format_bench_text(report))
        return

    if command == "config":
        _handle_config_command(args)
        return

    if command == "status":
        env_path = getattr(args, "env_path", None)
        config_path = getattr(args, "config_path", None)
        if env_path:
            env = _read_env_file(Path(env_path))
        else:
            env = dict(os.environ)
            for key, value in _read_env_file(_get_hermes_env_path()).items():
                env.setdefault(key, value)
        config = _load_behavior_config(Path(config_path)) if config_path else _load_behavior_config()
        if getattr(args, "json", False):
            print(json.dumps(_status_payload(env, config), indent=2, sort_keys=True))
        else:
            print(_render_setup_guidance(env=env, fancy=not getattr(args, "plain", False)))
            print("\n" + _routing_summary(config))
        return

    if command == "setup":
        selected = set(getattr(args, "providers", None) or [])
        selected = {_normalize_provider_name(p) for p in selected} if selected else set()
        catalog = [item for item in _PROVIDER_CATALOG if item["provider"] in selected] if selected else _providers_for_preset(getattr(args, "preset", "all"))
        if not catalog:
            raise SystemExit("No matching providers. Run `python ~/.hermes/plugins/web-search-plus/setup.py list`.")

        env_path = Path(getattr(args, "env_path", None) or _get_hermes_env_path())
        config_path = Path(getattr(args, "config_path", None) or _get_plugin_config_path())
        config = _apply_setup_routing_args(_load_behavior_config(config_path), args)
        print(_render_status_dashboard(_provider_config_status(_read_env_file(env_path))))
        print("\nSetup plan:")
        for item in catalog:
            rec = " recommended" if item.get("recommended") else ""
            caps = ", ".join(item.get("capabilities", []))
            keyless = " — keyless public tier available (no key needed)" if item["provider"] in _KEYLESS_PROVIDER_IDS else ""
            print(f"  • {item['display_name']} ({item['provider']}) — {item['env']} — {caps}{rec}{keyless}")
            print(f"    {item['signup_url']}")
        print(f"\nTarget env file: {env_path}")
        print(f"Target config file: {config_path}")
        print(_routing_summary(config))
        if getattr(args, "dry_run", False):
            print("Dry run only; no keys or routing config written.")
            return

        force_keyless = getattr(args, "keyless_public", False)
        values: Dict[str, str] = {}
        keyless_enable: List[str] = []
        for item in catalog:
            if getattr(args, "open", False):
                webbrowser.open(item["signup_url"])
            prompt = f"{item['display_name']} key ({item['env']}, Enter to skip): "
            try:
                if getattr(args, "show_values", False):
                    value = input(prompt).strip()
                else:
                    value = getpass.getpass(prompt).strip()
            except EOFError:
                value = ""
            if value:
                values[item["env"]] = value
                continue
            if item["provider"] not in _KEYLESS_PROVIDER_IDS or _keyless_public_opted_in(item["provider"], config_path):
                continue
            if force_keyless:
                answer = "y"
            else:
                try:
                    answer = input(f"  Use {item['display_name']} keyless public search (no API key)? [y/N, Enter to skip]: ").strip().lower()
                except (EOFError, OSError):
                    answer = ""
            if answer in ("y", "yes"):
                keyless_enable.append(item["provider"])
        for provider in keyless_enable:
            config.setdefault(PROVIDER_SPECS[provider].config_section, {})["allow_public"] = True
        routing_args_present = any(
            getattr(args, name, None) is not None
            for name in ["routing", "default_provider", "provider_priority", "disable_providers", "fallback_provider", "confidence_threshold"]
        )
        wrote_any = False
        if values:
            result = _upsert_env_values(env_path, values)
            changed = sorted(result["updated"] + result["added"])
            print(f"\n✓ Configured {len(changed)} provider key(s) in {env_path}: " + ", ".join(changed))
            print("✓ Secrets were not printed.")
            wrote_any = True
        if routing_args_present or keyless_enable:
            _write_behavior_config(config_path, config)
            if routing_args_present:
                print(f"✓ Saved routing preferences in {config_path}")
            if keyless_enable:
                names = ", ".join(PROVIDER_SPECS[p].display_name for p in keyless_enable)
                print(f"✓ Enabled keyless public search for {names} in {config_path}")
            wrote_any = True
        if not wrote_any:
            print("No keys entered; nothing changed.")
            return
        print("Next: restart Hermes or run /reset so tools re-register with the new credentials/preferences.")
        return

    raise SystemExit(f"Unknown web-search-plus command: {command}")

def _web_search_plus_slash_setup(raw_args: str = "") -> str:
    """In-session lightweight status/help command."""
    return _render_setup_guidance()


def _on_session_start(**kwargs: Any) -> Optional[Dict[str, str]]:
    hint = _unconfigured_session_hint()
    if hint:
        logger.info(hint["message"])
    return hint


_search_module: Any = None
_search_import_failed = False
_search_import_lock = threading.Lock()


def _load_search_module() -> Any:
    """Load the in-process search engine from this plugin's ``search.py``.

    ``search.py`` still uses flat absolute imports for sibling modules, so the
    plugin directory must be on ``sys.path`` while it loads. The search module
    itself is loaded from its exact file path under a private module name instead
    of ``import search`` so an unrelated global ``search`` module cannot shadow the
    plugin engine.
    """
    global _search_module, _search_import_failed
    if _search_module is not None:
        return _search_module
    if _search_import_failed:
        return None
    with _search_import_lock:
        if _search_module is not None:
            return _search_module
        if _search_import_failed:
            return None
        plugin_dir = str(Path(__file__).parent)
        inserted = False
        if plugin_dir not in sys.path:
            sys.path.insert(0, plugin_dir)
            inserted = True
        # Stash any top-level modules whose names collide with this plugin's
        # flat sibling imports (providers, extract, routing, research, etc.).
        # If hermes-agent's `providers` package is already in sys.modules,
        # `from providers import extract_exa` inside extract.py resolves
        # to the wrong module. Pop them for the duration of the load,
        # restore afterward.
        _COLLIDING_MODULES = (
            "providers",
            "bench",
            "extract",
            "routing",
            "research",
            "search",
            "config",
            "cache",
            "quality",
            "http_client",
            "env_loader",
            "provider_health",
            "provider_registry",
        )
        stashed: dict[str, Any] = {}
        for _name in _COLLIDING_MODULES:
            if _name in sys.modules:
                stashed[_name] = sys.modules.pop(_name)
        try:
            spec = importlib.util.spec_from_file_location("_wsp_search_engine", _SEARCH_SCRIPT)
            if spec is None or spec.loader is None:
                raise ImportError(f"cannot load search engine from {_SEARCH_SCRIPT}")
            _search = importlib.util.module_from_spec(spec)
            sys.modules["_wsp_search_engine"] = _search
            spec.loader.exec_module(_search)
        except Exception:  # pragma: no cover - defensive: fall back to subprocess
            sys.modules.pop("_wsp_search_engine", None)
            logger.exception("web-search-plus: in-process search import failed; using subprocess fallback")
            _search_import_failed = True
            return None
        finally:
            # Restore the original top-level modules so unrelated code that
            # imported `providers` etc. still sees what it expects.
            for _name in _COLLIDING_MODULES:
                sys.modules.pop(_name, None)
            for _name, _mod in stashed.items():
                sys.modules[_name] = _mod
            if inserted:
                try:
                    sys.path.remove(plugin_dir)
                except ValueError:  # pragma: no cover - defensive cleanup
                    pass
        _search_module = _search
        return _search_module


def _force_subprocess() -> bool:
    """Allow operators to opt back into the legacy subprocess path via env."""
    return _clean_env_value(os.environ.get("WSP_FORCE_SUBPROCESS", "")) is not None


def _search_timeout(mode: str, research_time_budget: float, base: int = 75) -> int:
    """Wall-clock budget for a search call, widened for research mode."""
    if mode == "research":
        return max(base, int(research_time_budget) + 15)
    return base


def _call_with_timeout(fn: Callable[[], dict], timeout: int) -> dict:
    """Run ``fn`` on a daemon thread bounded by a wall-clock timeout.

    Mirrors the hard timeout the subprocess used to give us. On timeout we stop
    waiting (the orphaned worker is bounded by per-provider HTTP timeouts) and
    raise ``FuturesTimeout`` for the caller to translate into a structured error.
    A daemon thread — unlike a ThreadPoolExecutor worker — is not joined at
    interpreter exit, so an overdue call cannot stall process shutdown either.
    """
    return DaemonTask(fn).result(timeout=timeout)


def _run_search(
    query: str,
    provider: str = "auto",
    count: int = 5,
    exa_depth: str = "normal",
    time_range: Optional[str] = None,
    freshness: Optional[str] = None,
    include_domains: Optional[List[str]] = None,
    exclude_domains: Optional[List[str]] = None,
    mode: str = "normal",
    quality_report: bool = False,
    research_time_budget: float = 55.0,
    language: Optional[str] = None,
    country: Optional[str] = None,
    subprocess_timeout: int = 75,
) -> dict:
    """Run a search in-process (fast path), falling back to the subprocess engine.

    The in-process path avoids per-call interpreter startup, module re-import, and
    a JSON round-trip. A thread watchdog preserves the wall-clock timeout the
    subprocess previously enforced.
    """
    timeout = _search_timeout(mode, research_time_budget, subprocess_timeout)
    search = None if _force_subprocess() else _load_search_module()
    if search is None:
        return _run_search_subprocess(
            query=query, provider=provider, count=count, exa_depth=exa_depth,
            time_range=time_range, freshness=freshness, include_domains=include_domains,
            exclude_domains=exclude_domains, mode=mode, quality_report=quality_report,
            research_time_budget=research_time_budget, language=language, country=country,
            subprocess_timeout=timeout,
        )

    def call() -> dict:
        return search.run_search_request(
            query=query, provider=provider, count=count, exa_depth=exa_depth,
            time_range=time_range, freshness=freshness, include_domains=include_domains,
            exclude_domains=exclude_domains, mode=mode, quality_report=quality_report,
            research_time_budget=research_time_budget, language=language, country=country,
        )

    try:
        return _call_with_timeout(call, timeout)
    except FuturesTimeout:
        return {"error": f"Search timed out after {timeout}s", "provider": provider, "query": query, "results": []}
    except Exception as e:
        return {"error": str(e), "provider": provider, "query": query, "results": []}


def _run_search_subprocess(
    query: str,
    provider: str = "auto",
    count: int = 5,
    exa_depth: str = "normal",
    time_range: Optional[str] = None,
    freshness: Optional[str] = None,
    include_domains: Optional[List[str]] = None,
    exclude_domains: Optional[List[str]] = None,
    mode: str = "normal",
    quality_report: bool = False,
    research_time_budget: float = 55.0,
    language: Optional[str] = None,
    country: Optional[str] = None,
    subprocess_timeout: int = 75,
) -> dict:
    """Legacy fallback: call search.py as a subprocess and return parsed JSON."""
    cmd = [
        sys.executable,
        str(_SEARCH_SCRIPT),
        "--query", query,
        "--provider", provider,
        "--max-results", str(count),
        "--compact",
    ]
    if exa_depth != "normal":
        cmd += ["--exa-depth", exa_depth]
    if time_range and time_range != "none":
        cmd += ["--time-range", time_range]
    if freshness:
        cmd += ["--freshness", str(freshness)]
    if include_domains:
        cmd += ["--include-domains"] + include_domains
    if exclude_domains:
        cmd += ["--exclude-domains"] + exclude_domains
    if mode != "normal":
        cmd += ["--mode", mode, "--research-time-budget", str(research_time_budget)]
        if mode == "research":
            subprocess_timeout = max(subprocess_timeout, int(research_time_budget) + 15)
    if quality_report:
        cmd.append("--quality-report")
    if language and language != "auto":
        cmd += ["--language", language]
    if country and country != "auto":
        cmd += ["--country", country]

    env = os.environ.copy()

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=subprocess_timeout,
            env=env,
        )
        if result.returncode != 0:
            stderr = result.stderr.strip()
            try:
                return json.loads(stderr)
            except json.JSONDecodeError:
                return {"error": stderr or "Search failed", "provider": provider, "query": query, "results": []}

        return json.loads(result.stdout)

    except subprocess.TimeoutExpired:
        return {"error": f"Search timed out after {subprocess_timeout}s", "provider": provider, "query": query, "results": []}
    except Exception as e:
        return {"error": str(e), "provider": provider, "query": query, "results": []}


def _run_extract(
    urls: List[str],
    provider: str = "auto",
    output_format: str = "markdown",
    include_images: bool = False,
    include_raw_html: bool = False,
    render_js: bool = False,
    subprocess_timeout: int = 90,
) -> dict:
    """Run URL extraction in-process (fast path), falling back to the subprocess."""
    search = None if _force_subprocess() else _load_search_module()
    if search is None:
        return _run_extract_subprocess(
            urls, provider=provider, output_format=output_format,
            include_images=include_images, include_raw_html=include_raw_html,
            render_js=render_js, subprocess_timeout=subprocess_timeout,
        )

    def call() -> dict:
        return search.run_extract_request(
            urls, provider=provider, output_format=output_format,
            include_images=include_images, include_raw_html=include_raw_html,
            render_js=render_js,
        )

    try:
        return _call_with_timeout(call, subprocess_timeout)
    except FuturesTimeout:
        return {"error": f"Extract timed out after {subprocess_timeout}s", "provider": provider, "results": []}
    except Exception as e:
        return {"error": str(e), "provider": provider, "results": []}


def _run_extract_subprocess(
    urls: List[str],
    provider: str = "auto",
    output_format: str = "markdown",
    include_images: bool = False,
    include_raw_html: bool = False,
    render_js: bool = False,
    subprocess_timeout: int = 90,
) -> dict:
    """Legacy fallback: call search.py extract mode and return parsed JSON result."""
    cmd = [
        sys.executable,
        str(_SEARCH_SCRIPT),
        "--extract-urls",
        *urls,
        "--provider",
        provider,
        "--format",
        output_format,
        "--compact",
    ]
    if include_images:
        cmd.append("--extract-images")
    if include_raw_html:
        cmd.append("--include-raw-html")
    if render_js:
        cmd.append("--render-js")

    env = os.environ.copy()
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=subprocess_timeout, env=env)
        if result.returncode != 0:
            stderr = result.stderr.strip()
            try:
                return json.loads(stderr)
            except json.JSONDecodeError:
                return {"error": stderr or "Extract failed", "provider": provider, "results": []}
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired:
        return {"error": f"Extract timed out after {subprocess_timeout}s", "provider": provider, "results": []}
    except Exception as e:
        return {"error": str(e), "provider": provider, "results": []}


def _format_results(data: dict) -> str:
    """Format search results for LLM consumption."""
    if "error" in data and not data.get("results"):
        return f"Search error: {data['error']}"

    results = data.get("results", [])
    provider = data.get("provider", "unknown")
    routing = data.get("routing", {})
    answer = data.get("answer", "")
    cached = data.get("cached", False)

    lines = []

    if routing.get("auto_routed"):
        confidence = routing.get("confidence_level", "")
        reason = routing.get("reason", "")
        lines.append(f"[Provider: {provider} | auto-routed | {confidence} confidence | {reason}]")
    else:
        lines.append(f"[Provider: {provider}{' | cached' if cached else ''}]")

    freshness_meta = (data.get("metadata") or {}).get("freshness")
    if isinstance(freshness_meta, dict) and freshness_meta.get("requested"):
        per_provider = freshness_meta.get("providers")
        if isinstance(per_provider, list):
            applied = [m.get("provider") for m in per_provider if m.get("applied")]
            skipped = [m.get("provider") for m in per_provider if not m.get("applied")]
            detail = "applied by: " + (", ".join(str(p) for p in applied) or "none")
            if skipped:
                detail += " | not supported: " + ", ".join(str(p) for p in skipped)
        elif freshness_meta.get("applied"):
            detail = "applied"
        else:
            detail = f"not applied — {freshness_meta.get('reason', 'unsupported provider')}"
        lines.append(f"[Freshness: {freshness_meta['requested']} | {detail}]")

    if answer:
        lines.append(f"\nAnswer: {answer}\n")

    quality_report = data.get("quality_report") or {}
    if quality_report:
        lines.append(
            "Quality: "
            f"{quality_report.get('confidence', 'unknown')} confidence | "
            f"{quality_report.get('domain_count', 0)} domains | "
            f"{quality_report.get('duplicate_count', 0)} duplicates | "
            f"extract recommended: {quality_report.get('extract_recommended', False)}"
        )
        if quality_report.get("extract_reasons"):
            lines.append("Quality reasons: " + ", ".join(quality_report["extract_reasons"]))
        lines.append("")

    source_summaries = data.get("source_summaries") or []
    if source_summaries:
        lines.append("Extracted source summaries:")
        for i, src in enumerate(source_summaries, 1):
            url = src.get("url", "")
            content = (src.get("content") or src.get("raw_content") or "").strip()
            lines.append(f"{i}. {url}")
            if content:
                lines.append(f"   {content[:500]}")
        lines.append("")

    for i, r in enumerate(results, 1):
        title = r.get("title", "No title")
        url = r.get("url", "")
        snippet = r.get("snippet", "")
        lines.append(f"{i}. {title}")
        if url:
            lines.append(f"   {url}")
        if snippet:
            lines.append(f"   {snippet}")
        lines.append("")

    return "\n".join(lines).strip()




_BASE64_MARKDOWN_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(\s*data:image/[^)]+\)", re.IGNORECASE)
_BASE64_HTML_IMAGE_RE = re.compile(r"<img\b(?=[^>]*\bsrc=[\"']data:image/)[^>]*(?:\balt=[\"']([^\"']*)[\"'])?[^>]*>", re.IGNORECASE)
_DEFAULT_EXTRACT_CHAR_LIMIT = 15000


def _sanitize_extract_content(content: str) -> str:
    """Remove inline base64 image bombs while preserving normal http(s) images."""
    def markdown_repl(match: re.Match[str]) -> str:
        alt = (match.group(1) or "image").strip() or "image"
        return f"[IMAGE: {alt}]"

    def html_repl(match: re.Match[str]) -> str:
        tag = match.group(0)
        alt_match = re.search(r"\balt=[\"']([^\"']*)[\"']", tag, re.IGNORECASE)
        alt = (alt_match.group(1) if alt_match else "image").strip() or "image"
        return f"[IMAGE: {alt}]"

    content = _BASE64_MARKDOWN_IMAGE_RE.sub(markdown_repl, content)
    content = _BASE64_HTML_IMAGE_RE.sub(html_repl, content)
    return content


def _extract_char_limit() -> int:
    """Read web.extract_char_limit with a safe default for old configs."""
    try:
        config = load_config()
        limit = int(((config.get("web") or {}).get("extract_char_limit")) or _DEFAULT_EXTRACT_CHAR_LIMIT)
    except Exception:
        return _DEFAULT_EXTRACT_CHAR_LIMIT
    return max(1000, limit)


def _split_extract_content(content: str, limit: int) -> tuple[str, str, int, int]:
    """Return head, tail, omitted-start line, and omitted char count."""
    head_chars = min(max(1, int(limit * 2 / 3)), max(1, limit - 1))
    tail_chars = min(max(1, int(limit * 0.2)), max(1, limit - head_chars))
    if head_chars + tail_chars >= len(content):
        return content, "", content.count("\n") + 1, 0
    head = content[:head_chars].rstrip()
    tail = content[-tail_chars:].lstrip()
    omitted_start_line = head.count("\n") + 1
    omitted_chars = max(0, len(content) - len(head) - len(tail))
    return head, tail, omitted_start_line, omitted_chars


def _format_truncated_extract_content(content: str, url: str, limit: int) -> str:
    """Return inline-safe extract content, storing full text when truncated."""
    cleaned = _sanitize_extract_content(content)
    if len(cleaned) <= limit:
        return cleaned

    store_meta = store_web_text(url or "unknown-url", cleaned, max_chars=MAX_STORED_TEXT_CHARS)
    head, tail, omitted_start_line, omitted_chars = _split_extract_content(cleaned, limit)
    footer = [
        "",
        "---",
        f"[Content truncated: original {len(cleaned)} chars; omitted middle {omitted_chars} chars; showing head and tail.]",
    ]
    if store_meta.get("stored"):
        footer.append(f"Full cleaned text stored at: {store_meta['path']}")
        footer.append(
            "Page omitted middle with Hermes file tool: "
            f"read_file(path=\"{store_meta['path']}\", offset={omitted_start_line}, limit=500)"
        )
        footer.append("For more of the omitted middle, repeat read_file with the next offset; the stored path contains the cleaned text for page-on-demand.")
        if store_meta.get("capped"):
            footer.append(
                f"Stored file capped at {MAX_STORED_TEXT_CHARS} characters; cleaned text was {store_meta.get('original_chars')} chars."
            )
    else:
        footer.append(f"Full-text store failed for path: {store_meta.get('path')} ({store_meta.get('error', 'unknown error')})")
    return f"{head}\n\n[... omitted middle; see footer for page-on-demand ...]\n\n{tail}" + "\n" + "\n".join(footer)


def _format_extract_results(data: dict) -> str:
    """Format extracted URL content for LLM consumption."""
    if "error" in data and not data.get("results"):
        return f"Extract error: {data['error']}"
    provider = data.get("provider", "unknown")
    lines = [f"[Provider: {provider}]"]
    limit = _extract_char_limit()
    for i, r in enumerate(data.get("results", []), 1):
        title = r.get("title") or "No title"
        url = r.get("url", "")
        content = r.get("content") or r.get("raw_content") or ""
        lines.append(f"\n{i}. {title}")
        if url:
            lines.append(url)
        if r.get("error"):
            lines.append(f"Error: {r['error']}")
        elif content:
            lines.append(_format_truncated_extract_content(content, url, limit))
    return "\n".join(lines).strip()


def register(ctx: Any) -> None:
    """Register web-search-plus tools with Hermes plugin system."""

    schema = {
        "name": "web_search_plus",
        "description": (
            "Multi-provider web search with intelligent auto-routing. "
            "Automatically selects the best provider based on query intent: "
            "Serper for shopping/news/facts, Tavily for research/analysis, "
            "Exa for semantic discovery, "
            "Brave for general web search, "
            "Linkup for source-backed grounding/citations, "
            "Firecrawl for web search plus optional scrape-ready results, "
            "Perplexity for direct answers, You.com for real-time snippets, "
            "SearXNG for privacy-focused/self-hosted search, and SerpBase/Querit only when explicitly enabled or forced. "
            "Set depth='deep' for Exa multi-source synthesis, 'deep-reasoning' for complex cross-document analysis. "
            "Override with provider param if needed."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query",
                },
                "provider": {
                    "type": "string",
                    "enum": ["auto", "serper", "serpbase", "brave", "tavily", "exa", "querit", "linkup", "firecrawl", "parallel", "perplexity", "kilo-perplexity", "you", "searxng", "keenable"],
                    "description": "Search provider. Use 'auto' for intelligent routing (default). Brave and Serper share generic web-search intents and ties are distributed deterministically per query.",
                    "default": "auto",
                },
                "depth": {
                    "type": "string",
                    "enum": ["normal", "deep", "deep-reasoning"],
                    "description": "Exa search depth: 'deep' synthesizes across sources (4-12s), 'deep-reasoning' for complex cross-document analysis (12-50s). Only applies when routed to Exa.",
                    "default": "normal",
                },
                "count": {
                    "type": "integer",
                    "description": "Number of results to return (default: 5)",
                    "default": 5,
                    "minimum": 1,
                    "maximum": 20,
                },
                "time_range": {
                    "type": "string",
                    "enum": ["day", "week", "month", "year"],
                    "description": "Filter results by recency. Optional.",
                },
                "freshness": {
                    "type": "string",
                    "enum": ["day", "week", "month", "year"],
                    "description": (
                        "Unified recency filter (case-insensitive). Applied natively by serper, brave, "
                        "querit, firecrawl, keenable, you, perplexity, kilo-perplexity, and searxng; "
                        "providers without recency support (tavily, exa, linkup, parallel, serpbase) still "
                        "run the search and report freshness.applied=false in result metadata. Optional."
                    ),
                },
                "include_domains": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Whitelist specific domains (e.g. ['arxiv.org', 'github.com']). Optional.",
                },
                "exclude_domains": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Blacklist specific domains (e.g. ['reddit.com']). Optional.",
                },
                "mode": {
                    "type": "string",
                    "enum": ["normal", "research"],
                    "description": "normal = fast routed search; research = multi-provider search plus top-source extraction.",
                    "default": "normal",
                },
                "quality_report": {
                    "type": "boolean",
                    "description": "Attach routing/result quality diagnostics such as selected provider, skips, dedup count, domain diversity, and extraction recommendation.",
                    "default": False,
                },
                "research_time_budget": {
                    "type": "number",
                    "description": "Best-effort wall-clock budget in seconds for research mode. Checked between provider calls and before extraction.",
                    "default": 55.0,
                    "minimum": 1,
                    "maximum": 75,
                },
            },
            "required": ["query"],
        },
    }

    def handler(args_or_query, provider: str = "auto", count: int = 5, depth: str = "normal",
                time_range: Optional[str] = None, freshness: Optional[str] = None,
                include_domains: Optional[List[str]] = None,
                exclude_domains: Optional[List[str]] = None, mode: str = "normal",
                quality_report: bool = False, research_time_budget: float = 55.0, **kwargs) -> str:
        # Hermes registry passes the entire input dict as first positional arg
        if isinstance(args_or_query, dict):
            query = args_or_query.get("query", "")
            provider = args_or_query.get("provider", provider)
            count = args_or_query.get("count", count)
            depth = args_or_query.get("depth", depth)
            time_range = args_or_query.get("time_range", time_range)
            freshness = args_or_query.get("freshness", freshness)
            include_domains = args_or_query.get("include_domains", include_domains)
            exclude_domains = args_or_query.get("exclude_domains", exclude_domains)
            mode = args_or_query.get("mode", mode)
            quality_report = args_or_query.get("quality_report", quality_report)
            research_time_budget = args_or_query.get("research_time_budget", research_time_budget)
        else:
            query = args_or_query
        data = _run_search(
            query=query,
            provider=provider,
            count=count,
            exa_depth=depth,
            time_range=time_range,
            freshness=freshness,
            include_domains=include_domains,
            exclude_domains=exclude_domains,
            mode=mode,
            quality_report=quality_report,
            research_time_budget=research_time_budget,
        )
        return _format_results(data)

    def check_fn() -> bool:
        return any(os.environ.get(k) for k in _PROVIDER_ENV_KEYS) or any(
            _keyless_public_opted_in(p) for p in _KEYLESS_PROVIDER_IDS)

    def extract_check_fn() -> bool:
        return any(os.environ.get(k) for k in _EXTRACT_PROVIDER_ENV_KEYS) or any(
            _keyless_public_opted_in(p) for p in _KEYLESS_EXTRACT_PROVIDER_IDS)

    ctx.register_tool(
        name="web_search_plus",
        toolset=_TOOLSET_NAME,
        schema=schema,
        handler=handler,
        check_fn=check_fn,
        requires_env=[],
        description="Multi-provider web search with intelligent auto-routing",
        emoji="🔍",
    )

    extract_schema = {
        "name": "web_extract_plus",
        "description": (
            "Multi-provider URL content extraction. Auto tries Tavily, Exa, Linkup, "
            "Firecrawl, You.com (plus keyless Keenable when its public endpoint is opted in); "
            "force a provider for robust scraping, clean markdown, or explicit fallback tests."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "urls": {"type": "array", "items": {"type": "string"}, "description": "URLs to extract"},
                "provider": {"type": "string", "enum": ["auto", "firecrawl", "linkup", "parallel", "tavily", "exa", "you", "keenable"], "default": "auto"},
                "format": {"type": "string", "enum": ["markdown", "html"], "default": "markdown"},
                "include_images": {"type": "boolean", "default": False},
                "include_raw_html": {"type": "boolean", "default": False},
                "render_js": {"type": "boolean", "default": False},
            },
            "required": ["urls"],
        },
    }

    def extract_handler(args_or_urls, provider: str = "auto", format: str = "markdown",
                        include_images: bool = False, include_raw_html: bool = False,
                        render_js: bool = False, **kwargs) -> str:
        if isinstance(args_or_urls, dict):
            urls = args_or_urls.get("urls", [])
            provider = args_or_urls.get("provider", provider)
            format = args_or_urls.get("format", format)
            include_images = args_or_urls.get("include_images", include_images)
            include_raw_html = args_or_urls.get("include_raw_html", include_raw_html)
            render_js = args_or_urls.get("render_js", render_js)
        else:
            urls = args_or_urls
        if isinstance(urls, str):
            urls = [urls]
        data = _run_extract(
            urls=urls,
            provider=provider,
            output_format=format,
            include_images=include_images,
            include_raw_html=include_raw_html,
            render_js=render_js,
        )
        return _format_extract_results(data)

    ctx.register_tool(
        name="web_extract_plus",
        toolset=_TOOLSET_NAME,
        schema=extract_schema,
        handler=extract_handler,
        check_fn=extract_check_fn,
        requires_env=[],
        description="Multi-provider URL extraction",
        emoji="📄",
    )

    if hasattr(ctx, "register_command"):
        ctx.register_command(
            name="web-search-plus-setup",
            handler=_web_search_plus_slash_setup,
            description="Show Web Search Plus provider setup status and starter-key guidance.",
            args_hint="",
        )

    if hasattr(ctx, "register_hook"):
        ctx.register_hook("on_session_start", _on_session_start)
