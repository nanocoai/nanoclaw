"""Result normalization, deduplication, reranking, and quality-report helpers."""

import hashlib
import re
from typing import Any, Dict, List, Tuple
from urllib.parse import urlparse


ROUTING_POLICY = "routing-v2"


def _title_from_url(url: str) -> str:
    """Derive a readable title from a URL when none is provided."""
    try:
        parsed = urlparse(url)
        domain = parsed.netloc.replace("www.", "")
        # Use last meaningful path segment as context
        segments = [s for s in parsed.path.strip("/").split("/") if s]
        if segments:
            last = segments[-1].replace("-", " ").replace("_", " ")
            # Strip file extensions
            last = re.sub(r'\.\w{2,4}$', '', last)
            if last:
                return f"{domain} — {last[:80]}"
        return domain
    except Exception:
        return url[:60]


def normalize_result_url(url: str) -> str:
    if not url:
        return ""
    parsed = urlparse(url.strip())
    netloc = (parsed.netloc or "").lower()
    if netloc.startswith("www."):
        netloc = netloc[4:]
    path = parsed.path.rstrip("/")
    return f"{netloc}{path}"


def deduplicate_results_across_providers(results_by_provider: List[Tuple[str, Dict[str, Any]]], max_results: int) -> Tuple[List[Dict[str, Any]], int]:
    deduped = []
    seen = set()
    dedup_count = 0
    for provider_name, data in results_by_provider:
        for item in data.get("results", []):
            norm = normalize_result_url(item.get("url", ""))
            if norm and norm in seen:
                dedup_count += 1
                continue
            if norm:
                seen.add(norm)
            item = item.copy()
            item.setdefault("provider", provider_name)
            deduped.append(item)
            if len(deduped) >= max_results:
                return deduped, dedup_count
    return deduped, dedup_count

def _choose_tie_winner(query: str, winners: List[str], priority: List[str]) -> str:
    """Break score ties deterministically per query.

    Uses a stable hash of the query to distribute ties across providers while
    keeping the same query reproducible across runs.
    """
    ordered_winners = [p for p in priority if p in winners]
    if not ordered_winners:
        ordered_winners = sorted(winners)
    if len(ordered_winners) == 1:
        return ordered_winners[0]
    digest = hashlib.sha256(f"{query}|{'|'.join(ordered_winners)}".encode("utf-8")).hexdigest()
    idx = int(digest[:8], 16) % len(ordered_winners)
    return ordered_winners[idx]


def _result_domain(url: str) -> str:
    try:
        netloc = urlparse(url or "").netloc.lower()
        return netloc[4:] if netloc.startswith("www.") else netloc
    except Exception:
        return ""


CANONICAL_DOMAIN_RULES: Dict[str, Dict[str, List[str]]] = {
    "official_vendor_release": {
        "boost": [
            "mistral.ai", "anthropic.com", "openai.com", "googleblog.com",
            "blog.google", "ai.google.dev", "meta.com", "ai.meta.com",
            "nvidia.com", "developer.nvidia.com", "apple.com", "microsoft.com",
        ],
        "demote": ["youtube.com", "youtu.be", "medium.com", "aizolo.com", "reddit.com"],
    },
    "official_docs": {
        "boost": ["docs.", "developer.", "github.com", "readthedocs.io", "modelcontextprotocol.io"],
        "demote": ["medium.com", "dev.to", "reddit.com", "stackoverflow.com", "youtube.com"],
    },
    "policy_pdf": {
        "boost": ["europa.eu", "ec.europa.eu", "nist.gov", "nvlpubs.nist.gov", "oecd.org", "who.int", "gov.uk", "federalregister.gov"],
        "demote": ["scribd.com", "researchgate.net", "universityofcalifornia.edu", "slideshare.net"],
    },
    "finance_earnings_official": {
        "boost": ["investor.", "ir.", "nvidia.com", "sec.gov", "nasdaq.com"],
        "demote": ["reddit.com", "fool.com", "seekingalpha.com", "youtube.com"],
    },
    "security_advisory": {
        "boost": ["nvd.nist.gov", "cve.org", "github.com", "github.com/advisories", "security.", "cert.europa.eu", "kb.cert.org"],
        "demote": ["youtube.com", "medium.com", "reddit.com"],
    },
}


def _domain_matches_rule(domain: str, rule: str) -> bool:
    return domain == rule or domain.endswith(f".{rule}") or domain.startswith(rule)


def _url_matches_rule(url: str, rule: str) -> bool:
    domain = _result_domain(url)
    if "/" not in rule:
        return _domain_matches_rule(domain, rule)
    normalized = normalize_result_url(url)
    normalized_rule = rule.lower().strip().rstrip("/")
    return normalized == normalized_rule or normalized.startswith(f"{normalized_rule}/")


def rerank_results_for_intent(
    query: str,
    routing_class: str,
    results: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Small authority reranker for classes where source authority beats snippet luck."""
    rules = CANONICAL_DOMAIN_RULES.get(routing_class, {})
    if not results or not rules:
        return results, {"reranked": False, "routing_class": routing_class}

    q = query.lower()
    scored: List[Tuple[float, int, Dict[str, Any]]] = []
    for idx, item in enumerate(results):
        url = item.get("url", "")
        domain = _result_domain(url)
        title = (item.get("title") or "").lower()
        snippet = (item.get("snippet") or item.get("description") or "").lower()
        score = float(len(results) - idx) * 0.01
        if any(_url_matches_rule(url, rule) for rule in rules.get("boost", [])):
            score += 10.0
        if any(_url_matches_rule(url, rule) for rule in rules.get("demote", [])):
            score -= 6.0
        if routing_class == "official_vendor_release" and any(term in domain for term in ("mistral", "anthropic", "openai", "nvidia", "google", "meta")):
            score += 3.0
        if routing_class == "policy_pdf" and (item.get("url", "").lower().endswith(".pdf") or "pdf" in title):
            score += 2.0
        if "official" in q and ("official" in title or "official" in snippet):
            score += 1.0
        scored.append((score, idx, item))

    reranked = [item.copy() for _, _, item in sorted(scored, key=lambda row: (-row[0], row[1]))]
    before_urls = [item.get("url", "") for item in results]
    after_urls = [item.get("url", "") for item in reranked]
    changed = before_urls != after_urls
    return reranked, {
        "reranked": changed,
        "routing_class": routing_class,
        "top_domain_before": _result_domain(results[0].get("url", "")) if results else None,
        "top_domain_after": _result_domain(reranked[0].get("url", "")) if reranked else None,
    }


def build_authority_signals(routing_class: str, results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Summarize primary-source authority signals for quality reports."""
    rules = CANONICAL_DOMAIN_RULES.get(routing_class, {})
    urls = [item.get("url", "") for item in results if item.get("url")]
    domains = [_result_domain(url) for url in urls]
    boosted_domains = []
    demoted_domains = []
    boosted_flags = []
    for url, domain in zip(urls, domains):
        boosted = any(_url_matches_rule(url, rule) for rule in rules.get("boost", []))
        demoted = any(_url_matches_rule(url, rule) for rule in rules.get("demote", []))
        boosted_flags.append(boosted)
        if boosted:
            boosted_domains.append(domain)
        if demoted:
            demoted_domains.append(domain)

    return {
        "routing_class": routing_class,
        "rules_applied": bool(rules),
        "top_domain": domains[0] if domains else None,
        "canonical_domain_hits": sorted(set(boosted_domains)),
        "demoted_domain_hits": sorted(set(demoted_domains)),
        "canonical_top_result": bool(boosted_flags and boosted_flags[0]),
    }


def _snippet_text(item: Dict[str, Any]) -> str:
    return " ".join(
        str(item.get(k) or "")
        for k in ("description", "snippet", "content", "raw_content", "summary")
    ).strip()


def build_quality_report(
    query: str,
    result: Dict[str, Any],
    routing_info: Dict[str, Any],
    providers_considered: List[str],
    eligible_providers: List[str],
    cooldown_skips: List[Dict[str, Any]],
    errors: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Build transparent search-quality diagnostics without changing results."""
    results = result.get("results", []) or []
    domains = [_result_domain(r.get("url", "")) for r in results]
    domains = [d for d in domains if d]
    unique_domains = sorted(set(domains))
    duplicate_count = int(result.get("metadata", {}).get("dedup_count", 0) or 0)

    short_snippets = 0
    for item in results:
        if len(_snippet_text(item)) < 40:
            short_snippets += 1

    extract_reasons: List[str] = []
    confidence_level = routing_info.get("confidence_level") or "unknown"
    confidence_score = routing_info.get("confidence")
    if confidence_level == "low" or (confidence_score is not None and float(confidence_score or 0) < 0.4):
        extract_reasons.append("low routing confidence")
    if len(results) < 3:
        extract_reasons.append("few search results")
    if results and len(unique_domains) <= 1:
        extract_reasons.append("low domain diversity")
    if duplicate_count:
        extract_reasons.append("duplicate results detected")
    if results and short_snippets / max(len(results), 1) >= 0.5:
        extract_reasons.append("thin snippets")

    skipped = []
    for item in cooldown_skips:
        skipped.append({
            "provider": item.get("provider"),
            "reason": "cooldown",
            "cooldown_remaining_seconds": item.get("cooldown_remaining_seconds"),
        })
    for err in errors:
        skipped.append({
            "provider": err.get("provider"),
            "reason": "error",
            "error": err.get("error"),
        })

    routing_class = routing_info.get("analysis_summary", {}).get("routing_class")
    authority_signals = build_authority_signals(routing_class, results) if routing_class else None

    return {
        "query": query,
        "selected_provider": routing_info.get("provider") or result.get("provider"),
        "routing_reason": routing_info.get("reason"),
        "routing_policy": routing_info.get("routing_policy", ROUTING_POLICY),
        "routing_class": routing_class,
        "language_hint": routing_info.get("analysis_summary", {}).get("language_hint"),

        "confidence": confidence_level,
        "confidence_score": routing_info.get("confidence"),
        "providers_considered": providers_considered,
        "eligible_providers": eligible_providers,
        "skipped_providers": skipped,
        "result_count": len(results),
        "domain_count": len(unique_domains),
        "domains": unique_domains,
        "domain_diversity": (len(unique_domains) / len(results)) if results else 0.0,
        "duplicate_count": duplicate_count,
        "thin_snippet_count": short_snippets,
        "extract_recommended": bool(extract_reasons),
        "extract_reasons": extract_reasons,
        "scores": routing_info.get("scores", {}),
        "authority_signals": authority_signals,
    }


def select_research_providers(
    primary_provider: str,
    provider_priority: List[str],
    available_providers: set,
    max_providers: int = 3,
) -> List[str]:
    """Pick a compact provider set for research mode."""
    preferred = [primary_provider, "linkup", "tavily", "exa", "firecrawl", "brave", "serper", "you", "querit"]
    ordered: List[str] = []
    for provider in preferred + provider_priority:
        if provider and provider in available_providers and provider not in ordered:
            ordered.append(provider)
        if len(ordered) >= max_providers:
            break
    return ordered
