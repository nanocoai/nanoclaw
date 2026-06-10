"""Provider cooldown and retry helpers for Web Search Plus."""

import json
import os
import random
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, Tuple

from cache import CACHE_DIR
from http_client import ProviderRequestError


PROVIDER_HEALTH_FILE = CACHE_DIR / "provider_health.json"
COOLDOWN_STEPS_SECONDS = [60, 300, 1500, 3600]  # 1m -> 5m -> 25m -> 1h cap
RETRY_BACKOFF_SECONDS = [1, 3, 9]
# Add up to this fraction of the base delay as random jitter so concurrent or
# repeated retries against a recovering provider do not synchronize into bursts.
RETRY_JITTER_FRACTION = 0.5

# Serializes read-modify-write of the shared health file when search/extract run
# providers concurrently in-process (e.g. parallel research mode). Atomic writes
# already prevent torn reads; this prevents lost updates between threads.
_HEALTH_LOCK = threading.Lock()


def _retry_delay(attempt: int) -> float:
    """Return the backoff delay (seconds) for a retry attempt, with jitter."""
    base = RETRY_BACKOFF_SECONDS[min(attempt, len(RETRY_BACKOFF_SECONDS) - 1)]
    return base + random.uniform(0.0, base * RETRY_JITTER_FRACTION)


def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _load_provider_health() -> Dict[str, Any]:
    if not PROVIDER_HEALTH_FILE.exists():
        return {}
    try:
        with open(PROVIDER_HEALTH_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, IOError):
        return {}


def _save_provider_health(state: Dict[str, Any]) -> None:
    _ensure_parent(PROVIDER_HEALTH_FILE)
    fd, tmp_name = tempfile.mkstemp(
        prefix=PROVIDER_HEALTH_FILE.name + ".",
        suffix=".tmp",
        dir=str(PROVIDER_HEALTH_FILE.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp_name, PROVIDER_HEALTH_FILE)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def provider_in_cooldown(provider: str) -> Tuple[bool, int]:
    state = _load_provider_health()
    pstate = state.get(provider, {})
    cooldown_until = int(pstate.get("cooldown_until", 0) or 0)
    remaining = cooldown_until - int(time.time())
    return (remaining > 0, max(0, remaining))


def mark_provider_failure(provider: str, error_message: str) -> Dict[str, Any]:
    with _HEALTH_LOCK:
        state = _load_provider_health()
        now = int(time.time())
        pstate = state.get(provider, {})
        fail_count = int(pstate.get("failure_count", 0)) + 1
        cooldown_seconds = COOLDOWN_STEPS_SECONDS[min(fail_count - 1, len(COOLDOWN_STEPS_SECONDS) - 1)]
        state[provider] = {
            "failure_count": fail_count,
            "cooldown_until": now + cooldown_seconds,
            "cooldown_seconds": cooldown_seconds,
            "last_error": error_message,
            "last_failure_at": now,
        }
        _save_provider_health(state)
        return state[provider]


def reset_provider_health(provider: str) -> None:
    with _HEALTH_LOCK:
        state = _load_provider_health()
        if provider in state:
            state.pop(provider, None)
            _save_provider_health(state)


def execute_provider_with_retry(provider: str, operation, max_attempts: int = 3) -> Dict[str, Any]:
    """Execute a provider operation with shared transient-error retry semantics."""
    last_error = None
    for attempt in range(0, max_attempts):
        try:
            return operation()
        except ProviderRequestError as e:
            last_error = e
            if e.status_code in {401, 403}:
                break
            if not e.transient:
                break
            if attempt < max_attempts - 1:
                time.sleep(_retry_delay(attempt))
                continue
            break
        except Exception as e:
            last_error = e
            break
    raise last_error if last_error else Exception(f"Unknown {provider} provider execution error")
