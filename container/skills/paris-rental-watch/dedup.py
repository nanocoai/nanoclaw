#!/usr/bin/env python3
"""Content-based listing de-duplication for paris-rental-watch.

Why this module exists
======================
The seen-set (`seen_post_ids`) de-dupes by `source:post_id`, so it only
catches the *exact same post*. But francezone real-estate agents bump a
listing by re-posting the SAME flat under a NEW idxno every few days — and
the same unit can appear on both bbs_2 and bbs_3, or be cross-listed. Each
repost has a fresh post_id, so the seen-set lets it through and the user
gets re-alerted for a flat they already saw. Observed in the wild: one
75005 / 38 m² / 1650 € / T2 reposted 11× in a month under 11 idxnos.

The fix is a *content fingerprint* keyed on the stable physical attributes
of a unit — arrondissement (zip), surface, monthly price, and room class.
Titles are useless for this (agents rewrite them every repost); the
numeric triple + room class is what stays constant.

Fingerprint contract
====================
    listing_fingerprint(zip_or_arr=..., area_m2=..., price_eur=..., rooms=...)
        -> str | None

  * Returns a stable "ZIP|AREA|PRICE|ROOMS" key when the three strong
    signals (zip, area, price) are all present.
  * Returns None when any of zip / area / price is missing — too little to
    safely call two listings the same unit, so the caller falls back to
    post_id-only de-dup (never merges on weak evidence).
  * `rooms` is a CATEGORY string in this dataset (T1/T2/T3/T4+/unknown),
    not an int; it's normalised to a lowercase token, with unknown/empty
    collapsing to "?" so a unit whose room-class never parsed still
    matches its own reposts.

Source-agnostic by design: the key has no source component, so a unit
cross-listed on pap + francezone (or bbs_2 + bbs_3) collapses to one
fingerprint. The price/area extraction differs slightly across sources,
so a genuine cross-source match is best-effort — but within francezone
(where every observed duplicate lives) it is exact.

Pure + side-effect-free.

Run the tests:
    cd container/skills/paris-rental-watch
    python3 -m unittest test_dedup -v
"""
from __future__ import annotations

import re
from typing import Any

_ZIP_RE = re.compile(r"\d{5}")


def _norm_zip(zip_or_arr: Any) -> str | None:
    """First 5-digit run in the value (e.g. '75005', or '75015' out of
    'Paris 75015'). None when there is no 5-digit code."""
    m = _ZIP_RE.search(str(zip_or_arr or ""))
    return m.group(0) if m else None


def _norm_int(v: Any) -> int | None:
    """Round numeric area/price to a stable int. None for non-numeric /
    missing values. Strings like '38' are tolerated; '협의' is not."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(round(v))
    try:
        return int(round(float(str(v).strip())))
    except (TypeError, ValueError):
        return None


def _norm_rooms(rooms: Any) -> str:
    """Room class token. T1/T2/T3/T4+/... → lowercase as-is; unknown,
    empty, or None → '?'. Kept as a category (this dataset stores rooms as
    a string, not an int)."""
    s = str(rooms or "").strip().lower()
    if not s or s == "unknown":
        return "?"
    return s


def listing_fingerprint(
    *,
    zip_or_arr: Any,
    area_m2: Any,
    price_eur: Any,
    rooms: Any = None,
) -> str | None:
    """Stable 'ZIP|AREA|PRICE|ROOMS' key, or None when zip/area/price aren't
    all present (insufficient evidence — caller must NOT content-dedup)."""
    z = _norm_zip(zip_or_arr)
    a = _norm_int(area_m2)
    p = _norm_int(price_eur)
    if z is None or a is None or p is None:
        return None
    return f"{z}|{a}|{p}|{_norm_rooms(rooms)}"


def fingerprint_of(listing: dict[str, Any]) -> str | None:
    """Convenience wrapper: pull the four fields off a listing/verdict dict."""
    return listing_fingerprint(
        zip_or_arr=listing.get("zip_or_arr"),
        area_m2=listing.get("area_m2"),
        price_eur=listing.get("price_eur"),
        rooms=listing.get("rooms"),
    )
