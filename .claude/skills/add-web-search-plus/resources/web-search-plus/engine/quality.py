"""Result normalization, deduplication, reranking, and quality-report helpers."""

import hashlib
import re
from typing import Any, Dict, List, Optional, Tuple
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
    if rule.endswith("."):
        # Label-prefix rules such as "docs." / "investor." / "ir." match a
        # leading host label (docs.python.org), never a bare domain (notdocs.com).
        return domain.startswith(rule)
    # Exact domain or true subdomain only. A bare startswith would let
    # look-alike registrations such as openai.com.evil.example inherit
    # authority boosts (same reasoning as _blocked_domain_matches below).
    return domain == rule or domain.endswith(f".{rule}")


# Known content mirrors and SEO scraper sites that republish Stack Overflow,
# GitHub, and documentation content. These add no information over the
# canonical source and frequently outrank it; they are removed from results
# rather than merely demoted. Operators can extend via config
# quality.blocked_domains or rescue a domain via quality.allowed_domains.
SPAM_MIRROR_DOMAINS: List[str] = [
    # Stack Overflow / Q&A scrapers
    "newbedev.com",
    "stackoom.com",
    "stackovergo.com",
    "syntaxfix.com",
    "copyprogramming.com",
    "devcodef1.com",
    "exceptionshub.com",
    "code-examples.net",
    "i-harness.com",
    "fixmycodeerror.com",
    "stacklesson.com",
    # GitHub issue/readme mirrors
    "githubmemory.com",
    "gitmemory.com",
    "issueexplorer.com",
    "bleepcoder.com",
    "gitanswer.com",
    # Documentation mirrors
    "w3cub.com",
    # Generic AI/SEO content farms already demoted by the intent reranker
    "aizolo.com",
]


def _blocked_domain_matches(domain: str, rule: str) -> bool:
    """Strict matcher for domain block/allow lists.

    Only the exact domain or true subdomains match (``newbedev.com``,
    ``de.newbedev.com``). Unlike ``_domain_matches_rule`` there is no
    ``startswith`` clause, so look-alike registrations such as
    ``newbedev.com.evil.example`` do NOT match.
    """
    return domain == rule or domain.endswith(f".{rule}")


_SITE_OPERATOR_RE = re.compile(r"\bsite:([a-z0-9][a-z0-9.-]*)", re.IGNORECASE)


def extract_domain_constraints(query: str, include_domains: Optional[List[str]] = None) -> List[str]:
    """Domains the user explicitly constrained the search to.

    Collects ``site:`` operators from the query plus ``include_domains``.
    Explicit constraints express intent: constrained domains are exempt from
    spam filtering, and domain-diversity reranking is skipped entirely.
    """
    domains = [d.lower().rstrip(".") for d in _SITE_OPERATOR_RE.findall(query or "")]
    for entry in include_domains or []:
        if entry and entry.strip():
            domains.append(entry.lower().strip())
    return sorted(set(domains))


def filter_spam_results(
    results: List[Dict[str, Any]],
    extra_blocked: Optional[List[str]] = None,
    allowed: Optional[List[str]] = None,
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Drop results from known mirror/SEO-spam domains.

    Returns the kept results and the sorted unique domains that were removed.
    ``allowed`` rescues a domain from both the builtin and extra blocklists.
    """
    blocked_rules = SPAM_MIRROR_DOMAINS + [d.lower().strip() for d in (extra_blocked or []) if d and d.strip()]
    allowed_rules = [d.lower().strip() for d in (allowed or []) if d and d.strip()]
    kept: List[Dict[str, Any]] = []
    removed_domains: List[str] = []
    for item in results:
        domain = _result_domain(item.get("url", ""))
        if (
            domain
            and not any(_blocked_domain_matches(domain, rule) for rule in allowed_rules)
            and any(_blocked_domain_matches(domain, rule) for rule in blocked_rules)
        ):
            removed_domains.append(domain)
            continue
        kept.append(item)
    return kept, sorted(set(removed_domains))


def rerank_domain_diversity(
    results: List[Dict[str, Any]],
    max_per_domain: int = 2,
) -> Tuple[List[Dict[str, Any]], int]:
    """Stable rerank that stops one domain from crowding out the result list.

    The first ``max_per_domain`` results per domain keep their original order;
    overflow results are moved behind the diverse head (also in original
    order) instead of being dropped. Returns the reranked list and how many
    results were demoted.
    """
    if max_per_domain < 1 or len(results) < 3:
        return results, 0
    head: List[Dict[str, Any]] = []
    overflow: List[Dict[str, Any]] = []
    per_domain: Dict[str, int] = {}
    for item in results:
        domain = _result_domain(item.get("url", ""))
        count = per_domain.get(domain, 0)
        if domain and count >= max_per_domain:
            overflow.append(item)
            continue
        per_domain[domain] = count + 1
        head.append(item)
    return head + overflow, len(overflow)


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
        "adaptive_adjustments": routing_info.get("adaptive_adjustments", {}),
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
