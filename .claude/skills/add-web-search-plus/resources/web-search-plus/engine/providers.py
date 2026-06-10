"""Provider implementations for Web Search Plus search and extraction backends."""

from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import re
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, quote, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen

from http_client import (
    DEFAULT_USER_AGENT,
    ProviderRequestError,
    TRANSIENT_HTTP_CODES,
    _read_json_response,
    _read_response_body,
    make_get_request,
    make_request,
)
from quality import _title_from_url


def search_serper(
    query: str,
    api_key: str,
    max_results: int = 5,
    country: str = "us",
    language: str = "en",
    search_type: str = "search",
    time_range: Optional[str] = None,
    include_images: bool = False,
) -> dict:
    """Search using Serper (Google Search API)."""
    endpoint = f"https://google.serper.dev/{search_type}"

    body = {
        "q": query,
        "gl": country,
        "hl": language,
        "num": max_results,
        "autocorrect": True,
    }

    if time_range and time_range != "none":
        tbs_map = {
            "hour": "qdr:h",
            "day": "qdr:d",
            "week": "qdr:w",
            "month": "qdr:m",
            "year": "qdr:y",
        }
        if time_range in tbs_map:
            body["tbs"] = tbs_map[time_range]

    headers = {
        "X-API-KEY": api_key,
        "Content-Type": "application/json",
    }

    data = make_request(endpoint, headers, body)

    results = []
    for i, item in enumerate(data.get("organic", [])[:max_results]):
        results.append({
            "title": item.get("title", ""),
            "url": item.get("link", ""),
            "snippet": item.get("snippet", ""),
            "score": round(1.0 - i * 0.1, 2),
            "date": item.get("date"),
        })

    answer = ""
    if data.get("answerBox", {}).get("answer"):
        answer = data["answerBox"]["answer"]
    elif data.get("answerBox", {}).get("snippet"):
        answer = data["answerBox"]["snippet"]
    elif data.get("knowledgeGraph", {}).get("description"):
        answer = data["knowledgeGraph"]["description"]
    elif results:
        answer = results[0]["snippet"]

    images = []
    if include_images:
        try:
            img_data = make_request(
                "https://google.serper.dev/images",
                headers,
                {"q": query, "gl": country, "hl": language, "num": 5},
            )
            images = [img.get("imageUrl", "") for img in img_data.get("images", [])[:5] if img.get("imageUrl")]
        except Exception:
            pass

    return {
        "provider": "serper",
        "query": query,
        "results": results,
        "images": images,
        "answer": answer,
        "metadata": {},
        "knowledge_graph": data.get("knowledgeGraph"),
        "related_searches": [r.get("query") for r in data.get("relatedSearches", [])]
    }

def _strip_tracking_params(url: str) -> str:
    """Remove common SERP tracking params while preserving the canonical target URL."""
    if not url:
        return ""
    parsed = urlparse(url)
    tracking_prefixes = ("utm_",)
    tracking_names = {"srsltid", "gclid", "fbclid", "mc_cid", "mc_eid"}
    query = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if key.lower() not in tracking_names and not key.lower().startswith(tracking_prefixes)
    ]
    return urlunparse(parsed._replace(query=urlencode(query, doseq=True)))

def _serpbase_related_search_query(item: Any) -> Optional[str]:
    if isinstance(item, dict):
        return item.get("query") or item.get("title")
    if isinstance(item, str):
        return item
    return None

def search_serpbase(
    query: str,
    api_key: str,
    max_results: int = 5,
    country: str = "us",
    language: str = "en",
    page: int = 1,
    api_url: str = "https://api.serpbase.dev/google/search",
    timeout: int = 30,
) -> dict:
    """Search using SerpBase's Google Search endpoint.

    SerpBase returns HTTP 200 for some business failures, so `status == 0` is
    required before parsing results.
    """
    body = {
        "q": query,
        "hl": language,
        "gl": country,
        "page": page,
    }
    headers = {
        "X-API-Key": api_key,
        "Content-Type": "application/json",
    }

    data = make_request(api_url, headers, body, timeout=timeout)
    status = data.get("status", 0)
    if status != 0:
        message = data.get("message") or data.get("error") or data.get("msg") or "business status failure"
        transient = status in {1029, 1502, 1503, 1504}
        raise ProviderRequestError(f"SerpBase error {status}: {message}", transient=transient)

    results = []
    for i, item in enumerate(data.get("organic", [])[:max_results]):
        results.append({
            "title": item.get("title", ""),
            "url": _strip_tracking_params(item.get("link", "") or item.get("url", "")),
            "snippet": item.get("snippet", ""),
            "score": round(1.0 - i * 0.1, 2),
            "rank": item.get("rank") or item.get("position") or i + 1,
            "display_link": item.get("display_link") or item.get("displayed_link"),
        })

    related_searches = [
        value for value in (_serpbase_related_search_query(item) for item in data.get("related_searches", [])) if value
    ]
    answer = ""
    if data.get("answer_box"):
        answer_box = data.get("answer_box") or {}
        answer = answer_box.get("answer") or answer_box.get("snippet") or ""
    elif data.get("knowledge_graph"):
        kg = data.get("knowledge_graph") or {}
        answer = kg.get("description") or kg.get("subtitle") or ""
    elif results:
        answer = results[0]["snippet"]

    return {
        "provider": "serpbase",
        "query": query,
        "results": results,
        "images": [],
        "answer": answer,
        "metadata": {
            "session_id": data.get("session_id"),
        },
        "knowledge_graph": data.get("knowledge_graph"),
        "related_searches": related_searches,
        "session_id": data.get("session_id"),
    }

def search_brave(
    query: str,
    api_key: str,
    max_results: int = 5,
    country: str = "US",
    language: str = "en",
    time_range: Optional[str] = None,
    safesearch: str = "moderate",
) -> dict:
    """Search using Brave Search API."""
    freshness_map = {
        "hour": "pd",
        "day": "pd",
        "week": "pw",
        "month": "pm",
        "year": "py",
    }
    params = {
        "q": query,
        "count": max_results,
        "country": country.upper(),
        "search_lang": language,
        "safesearch": safesearch,
        "spellcheck": 1,
    }
    if time_range and time_range in freshness_map:
        params["freshness"] = freshness_map[time_range]

    url = f"https://api.search.brave.com/res/v1/web/search?{urlencode(params)}"
    headers = {
        "X-Subscription-Token": api_key,
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
    }

    data = make_get_request(url, headers)

    web_results = (data.get("web") or {}).get("results", [])[:max_results]
    results = []
    for i, item in enumerate(web_results):
        snippet_parts = []
        description = item.get("description") or item.get("snippet") or ""
        if description:
            snippet_parts.append(description)
        extra_snippets = item.get("extra_snippets") or []
        if extra_snippets:
            snippet_parts.extend(extra_snippets[:2])
        results.append({
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "snippet": " ... ".join(part for part in snippet_parts if part),
            "score": round(1.0 - i * 0.1, 2),
            "age": item.get("age"),
        })

    answer = ""
    if data.get("summary"):
        answer = data.get("summary", "")
    elif data.get("infobox", {}).get("description"):
        answer = data["infobox"]["description"]
    elif results:
        answer = results[0]["snippet"]

    return {
        "provider": "brave",
        "query": query,
        "results": results,
        "images": [],
        "answer": answer,
        "metadata": {},
        "mixed": data.get("mixed"),
    }

def search_tavily(
    query: str,
    api_key: str,
    max_results: int = 5,
    depth: str = "basic",
    topic: str = "general",
    include_domains: Optional[List[str]] = None,
    exclude_domains: Optional[List[str]] = None,
    include_images: bool = False,
    include_raw_content: bool = False,
) -> dict:
    """Search using Tavily (AI Research Search)."""
    endpoint = "https://api.tavily.com/search"

    body = {
        "api_key": api_key,
        "query": query,
        "max_results": max_results,
        "search_depth": depth,
        "topic": topic,
        "include_images": include_images,
        "include_answer": True,
        "include_raw_content": include_raw_content,
    }

    if include_domains:
        body["include_domains"] = include_domains
    if exclude_domains:
        body["exclude_domains"] = exclude_domains

    headers = {"Content-Type": "application/json"}

    data = make_request(endpoint, headers, body)

    results = []
    for item in data.get("results", [])[:max_results]:
        result = {
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "snippet": item.get("content", ""),
            "score": round(item.get("score", 0.0), 3),
        }
        if include_raw_content and item.get("raw_content"):
            result["raw_content"] = item["raw_content"]
        results.append(result)

    return {
        "provider": "tavily",
        "query": query,
        "results": results,
        "images": data.get("images", []),
        "answer": data.get("answer", ""),
        "metadata": {},
    }

def _map_querit_time_range(time_range: Optional[str]) -> Optional[str]:
    """Map generic time ranges to Querit's compact date filter format."""
    if not time_range:
        return None
    return {
        "day": "d1",
        "week": "w1",
        "month": "m1",
        "year": "y1",
    }.get(time_range, time_range)

def search_querit(
    query: str,
    api_key: str,
    max_results: int = 5,
    language: str = "en",
    country: str = "us",
    time_range: Optional[str] = None,
    include_domains: Optional[List[str]] = None,
    exclude_domains: Optional[List[str]] = None,
    base_url: str = "https://api.querit.ai",
    base_path: str = "/v1/search",
    timeout: int = 30,
) -> dict:
    """Search using Querit.

    Mirrors the Querit Python SDK payload shape:
      - query
      - count
      - optional filters: languages, geo, sites, timeRange
    """
    endpoint = base_url.rstrip("/") + base_path

    filters: Dict[str, Any] = {}
    if language:
        filters["languages"] = {"include": [language.lower()]}
    if country:
        filters["geo"] = {"countries": {"include": [country.upper()]}}
    if include_domains or exclude_domains:
        sites: Dict[str, List[str]] = {}
        if include_domains:
            sites["include"] = include_domains
        if exclude_domains:
            sites["exclude"] = exclude_domains
        filters["sites"] = sites

    querit_time_range = _map_querit_time_range(time_range)
    if querit_time_range:
        filters["timeRange"] = {"date": querit_time_range}

    body: Dict[str, Any] = {
        "query": query,
        "count": max_results,
    }
    if filters:
        body["filters"] = filters

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    data = make_request(endpoint, headers, body, timeout=timeout)

    error_code = data.get("error_code")
    error_msg = data.get("error_msg")
    if error_msg or (error_code not in (None, 0, 200)):
        message = error_msg or f"Querit request failed with error_code={error_code}"
        raise ProviderRequestError(message)

    raw_results = ((data.get("results") or {}).get("result")) or []
    results = []
    for i, item in enumerate(raw_results[:max_results]):
        snippet = item.get("snippet") or item.get("page_age") or ""
        result = {
            "title": item.get("title") or _title_from_url(item.get("url", "")),
            "url": item.get("url", ""),
            "snippet": snippet,
            "score": round(1.0 - i * 0.05, 3),
        }
        if item.get("page_time") is not None:
            result["page_time"] = item["page_time"]
        if item.get("page_age"):
            result["date"] = item["page_age"]
        if item.get("language") is not None:
            result["language"] = item["language"]
        results.append(result)

    answer = results[0]["snippet"] if results else ""

    return {
        "provider": "querit",
        "query": query,
        "results": results,
        "images": [],
        "answer": answer,
        "metadata": {
            "search_id": data.get("search_id"),
            "time_range": querit_time_range,
        }
    }

def search_linkup(
    query: str,
    api_key: str,
    max_results: int = 5,
    depth: str = "standard",
    output_type: str = "searchResults",
    include_domains: Optional[List[str]] = None,
    exclude_domains: Optional[List[str]] = None,
    api_url: str = "https://api.linkup.so/v1/search",
    timeout: int = 30,
) -> dict:
    """Search using Linkup's source-grounded web search API."""
    body: Dict[str, Any] = {
        "q": query,
        "depth": depth,
        "outputType": output_type,
    }
    if include_domains:
        body["includeDomains"] = include_domains[:50]
    if exclude_domains:
        body["excludeDomains"] = exclude_domains[:50]

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    data = make_request(api_url, headers, body, timeout=timeout)
    if data.get("error"):
        raise ProviderRequestError(str(data.get("error")))

    raw_results = data.get("results") or data.get("sources") or []
    results = []
    for i, item in enumerate(raw_results[:max_results]):
        snippet = item.get("content") or item.get("snippet") or item.get("description") or ""
        result = {
            "title": item.get("name") or item.get("title") or _title_from_url(item.get("url", "")),
            "url": item.get("url", ""),
            "snippet": snippet,
            "score": round(1.0 - i * 0.05, 3),
        }
        if item.get("type") is not None:
            result["type"] = item["type"]
        if item.get("favicon") is not None:
            result["favicon"] = item["favicon"]
        results.append(result)

    return {
        "provider": "linkup",
        "query": query,
        "results": results,
        "images": data.get("images", []),
        "answer": data.get("answer", ""),
        "metadata": {
            "depth": depth,
            "output_type": output_type,
        },
    }

def _map_firecrawl_time_range(time_range: Optional[str]) -> Optional[str]:
    """Map generic time ranges to Firecrawl/Google tbs values."""
    if not time_range:
        return None
    return {
        "hour": "qdr:h",
        "day": "qdr:d",
        "week": "qdr:w",
        "month": "qdr:m",
        "year": "qdr:y",
    }.get(time_range, time_range)

def search_firecrawl(
    query: str,
    api_key: str,
    max_results: int = 5,
    country: str = "US",
    time_range: Optional[str] = None,
    sources: Optional[List[str]] = None,
    include_domains: Optional[List[str]] = None,
    exclude_domains: Optional[List[str]] = None,
    scrape_markdown: bool = False,
    ignore_invalid_urls: bool = False,
    api_url: str = "https://api.firecrawl.dev/v2/search",
    timeout_ms: int = 30000,
) -> dict:
    """Search using Firecrawl's v2 search endpoint."""
    selected_sources = sources or ["web"]
    body: Dict[str, Any] = {
        "query": query,
        "limit": max_results,
        "sources": selected_sources,
        "timeout": timeout_ms,
        "ignoreInvalidURLs": ignore_invalid_urls,
    }

    if country:
        body["country"] = country.upper()

    tbs = _map_firecrawl_time_range(time_range)
    if tbs:
        body["tbs"] = tbs

    if include_domains:
        body["query"] += " " + " ".join(f"site:{domain}" for domain in include_domains)
    if exclude_domains:
        body["query"] += " " + " ".join(f"-site:{domain}" for domain in exclude_domains)

    if scrape_markdown:
        body["scrapeOptions"] = {"formats": ["markdown"]}

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    data = make_request(api_url, headers, body, timeout=max(1, int(timeout_ms / 1000)))
    if data.get("success") is False:
        raise ProviderRequestError(data.get("error") or data.get("warning") or "Firecrawl request failed")

    response_data = data.get("data") or {}
    raw_web = response_data.get("web") or []
    results = []
    for i, item in enumerate(raw_web[:max_results]):
        snippet = item.get("description") or item.get("snippet") or ""
        result = {
            "title": item.get("title") or _title_from_url(item.get("url", "")),
            "url": item.get("url", ""),
            "snippet": snippet,
            "score": round(1.0 - i * 0.05, 3),
        }
        if item.get("position") is not None:
            result["position"] = item.get("position")
        if item.get("category") is not None:
            result["category"] = item.get("category")
        if item.get("markdown"):
            result["raw_content"] = item["markdown"]
            if not result["snippet"]:
                result["snippet"] = item["markdown"][:500]
        metadata = item.get("metadata") or {}
        if metadata.get("statusCode") is not None:
            result["status_code"] = metadata.get("statusCode")
        if metadata.get("error"):
            result["error"] = metadata.get("error")
        results.append(result)

    images = []
    for image in response_data.get("images") or []:
        image_url = image.get("imageUrl")
        if image_url:
            images.append(image_url)

    answer = results[0]["snippet"] if results else ""
    return {
        "provider": "firecrawl",
        "query": query,
        "results": results,
        "images": images,
        "answer": answer,
        "warning": data.get("warning"),
        "credits_used": data.get("creditsUsed"),
        "metadata": {
            "id": data.get("id"),
            "sources": selected_sources,
            "tbs": tbs,
        },
    }

def _normalize_extract_result(
    provider: str,
    url: str,
    title: str = "",
    content: str = "",
    raw_content: Optional[str] = None,
    **extra: Any,
) -> Dict[str, Any]:
    result = {
        "url": url,
        "title": title or _title_from_url(url),
        "content": content or "",
        "raw_content": raw_content if raw_content is not None else (content or ""),
        "provider": provider,
    }
    for key, value in extra.items():
        if value is not None:
            result[key] = value
    return result

def extract_firecrawl(
    urls: List[str],
    api_key: str,
    output_format: str = "markdown",
    include_images: bool = False,
    include_raw_html: bool = False,
    render_js: bool = False,
    api_url: str = "https://api.firecrawl.dev/v2/scrape",
    timeout: int = 60,
) -> dict:
    """Extract URL content using Firecrawl scrape."""
    formats = ["markdown"] if output_format != "html" else ["html"]
    if include_raw_html and "html" not in formats:
        formats.append("html")

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    results: List[Dict[str, Any]] = []
    for url in urls:
        body: Dict[str, Any] = {"url": url, "formats": formats}
        if render_js:
            body["waitFor"] = 1000
        data = make_request(api_url, headers, body, timeout=timeout)
        if data.get("success") is False:
            results.append(_normalize_extract_result("firecrawl", url, error=data.get("error") or data.get("warning") or "Firecrawl scrape failed"))
            continue
        payload = data.get("data") if isinstance(data.get("data"), dict) else data
        metadata = payload.get("metadata") or {}
        final_url = metadata.get("sourceURL") or metadata.get("url") or url
        title = metadata.get("title") or ""
        markdown = payload.get("markdown") or ""
        html = payload.get("html") or payload.get("rawHtml") or ""
        content = html if output_format == "html" else markdown or html
        images = None
        if include_images:
            md_images = []
            seen_image_urls = set()
            for alt, image_url in re.findall(r"!\[([^\]]*)\]\(([^)]+)\)", markdown):
                if image_url not in seen_image_urls:
                    md_images.append({"alt": alt, "url": image_url})
                    seen_image_urls.add(image_url)
            og_image = metadata.get("ogImage") or metadata.get("og:image")
            if og_image and og_image not in seen_image_urls:
                md_images.insert(0, {"alt": "og:image", "url": og_image})
            images = md_images or None
        results.append(_normalize_extract_result(
            "firecrawl",
            final_url,
            title=title,
            content=content,
            raw_content=content,
            raw_html=html if html else None,
            images=images,
            metadata=metadata,
        ))
    return {"provider": "firecrawl", "results": results}

def extract_linkup(
    urls: List[str],
    api_key: str,
    output_format: str = "markdown",
    include_images: bool = False,
    include_raw_html: bool = False,
    render_js: bool = False,
    api_url: str = "https://api.linkup.so/v1/fetch",
    timeout: int = 30,
) -> dict:
    """Extract URL content using Linkup fetch."""
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    def fetch_one(url: str) -> Dict[str, Any]:
        body = {
            "url": url,
            "extractImages": include_images,
            "includeRawHtml": include_raw_html or output_format == "html",
            "renderJs": render_js,
        }
        data = make_request(api_url, headers, body, timeout=timeout)
        if data.get("error"):
            return _normalize_extract_result("linkup", url, error=str(data.get("error")))
        markdown = data.get("markdown") or ""
        raw_html = data.get("rawHtml") or data.get("raw_html") or ""
        content = raw_html if output_format == "html" else markdown or raw_html
        return _normalize_extract_result(
            "linkup",
            url,
            content=content,
            raw_content=content,
            raw_html=raw_html if raw_html else None,
            images=data.get("images") if include_images else None,
        )

    if len(urls) <= 1:
        return {"provider": "linkup", "results": [fetch_one(url) for url in urls]}

    indexed_results: Dict[int, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=min(len(urls), 5)) as executor:
        futures = {executor.submit(fetch_one, url): idx for idx, url in enumerate(urls)}
        for future in as_completed(futures):
            indexed_results[futures[future]] = future.result()
    results = [indexed_results[idx] for idx in range(len(urls)) if idx in indexed_results]
    return {"provider": "linkup", "results": results}

def extract_tavily(
    urls: List[str],
    api_key: str,
    output_format: str = "markdown",
    include_images: bool = False,
    include_raw_html: bool = False,
    render_js: bool = False,
    api_url: str = "https://api.tavily.com/extract",
    timeout: int = 30,
) -> dict:
    """Extract URL content using Tavily extract."""
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    body = {"urls": urls, "include_images": include_images}
    data = make_request(api_url, headers, body, timeout=timeout)
    results: List[Dict[str, Any]] = []
    for item in data.get("results", []):
        url = item.get("url", "")
        content = item.get("raw_content") or item.get("content") or ""
        results.append(_normalize_extract_result(
            "tavily",
            url,
            title=item.get("title", ""),
            content=content,
            raw_content=content,
            images=item.get("images") if include_images else None,
        ))
    for failed in data.get("failed_results", []) or []:
        failed_url = failed.get("url", "")
        results.append(_normalize_extract_result("tavily", failed_url, error=failed.get("error") or "Tavily extract failed"))
    return {"provider": "tavily", "results": results}

def extract_exa(
    urls: List[str],
    api_key: str,
    output_format: str = "markdown",
    include_images: bool = False,
    include_raw_html: bool = False,
    render_js: bool = False,
    api_url: str = "https://api.exa.ai/contents",
    timeout: int = 30,
) -> dict:
    """Extract URL content using Exa Contents API."""
    headers = {"x-api-key": api_key, "Content-Type": "application/json"}
    body: Dict[str, Any] = {"urls": urls, "text": True}
    data = make_request(api_url, headers, body, timeout=timeout)
    results: List[Dict[str, Any]] = []
    for item in data.get("results", []):
        url = item.get("url") or item.get("id") or ""
        content = item.get("text") or item.get("summary") or ""
        results.append(_normalize_extract_result(
            "exa",
            url,
            title=item.get("title", ""),
            content=content,
            raw_content=content,
            summary=item.get("summary"),
            highlights=item.get("highlights"),
            published_date=item.get("publishedDate"),
            author=item.get("author"),
            image=item.get("image") if include_images else None,
            favicon=item.get("favicon"),
        ))
    return {
        "provider": "exa",
        "results": results,
        "request_id": data.get("requestId"),
        "cost_dollars": data.get("costDollars"),
        "statuses": data.get("statuses"),
    }

def extract_you(
    urls: List[str],
    api_key: str,
    output_format: str = "markdown",
    include_images: bool = False,
    include_raw_html: bool = False,
    render_js: bool = False,
    api_url: str = "https://ydc-index.io/v1/contents",
    timeout: int = 30,
) -> dict:
    """Extract URL content using You.com Contents API."""
    formats = ["html" if output_format == "html" else "markdown"]
    if include_raw_html and "html" not in formats:
        formats.append("html")
    if "metadata" not in formats:
        formats.append("metadata")
    headers = {"X-API-Key": api_key, "Content-Type": "application/json"}
    body = {"urls": urls, "formats": formats, "crawl_timeout": max(1, min(timeout, 60))}
    data = make_request(api_url, headers, body, timeout=timeout)
    raw_items = data if isinstance(data, list) else data.get("results", []) or data.get("data", [])
    results: List[Dict[str, Any]] = []
    for item in raw_items:
        url = item.get("url", "")
        markdown = item.get("markdown") or ""
        html = item.get("html") or ""
        content = html if output_format == "html" else markdown or html
        results.append(_normalize_extract_result(
            "you",
            url,
            title=item.get("title", ""),
            content=content,
            raw_content=content,
            raw_html=html if html else None,
            metadata=item.get("metadata"),
        ))
    return {"provider": "you", "results": results}

def extract_parallel(
    urls: List[str],
    api_key: str,
    output_format: str = "markdown",
    include_images: bool = False,
    include_raw_html: bool = False,
    render_js: bool = False,
    api_url: str = "https://api.parallel.ai/v1/extract",
    timeout: int = 60,
    client_model: Optional[str] = None,
    max_chars_total: int = 12000,
    max_chars_per_result: int = 6000,
) -> dict:
    """Extract URL content using Parallel Extract.

    Parallel returns excerpts by default; request full_content explicitly and
    normalize it into the common markdown/content shape. HTML/raw-image options
    are accepted for tool compatibility but ignored when unsupported upstream.
    """
    headers = {"x-api-key": api_key, "Content-Type": "application/json"}
    body: Dict[str, Any] = {
        "urls": urls,
        "max_chars_total": max_chars_total,
        "advanced_settings": {
            "full_content": {"max_chars_per_result": max_chars_per_result}
        },
    }
    if client_model:
        body["client_model"] = client_model

    data = make_request(api_url, headers, body, timeout=timeout)
    results: List[Dict[str, Any]] = []
    for item in data.get("results", []) or []:
        url = item.get("url") or ""
        excerpts = item.get("excerpts") or []
        excerpt_text = "\n\n".join(
            (ex.get("text") or ex.get("content") or "") if isinstance(ex, dict) else str(ex)
            for ex in excerpts
        ).strip()
        content = item.get("full_content") or item.get("markdown") or item.get("content") or excerpt_text
        results.append(_normalize_extract_result(
            "parallel",
            url,
            title=item.get("title", ""),
            content=content,
            raw_content=content,
            excerpts=excerpts or None,
            metadata={k: v for k, v in item.items() if k not in {"url", "title", "full_content", "markdown", "content", "excerpts"}},
        ))
    for failed in data.get("errors", []) or []:
        failed_url = failed.get("url", "") if isinstance(failed, dict) else ""
        results.append(_normalize_extract_result("parallel", failed_url, error=str(failed)))
    return {
        "provider": "parallel",
        "results": results,
        "metadata": {
            "search_id": data.get("search_id"),
            "session_id": data.get("session_id"),
        },
    }

def search_exa(
    query: str,
    api_key: str,
    max_results: int = 5,
    search_type: str = "neural",
    exa_depth: str = "normal",
    category: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    similar_url: Optional[str] = None,
    include_domains: Optional[List[str]] = None,
    exclude_domains: Optional[List[str]] = None,
    text_verbosity: str = "standard",
) -> dict:
    """Search using Exa (Neural/Semantic/Deep Search).

    exa_depth controls synthesis level:
      - "normal": standard search (neural/fast/auto/keyword/instant)
      - "deep": multi-source synthesis with grounding (4-12s, $12/1k)
      - "deep-reasoning": cross-reference reasoning with grounding (12-50s, $15/1k)
    """
    is_deep = exa_depth in ("deep", "deep-reasoning")

    if similar_url:
        # findSimilar does not support deep search types
        endpoint = "https://api.exa.ai/findSimilar"
        body: Dict[str, Any] = {
            "url": similar_url,
            "numResults": max_results,
            "contents": {
                "text": {"maxCharacters": 2000, "verbosity": text_verbosity},
                "highlights": {"numSentences": 3, "highlightsPerUrl": 2},
            },
        }
    elif is_deep:
        endpoint = "https://api.exa.ai/search"
        body = {
            "query": query,
            "numResults": max_results,
            "type": exa_depth,
            "contents": {
                "text": {"maxCharacters": 5000, "verbosity": "full"},
            },
        }
    else:
        endpoint = "https://api.exa.ai/search"
        body = {
            "query": query,
            "numResults": max_results,
            "type": search_type,
            "contents": {
                "text": {"maxCharacters": 2000, "verbosity": text_verbosity},
                "highlights": {"numSentences": 3, "highlightsPerUrl": 2},
            },
        }

    if category:
        body["category"] = category
    if start_date:
        body["startPublishedDate"] = start_date
    if end_date:
        body["endPublishedDate"] = end_date
    if include_domains:
        body["includeDomains"] = include_domains
    if exclude_domains:
        body["excludeDomains"] = exclude_domains

    headers = {
        "x-api-key": api_key,
        "Content-Type": "application/json",
    }

    timeout = 55 if is_deep else 30
    data = make_request(endpoint, headers, body, timeout=timeout)

    results = []

    # Deep search: primary content in output field with grounding citations
    if is_deep:
        deep_output = data.get("output", {})
        synthesized_text = ""
        grounding_citations: List[Dict[str, Any]] = []

        if isinstance(deep_output.get("content"), str):
            synthesized_text = deep_output["content"]
        elif isinstance(deep_output.get("content"), dict):
            synthesized_text = json.dumps(deep_output["content"], ensure_ascii=False)

        for field_citation in deep_output.get("grounding", []):
            for cite in field_citation.get("citations", []):
                grounding_citations.append({
                    "url": cite.get("url", ""),
                    "title": cite.get("title", ""),
                    "confidence": field_citation.get("confidence", ""),
                    "field": field_citation.get("field", ""),
                })

        # Primary synthesized result
        if synthesized_text:
            results.append({
                "title": f"Exa {exa_depth.replace('-', ' ').title()} Synthesis",
                "url": "",
                "snippet": synthesized_text,
                "full_synthesis": synthesized_text,
                "score": 1.0,
                "grounding": grounding_citations[:10],
                "type": "synthesis",
            })

        # Supporting source documents
        for item in data.get("results", [])[:max_results]:
            text_content = item.get("text", "") or ""
            highlights = item.get("highlights", [])
            snippet = text_content[:800] if text_content else (highlights[0] if highlights else "")
            results.append({
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "snippet": snippet,
                "score": round(item.get("score", 0.0), 3),
                "published_date": item.get("publishedDate"),
                "author": item.get("author"),
                "type": "source",
            })

        answer = synthesized_text if synthesized_text else (results[1]["snippet"] if len(results) > 1 else "")

        return {
            "provider": "exa",
            "query": query,
            "exa_depth": exa_depth,
            "results": results,
            "images": [],
            "answer": answer,
            "grounding": grounding_citations,
            "metadata": {
                "synthesis_length": len(synthesized_text),
                "source_count": len(data.get("results", [])),
            },
        }

    # Standard search result parsing
    for item in data.get("results", [])[:max_results]:
        text_content = item.get("text", "") or ""
        highlights = item.get("highlights", [])
        if text_content:
            snippet = text_content[:800]
        elif highlights:
            snippet = " ... ".join(highlights[:2])
        else:
            snippet = ""

        results.append({
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "snippet": snippet,
            "score": round(item.get("score", 0.0), 3),
            "published_date": item.get("publishedDate"),
            "author": item.get("author"),
        })

    answer = results[0]["snippet"] if results else ""

    return {
        "provider": "exa",
        "query": query if not similar_url else f"Similar to: {similar_url}",
        "results": results,
        "images": [],
        "answer": answer,
        "metadata": {},
    }

def search_parallel(
    query: str,
    api_key: str,
    max_results: int = 5,
    include_domains: Optional[List[str]] = None,
    exclude_domains: Optional[List[str]] = None,
    api_url: str = "https://api.parallel.ai/v1/search",
    timeout: int = 45,
    client_model: Optional[str] = None,
) -> dict:
    """Search using Parallel's web search API.

    Parallel returns source URLs plus long LLM-ready excerpts. Its API does not
    currently accept a generic max_results parameter, so results are trimmed
    locally to the requested count.
    """
    search_query = query
    if include_domains:
        search_query += " " + " ".join(f"site:{domain}" for domain in include_domains)
    if exclude_domains:
        search_query += " " + " ".join(f"-site:{domain}" for domain in exclude_domains)

    body: Dict[str, Any] = {
        "objective": query,
        "search_queries": [search_query],
    }
    if client_model:
        body["client_model"] = client_model

    headers = {"x-api-key": api_key, "Content-Type": "application/json"}
    data = make_request(api_url, headers, body, timeout=timeout)

    raw_results = data.get("results") or []
    results = []
    for i, item in enumerate(raw_results[:max_results]):
        excerpts = item.get("excerpts") or []
        snippet_parts = []
        for excerpt in excerpts:
            if isinstance(excerpt, dict):
                snippet_parts.append(excerpt.get("text") or excerpt.get("content") or "")
            elif isinstance(excerpt, str):
                snippet_parts.append(excerpt)
        snippet = "\n\n".join(part for part in snippet_parts if part).strip()
        results.append({
            "title": item.get("title") or _title_from_url(item.get("url", "")),
            "url": item.get("url", ""),
            "snippet": snippet,
            "score": round(1.0 - i * 0.05, 3),
            "publish_date": item.get("publish_date"),
            "excerpts": excerpts,
        })

    answer = " ".join(r.get("snippet", "") for r in results[:3])[:1200]
    return {
        "provider": "parallel",
        "query": query,
        "results": results,
        "images": [],
        "answer": answer,
        "metadata": {
            "search_id": data.get("search_id"),
            "session_id": data.get("session_id"),
            "result_count_raw": len(raw_results),
        },
    }

def search_perplexity(
    query: str,
    api_key: str,
    max_results: int = 5,
    model: str = "sonar-pro",
    api_url: str = "https://api.perplexity.ai/chat/completions",
    freshness: Optional[str] = None,
    provider_name: str = "perplexity",
) -> dict:
    """Search/answer using the native Perplexity API or a compatible gateway.

    Args:
        query: Search query
        api_key: Provider API key
        max_results: Maximum results to return
        model: Perplexity-compatible model to use
        api_url: Chat completions endpoint
        freshness: Filter by recency — 'day', 'week', 'month', 'year' (maps to
                   Perplexity's search_recency_filter parameter)
        provider_name: Result provider label (perplexity or kilo-perplexity)
    """
    # Map generic freshness values to Perplexity's search_recency_filter
    recency_map = {"day": "day", "pd": "day", "week": "week", "pw": "week", "month": "month", "pm": "month", "year": "year", "py": "year"}
    recency_filter = recency_map.get(freshness or "", None)

    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": "Answer with concise factual summary and include source URLs."},
            {"role": "user", "content": query},
        ],
        "temperature": 0.2,
    }
    if recency_filter:
        body["search_recency_filter"] = recency_filter

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    data = make_request(api_url, headers, body)
    choices = data.get("choices", [])
    message = choices[0].get("message", {}) if choices else {}
    answer = (message.get("content") or "").strip()

    # Prefer the structured citations array from Perplexity API response
    api_citations = data.get("citations", [])

    # Fallback: extract URLs from answer text if API doesn't provide citations
    if not api_citations:
        api_citations = []
        seen = set()
        for u in re.findall(r"https?://[^\s)\]}>\"']+", answer):
            if u not in seen:
                seen.add(u)
                api_citations.append(u)

    results = []

    # Primary result: the synthesized answer itself
    if answer:
        # Clean citation markers [1][2] for the snippet
        clean_answer = re.sub(r'\[\d+\]', '', answer).strip()
        results.append({
            "title": f"Perplexity Answer: {query[:80]}",
            "url": "https://www.perplexity.ai",
            "snippet": clean_answer[:500],
            "score": 1.0,
        })

    # Source results from citations
    for i, citation in enumerate(api_citations[:max_results - 1]):
        # citations can be plain URL strings or dicts with url/title
        if isinstance(citation, str):
            url = citation
            title = _title_from_url(url)
        else:
            url = citation.get("url", "")
            title = citation.get("title") or _title_from_url(url)
        results.append({
            "title": title,
            "url": url,
            "snippet": f"Source cited in Perplexity answer [citation {i+1}]",
            "score": round(0.9 - i * 0.1, 3),
        })

    return {
        "provider": provider_name,
        "query": query,
        "results": results,
        "images": [],
        "answer": answer,
        "metadata": {
            "model": model,
            "usage": data.get("usage", {}),
        }
    }

def search_you(
    query: str,
    api_key: str,
    max_results: int = 5,
    country: str = "US",
    language: str = "en",
    freshness: Optional[str] = None,
    safesearch: str = "moderate",
    include_news: bool = True,
    livecrawl: Optional[str] = None,
) -> dict:
    """Search using You.com (LLM-Ready Web & News Search).

    You.com excels at:
    - RAG applications with pre-extracted snippets
    - Combined web + news results in one call
    - Real-time information with automatic news classification
    - Clean, structured JSON optimized for AI consumption

    Args:
        query: Search query
        api_key: You.com API key
        max_results: Maximum results to return (default 5, max 100)
        country: ISO 3166-2 country code (e.g., US, GB, DE)
        language: BCP 47 language code (e.g., en, de, fr)
        freshness: Filter by recency: day, week, month, year, or YYYY-MM-DDtoYYYY-MM-DD
        safesearch: Content filter: off, moderate (default), strict
        include_news: Include news results when relevant (default True)
        livecrawl: Fetch full page content: "web", "news", or "all"
    """
    endpoint = "https://ydc-index.io/v1/search"

    # Build query parameters
    params = {
        "query": query,
        "count": max_results,
        "safesearch": safesearch,
    }

    if country:
        params["country"] = country.upper()
    if language:
        params["language"] = language.upper()
    if freshness:
        params["freshness"] = freshness
    if livecrawl:
        params["livecrawl"] = livecrawl
        params["livecrawl_formats"] = "markdown"

    # Build URL with query params (URL-encode values)
    query_string = "&".join(f"{k}={quote(str(v))}" for k, v in params.items())
    url = f"{endpoint}?{query_string}"

    headers = {
        "X-API-KEY": api_key,
        "Accept": "application/json",
        "User-Agent": DEFAULT_USER_AGENT,
    }

    # Make GET request (You.com uses GET, not POST)
    from urllib.request import Request, urlopen
    req = Request(url, headers=headers, method="GET")

    try:
        with urlopen(req, timeout=30) as response:
            data = _read_json_response(response)
    except HTTPError as e:
        error_body = _read_response_body(e).decode("utf-8") if e.fp else str(e)
        try:
            error_json = json.loads(error_body)
            error_detail = error_json.get("error") or error_json.get("message") or error_body
        except json.JSONDecodeError:
            error_detail = error_body[:500]

        error_messages = {
            401: "Invalid or expired API key. Get one at https://api.you.com",
            403: "Access forbidden. Check your API key permissions.",
            429: "Rate limit exceeded. Please wait and try again.",
            500: "You.com server error. Try again later.",
            503: "You.com service unavailable."
        }
        friendly_msg = error_messages.get(e.code, f"API error: {error_detail}")
        raise ProviderRequestError(f"{friendly_msg} (HTTP {e.code})", status_code=e.code, transient=e.code in TRANSIENT_HTTP_CODES)
    except URLError as e:
        reason = str(getattr(e, "reason", e))
        is_timeout = "timed out" in reason.lower()
        raise ProviderRequestError(f"Network error: {reason}. Check your internet connection.", transient=is_timeout)
    except TimeoutError:
        raise ProviderRequestError("You.com request timed out after 30s.", transient=True)

    # Parse results
    results_data = data.get("results", {})
    web_results = results_data.get("web", [])
    news_results = results_data.get("news", []) if include_news else []
    metadata = data.get("metadata", {})

    # Normalize web results
    results = []
    for i, item in enumerate(web_results[:max_results]):
        snippets = item.get("snippets", [])
        snippet = snippets[0] if snippets else item.get("description", "")

        result = {
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "snippet": snippet,
            "score": round(1.0 - i * 0.05, 3),  # Assign descending score
            "date": item.get("page_age"),
            "source": "web",
        }

        # Include additional snippets if available (great for RAG)
        if len(snippets) > 1:
            result["additional_snippets"] = snippets[1:3]

        # Include thumbnail and favicon for UI display
        if item.get("thumbnail_url"):
            result["thumbnail"] = item["thumbnail_url"]
        if item.get("favicon_url"):
            result["favicon"] = item["favicon_url"]

        # Include live-crawled content if available
        if item.get("contents"):
            result["raw_content"] = item["contents"].get("markdown") or item["contents"].get("html", "")

        results.append(result)

    # Add news results (if any)
    news = []
    for item in news_results[:5]:
        news.append({
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "snippet": item.get("description", ""),
            "date": item.get("page_age"),
            "thumbnail": item.get("thumbnail_url"),
            "source": "news",
        })

    # Build answer from best snippets
    answer = ""
    if results:
        # Combine top snippets for LLM context
        top_snippets = []
        for r in results[:3]:
            if r.get("snippet"):
                top_snippets.append(r["snippet"])
        answer = " ".join(top_snippets)[:1000]

    return {
        "provider": "you",
        "query": query,
        "results": results,
        "news": news,
        "images": [],
        "answer": answer,
        "metadata": {
            "search_uuid": metadata.get("search_uuid"),
            "latency": metadata.get("latency"),
        }
    }

def search_searxng(
    query: str,
    instance_url: str,
    max_results: int = 5,
    categories: Optional[List[str]] = None,
    engines: Optional[List[str]] = None,
    language: str = "en",
    time_range: Optional[str] = None,
    safesearch: int = 0,
) -> dict:
    """Search using SearXNG (self-hosted privacy-first meta-search).

    SearXNG excels at:
    - Privacy-preserving search (no tracking, no profiling)
    - Multi-source aggregation (70+ upstream engines)
    - $0 API cost (self-hosted)
    - Diverse perspectives from multiple search engines

    Args:
        query: Search query
        instance_url: URL of your SearXNG instance (required)
        max_results: Maximum results to return (default 5)
        categories: Search categories (general, images, news, videos, etc.)
        engines: Specific engines to use (google, bing, duckduckgo, etc.)
        language: Language code (e.g., en, de, fr)
        time_range: Filter by recency: day, week, month, year
        safesearch: Content filter: 0=off, 1=moderate, 2=strict

    Note:
        Requires a self-hosted SearXNG instance with JSON format enabled.
        See: https://docs.searxng.org/admin/installation.html
    """
    # Build URL with query parameters
    params = {
        "q": query,
        "format": "json",
        "language": language,
        "safesearch": str(safesearch),
    }

    if categories:
        params["categories"] = ",".join(categories)
    if engines:
        params["engines"] = ",".join(engines)
    if time_range:
        params["time_range"] = time_range

    # Build URL — instance_url comes from operator-controlled config/env only
    # (validated by _validate_searxng_url), not from agent/LLM input
    base_url = instance_url.rstrip("/")
    query_string = "&".join(f"{k}={quote(str(v))}" for k, v in params.items())
    url = f"{base_url}/search?{query_string}"

    headers = {
        "User-Agent": DEFAULT_USER_AGENT,
        "Accept": "application/json",
    }

    # Make GET request
    req = Request(url, headers=headers, method="GET")

    try:
        with urlopen(req, timeout=30) as response:
            data = _read_json_response(response)
    except HTTPError as e:
        error_body = _read_response_body(e).decode("utf-8") if e.fp else str(e)
        try:
            error_json = json.loads(error_body)
            error_detail = error_json.get("error") or error_json.get("message") or error_body
        except json.JSONDecodeError:
            error_detail = error_body[:500]

        error_messages = {
            403: "JSON API disabled on this SearXNG instance. Enable 'json' in search.formats in settings.yml",
            404: "SearXNG instance not found. Check your instance URL.",
            500: "SearXNG server error. Check instance health.",
            503: "SearXNG service unavailable."
        }
        friendly_msg = error_messages.get(e.code, f"SearXNG error: {error_detail}")
        raise ProviderRequestError(f"{friendly_msg} (HTTP {e.code})", status_code=e.code, transient=e.code in TRANSIENT_HTTP_CODES)
    except URLError as e:
        reason = str(getattr(e, "reason", e))
        is_timeout = "timed out" in reason.lower()
        raise ProviderRequestError(f"Cannot reach SearXNG instance at {instance_url}. Error: {reason}", transient=is_timeout)
    except TimeoutError:
        raise ProviderRequestError("SearXNG request timed out after 30s. Check instance health.", transient=True)

    # Parse results
    raw_results = data.get("results", [])

    # Normalize results to unified format
    results = []
    engines_used = set()
    for i, item in enumerate(raw_results[:max_results]):
        engine = item.get("engine", "unknown")
        engines_used.add(engine)

        results.append({
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "snippet": item.get("content", ""),
            "score": round(item.get("score", 1.0 - i * 0.05), 3),
            "engine": engine,
            "category": item.get("category", "general"),
            "date": item.get("publishedDate"),
        })

    # Build answer from answers, infoboxes, or first result
    answer = ""
    if data.get("answers"):
        answer = data["answers"][0] if isinstance(data["answers"][0], str) else str(data["answers"][0])
    elif data.get("infoboxes"):
        infobox = data["infoboxes"][0]
        answer = infobox.get("content", "") or infobox.get("infobox", "")
    elif results:
        answer = results[0]["snippet"]

    return {
        "provider": "searxng",
        "query": query,
        "results": results,
        "images": [],
        "answer": answer,
        "suggestions": data.get("suggestions", []),
        "corrections": data.get("corrections", []),
        "metadata": {
            "number_of_results": data.get("number_of_results"),
            "engines_used": list(engines_used),
            "instance_url": instance_url,
        }
    }
