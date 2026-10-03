"""In-process provider bakeoff ("bench") for Web Search Plus.

Runs a small fixed query suite against every configured search-capable
provider and reports success rate, median latency, result volume, and simple
quality signals (duplicate-free URLs, snippet coverage), then recommends an
``auto_routing.provider_priority`` order ranked by a weighted score.

Two deliberate properties:

- Provider failures never abort a bench run; they are captured per query and
  simply rank the provider lower.
- Bench traffic must not poison operational state: provider search functions
  are called directly, bypassing ``execute_provider_with_retry`` /
  ``mark_provider_failure`` (provider_health cooldowns) and
  ``record_provider_outcome`` (provider_stats adaptive-routing memory).

The bench never writes configuration. Applying the recommended priority is an
explicit operator step (``setup.py config set-priority ...``).
"""

from __future__ import annotations

import importlib
import statistics
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from config import (
    _validate_searxng_url,
    keyless_public_allowed,
    provider_configured,
    validate_api_key,
)
from provider_registry import DEFAULT_PROVIDER_PRIORITY, PROVIDER_SPECS, SEARCH_PROVIDER_IDS
from provider_stats import LATENCY_CEILING_SECONDS
from quality import _snippet_text, normalize_result_url


# Fixed, representative query suite drawn from the scripts/golden_eval.py
# categories (docs, vendor release, community, non-English). Kept small on
# purpose: every bench query spends real provider quota.
BENCH_QUERIES: List[Dict[str, str]] = [
    {
        "id": "docs-mcp-spec",
        "category": "docs",
        "query": "model context protocol specification documentation",
    },
    {
        "id": "vendor-release-tailscale",
        "category": "news_vendor_release",
        "query": "latest Tailscale release notes subnet router",
    },
    {
        "id": "community-local-llm",
        "category": "community",
        "query": "site:reddit.com/r/LocalLLaMA best local LLM inference server 2026",
    },
    {
        "id": "german-ki-regulierung",
        "category": "non_english",
        "query": "aktuelle KI Regulierung Österreich Unternehmen 2026",
    },
]

# Results requested per bench query: enough for duplicate/snippet signals
# without burning provider quota.
DEFAULT_BENCH_MAX_RESULTS = 5
# Best-effort wall-clock budget for one whole bench run, checked between
# providers. A provider that would start after the budget is skipped and
# reported, never silently dropped.
DEFAULT_BENCH_TIMEOUT_BUDGET_SECONDS = 120.0

# Ranking weights. Reliability dominates: a provider that errors is useless no
# matter how fast it is. Latency beats fine-grained quality signals because a
# slow provider stalls every fallback chain it leads.
SCORE_WEIGHT_SUCCESS_RATE = 0.5
SCORE_WEIGHT_LATENCY = 0.3
SCORE_WEIGHT_QUALITY = 0.2
# Quality signal mix: duplicate-free URLs vs. results carrying a usable snippet.
QUALITY_WEIGHT_UNIQUE_URLS = 0.5
QUALITY_WEIGHT_SNIPPET_COVERAGE = 0.5
# Snippets shorter than this count as thin (mirrors quality.build_quality_report).
MIN_SNIPPET_CHARS = 40
# Bench output is often pasted into issues; keep captured error strings short.
ERROR_MESSAGE_MAX_CHARS = 200

RECOMMENDATION_CONFIG_KEY = "auto_routing.provider_priority"
RECOMMENDATION_NOTE = (
    "Recommendation only — no configuration was written. Review the scores, "
    "then apply the priority yourself if it matches your needs."
)


def _resolve_search_module(search_module: Optional[Any] = None) -> Any:
    """Return the module exposing the ``search_<provider>`` seams.

    ``search.py`` passes itself so bench honours the same monkeypatch seams as
    the rest of the pipeline (tests patch ``search.search_you`` etc.). When
    called without one (e.g. ``bench.run_bench(config)`` from a REPL), the flat
    sibling ``search`` module is imported lazily to avoid an import cycle.
    """
    if search_module is not None:
        return search_module
    return importlib.import_module("search")


def bench_eligible_providers(config: Dict[str, Any]) -> List[str]:
    """Configured, search-capable, not-disabled providers, in registry order."""
    auto_config = config.get("auto_routing")
    if not isinstance(auto_config, dict):
        auto_config = {}
    disabled = set(auto_config.get("disabled_providers", []) or [])
    return [
        provider
        for provider in SEARCH_PROVIDER_IDS
        if provider not in disabled and provider_configured(provider, config)
    ]


def _call_provider_search(
    search: Any,
    provider: str,
    query: str,
    max_results: int,
    config: Dict[str, Any],
) -> Dict[str, Any]:
    """Call one provider's search function directly.

    Deliberately bypasses ``execute_provider_with_retry`` so a bench run never
    marks provider health failures, triggers cooldowns, or records adaptive
    routing stats.
    """
    key = validate_api_key(provider, config)
    if provider == "searxng":
        return search.search_searxng(
            query=query,
            instance_url=_validate_searxng_url(key),
            max_results=max_results,
        )
    if provider == "keenable":
        return search.search_keenable(
            query=query,
            api_key=key,
            max_results=max_results,
            public=keyless_public_allowed(provider, config),
        )
    if provider in ("perplexity", "kilo-perplexity"):
        return search.search_perplexity(
            query=query,
            api_key=key,
            max_results=max_results,
            provider_name=provider,
        )
    search_fn = getattr(search, "search_" + provider, None)
    if search_fn is None:
        raise ValueError("Unknown search provider: {}".format(provider))
    return search_fn(query=query, api_key=key, max_results=max_results)


def compute_provider_score(
    success_rate: float,
    median_latency_seconds: Optional[float],
    unique_url_ratio: float,
    snippet_coverage: float,
) -> Tuple[float, Dict[str, float]]:
    """Weighted 0..1 score from success rate, speed, and quality signals."""
    if median_latency_seconds is None:
        latency_component = 0.0
    else:
        latency_component = max(
            0.0, 1.0 - float(median_latency_seconds) / LATENCY_CEILING_SECONDS
        )
    quality_component = (
        QUALITY_WEIGHT_UNIQUE_URLS * unique_url_ratio
        + QUALITY_WEIGHT_SNIPPET_COVERAGE * snippet_coverage
    )
    score = (
        SCORE_WEIGHT_SUCCESS_RATE * success_rate
        + SCORE_WEIGHT_LATENCY * latency_component
        + SCORE_WEIGHT_QUALITY * quality_component
    )
    components = {
        "success_rate": round(success_rate, 3),
        "latency": round(latency_component, 3),
        "quality": round(quality_component, 3),
    }
    return round(score, 3), components


def _bench_one_provider(
    search: Any,
    provider: str,
    queries: List[Dict[str, str]],
    max_results: int,
    config: Dict[str, Any],
) -> Dict[str, Any]:
    """Run the query suite against one provider; errors are captured, not raised."""
    runs: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    latencies: List[float] = []
    total_results = 0
    unique_results = 0
    snippet_results = 0

    for case in queries:
        run: Dict[str, Any] = {
            "id": case.get("id"),
            "category": case.get("category"),
            "query": case.get("query"),
        }
        started = time.monotonic()
        try:
            payload = _call_provider_search(search, provider, case.get("query", ""), max_results, config)
        except Exception as exc:  # noqa: BLE001 - one provider must never abort the bench
            run["ok"] = False
            run["latency_seconds"] = round(time.monotonic() - started, 3)
            run["error"] = str(exc)[:ERROR_MESSAGE_MAX_CHARS]
            errors.append({"id": run["id"], "error": run["error"]})
            runs.append(run)
            continue

        latency = time.monotonic() - started
        results = payload.get("results") if isinstance(payload, dict) else None
        results = [item for item in (results or []) if isinstance(item, dict)]
        seen_urls = set()
        unique_count = 0
        for item in results:
            normalized = normalize_result_url(item.get("url", ""))
            if normalized and normalized in seen_urls:
                continue
            if normalized:
                seen_urls.add(normalized)
            unique_count += 1
        snippet_count = sum(1 for item in results if len(_snippet_text(item)) >= MIN_SNIPPET_CHARS)

        run.update({
            "ok": True,
            "latency_seconds": round(latency, 3),
            "result_count": len(results),
            "unique_result_count": unique_count,
            "snippet_result_count": snippet_count,
        })
        runs.append(run)
        latencies.append(latency)
        total_results += len(results)
        unique_results += unique_count
        snippet_results += snippet_count

    success_count = sum(1 for run in runs if run.get("ok"))
    query_count = len(runs)
    success_rate = round(success_count / query_count, 3) if query_count else 0.0
    median_latency = round(statistics.median(latencies), 3) if latencies else None
    unique_url_ratio = round(unique_results / total_results, 3) if total_results else 0.0
    snippet_coverage = round(snippet_results / total_results, 3) if total_results else 0.0
    avg_result_count = round(total_results / success_count, 1) if success_count else 0.0
    score, components = compute_provider_score(
        success_rate, median_latency, unique_url_ratio, snippet_coverage
    )

    return {
        "provider": provider,
        "score": score,
        "score_components": components,
        "query_count": query_count,
        "success_count": success_count,
        "success_rate": success_rate,
        "median_latency_seconds": median_latency,
        "avg_result_count": avg_result_count,
        "unique_url_ratio": unique_url_ratio,
        "snippet_coverage": snippet_coverage,
        "errors": errors,
        "queries": runs,
    }


def _build_recommendation(ranked: List[str], current_priority: List[str]) -> Dict[str, Any]:
    if ranked:
        apply_hint = "python setup.py config set-priority " + ",".join(ranked)
    else:
        apply_hint = "configure at least one search provider first: python setup.py setup"
    return {
        "config_key": RECOMMENDATION_CONFIG_KEY,
        "provider_priority": list(ranked),
        "current_provider_priority": list(current_priority),
        "apply_hint": apply_hint,
        "note": RECOMMENDATION_NOTE,
    }


def run_bench(
    config: Dict[str, Any],
    queries: Optional[List[Dict[str, str]]] = None,
    providers: Optional[List[str]] = None,
    max_results: int = DEFAULT_BENCH_MAX_RESULTS,
    timeout_budget: float = DEFAULT_BENCH_TIMEOUT_BUDGET_SECONDS,
    search_module: Optional[Any] = None,
) -> Dict[str, Any]:
    """Bench configured search providers in-process and rank them.

    Returns a structured report with per-provider metrics (best score first)
    plus an ``auto_routing.provider_priority`` recommendation. Provider errors
    are captured per query; a failing provider ranks last but never aborts the
    run. Health cooldowns and adaptive routing stats are untouched.
    """
    search = _resolve_search_module(search_module)
    config = config if isinstance(config, dict) else {}
    suite = [dict(case) for case in (queries if queries is not None else BENCH_QUERIES)]

    skipped: List[Dict[str, str]] = []
    selected: List[str] = []
    for provider in (providers if providers is not None else bench_eligible_providers(config)):
        spec = PROVIDER_SPECS.get(provider)
        if spec is None or not spec.supports_search:
            skipped.append({"provider": provider, "reason": "unknown_or_not_search_capable"})
        else:
            selected.append(provider)

    started = time.monotonic()
    rows: List[Dict[str, Any]] = []
    for provider in selected:
        if time.monotonic() - started >= float(timeout_budget):
            skipped.append({"provider": provider, "reason": "time_budget_exhausted"})
            continue
        rows.append(_bench_one_provider(search, provider, suite, max_results, config))

    auto_config = config.get("auto_routing") if isinstance(config.get("auto_routing"), dict) else {}
    current_priority = list(auto_config.get("provider_priority") or DEFAULT_PROVIDER_PRIORITY)
    priority_index = {provider: idx for idx, provider in enumerate(current_priority)}
    rows.sort(
        key=lambda row: (
            -row["score"],
            priority_index.get(row["provider"], len(priority_index)),
            row["provider"],
        )
    )
    ranked = [row["provider"] for row in rows]

    return {
        "ok": any(row["success_count"] for row in rows),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "query_count": len(suite),
        "max_results": int(max_results),
        "timeout_budget_seconds": float(timeout_budget),
        "weights": {
            "success_rate": SCORE_WEIGHT_SUCCESS_RATE,
            "latency": SCORE_WEIGHT_LATENCY,
            "quality": SCORE_WEIGHT_QUALITY,
        },
        "providers": rows,
        "skipped_providers": skipped,
        "recommendation": _build_recommendation(ranked, current_priority),
    }


def format_bench_text(report: Dict[str, Any]) -> str:
    """Human-readable bench table, styled after the doctor's plain-text output."""
    lines = [
        "Web Search Plus Bench",
        "OK: {}".format(report["ok"]),
        "Queries per provider: {} (max_results={})".format(
            report["query_count"], report["max_results"]
        ),
        "",
        "Providers (best first):",
        "  {:<16} {:>5} {:>8} {:>8} {:>8} {:>7} {:>9}".format(
            "provider", "score", "success", "median", "results", "unique", "snippets"
        ),
    ]
    for row in report["providers"]:
        median = row["median_latency_seconds"]
        median_text = "{:.2f}s".format(median) if median is not None else "-"
        lines.append(
            "  {:<16} {:>5.2f} {:>8} {:>8} {:>8} {:>6.0f}% {:>8.0f}%".format(
                row["provider"],
                row["score"],
                "{}/{}".format(row["success_count"], row["query_count"]),
                median_text,
                row["avg_result_count"],
                row["unique_url_ratio"] * 100,
                row["snippet_coverage"] * 100,
            )
        )
        for error in row.get("errors", []):
            lines.append("    ! {}: {}".format(error.get("id"), error.get("error")))
    for item in report.get("skipped_providers", []):
        lines.append("  - {}: skipped ({})".format(item.get("provider"), item.get("reason")))

    recommendation = report["recommendation"]
    lines.extend([
        "",
        "Recommended {}:".format(recommendation["config_key"]),
        "  {}".format(", ".join(recommendation["provider_priority"]) or "(none — no provider produced results)"),
        "Apply with:",
        "  {}".format(recommendation["apply_hint"]),
        recommendation["note"],
    ])
    return "\n".join(lines)
