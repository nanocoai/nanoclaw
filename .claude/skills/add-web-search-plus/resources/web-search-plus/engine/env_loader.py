"""Shared environment loading helpers for Web Search Plus.

The plugin supports three credential locations, in precedence order:
1. plugin-local ``.env`` for standalone/plugin development
2. legacy parent ``.env`` used by earlier installs
3. Hermes profile ``.env`` (``$HERMES_HOME/.env`` or hermes_constants)

Values already present in ``os.environ`` are never overwritten.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import List, MutableMapping, Optional, Set, Union


def is_placeholder_env_value(value: str) -> bool:
    """Return True for empty/template placeholders that are not credentials."""
    stripped = (value or "").strip().strip('"').strip("'")
    return not stripped or set(stripped) == {"*"}


def clean_env_value(value: str) -> Optional[str]:
    """Return a real env value, or None for empty/template placeholders."""
    stripped = (value or "").strip().strip('"').strip("'")
    return None if is_placeholder_env_value(stripped) else stripped


def get_hermes_env_path() -> Path:
    """Return Hermes' profile-aware .env path when available."""
    try:
        from hermes_constants import get_hermes_home  # type: ignore

        return Path(get_hermes_home()) / ".env"
    except Exception:
        return Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")) / ".env"


def candidate_env_paths(anchor_file: Union[str, Path]) -> List[Path]:
    """Return .env files checked for a module anchored in the plugin dir."""
    plugin_dir = Path(anchor_file).resolve().parent
    paths = [
        plugin_dir / ".env",
        plugin_dir.parent / ".env",
        get_hermes_env_path(),
    ]
    deduped: List[Path] = []
    seen: Set[str] = set()
    for path in paths:
        key = str(path.expanduser())
        if key not in seen:
            deduped.append(path)
            seen.add(key)
    return deduped


def load_env_files(anchor_file: Union[str, Path], environ: Optional[MutableMapping[str, str]] = None) -> List[Path]:
    """Load supported .env files without overriding existing env vars.

    Returns the files that existed and were inspected. Template placeholders such
    as ``***`` are ignored so they do not mask later real credentials.
    """
    target_env = environ if environ is not None else os.environ
    loaded: List[Path] = []
    for env_path in candidate_env_paths(anchor_file):
        if not env_path.exists():
            continue
        loaded.append(env_path)
        for raw_line in env_path.read_text().splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[7:]
            key, _, value = line.partition("=")
            key = key.strip()
            value = clean_env_value(value)
            if key and value and key not in target_env:
                target_env[key] = value
    return loaded
