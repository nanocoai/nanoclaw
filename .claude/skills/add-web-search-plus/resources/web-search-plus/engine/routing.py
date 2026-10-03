"""Routing v2 query analysis for Web Search Plus."""

import re
from typing import Any, Dict, List, Optional, Tuple

from config import DEFAULT_CONFIG, get_api_key
from provider_registry import DEFAULT_PROVIDER_PRIORITY
from provider_stats import performance_adjustments
from quality import _choose_tie_winner


ROUTING_POLICY = "routing-v2"


# Ordered routing-class rules from the qualitative 25-query benchmark.
# Each entry maps a class name to one or more regex pattern groups; a class
# matches when every group matches the lowercased query. Entries are evaluated
# top to bottom and the first match wins, so order is part of the behavior.
# Synthesis/briefing queries should prefer broad real-time/search providers,
# but Web Search Plus no longer exposes a separate answer tool.
ROUTING_CLASS_RULES: List[Tuple[str, Tuple[str, ...]]] = [
    ("briefing_synthesis", (
        r'\b(difference|differences|unterschiede|vergleich|compare|comparison|brief(?:ing)?|summari[sz]e|zusammenfass(?:en|ung)|was sind|what are)\b',
    )),
    ("security_advisory", (
        r'\b(advisory|security advisory|cve|mitigation|openssl|openssh|vulnerability|zero[-\s]?day)\b',
    )),
    ("patents", (
        r'\b(patent|patents|patentscope|espacenet|uspto|google patents)\b',
    )),
    ("policy_pdf", (
        r'\b(pdf|whitepaper|code of practice)\b',
        r'\b(nist|eu ai act|regulation|regulatory|policy|commission|government|official|rmf)\b',
    )),
    ("official_regulatory", (
        r'\b(eu ai act|european commission|regulation|regulatory|obligations?)\b',
    )),
    ("finance_earnings_official", (
        r'\b(nvidia|earnings|gross margin|investor relations|guidance|10-[qk]|eps|revenue|quarterly results?)\b',
    )),
    ("finance_investor_monthly", (
        r'\b(investor monthly|monthly factsheet|monthly report|aum|fund flows?)\b',
    )),
    ("reddit_community", (
        r'\bsite:\s*reddit\.com\b|\br/\w+|\breddit\s+(thread|post|community|users?|discussion|comments?)\b',
    )),
    ("shopping_reviews_local", (
        r'\b(geizhals|preis|prices?|buy|kaufen|österreich|austria|shop|händler|deal|angebot)\b',
        r'\b(sony|denon|iphone|samsung|bose|kef|marantz|yamaha|lg|asus|laptop|tv|headphones?|speaker|receiver|avc|wh-|[a-z]{1,5}[-\s]?\d{3,}[a-z0-9-]*)\b',
        r'\b(review(s)?|test|tests?|vergleich|best|beste|under|unter|erfahrungen)\b',
    )),
    ("shopping_specs", (
        r'\b(geizhals|preis|prices?|buy|kaufen|österreich|austria|shop|händler|deal|angebot)\b',
        r'\b(sony|denon|iphone|samsung|bose|kef|marantz|yamaha|lg|asus|laptop|tv|headphones?|speaker|receiver|avc|wh-|[a-z]{1,5}[-\s]?\d{3,}[a-z0-9-]*)\b',
    )),
    ("community_forum", (
        r'\b(forum|forums|community|discussion|comments?|erfahrungen|review(s)?|measurements?|head-fi|audiosciencereview|hifi-forum)\b',
    )),
    ("academic_arxiv", (
        r'\barxiv\b|\bpaper(s)?\b|\bscaling laws\b|\brandomi[sz]ed trial\b|\bprimary sources?\b',
    )),
    ("github_docs", (
        r'\b(github\b|repo(sitory)?\b|plugin docs\b)',
    )),
    ("official_docs", (
        r'\b(official docs?|official documentation|api reference|developer docs?|official manual)\b',
    )),
    ("official_vendor_release", (
        r'\b(official|release|announcement|launch|changelog|release notes?)\b',
        r'\b(mistral|anthropic|openai|google|meta|nvidia|apple|microsoft|claude|gemini|llama)\b',
    )),
    ("docs_api", (
        r'\b(python|pydantic|node\.js|api docs?|documentation|docs|changelog|release notes?|taskgroup|basemodel)\b',
    )),
    ("official_regulatory", (
        r'\b(official|regulatory filing|public authority)\b',
    )),
    ("local_at", (
        r'\b(graz|öffnungszeiten|adresse|restaurants?|vegan|hifi team)\b',
    )),
    ("sports_current", (
        r'\b(bundesliga|standings?|fixtures?|tabelle|punkte|spieltag|matchday|lineups?|scores?|sturm|salzburg|lask)\b|\b(league|liga|standings?|points?)\s+table\b',
    )),
    ("weather_local", (
        r'\b(wetter|weather|forecast|regen|rain)\b',
    )),
    ("oss_discovery", (
        r'\b(alternatives? to|open source|self hosted|competitors?|similar to)\b',
    )),
]

# Fallback classes assigned when no rule above matches.
MULTILINGUAL_ROUTING_CLASS = "multilingual_current"
DEFAULT_ROUTING_CLASS = "general"

# Script/language-aware boosts for current queries in non-en/de languages:
# You performed best as the safe fast default, with Exa/Firecrawl/Linkup
# useful by script. Kept modest so strong class rules win.
LANGUAGE_HINT_PROVIDER_BOOSTS: Dict[str, List[Tuple[str, float]]] = {
    "zh": [("exa", 7.0), ("you", 6.0), ("firecrawl", 4.0), ("linkup", 3.0), ("serper", 2.5)],
    "ar": [("you", 8.0), ("linkup", 5.0), ("serper", 4.0), ("firecrawl", 2.0)],
    "default": [("you", 8.0), ("exa", 5.0), ("firecrawl", 4.0), ("linkup", 3.0), ("tavily", 2.0)],
}

# Conservative class-aware provider boosts (positive) and penalties (negative)
# from the qualitative routing benchmark, applied on top of the signal scores.
ROUTING_CLASS_PROVIDER_BOOSTS: Dict[str, List[Tuple[str, float]]] = {
    "shopping_at": [("serper", 8.0), ("firecrawl", 6.0), ("linkup", 4.0), ("you", 2.0), ("exa", -2.0)],
    "local_at": [("firecrawl", 8.0), ("serper", 6.0), ("linkup", 4.0), ("you", 2.0)],
    "official_vendor_release": [("you", 14.0), ("linkup", 10.0), ("exa", 7.0), ("serper", 4.0), ("firecrawl", 3.0)],
    "official_docs": [("exa", 12.0), ("you", 7.0), ("firecrawl", 5.0), ("serper", 3.0), ("tavily", 2.0)],
    "policy_pdf": [("linkup", 10.0), ("exa", 8.0), ("serper", 7.0), ("firecrawl", 6.0), ("you", 4.0)],
    "official_regulatory": [("exa", 8.0), ("firecrawl", 6.0), ("serper", 5.0), ("you", 3.0)],
    "sports_current": [("you", 8.0), ("serper", 6.0), ("linkup", 5.0), ("tavily", 2.0)],
    "github_docs": [("exa", 10.0), ("you", 6.0), ("firecrawl", 5.0), ("serper", 4.0)],
    "docs_api": [("serper", 6.0), ("exa", 5.0), ("you", 4.0), ("firecrawl", 3.0), ("tavily", 3.0)],
    "academic_arxiv": [("exa", 12.0), ("serper", 3.0), ("linkup", 2.0), ("you", 1.5)],
    "oss_discovery": [("exa", 8.0), ("firecrawl", 5.0), ("tavily", 4.0), ("you", 3.0)],
    "reddit_community": [("serper", 10.0), ("firecrawl", 8.0), ("tavily", 6.0), ("exa", -20.0)],
    "security_advisory": [("serper", 10.0), ("exa", 8.0), ("linkup", 5.0), ("you", 2.0), ("firecrawl", -20.0)],
    "finance_earnings_official": [("linkup", 14.0), ("you", 9.0), ("exa", 7.0), ("serper", 6.0), ("firecrawl", 4.0)],
    "finance_investor_monthly": [("linkup", 12.0), ("serper", 7.0), ("you", 5.0), ("exa", 4.0)],
    "community_forum": [("firecrawl", 10.0), ("serper", 8.0), ("tavily", 5.0), ("you", 4.0), ("exa", -18.0)],
    "shopping_specs": [("serper", 9.0), ("firecrawl", 6.0), ("linkup", 4.0), ("you", 2.0), ("exa", -2.0)],
    "shopping_reviews_local": [("serper", 9.0), ("firecrawl", 7.0), ("you", 4.0), ("tavily", 3.0), ("exa", -4.0)],
    "patents": [("exa", 10.0), ("serper", 7.0), ("linkup", 4.0), ("you", 3.0)],
    "weather_local": [("serper", 8.0), ("firecrawl", 6.0), ("you", 2.0)],
    "briefing_synthesis": [("you", 16.0), ("tavily", 4.0), ("linkup", 3.0), ("exa", 2.0)],
}


class QueryAnalyzer:
    """
    Intelligent query analysis for smart provider routing.

    Uses multi-signal analysis:
    - Intent classification (shopping, research, discovery, local, news)
    - Linguistic patterns (question structure, phrase patterns)
    - Entity detection (products, brands, URLs, dates)
    - Complexity assessment
    """

    # Intent signal patterns with weights
    # Higher weight = stronger signal for that provider

    SHOPPING_SIGNALS = {
        # Price patterns (very strong)
        r'\bhow much\b': 4.0,
        r'\bprice of\b': 4.0,
        r'\bcost of\b': 4.0,
        r'\bprices?\b': 3.0,
        r'\$\d+|\d+\s*dollars?': 3.0,
        r'€\d+|\d+\s*euros?': 3.0,
        r'£\d+|\d+\s*pounds?': 3.0,

        # German price patterns (sehr stark)
        r'\bpreis(e)?\b': 3.5,
        r'\bkosten\b': 3.0,
        r'\bwieviel\b': 3.5,
        r'\bwie viel\b': 3.5,
        r'\bwas kostet\b': 4.0,

        # Purchase intent (strong)
        r'\bbuy\b': 3.5,
        r'\bpurchase\b': 3.5,
        r'\border\b(?!\s+by)': 3.0,  # "order" but not "order by"
        r'\bshopping\b': 3.5,
        r'\bshop for\b': 3.5,
        r'\bwhere to (buy|get|purchase)\b': 4.0,

        # German purchase intent (stark)
        r'\bkaufen\b': 3.5,
        r'\bbestellen\b': 3.5,
        r'\bwo kaufen\b': 4.0,
        r'\bhändler\b': 3.0,
        r'\bshop\b': 2.5,

        # Deal/discount signals
        r'\bdeal(s)?\b': 3.0,
        r'\bdiscount(s)?\b': 3.0,
        r'\bsale\b': 2.5,
        r'\bcheap(er|est)?\b': 3.0,
        r'\baffordable\b': 2.5,
        r'\bbudget\b': 2.5,
        r'\bbest price\b': 3.5,
        r'\bcompare prices\b': 3.5,
        r'\bcoupon\b': 3.0,

        # German deal/discount signals
        r'\bgünstig(er|ste)?\b': 3.0,
        r'\bbillig(er|ste)?\b': 3.0,
        r'\bangebot(e)?\b': 3.0,
        r'\brabatt\b': 3.0,
        r'\baktion\b': 2.5,
        r'\bschnäppchen\b': 3.0,

        # Product comparison
        r'\bvs\.?\b': 2.0,
        r'\bversus\b': 2.0,
        r'\bor\b.*\bwhich\b': 2.0,
        r'\bspecs?\b': 2.5,
        r'\bspecifications?\b': 2.5,
        r'\breview(s)?\b': 2.0,
        r'\brating(s)?\b': 2.0,
        r'\bunboxing\b': 2.5,

        # German product comparison
        r'\btest\b': 2.5,
        r'\bbewertung(en)?\b': 2.5,
        r'\btechnische daten\b': 3.0,
        r'\bspezifikationen\b': 2.5,
    }

    RESEARCH_SIGNALS = {
        # Explanation patterns (very strong)
        r'\bhow does\b': 4.0,
        r'\bhow do\b': 3.5,
        r'\bwhy does\b': 4.0,
        r'\bwhy do\b': 3.5,
        r'\bwhy is\b': 3.5,
        r'\bexplain\b': 4.0,
        r'\bexplanation\b': 4.0,
        r'\bwhat is\b': 3.0,
        r'\bwhat are\b': 3.0,
        r'\bdefine\b': 3.5,
        r'\bdefinition of\b': 3.5,
        r'\bmeaning of\b': 3.0,

        # Analysis patterns (strong)
        r'\banalyze\b': 3.5,
        r'\banalysis\b': 3.5,
        r'\bcompare\b(?!\s*prices?)': 3.0,  # compare but not "compare prices"
        r'\bcomparison\b': 3.0,
        r'\bstatus of\b': 3.5,
        r'\bstatus\b': 2.5,
        r'\bwhat happened with\b': 4.0,
        r'\bpros and cons\b': 4.0,
        r'\badvantages?\b': 3.0,
        r'\bdisadvantages?\b': 3.0,
        r'\bbenefits?\b': 2.5,
        r'\bdrawbacks?\b': 3.0,
        r'\bdifference between\b': 3.5,

        # Learning patterns
        r'\bunderstand\b': 3.0,
        r'\blearn(ing)?\b': 2.5,
        r'\btutorial\b': 3.0,
        r'\bguide\b': 2.5,
        r'\bhow to\b': 2.0,  # Lower weight - could be shopping too
        r'\bstep by step\b': 3.0,

        # Depth signals
        r'\bin[- ]depth\b': 3.0,
        r'\bdetailed\b': 2.5,
        r'\bcomprehensive\b': 3.0,
        r'\bthorough\b': 2.5,
        r'\bdeep dive\b': 3.5,
        r'\boverall\b': 2.0,
        r'\bsummary\b': 2.0,

        # Academic patterns
        r'\bstudy\b': 2.5,
        r'\bresearch shows\b': 3.5,
        r'\baccording to\b': 2.5,
        r'\bevidence\b': 3.0,
        r'\bscientific\b': 3.0,
        r'\bhistory of\b': 3.0,
        r'\bbackground\b': 2.5,
        r'\bcontext\b': 2.5,
        r'\bimplications?\b': 3.0,

        # German explanation patterns (sehr stark)
        r'\bwie funktioniert\b': 4.0,
        r'\bwarum\b': 3.5,
        r'\berklär(en|ung)?\b': 4.0,
        r'\bwas ist\b': 3.0,
        r'\bwas sind\b': 3.0,
        r'\bbedeutung\b': 3.0,

        # German analysis patterns
        r'\banalyse\b': 3.5,
        r'\bvergleich(en)?\b': 3.0,
        r'\bvor- und nachteile\b': 4.0,
        r'\bvorteile\b': 3.0,
        r'\bnachteile\b': 3.0,
        r'\bunterschied(e)?\b': 3.5,

        # German learning patterns
        r'\bverstehen\b': 3.0,
        r'\blernen\b': 2.5,
        r'\banleitung\b': 3.0,
        r'\bübersicht\b': 2.5,
        r'\bhintergrund\b': 2.5,
        r'\bzusammenfassung\b': 2.5,
    }

    DISCOVERY_SIGNALS = {
        # Similarity patterns (very strong)
        r'\bsimilar to\b': 5.0,
        r'\blike\s+\w+\.com': 4.5,  # "like notion.com"
        r'\balternatives? to\b': 5.0,
        r'\bcompetitors? (of|to)\b': 4.5,
        r'\bcompeting with\b': 4.0,
        r'\brivals? (of|to)\b': 4.0,
        r'\binstead of\b': 3.0,
        r'\breplacement for\b': 3.5,

        # Company/startup patterns (strong)
        r'\bcompanies (like|that|doing|building)\b': 4.5,
        r'\bstartups? (like|that|doing|building)\b': 4.5,
        r'\bwho else\b': 4.0,
        r'\bother (companies|startups|tools|apps)\b': 3.5,
        r'\bfind (companies|startups|tools|examples?)\b': 4.5,
        r'\bevents? in\b': 4.0,
        r'\bthings to do in\b': 4.5,

        # Funding/business patterns
        r'\bseries [a-d]\b': 4.0,
        r'\byc\b|y combinator': 4.0,
        r'\bfund(ed|ing|raise)\b': 3.5,
        r'\bventure\b': 3.0,
        r'\bvaluation\b': 3.0,

        # Category patterns
        r'\bresearch papers? (on|about)\b': 4.0,
        r'\barxiv\b': 4.5,
        r'\bgithub (projects?|repos?)\b': 4.5,
        r'\bopen source\b.*\bprojects?\b': 4.0,
        r'\btweets? (about|on)\b': 3.5,
        r'\bblogs? (about|on|like)\b': 3.0,

        # URL detection (very strong signal for Exa similar)
        r'https?://[^\s]+': 5.0,
        r'\b\w+\.(com|org|io|ai|co|dev)\b': 3.5,
    }

    LOCAL_NEWS_SIGNALS = {
        # Local patterns → Serper
        r'\bnear me\b': 4.0,
        r'\bnearby\b': 3.5,
        r'\blocal\b': 3.0,
        r'\bin (my )?(city|area|town|neighborhood)\b': 3.5,
        r'\brestaurants?\b': 2.5,
        r'\bhotels?\b': 2.5,
        r'\bcafes?\b': 2.5,
        r'\bstores?\b': 2.0,
        r'\bdirections? to\b': 3.5,
        r'\bmap of\b': 3.0,
        r'\bphone number\b': 3.0,
        r'\baddress of\b': 3.0,
        r'\bopen(ing)? hours\b': 3.0,

        # Weather/time
        r'\bweather\b': 4.0,
        r'\bforecast\b': 3.5,
        r'\btemperature\b': 3.0,
        r'\btime in\b': 3.0,

        # News/recency patterns → Serper (or Tavily for news depth)
        r'\blatest\b': 2.5,
        r'\brecent\b': 2.5,
        r'\btoday\b': 2.5,
        r'\bbreaking\b': 3.5,
        r'\bnews\b': 2.5,
        r'\bheadlines?\b': 3.0,
        r'\b202[4-9]\b': 2.0,  # Current year mentions
        r'\blast (week|month|year)\b': 2.0,

        # German local patterns
        r'\bin der nähe\b': 4.0,
        r'\bin meiner nähe\b': 4.0,
        r'\böffnungszeiten\b': 3.0,
        r'\badresse von\b': 3.0,
        r'\bweg(beschreibung)? nach\b': 3.5,

        # German news/recency patterns
        r'\bheute\b': 2.5,
        r'\bmorgen\b': 2.0,
        r'\baktuell\b': 2.5,
        r'\bnachrichten\b': 3.0,
    }

    # Source-grounded/RAG retrieval signals → Linkup
    # Linkup is strongest when the user wants source-backed evidence for LLM grounding.
    LINKUP_SOURCE_SIGNALS = {
        r'\bcitations?\b': 5.0,
        r'\bsources?\b': 4.5,
        r'\bsource.?backed\b': 5.0,
        r'\bwith sources\b': 5.0,
        r'\bwith references\b': 5.0,
        r'\breferences?\b': 4.5,
        r'\bevidence\b': 4.5,
        r'\bcredible sources?\b': 5.5,
        r'\bprimary sources?\b': 5.0,
        r'\bsupporting links?\b': 4.5,
        r'\bverify (this|the)?\b': 4.5,
        r'\bfact.?check\b': 5.0,
        r'\bground(ed|ing)?\b': 4.5,
        r'\bground this\b': 5.0,
        r'\bclaim\b': 2.5,
        r'\bfind (credible )?sources?\b': 5.5,
        r'\bfind pages? that support\b': 5.0,
        r'\bwhere did this come from\b': 5.0,
        r'\bsource material\b': 4.0,
    }

    # RAG/AI signals → You.com
    # You.com excels at providing LLM-ready snippets and combined web+news
    RAG_SIGNALS = {
        # RAG/context patterns (strong signal for You.com)
        r'\brag\b': 4.5,
        r'\bcontext for\b': 4.0,
        r'\bsummarize\b': 3.5,
        r'\bbrief(ly)?\b': 3.0,
        r'\bquick overview\b': 3.5,
        r'\btl;?dr\b': 4.0,
        r'\bkey (points|facts|info)\b': 3.5,
        r'\bmain (points|takeaways)\b': 3.5,

        # Combined web + news queries
        r'\b(web|online)\s+and\s+news\b': 4.0,
        r'\ball sources\b': 3.5,
        r'\bcomprehensive (search|overview)\b': 3.5,
        r'\blatest\s+(news|updates)\b': 3.0,
        r'\bcurrent (events|situation|status)\b': 3.5,

        # Real-time information needs
        r'\bright now\b': 3.0,
        r'\bas of today\b': 3.5,
        r'\bup.to.date\b': 3.5,
        r'\breal.time\b': 4.0,
        r'\blive\b': 2.5,

        # Information synthesis
        r'\bwhat\'?s happening with\b': 3.5,
        r'\bwhat\'?s the latest\b': 4.0,
        r'\bupdates?\s+on\b': 3.5,
        r'\bstatus of\b': 3.0,
        r'\bsituation (in|with|around)\b': 3.5,
    }

    # Direct answer / synthesis signals → Perplexity via Kilo Gateway
    DIRECT_ANSWER_SIGNALS = {
        r'\bwhat is\b': 3.0,
        r'\bwhat are\b': 2.5,
        r'\bcurrent status\b': 4.0,
        r'\bstatus of\b': 3.5,
        r'\bstatus\b': 2.5,
        r'\bwhat happened with\b': 4.0,
        r"\bwhat'?s happening with\b": 4.0,
        r'\bas of (today|now)\b': 4.0,
        r'\bthis weekend\b': 3.5,
        r'\bevents? in\b': 3.5,
        r'\bthings to do in\b': 4.0,
        r'\bnear me\b': 3.0,
        r'\bcan you (tell me|summarize|explain)\b': 3.5,
        # German
        r'\bwann\b': 3.0,
        r'\bwer\b': 3.0,
        r'\bwo\b': 2.5,
        r'\bwie viele\b': 3.0,
    }

    # Privacy/Multi-source signals → SearXNG (self-hosted meta-search)
    # SearXNG is ideal for privacy-focused queries and aggregating multiple sources
    PRIVACY_SIGNALS = {
        # Privacy signals (very strong)
        r'\bprivate(ly)?\b': 4.0,
        r'\banonymous(ly)?\b': 4.0,
        r'\bwithout tracking\b': 4.5,
        r'\bno track(ing)?\b': 4.5,
        r'\bprivacy\b': 3.5,
        r'\bprivacy.?focused\b': 4.5,
        r'\bprivacy.?first\b': 4.5,
        r'\bduckduckgo alternative\b': 4.5,
        r'\bprivate search\b': 5.0,

        # German privacy signals
        r'\bprivat\b': 4.0,
        r'\banonym\b': 4.0,
        r'\bohne tracking\b': 4.5,
        r'\bdatenschutz\b': 4.0,

        # Multi-source aggregation signals
        r'\baggregate results?\b': 4.0,
        r'\bmultiple sources?\b': 4.0,
        r'\bdiverse (results|perspectives|sources)\b': 4.0,
        r'\bfrom (all|multiple|different) (engines?|sources?)\b': 4.5,
        r'\bmeta.?search\b': 5.0,
        r'\ball engines?\b': 4.0,

        # German multi-source signals
        r'\bverschiedene quellen\b': 4.0,
        r'\baus mehreren quellen\b': 4.0,
        r'\balle suchmaschinen\b': 4.5,

        # Budget/free signals (SearXNG is self-hosted = $0 API cost)
        r'\bfree search\b': 3.5,
        r'\bno api cost\b': 4.0,
        r'\bself.?hosted search\b': 5.0,
        r'\bzero cost\b': 3.5,
        r'\bbudget\b(?!\s*(laptop|phone|option))\b': 2.5,  # "budget" alone, not "budget laptop"

        # German budget signals
        r'\bkostenlos(e)?\s+suche\b': 3.5,
        r'\bkeine api.?kosten\b': 4.0,
    }

    # Exa Deep Search signals → deep multi-source synthesis
    EXA_DEEP_SIGNALS = {
        r'\bsynthesi[sz]e\b': 5.0,
        r'\bdeep research\b': 5.0,
        r'\bcomprehensive (analysis|report|overview|survey)\b': 4.5,
        r'\bacross (multiple|many|several) (sources|documents|papers)\b': 4.5,
        r'\baggregat(e|ing) (information|data|results)\b': 4.0,
        r'\bcross.?referenc': 4.5,
        r'\bsec filings?\b': 4.5,
        r'\bannual reports?\b': 4.0,
        r'\bearnings (call|report|transcript)\b': 4.5,
        r'\bfinancial analysis\b': 4.0,
        r'\bliterature (review|survey)\b': 5.0,
        r'\bacademic literature\b': 4.5,
        r'\bstate of the (art|field|industry)\b': 4.0,
        r'\bcompile (a |the )?(report|findings|results)\b': 4.5,
        r'\bsummariz(e|ing) (research|papers|studies)\b': 4.0,
        r'\bmultiple documents?\b': 4.0,
        r'\bdossier\b': 4.5,
        r'\bdue diligence\b': 4.5,
        r'\bstructured (output|data|report)\b': 4.0,
        r'\bmarket research\b': 4.0,
        r'\bindustry (report|analysis|overview)\b': 4.0,
        r'\bresearch (on|about|into)\b': 4.0,
        r'\bwhitepaper\b': 4.5,
        r'\btechnical report\b': 4.0,
        r'\bsurvey of\b': 4.5,
        r'\bmeta.?analysis\b': 5.0,
        r'\bsystematic review\b': 5.0,
        r'\bcase study\b': 3.5,
        r'\bbenchmark(s|ing)?\b': 3.5,
        # German
        r'\btiefenrecherche\b': 5.0,
        r'\bumfassende (analyse|übersicht|recherche)\b': 4.5,
        r'\baus mehreren quellen zusammenfassen\b': 4.5,
        r'\bmarktforschung\b': 4.0,
    }

    # Exa Deep Reasoning signals → complex cross-reference analysis
    EXA_DEEP_REASONING_SIGNALS = {
        r'\bdeep.?reasoning\b': 6.0,
        r'\bcomplex (analysis|reasoning|research)\b': 4.5,
        r'\bcontradictions?\b': 4.5,
        r'\breconcil(e|ing)\b': 5.0,
        r'\bcritical(ly)? analyz': 4.5,
        r'\bweigh(ing)? (the )?evidence\b': 4.5,
        r'\bcompeting (claims|theories|perspectives)\b': 4.5,
        r'\bcomplex financial\b': 4.5,
        r'\bregulatory (analysis|compliance|landscape)\b': 4.5,
        r'\blegal analysis\b': 4.5,
        r'\bcomprehensive (due diligence|investigation)\b': 5.0,
        r'\bpatent (landscape|analysis|search)\b': 4.5,
        r'\bmarket intelligence\b': 4.5,
        r'\bcompetitive (intelligence|landscape)\b': 4.5,
        r'\btrade.?offs?\b': 4.0,
        r'\bpros and cons of\b': 4.0,
        r'\bshould I (use|choose|pick)\b': 3.5,
        r'\bwhich is better\b': 4.0,
        # German
        r'\bkomplexe analyse\b': 4.5,
        r'\bwidersprüche\b': 4.5,
        r'\bquellen abwägen\b': 4.5,
        r'\brechtliche analyse\b': 4.5,
        r'\bvergleich(e|en)?\b': 3.5,
    }


    # Brand/product patterns for shopping detection
    BRAND_PATTERNS = [
        # Tech brands
        r'\b(apple|iphone|ipad|macbook|airpods?)\b',
        r'\b(samsung|galaxy)\b',
        r'\b(google|pixel)\b',
        r'\b(microsoft|surface|xbox)\b',
        r'\b(sony|playstation)\b',
        r'\b(nvidia|geforce|rtx)\b',
        r'\b(amd|ryzen|radeon)\b',
        r'\b(intel|core i[3579])\b',
        r'\b(dell|hp|lenovo|asus|acer)\b',
        r'\b(lg|tcl|hisense)\b',

        # Product categories
        r'\b(laptop|phone|tablet|tv|monitor|headphones?|earbuds?)\b',
        r'\b(camera|lens|drone)\b',
        r'\b(watch|smartwatch|fitbit|garmin)\b',
        r'\b(router|modem|wifi)\b',
        r'\b(keyboard|mouse|gaming)\b',
    ]

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.auto_config = config.get("auto_routing", DEFAULT_CONFIG["auto_routing"])

    def _calculate_signal_score(
        self,
        query: str,
        signals: Dict[str, float]
    ) -> Tuple[float, List[Dict[str, Any]]]:
        """
        Calculate score for a signal category.
        Returns (total_score, list of matched signals with details).
        """
        query_lower = query.lower()
        matches = []
        total_score = 0.0

        for pattern, weight in signals.items():
            regex = re.compile(pattern, re.IGNORECASE)
            found = regex.findall(query_lower)
            if found:
                # Normalize found matches
                match_text = found[0] if isinstance(found[0], str) else found[0][0] if found[0] else pattern
                matches.append({
                    "pattern": pattern,
                    "matched": match_text,
                    "weight": weight
                })
                total_score += weight

        return total_score, matches

    def _detect_product_brand_combo(self, query: str) -> float:
        """
        Detect product + brand combinations which strongly indicate shopping intent.
        Returns a bonus score.
        """
        query_lower = query.lower()
        brand_found = False
        product_found = False

        for pattern in self.BRAND_PATTERNS:
            if re.search(pattern, query_lower, re.IGNORECASE):
                brand_found = True
                break

        # Check for product indicators
        product_indicators = [
            r'\b(buy|price|specs?|review|vs|compare)\b',
            r'\b(pro|max|plus|mini|ultra|lite)\b',  # Product tier names
            r'\b\d+\s*(gb|tb|inch|mm|hz)\b',  # Specifications
        ]
        for pattern in product_indicators:
            if re.search(pattern, query_lower, re.IGNORECASE):
                product_found = True
                break

        if brand_found and product_found:
            return 3.0  # Strong shopping signal
        elif brand_found:
            return 1.5  # Moderate shopping signal
        return 0.0

    def _detect_url(self, query: str) -> Optional[str]:
        """Detect URLs in query - strong signal for Exa similar search."""
        url_pattern = r'https?://[^\s]+'
        match = re.search(url_pattern, query)
        if match:
            return match.group()

        # Also check for domain-like patterns
        domain_pattern = r'\b(\w+\.(com|org|io|ai|co|dev|net|app))\b'
        match = re.search(domain_pattern, query, re.IGNORECASE)
        if match:
            return match.group()

        return None

    def _assess_query_complexity(self, query: str) -> Dict[str, Any]:
        """
        Assess query complexity - complex queries favor Tavily.
        """
        words = query.split()
        word_count = len(words)

        # Count question words
        question_words = len(re.findall(
            r'\b(what|why|how|when|where|which|who|whose|whom)\b',
            query, re.IGNORECASE
        ))

        # Check for multiple clauses
        clause_markers = len(re.findall(
            r'\b(and|but|or|because|since|while|although|if|when)\b',
            query, re.IGNORECASE
        ))

        complexity_score = 0.0
        if word_count > 10:
            complexity_score += 1.5
        if word_count > 20:
            complexity_score += 1.0
        if question_words > 1:
            complexity_score += 1.0
        if clause_markers > 0:
            complexity_score += 0.5 * clause_markers

        return {
            "word_count": word_count,
            "question_words": question_words,
            "clause_markers": clause_markers,
            "complexity_score": complexity_score,
            "is_complex": complexity_score > 2.0
        }

    def _detect_recency_intent(self, query: str) -> Tuple[bool, float]:
        """
        Detect if query wants recent/timely information.
        Returns (is_recency_focused, score).
        """
        recency_patterns = [
            (r'\b(latest|newest|recent|current)\b', 2.5),
            (r'\b(today|yesterday|this week|this month)\b', 3.0),
            (r'\b(202[4-9]|2030)\b', 2.0),
            (r'\b(breaking|live|just|now)\b', 3.0),
            (r'\blast (hour|day|week|month)\b', 2.5),
            # Common non-English freshness markers from the 25-query routing benchmark.
            (r'\b(hoy|aujourd|heute|aktuell)\b', 2.5),
            (r'[今日最新]', 2.5),
            (r'(сегодня|новости)', 2.5),
            (r'(اليوم|أخبار)', 2.5),
            (r'(最新|今天)', 2.5),
        ]

        total = 0.0
        for pattern, weight in recency_patterns:
            if re.search(pattern, query, re.IGNORECASE):
                total += weight

        return total > 2.0, total

    def _detect_language_hint(self, query: str) -> str:
        """Best-effort language/script hint for routing; not user-facing translation."""
        q = query.lower()
        if re.search(r'[\u0600-\u06ff]', query):
            return "ar"
        if re.search(r'[\u0400-\u04ff]', query):
            return "ru"
        if re.search(r'[\u3040-\u30ff]', query) or re.search(r'(東京|ニュース|今日|企業|発表)', query):
            return "ja"
        if re.search(r'[\u4e00-\u9fff]', query):
            return "zh"
        if re.search(r'\b(noticias|españa|hoy|regulación|inteligencia artificial)\b', q):
            return "es"
        if re.search(r'\b(actualités|france|aujourd|ouverts?|dimanche|récents?|avis)\b', q):
            return "fr"
        if re.search(r'\b(der|die|das|und|oder|nicht|ist|sind|aktuelle?n?|preis|kaufen|öffnungszeiten|österreich)\b', q):
            return "de"
        return "en"

    def _detect_routing_class(self, query: str, language_hint: str) -> str:
        """Coarse class labels from the qualitative 25-query benchmark."""
        q = query.lower()
        for routing_class, patterns in ROUTING_CLASS_RULES:
            if all(re.search(pattern, q) for pattern in patterns):
                return routing_class
        if language_hint not in {"en", "de"}:
            return MULTILINGUAL_ROUTING_CLASS
        return DEFAULT_ROUTING_CLASS

    def _apply_vnext_routing_boosts(
        self,
        query: str,
        provider_scores: Dict[str, float],
        language_hint: str,
        routing_class: str,
        recency_score: float,
    ) -> None:
        """Apply conservative class-aware boosts from the qualitative routing benchmark.

        Search auto-routing still avoids slow answer-only providers unless explicitly selected.
        """
        def boost(provider: str, value: float) -> None:
            provider_scores[provider] = provider_scores.get(provider, 0.0) + value

        def boost_many(items: List[Tuple[str, float]]) -> None:
            for provider, value in items:
                boost(provider, value)

        # Script/language-aware current queries: You performed best as the safe fast default,
        # with Exa/Firecrawl/Linkup useful by script. Keep this modest so strong class rules win.
        if language_hint not in {"en", "de"}:
            boost_many(LANGUAGE_HINT_PROVIDER_BOOSTS.get(
                language_hint, LANGUAGE_HINT_PROVIDER_BOOSTS["default"]
            ))
            boost("you", min(recency_score, 3.0))

        class_boosts = ROUTING_CLASS_PROVIDER_BOOSTS.get(routing_class)
        if class_boosts:
            boost_many(class_boosts)

    def analyze(self, query: str) -> Dict[str, Any]:
        """
        Perform comprehensive query analysis.
        Returns detailed analysis with scores for each provider.
        """
        # Calculate scores for each intent category
        shopping_score, shopping_matches = self._calculate_signal_score(
            query, self.SHOPPING_SIGNALS
        )
        research_score, research_matches = self._calculate_signal_score(
            query, self.RESEARCH_SIGNALS
        )
        discovery_score, discovery_matches = self._calculate_signal_score(
            query, self.DISCOVERY_SIGNALS
        )
        local_news_score, local_news_matches = self._calculate_signal_score(
            query, self.LOCAL_NEWS_SIGNALS
        )
        rag_score, rag_matches = self._calculate_signal_score(
            query, self.RAG_SIGNALS
        )
        privacy_score, privacy_matches = self._calculate_signal_score(
            query, self.PRIVACY_SIGNALS
        )
        linkup_source_score, linkup_source_matches = self._calculate_signal_score(
            query, self.LINKUP_SOURCE_SIGNALS
        )
        direct_answer_score, direct_answer_matches = self._calculate_signal_score(
            query, self.DIRECT_ANSWER_SIGNALS
        )
        exa_deep_score, exa_deep_matches = self._calculate_signal_score(
            query, self.EXA_DEEP_SIGNALS
        )
        exa_deep_reasoning_score, exa_deep_reasoning_matches = self._calculate_signal_score(
            query, self.EXA_DEEP_REASONING_SIGNALS
        )

        # Apply product/brand bonus to shopping
        brand_bonus = self._detect_product_brand_combo(query)
        if brand_bonus > 0:
            shopping_score += brand_bonus
            shopping_matches.append({
                "pattern": "product_brand_combo",
                "matched": "brand + product detected",
                "weight": brand_bonus
            })

        # Detect URL → strong Exa signal
        detected_url = self._detect_url(query)
        if detected_url:
            discovery_score += 5.0
            discovery_matches.append({
                "pattern": "url_detected",
                "matched": detected_url,
                "weight": 5.0
            })

        # Assess complexity → favors Tavily
        complexity = self._assess_query_complexity(query)
        if complexity["is_complex"]:
            research_score += complexity["complexity_score"]
            research_matches.append({
                "pattern": "query_complexity",
                "matched": f"complex query ({complexity['word_count']} words)",
                "weight": complexity["complexity_score"]
            })

        # Check recency intent and benchmark-derived language/class hints
        is_recency, recency_score = self._detect_recency_intent(query)
        language_hint = self._detect_language_hint(query)
        routing_class = self._detect_routing_class(query, language_hint)

        # Map intents to providers with final scores
        provider_scores = {
            "serper": shopping_score + local_news_score + (recency_score * 0.35),
            "serpbase": (shopping_score * 0.8) + (local_news_score * 0.8) + (recency_score * 0.25),
            "brave": shopping_score + local_news_score + (recency_score * 0.35),
            "tavily": research_score + (complexity["complexity_score"] if not complexity["is_complex"] else 0) + (0.2 * recency_score),
            "querit": (research_score * 0.65) + (rag_score * 0.35) + (recency_score * 0.45),
            "linkup": linkup_source_score + (rag_score * 0.7) + (research_score * 0.45) + (recency_score * 0.35),
            "exa": discovery_score + (1.0 if re.search(r"\b(similar|alternatives?|examples?)\b", query, re.IGNORECASE) else 0.0) + (exa_deep_score * 0.5) + (exa_deep_reasoning_score * 0.5),
            "perplexity": direct_answer_score + (local_news_score * 0.4) + (recency_score * 0.55),
            "kilo-perplexity": direct_answer_score + (local_news_score * 0.4) + (recency_score * 0.55),
            "you": rag_score + (recency_score * 0.25),  # You.com good for real-time + RAG
            "searxng": privacy_score,  # SearXNG for privacy/multi-source queries
            "firecrawl": discovery_score + (research_score * 0.35) + (recency_score * 0.25),
        }
        self._apply_vnext_routing_boosts(
            query,
            provider_scores,
            language_hint,
            routing_class,
            recency_score,
        )

        # Build match details per provider
        provider_matches = {
            "serper": shopping_matches + local_news_matches,
            "serpbase": shopping_matches + local_news_matches,
            "brave": shopping_matches + local_news_matches,
            "tavily": research_matches,
            "querit": research_matches,
            "linkup": linkup_source_matches + rag_matches + research_matches,
            "exa": discovery_matches + exa_deep_matches + exa_deep_reasoning_matches,
            "perplexity": direct_answer_matches,
            "kilo-perplexity": direct_answer_matches,
            "you": rag_matches,
            "searxng": privacy_matches,
            "firecrawl": discovery_matches + research_matches,
        }

        return {
            "query": query,
            "provider_scores": provider_scores,
            "provider_matches": provider_matches,
            "detected_url": detected_url,
            "complexity": complexity,
            "recency_focused": is_recency,
            "recency_score": recency_score,
            "language_hint": language_hint,
            "routing_class": routing_class,
            "linkup_source_score": linkup_source_score,
            "exa_deep_score": exa_deep_score,
            "exa_deep_reasoning_score": exa_deep_reasoning_score,
        }

    def route(self, query: str) -> Dict[str, Any]:
        """
        Route query to optimal provider with confidence scoring.
        """
        analysis = self.analyze(query)
        scores = analysis["provider_scores"]

        # Filter to available providers
        disabled = set(self.auto_config.get("disabled_providers", []))
        # Filter to configured providers that are eligible for automatic routing.
        # Providers with auto_allow=false remain available for explicit calls.
        auto_excluded = [
            p for p in scores
            if get_api_key(p, self.config) and p not in disabled and not _provider_auto_allowed(p, self.auto_config)
        ]
        available = {
            p: s for p, s in scores.items()
            if p not in disabled and _provider_auto_allowed(p, self.auto_config) and get_api_key(p, self.config)
        }

        if not available:
            # No providers available, use fallback
            fallback = self.auto_config.get("fallback_provider", "serper")
            return {
                "provider": fallback,
                "confidence": 0.0,
                "confidence_level": "low",
                "reason": "no_available_providers",
                "routing_policy": ROUTING_POLICY,
                "scores": scores,
                "top_signals": [],
                "analysis": analysis,
                "auto_allow_excluded": auto_excluded,
            }

        # Adaptive routing: blend in bounded, learned performance adjustments
        # (latency / success / empty-result history of real calls). Only when
        # query-class signals matched at all — performance memory breaks close
        # calls but never invents a winner out of silence.
        adaptive_adjustments: Dict[str, float] = {}
        if max(available.values()) > 0 and self.auto_config.get("adaptive_routing", True):
            adaptive_adjustments = performance_adjustments(list(available))
            if adaptive_adjustments:
                available = {
                    p: max(0.0, s + adaptive_adjustments.get(p, 0.0))
                    for p, s in available.items()
                }

        # Find the winner
        max_score = max(available.values())

        # Handle ties using deterministic per-query distribution
        priority = self.auto_config.get("provider_priority", list(DEFAULT_PROVIDER_PRIORITY))
        winners = [p for p, s in available.items() if s == max_score]

        if len(winners) > 1:
            winner = _choose_tie_winner(query, winners, priority)
        else:
            winner = winners[0]

        # Calculate confidence
        # High confidence = clear winner with good margin
        if max_score == 0:
            confidence = 0.0
            reason = "no_signals_matched"
        else:
            # Confidence based on:
            # 1. Absolute score (is it strong enough?)
            # 2. Relative margin (is there a clear winner?)
            second_best = sorted(available.values(), reverse=True)[1] if len(available) > 1 else 0
            margin = (max_score - second_best) / max_score if max_score > 0 else 0

            # Normalize score to 0-1 range (assuming max reasonable score ~15)
            normalized_score = min(max_score / 15.0, 1.0)

            # Confidence is combination of absolute strength and relative margin
            confidence = round((normalized_score * 0.6 + margin * 0.4), 3)

            if confidence >= 0.7:
                reason = "high_confidence_match"
            elif confidence >= 0.4:
                reason = "moderate_confidence_match"
            else:
                reason = "low_confidence_match"

        # Get top signals for the winning provider
        matches = analysis["provider_matches"].get(winner, [])
        top_signals = sorted(matches, key=lambda x: x["weight"], reverse=True)[:5]

        # Special case: URL detected and Exa available → strong recommendation
        if analysis["detected_url"] and "exa" in available:
            if winner != "exa":
                # Override if URL is present but didn't win
                # (user might want similar search)
                pass  # Keep current winner but note it

        # Determine Exa search depth when routed to Exa
        exa_depth = "normal"
        if winner == "exa":
            deep_r_score = analysis.get("exa_deep_reasoning_score", 0)
            deep_score = analysis.get("exa_deep_score", 0)
            if deep_r_score >= 4.0:
                exa_depth = "deep-reasoning"
            elif deep_score >= 4.0:
                exa_depth = "deep"

        # Build detailed routing result
        threshold = self.auto_config.get("confidence_threshold", 0.3)

        return {
            "provider": winner,
            "confidence": confidence,
            "confidence_level": "high" if confidence >= 0.7 else "medium" if confidence >= 0.4 else "low",
            "reason": reason,
            "routing_policy": ROUTING_POLICY,
            "exa_depth": exa_depth,
            "scores": {p: round(s, 2) for p, s in available.items()},
            "adaptive_adjustments": adaptive_adjustments,
            "winning_score": round(max_score, 2),
            "top_signals": [
                {"matched": s["matched"], "weight": s["weight"]}
                for s in top_signals
            ],
            "below_threshold": confidence < threshold,
            "auto_allow_excluded": auto_excluded,
            "analysis_summary": {
                "query_length": len(query.split()),
                "is_complex": analysis["complexity"]["is_complex"],
                "has_url": analysis["detected_url"] is not None,
                "recency_focused": analysis["recency_focused"],
                "language_hint": analysis.get("language_hint", "en"),
                "routing_class": analysis.get("routing_class", "general"),
            }
        }

def auto_route_provider(query: str, config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Intelligently route query to the best provider.
    Returns detailed routing decision with confidence.
    """
    auto_config = config.get("auto_routing", DEFAULT_CONFIG["auto_routing"])
    if auto_config.get("enabled", True) is False:
        default_provider = config.get("default_provider")
        if default_provider:
            return {
                "provider": default_provider,
                "confidence": 1.0,
                "confidence_level": "high",
                "reason": "auto_routing_disabled_default_provider",
                "scores": {default_provider: 1.0},
                "top_signals": [],
                "auto_routed": False,
            }
        return {
            "provider": None,
            "confidence": 0.0,
            "confidence_level": "low",
            "reason": "auto_routing_disabled_no_default_provider",
            "scores": {},
            "top_signals": [],
            "auto_routed": False,
        }
    analyzer = QueryAnalyzer(config)
    return analyzer.route(query)

def explain_routing(query: str, config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Provide detailed explanation of routing decision for debugging.
    """
    analyzer = QueryAnalyzer(config)
    analysis = analyzer.analyze(query)
    routing = analyzer.route(query)

    return {
        "query": query,
        "routing_decision": {
            "provider": routing["provider"],
            "confidence": routing["confidence"],
            "confidence_level": routing["confidence_level"],
            "reason": routing["reason"],
            "routing_policy": routing.get("routing_policy", ROUTING_POLICY),
            "exa_depth": routing.get("exa_depth", "normal"),
            "auto_allow_excluded": routing.get("auto_allow_excluded", []),
        },
        "scores": routing["scores"],
        "top_signals": routing["top_signals"],
        "intent_breakdown": {
            "shopping_signals": len(analysis["provider_matches"]["serper"]),
            "serpbase_signals": len(analysis["provider_matches"].get("serpbase", [])),
            "brave_signals": len(analysis["provider_matches"]["brave"]),
            "research_signals": len(analysis["provider_matches"]["tavily"]),
            "querit_signals": len(analysis["provider_matches"]["querit"]),
            "linkup_signals": len(analysis["provider_matches"].get("linkup", [])),
            "linkup_source_score": round(analysis.get("linkup_source_score", 0), 2),
            "discovery_signals": len(analysis["provider_matches"]["exa"]),
            "rag_signals": len(analysis["provider_matches"]["you"]),
            "exa_deep_score": round(analysis.get("exa_deep_score", 0), 2),
            "exa_deep_reasoning_score": round(analysis.get("exa_deep_reasoning_score", 0), 2),
            "firecrawl_signals": len(analysis["provider_matches"].get("firecrawl", [])),
        },
        "query_analysis": {
            "word_count": analysis["complexity"]["word_count"],
            "is_complex": analysis["complexity"]["is_complex"],
            "complexity_score": round(analysis["complexity"]["complexity_score"], 2),
            "has_url": analysis["detected_url"],
            "recency_focused": analysis["recency_focused"],
            "language_hint": analysis.get("language_hint", "en"),
            "routing_class": analysis.get("routing_class", "general"),
        },
        "all_matches": {
            provider: [
                {"matched": m["matched"], "weight": m["weight"]}
                for m in matches
            ]
            for provider, matches in analysis["provider_matches"].items()
            if matches
        },
        "available_providers": [
            p for p in ["serper", "serpbase", "brave", "tavily", "linkup", "querit", "exa", "firecrawl", "perplexity", "kilo-perplexity", "you", "searxng"]
            if get_api_key(p, config) and p not in config.get("auto_routing", {}).get("disabled_providers", []) and _provider_auto_allowed(p, config.get("auto_routing", {}))
        ]
    }

def _provider_auto_allowed(provider: str, auto_config: Dict[str, Any]) -> bool:
    """Return whether a configured provider may be selected by auto-routing/fallback.

    Explicit provider calls still work; this gate only prevents low-trust or
    experimental providers from receiving user queries automatically.
    """
    auto_allow = auto_config.get("auto_allow", {}) if isinstance(auto_config, dict) else {}
    if not isinstance(auto_allow, dict):
        return True
    return bool(auto_allow.get(provider, True))
