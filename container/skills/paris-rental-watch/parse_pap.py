#!/usr/bin/env python3
"""
pap.fr Paris rentals listings-index parser (container-side).

Reads pap.fr `locations-appartement-paris-75-g439[-N]` listings-page HTML on
stdin and emits a JSON array of card dicts on stdout — one entry per
`.search-list-item-alt` block.

The container's `web-fetch` CLI handles Cloudflare bypass transparently via
the host `cf-fetch-server` sidecar (see `container/skills/web-fetch/SKILL.md`),
so this parser only needs to walk the post-bypass HTML — no host-side
fetcher, no staging file.

Usage:
    web-fetch --output html --timeout 120 \
        "https://www.pap.fr/annonce/locations-appartement-paris-75-g439" \
        | python3 parse_pap.py list

Subcommands:
    list   parse listings-index HTML (the only mode currently supported)

Card shape:
    {
      "pap_id":         "<numeric id>",
      "title":          "<truncated 200ch>",
      "detail_url":     "<absolute url>",
      "price_eur":      <int|null>,        # parsed from .item-price (€)
      "surface_m2":     <int|null>,        # parsed from a .item-tags <li> with "<n> m"
      "rooms":          <int|null>,        # parsed from a .item-tags <li> with "<n> pi"
      "tags":           [<str>, ...],
      "location_text":  "<.h1 text>",
      "description":    "<truncated 500ch>",
      "photo_url":      "<first <img src>>",
    }

The selector contract was validated end-to-end by AC 1 of the
PapRentalCFBypassMigration Seed (see
container/skills/web-fetch/SUB-AC-1-PAP-SANITY-EVIDENCE.txt — 13 cards
detected on the live index, paired €/m² regex used to verify).
"""
from __future__ import annotations

import json
import re
import sys
from html import unescape

# ---------------------------------------------------------------------------
# Card boundaries
# ---------------------------------------------------------------------------
# pap.fr wraps each ad in `<div class="search-list-item-alt" …>`. We split
# the document on that opening tag and treat each chunk as one card. The
# first split element is the page preamble (header, nav, search form) and
# is discarded. The last chunk extends to the end of the document; we cap
# its length so footer/aside HTML can't bleed in and fool the regex.
_CARD_SPLIT_RE = re.compile(r'<div class="search-list-item-alt"', re.I)
_CARD_BODY_MAX_CHARS = 16000  # generous — a real card stays well under 8k

# The class="item-title" anchor carries the unique pap_id (`name` attr) and
# the detail URL. Either attribute may be missing in odd templates so we
# tolerate both orderings (name-then-href or href-then-name) and accept a
# missing name as long as the href contains `-r<digits>` (the id encoding
# pap.fr uses for individual ads).
_TITLE_RE = re.compile(
    r'<a\b[^>]*class="[^"]*\bitem-title\b[^"]*"[^>]*>(?P<inner>.*?)</a>',
    re.S | re.I,
)
_NAME_ATTR_RE = re.compile(r'\bname="(?P<v>[^"]+)"')
_HREF_ATTR_RE = re.compile(r'\bhref="(?P<v>[^"]+)"')
_ID_FROM_HREF_RE = re.compile(r'-r(\d+)\b')

# .item-price → "1.900&nbsp;€" or "1 900 € / mois"; we strip every non-
# digit before int() so thin-space, NBSP, narrow NBSP, dot, comma, and
# spaces all collapse to a bare integer the downstream pre-filter can compare.
_PRICE_RE = re.compile(
    r'class="[^"]*\bitem-price\b[^"]*"[^>]*>\s*([^<]*?)€',
    re.S | re.I,
)

# .item-tags is a UL of LIs; we capture the inner UL HTML then walk its LIs.
_TAGS_BLOCK_RE = re.compile(
    r'class="[^"]*\bitem-tags\b[^"]*"[^>]*>(?P<inner>.*?)</ul>',
    re.S | re.I,
)
_LI_RE = re.compile(r'<li\b[^>]*>(?P<inner>.*?)</li>', re.S | re.I)

# Surface / rooms heuristics.
# Surface tags read "45 m²" / "45 m2" / "45 m". A bare `(\d+)\s*m` would
# also match the leading digits of a "2 min métro" / "5 min marche"
# walk-time tag, so a card whose tags list a transit time BEFORE the
# surface tag would mis-parse surface to the walk-time number (e.g. a real
# 32 m² flat → surface_m2=2), which the downstream pre-filter then drops as
# "under 30 m²". The negative lookahead `(?![a-z])` requires the char after
# the `m` to NOT be a letter — so "m²"/"m2"/"m " match but "min" does not.
_SURFACE_TAG_RE = re.compile(r'(\d+)\s*m(?![a-z])', re.I)
# Rooms tags read "3 pièces" / "1 pièce" → match "<n> pi".
_ROOMS_TAG_RE = re.compile(r'(\d+)\s*pi', re.I)

# Other selectors.
_LOC_RE = re.compile(
    r'class="[^"]*\bh1\b[^"]*"[^>]*>(?P<inner>.*?)</',
    re.S | re.I,
)
_DESC_RE = re.compile(
    r'class="[^"]*\bitem-description\b[^"]*"[^>]*>(?P<inner>.*?)</',
    re.S | re.I,
)
_IMG_RE = re.compile(r'<img\b[^>]*\bsrc="(?P<v>[^"]+)"', re.I)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _read_stdin() -> str:
    raw = sys.stdin.buffer.read()
    # pap.fr serves UTF-8; fall back gracefully if the upstream pipe corrupts
    # bytes (rare — web-fetch already decodes the page).
    for enc in ("utf-8", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _clean_text(s: str) -> str:
    """Strip tags + entities + collapse whitespace — the text-extraction
    equivalent of a browser's `.innerText.replace(/\\s+/g, ' ').trim()`."""
    s = re.sub(r"<[^>]+>", "", s)
    s = unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def _parse_price(raw: str) -> int | None:
    """Extract an integer euro amount from the raw `.item-price` text.

    pap.fr renders prices as "1.900&nbsp;€" or "1 900 €" or "1 900 €".
    We strip non-digits and parse an int so the container's pre-filter has a
    plain integer to compare against PAP_PRICE_MAX."""
    digits = re.sub(r"[^\d]", "", raw or "")
    if not digits:
        return None
    try:
        return int(digits)
    except ValueError:
        return None


def _make_absolute(href: str) -> str:
    if not href:
        return ""
    if href.startswith("http://") or href.startswith("https://"):
        return href
    if href.startswith("//"):
        return "https:" + href
    if href.startswith("/"):
        return "https://www.pap.fr" + href
    # Bare relative paths are rare on pap.fr listings but handle defensively.
    return "https://www.pap.fr/" + href.lstrip("./")


def _pick_id(name_attr: str, href: str) -> str:
    if name_attr:
        return name_attr.strip()
    m = _ID_FROM_HREF_RE.search(href or "")
    if m:
        return m.group(1)
    return ""


def _parse_card(chunk: str) -> dict | None:
    """Parse one `.search-list-item-alt` chunk into a card dict, or None
    when the chunk doesn't carry the minimum fields (id + title)."""
    chunk = chunk[:_CARD_BODY_MAX_CHARS]

    tm = _TITLE_RE.search(chunk)
    if not tm:
        return None
    # The `<a class="item-title" …>` open tag's attributes appear BEFORE the
    # opening `>`, so we slice the chunk up to the inner-text start to find
    # name/href.
    a_open_end = tm.start("inner")
    a_open = chunk[max(0, tm.start() - 0):a_open_end]
    name_m = _NAME_ATTR_RE.search(a_open)
    href_m = _HREF_ATTR_RE.search(a_open)
    name_attr = name_m.group("v") if name_m else ""
    href = href_m.group("v") if href_m else ""

    pap_id = _pick_id(name_attr, href)
    if not pap_id:
        return None

    title = _clean_text(tm.group("inner"))[:200]
    detail_url = _make_absolute(href)

    price = None
    pm = _PRICE_RE.search(chunk)
    if pm:
        price = _parse_price(pm.group(1))

    tags: list[str] = []
    tags_m = _TAGS_BLOCK_RE.search(chunk)
    if tags_m:
        for li_m in _LI_RE.finditer(tags_m.group("inner")):
            tags.append(_clean_text(li_m.group("inner")))

    surface = None
    for t in tags:
        sm = _SURFACE_TAG_RE.search(t)
        if sm:
            try:
                surface = int(sm.group(1))
                break
            except ValueError:
                pass

    rooms = None
    for t in tags:
        rm = _ROOMS_TAG_RE.search(t)
        if rm:
            try:
                rooms = int(rm.group(1))
                break
            except ValueError:
                pass

    loc = ""
    lm = _LOC_RE.search(chunk)
    if lm:
        loc = _clean_text(lm.group("inner"))

    desc = ""
    dm = _DESC_RE.search(chunk)
    if dm:
        desc = _clean_text(dm.group("inner"))[:500]

    photo = ""
    im = _IMG_RE.search(chunk)
    if im:
        # A real browser's .src resolves protocol-relative and root-relative
        # URLs to absolute, so we do the same here for downstream consumers
        # (alert card rendering, geocoder fallback, etc.).
        photo = _make_absolute(im.group("v"))

    return {
        "pap_id": str(pap_id),
        "title": title,
        "detail_url": detail_url,
        "price_eur": price,
        "surface_m2": surface,
        "rooms": rooms,
        "tags": tags,
        "location_text": loc,
        "description": desc,
        "photo_url": photo,
    }


def parse_list(html: str) -> list[dict]:
    """Walk the listings-index HTML and return every card we can identify.

    Returns [] when the page has no `.search-list-item-alt` blocks (last
    pagination page, or empty result). The caller decides whether that
    means "stop pagination" or "treat as failure" based on which page
    number it is and whether prior pages produced cards.
    """
    parts = _CARD_SPLIT_RE.split(html)
    if len(parts) < 2:
        return []
    out: list[dict] = []
    for chunk in parts[1:]:
        card = _parse_card(chunk)
        if card is not None:
            out.append(card)
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    sub = args[0] if args else "list"
    if sub != "list":
        print(f"parse_pap.py: unknown subcommand {sub!r}; "
              f"supported: list", file=sys.stderr)
        return 2
    html = _read_stdin()
    cards = parse_list(html)
    print(json.dumps(cards, ensure_ascii=False))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
