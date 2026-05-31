#!/usr/bin/env python3
"""
Metro/RER/tram station name → coordinate lookup.

Loads `idf_stations.json` (~800 IDF stations from OSM Overpass), with multiple
alias keys (lowercased, deaccented, hyphen-variant) per station. ~1540 keys.

Two entry points:
  - find_station_in_text(text)  : extract station mentions from free-form text
  - lookup(name)                : direct name → coord

For francezone posts, common patterns:
  - "M4 Alésia"      → match "alésia"
  - "M7 Crimée역"    → match "crimée"
  - "RER B Port-Royal" → match "port-royal"
  - "Place Monge에서 1분" → match "place monge"
  - "[교통] M4 Alésia역, M6 Saint-Jacques역" → match the first
"""
import json
import os
import re
import unicodedata
from typing import Optional


_DATA_PATH = os.path.join(os.path.dirname(__file__), "idf_stations.json")
_STATIONS: dict[str, tuple[float, float]] = {}
# Parallel index: alias → list[str] of M/RER/T line ids served at that station.
# Populated from the third element of each idf_stations.json value (since
# 2026-05; entries may also be 2-tuples in older snapshots, in which case
# lines default to []).
_LINES: dict[str, list[str]] = {}
_LOADED = False


def _load() -> None:
    global _LOADED, _STATIONS
    if _LOADED:
        return
    with open(_DATA_PATH, "r", encoding="utf-8") as f:
        raw = json.load(f)
    for k, v in raw.items():
        _STATIONS[k] = (float(v[0]), float(v[1]))
        # Backward-compat: older 2-element snapshots have no line data.
        _LINES[k] = list(v[2]) if len(v) >= 3 and isinstance(v[2], list) else []
    _LOADED = True


def _normalize(s: str) -> str:
    """Lowercase + strip diacritics for fuzzy matching against alias keys."""
    s = s.strip().lower()
    s_ascii = "".join(
        c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn"
    )
    return s_ascii


def lookup(name: str) -> Optional[tuple[float, float]]:
    """Direct station-name lookup. Returns (lat, lng) or None."""
    _load()
    if not name:
        return None
    raw = name.strip().lower()
    if raw in _STATIONS:
        return _STATIONS[raw]
    norm = _normalize(name)
    if norm in _STATIONS:
        return _STATIONS[norm]
    # Variant: collapse whitespace, replace hyphens
    for variant in (
        re.sub(r"\s+", " ", raw),
        raw.replace("-", " "),
        norm.replace("-", " "),
        norm.replace("  ", " ").replace("  ", " "),
    ):
        if variant in _STATIONS:
            return _STATIONS[variant]
    return None


def lines_for(name: str) -> list[str]:
    """Return the list of M/RER/T line ids served at ``name`` (canonical
    alias form) or [] if the station isn't on any in-scope line.

    Uses the same alias-resolution rules as ``lookup`` so caller-provided
    diacritic / hyphen variants resolve to the same line set.
    """
    _load()
    if not name:
        return []
    raw = name.strip().lower()
    if raw in _LINES:
        return list(_LINES[raw])
    norm = _normalize(name)
    if norm in _LINES:
        return list(_LINES[norm])
    for variant in (
        re.sub(r"\s+", " ", raw),
        raw.replace("-", " "),
        norm.replace("-", " "),
        norm.replace("  ", " ").replace("  ", " "),
    ):
        if variant in _LINES:
            return list(_LINES[variant])
    return []


def lookup_prefix(name: str) -> Optional[tuple[float, float]]:
    """Multi-word prefix lookup against compound station names.

    OSM sometimes stores stations as compound names (e.g.
    "pont de rungis aéroport d'orly"). When the user just writes
    "Pont de Rungis", direct lookup fails. Try prefix match — but only when
    the candidate has 2+ words to avoid false hits like "pont" alone.
    """
    _load()
    if not name:
        return None
    norm = _normalize(name).strip()
    if not norm or " " not in norm:
        return None  # require multi-word to avoid ambiguous prefixes
    norm_dashed = norm.replace("-", " ")
    candidates: list[tuple[int, tuple[float, float]]] = []
    for key, coord in _STATIONS.items():
        if key == norm:
            return coord
        if key.startswith(norm + " ") or key.startswith(norm_dashed + " "):
            candidates.append((len(key), coord))
    if not candidates:
        return None
    # Prefer the SHORTEST extension — most likely the canonical compound name
    candidates.sort()
    return candidates[0][1]


# Capture station names. Strategy:
#   - Greedy match a candidate phrase after a context anchor (M<n>, RER, 역 suffix, etc.)
#   - In post-processing, strip 역 / trailing 역에서 / commas etc.
#   - Then try _try_window which shrinks suffix words progressively.
_PATTERNS = [
    # Korean: "<X>역" — capture word(s) before 역. Most reliable signal.
    re.compile(
        r"([A-ZÀ-ÿ][\w\s\.\-'À-ÿ\(\)]{1,50}?)역",
        re.UNICODE,
    ),
    # "M<n> Stationname" / "Métro Stationname" / "Ligne <n> Stationname"
    # Number after the marker is optional — "métro porte de Clichy" also valid.
    re.compile(
        r"\b(?:M|métro|metro|ligne)\s*[-_]?\s*(?:\d{1,2}\w?\s+)?([A-Za-zÀ-ÿ][\w\s\.\-'À-ÿ\(\)]{1,50})",
        re.UNICODE,
    ),
    # "RER <line> Stationname"
    re.compile(
        r"\bRER[\s_-]*[A-E]\s+([A-ZÀ-ÿ][\w\s\.\-'À-ÿ\(\)]{1,50})",
        re.UNICODE,
    ),
    # "T<n> Stationname" (tram)
    re.compile(
        r"\bT\s*\d+\w?\s+([A-ZÀ-ÿ][\w\s\.\-'À-ÿ\(\)]{1,50})",
        re.UNICODE,
    ),
    # "Place <Name>", "Square <Name>" — common station naming
    re.compile(
        r"\b(?:Place|Square|Sq\.|Pl\.)\s+([A-ZÀ-ÿ][\w\s\.\-'À-ÿ\(\)]{1,50})",
        re.UNICODE,
    ),
]


def _clean_candidate(c: str) -> str:
    """Strip trailing junk that the regex may have consumed: '역', '역에서', commas, paren contents."""
    # Drop trailing 역 + Korean particle endings ("역에서", "역까지")
    c = re.sub(r"역(?:에서|까지|을|를|는|은|이|가|에|의)?\s*[,.\d/]*\s*\S*$", "", c)
    # Drop trailing parentheticals like "(75019)"
    c = re.sub(r"\s*\([^)]*\)\s*$", "", c)
    # Drop trailing common Korean fillers
    c = re.sub(r"(?:도보|근처|인근|주변|에서|까지)\s*\S*$", "", c)
    # Drop trailing punctuation
    c = c.rstrip(" ,.;:'\"-_/()")
    return c.strip()


def _try_window(candidate: str) -> Optional[tuple[str, tuple[float, float]]]:
    """Given a candidate name, try lookup against contiguous word windows.

    Splits on whitespace AND hyphens AND punctuation breaks (".", ",", "!", "?").
    Tries longest contiguous windows first, returning the most specific match.
    """
    candidate = _clean_candidate(candidate)
    if not candidate:
        return None
    # Truncate at sentence-breaking punctuation (these stop a station name phrase)
    candidate = re.split(r"[.,!?;:/]", candidate, maxsplit=1)[0].strip()
    if not candidate:
        return None
    # Split on whitespace AND hyphens — treat hyphens as separators since some
    # stations are written as "Trocadéro-Boissière" but listed as "Trocadéro" alone.
    atoms = re.split(r"[\s\-]+", candidate)
    atoms = [a for a in atoms if a]
    if not atoms:
        return None
    # Try widest contiguous windows first (more specific matches preferred).
    candidates_to_try: list[str] = []
    for size in range(len(atoms), 0, -1):
        for start in range(0, len(atoms) - size + 1):
            window = " ".join(atoms[start:start + size])
            candidates_to_try.append(window)
    # Dedup preserving order
    seen: set[str] = set()
    # Pass 1: exact lookups
    for c in candidates_to_try:
        if c in seen:
            continue
        seen.add(c)
        coord = lookup(c)
        if coord:
            return c, coord
    # Pass 2: multi-word prefix lookups (catches compound OSM names like
    # "Pont de Rungis" → "pont de rungis aéroport d'orly")
    for c in candidates_to_try:
        if " " not in c:
            continue
        coord = lookup_prefix(c)
        if coord:
            return c, coord
    return None


def find_station_in_text(text: str) -> Optional[dict]:
    """Scan free-form text for a station mention. Return first match.

    Returns:
        {"name": <matched station>, "lat": float, "lng": float,
         "lines": [<line ids>], "source": "metro-osm"}
        or None. The ``lines`` key was added in 2026-05 to power the map's
        metro-line filter; older callers that only read lat/lng/name are
        unaffected.
    """
    if not text:
        return None
    _load()
    # Collect candidates with priority by pattern order
    for pat in _PATTERNS:
        for m in pat.finditer(text):
            candidate = m.group(1)
            hit = _try_window(candidate)
            if hit:
                name, (lat, lng) = hit
                return {
                    "name": name,
                    "lat": lat,
                    "lng": lng,
                    "lines": lines_for(name),
                    "source": "metro-osm",
                }
    # Last resort: scan for likely station names by checking the dict against
    # word windows in the text. Capture sequences of capitalized words possibly
    # joined by short lowercase connectors (de/la/du/des/le/les/d') and hyphens.
    word_re = re.compile(
        r"[A-ZÀ-ÿ][\w\.\-'À-ÿ]+(?:[\s\-](?:de|la|du|des|le|les|d')[\s\-][A-ZÀ-ÿ\d][\w\.\-'À-ÿ]*|[\s\-][A-ZÀ-ÿ][\w\.\-'À-ÿ]+)*",
        re.UNICODE,
    )
    candidates: list[str] = []
    for m in word_re.finditer(text):
        candidates.append(m.group(0))
    # Try each candidate (longest first — they are more specific)
    candidates.sort(key=len, reverse=True)
    for cand in candidates:
        hit = _try_window(cand)
        if hit:
            name, (lat, lng) = hit
            # Filter out trivially short single-word matches (avoid false positives
            # like "Paris" matching a generic word). Require the matched name to
            # be at least 5 chars OR be a multi-word match.
            if len(name) >= 5 or " " in name:
                return {
                    "name": name,
                    "lat": lat,
                    "lng": lng,
                    "lines": lines_for(name),
                    "source": "metro-osm",
                }
    return None


if __name__ == "__main__":
    import sys
    text = " ".join(sys.argv[1:]) or "M4 Alésia 도보 5분"
    out = find_station_in_text(text)
    print(json.dumps(out, ensure_ascii=False, indent=2))
