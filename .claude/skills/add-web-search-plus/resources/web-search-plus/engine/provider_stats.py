"""Rolling provider performance memory for adaptive routing.

Routing v2 scores are benchmarked but static: a provider that has been slow
or returning empty results for days keeps its full score. This module records
the real outcome of every provider call (latency, result count, errors) in a
small rolling window and turns it into a bounded score adjustment, so routing
gently prefers providers that are currently fast and productive — without
ever overriding strong query-class signals.
"""

from __future__ import annotations

import json
import os
import statistics
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional

from cache import CACHE_DIR


PROVIDER_STATS_FILE = CACHE_DIR / "provider_stats.json"
# Rolling window: keep this many most-recent samples per provider.
MAX_SAMPLES_PER_PROVIDER = 50
# Ignore samples older than this; stale history should not steer routing.
SAMPLE_MAX_AGE_SECONDS = 7 * 24 * 3600
# Providers need this many fresh samples before stats influence routing.
MIN_SAMPLES_FOR_ADJUSTMENT = 5
# Hard bound on routing-score influence. Query-class signals weigh 1.0-4.0
# per match, so performance can break ties and nudge close calls but never
# overrule a clear content-based winner.
MAX_SCORE_ADJUSTMENT = 1.0
# Median latency at or above this counts as fully slow (speed factor 0).
LATENCY_CEILING_SECONDS = 8.0
# Neutral point: providers performing at this combined level get adjustment 0.
PERFORMANCE_BASELINE = 0.75

_STATS_LOCK = threading.Lock()


def _load_stats() -> Dict[str, Any]:
    if not PROVIDER_STATS_FILE.exists():
        return {}
    try:
        with open(PROVIDER_STATS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, IOError):
        return {}


def _save_stats(state: Dict[str, Any]) -> None:
    PROVIDER_STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=PROVIDER_STATS_FILE.name + ".",
        suffix=".tmp",
        dir=str(PROVIDER_STATS_FILE.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp_name, PROVIDER_STATS_FILE)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def record_provider_outcome(
    provider: str,
    latency_seconds: float,
    result_count: int,
    error: bool,
    now: Optional[float] = None,
) -> None:
    """Append one provider-call outcome to the rolling window.

    Best-effort: stats must never break a search, so persistence errors are
    swallowed.
    """
    sample = {
        "t": int(now if now is not None else time.time()),
        "lat": round(max(0.0, float(latency_seconds)), 3),
        "n": int(max(0, result_count)),
        "err": bool(error),
    }
    try:
        with _STATS_LOCK:
            state = _load_stats()
            samples = state.get(provider)
            if not isinstance(samples, list):
                samples = []
            samples.append(sample)
            state[provider] = samples[-MAX_SAMPLES_PER_PROVIDER:]
            _save_stats(state)
    except Exception:
        pass


def _fresh_samples(samples: Any, now: float) -> List[Dict[str, Any]]:
    if not isinstance(samples, list):
        return []
    cutoff = now - SAMPLE_MAX_AGE_SECONDS
    return [
        sample for sample in samples
        if isinstance(sample, dict) and int(sample.get("t", 0) or 0) >= cutoff
    ]


def get_provider_performance(provider: str, now: Optional[float] = None) -> Optional[Dict[str, Any]]:
    """Return summarized fresh performance for one provider, or None."""
    now_ts = now if now is not None else time.time()
    samples = _fresh_samples(_load_stats().get(provider), now_ts)
    if not samples:
        return None
    successes = [s for s in samples if not s.get("err")]
    empty = [s for s in successes if int(s.get("n", 0) or 0) == 0]
    latencies = [float(s.get("lat", 0.0) or 0.0) for s in successes]
    return {
        "samples": len(samples),
        "success_rate": round(len(successes) / len(samples), 3),
        "empty_rate": round(len(empty) / len(successes), 3) if successes else 0.0,
        "median_latency_seconds": round(statistics.median(latencies), 3) if latencies else None,
    }


def performance_adjustment(provider: str, now: Optional[float] = None) -> float:
    """Bounded routing-score adjustment from recent real-world performance.

    Combines reliability (success rate, discounted by empty-result rate) and
    speed (median latency vs. LATENCY_CEILING_SECONDS) into
    [-MAX_SCORE_ADJUSTMENT, +MAX_SCORE_ADJUSTMENT]. Returns 0.0 until
    MIN_SAMPLES_FOR_ADJUSTMENT fresh samples exist.
    """
    perf = get_provider_performance(provider, now=now)
    if not perf or perf["samples"] < MIN_SAMPLES_FOR_ADJUSTMENT:
        return 0.0
    reliability = perf["success_rate"] * (1.0 - 0.5 * perf["empty_rate"])
    median_latency = perf["median_latency_seconds"]
    if median_latency is None:
        speed = 0.0
    else:
        speed = max(0.0, min(1.0, 1.0 - median_latency / LATENCY_CEILING_SECONDS))
    combined = 0.6 * reliability + 0.4 * speed
    adjustment = (combined - PERFORMANCE_BASELINE) * 2 * MAX_SCORE_ADJUSTMENT
    return round(max(-MAX_SCORE_ADJUSTMENT, min(MAX_SCORE_ADJUSTMENT, adjustment)), 3)


def performance_adjustments(providers: List[str], now: Optional[float] = None) -> Dict[str, float]:
    """Adjustments for several providers; providers without impact are omitted."""
    adjustments = {}
    for provider in providers:
        value = performance_adjustment(provider, now=now)
        if value != 0.0:
            adjustments[provider] = value
    return adjustments
