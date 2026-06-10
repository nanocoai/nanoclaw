"""Filesystem cache helpers for Web Search Plus."""

import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Optional


CACHE_DIR = Path(os.environ.get("WSP_CACHE_DIR", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".cache")))
DEFAULT_CACHE_TTL = 3600  # 1 hour in seconds
PROVIDER_HEALTH_FILENAME = "provider_health.json"


def _build_cache_payload(query: str, provider: str, max_results: int, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Build normalized payload used for cache key hashing."""
    payload = {
        "query": query,
        "provider": provider,
        "max_results": max_results,
    }
    if params:
        payload.update(params)
    return payload


def _get_cache_key(query: str, provider: str, max_results: int, params: Optional[Dict[str, Any]] = None) -> str:
    """Generate a unique cache key from all relevant query parameters."""
    payload = _build_cache_payload(query, provider, max_results, params)
    key_string = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(key_string.encode("utf-8")).hexdigest()[:32]


def _get_cache_path(cache_key: str) -> Path:
    """Get the file path for a cache entry."""
    return CACHE_DIR / f"{cache_key}.json"


def _ensure_cache_dir() -> None:
    """Create cache directory if it doesn't exist."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _atomic_write_json(path: Path, data: Dict[str, Any]) -> None:
    """Write JSON through a temp file and atomic replace to avoid torn cache reads."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def cache_get(query: str, provider: str, max_results: int, ttl: int = DEFAULT_CACHE_TTL, params: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """
    Retrieve cached search results if they exist and are not expired.

    Args:
        query: The search query
        provider: The search provider
        max_results: Maximum results requested
        ttl: Time-to-live in seconds (default: 1 hour)

    Returns:
        Cached result dict or None if not found/expired
    """
    cache_key = _get_cache_key(query, provider, max_results, params)
    cache_path = _get_cache_path(cache_key)

    if not cache_path.exists():
        return None

    try:
        with open(cache_path, "r", encoding="utf-8") as f:
            cached = json.load(f)

        cached_time = cached.get("_cache_timestamp", 0)
        if time.time() - cached_time > ttl:
            # Cache expired, remove it
            cache_path.unlink(missing_ok=True)
            return None

        return cached
    except (json.JSONDecodeError, IOError, KeyError):
        # Corrupted cache file, remove it
        cache_path.unlink(missing_ok=True)
        return None


def cache_put(query: str, provider: str, max_results: int, result: Dict[str, Any], params: Optional[Dict[str, Any]] = None) -> None:
    """
    Store search results in cache.

    Args:
        query: The search query
        provider: The search provider
        max_results: Maximum results requested
        result: The search result to cache
    """
    _ensure_cache_dir()

    cache_key = _get_cache_key(query, provider, max_results, params)
    cache_path = _get_cache_path(cache_key)

    # Add cache metadata
    cached_result = result.copy()
    cached_result["_cache_timestamp"] = time.time()
    cached_result["_cache_key"] = cache_key
    cached_result["_cache_query"] = query
    cached_result["_cache_provider"] = provider
    cached_result["_cache_max_results"] = max_results
    cached_result["_cache_params"] = params or {}

    try:
        _atomic_write_json(cache_path, cached_result)
    except IOError as e:
        # Non-fatal: log to stderr but don't fail
        print(json.dumps({"cache_write_error": str(e)}), file=sys.stderr)


def cache_clear() -> Dict[str, Any]:
    """
    Clear all cached results.

    Returns:
        Stats about what was cleared
    """
    if not CACHE_DIR.exists():
        return {"cleared": 0, "message": "Cache directory does not exist"}

    count = 0
    size_freed = 0

    for cache_file in CACHE_DIR.glob("*.json"):
        if cache_file.name == PROVIDER_HEALTH_FILENAME:
            continue
        try:
            size_freed += cache_file.stat().st_size
            cache_file.unlink()
            count += 1
        except IOError:
            pass

    return {
        "cleared": count,
        "size_freed_bytes": size_freed,
        "size_freed_kb": round(size_freed / 1024, 2),
        "message": f"Cleared {count} cached entries"
    }


def cache_stats() -> Dict[str, Any]:
    """
    Get statistics about the cache.

    Returns:
        Dict with cache statistics
    """
    if not CACHE_DIR.exists():
        return {
            "total_entries": 0,
            "total_size_bytes": 0,
            "total_size_kb": 0,
            "oldest": None,
            "newest": None,
            "cache_dir": str(CACHE_DIR),
            "exists": False
        }

    entries = [p for p in CACHE_DIR.glob("*.json") if p.name != PROVIDER_HEALTH_FILENAME]
    total_size = 0
    oldest_time = None
    newest_time = None
    oldest_query = None
    newest_query = None
    provider_counts = {}

    for cache_file in entries:
        try:
            stat = cache_file.stat()
            total_size += stat.st_size

            with open(cache_file, "r", encoding="utf-8") as f:
                cached = json.load(f)

            ts = cached.get("_cache_timestamp", 0)
            query = cached.get("_cache_query", "unknown")
            provider = cached.get("_cache_provider", "unknown")

            provider_counts[provider] = provider_counts.get(provider, 0) + 1

            if oldest_time is None or ts < oldest_time:
                oldest_time = ts
                oldest_query = query
            if newest_time is None or ts > newest_time:
                newest_time = ts
                newest_query = query
        except (json.JSONDecodeError, IOError):
            pass

    return {
        "total_entries": len(entries),
        "total_size_bytes": total_size,
        "total_size_kb": round(total_size / 1024, 2),
        "providers": provider_counts,
        "oldest": {
            "timestamp": oldest_time,
            "age_seconds": int(time.time() - oldest_time) if oldest_time else None,
            "query": oldest_query
        } if oldest_time else None,
        "newest": {
            "timestamp": newest_time,
            "age_seconds": int(time.time() - newest_time) if newest_time else None,
            "query": newest_query
        } if newest_time else None,
        "cache_dir": str(CACHE_DIR),
        "exists": True
    }
