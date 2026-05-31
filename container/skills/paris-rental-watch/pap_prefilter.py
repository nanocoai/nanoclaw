#!/usr/bin/env python3
"""pap.fr card pre-filter — conservative, evidence-only drop decision.

PapRentalCFBypassMigration follow-up. The Section C pap loop in SKILL.md
used to inline three reject rules, one of which dropped *any* 1-pièce card
whose surface failed to parse:

    if rooms == 1 and (surface is None or surface < SURFACE_MIN): reject

That over-filters: a real ≥30 m² studio whose surface tag didn't parse
(odd template, transit-time tag stealing the regex — see parse_pap.py)
would be silently discarded before the LLM ever saw it. The pre-filter's
job is only to cheaply drop cards we *know* violate the hard numeric
bounds; everything else must reach the LLM 7-axis classifier.

Contract — drop ONLY on positive evidence:
  * price known AND price > price_max      → drop ("price")
  * surface known AND surface < surface_min → drop ("surface")
  * anything unknown (None)                → KEEP (LLM decides)

`rooms` is no longer a drop axis on its own — a 1-pièce with unknown
surface is kept and handed to the classifier.

Public API:
    prefilter_pap_card(card, *, price_max, surface_min) -> (keep, reason)
        keep:   True  → forward to LLM classifier
                False → drop (counts toward pap_pre_filtered_out)
        reason: None when keep=True; "price" / "surface" when dropped.

Pure + side-effect-free so it can be unit-tested without network.

Run the tests:
    cd container/skills/paris-rental-watch
    python3 -m unittest test_pap_prefilter -v
"""
from __future__ import annotations

from typing import Any


def prefilter_pap_card(
    card: dict[str, Any],
    *,
    price_max: int,
    surface_min: int,
) -> tuple[bool, str | None]:
    """Return (keep, reason). Drops only on known-violating numeric bounds.

    `card` is a parse_pap.py card dict — `price_eur` and `surface_m2` may be
    int or None. A None value is "unknown" and never causes a drop.
    """
    price = card.get("price_eur")
    surface = card.get("surface_m2")

    if isinstance(price, int) and price > price_max:
        return False, "price"
    if isinstance(surface, int) and surface < surface_min:
        return False, "surface"
    return True, None
