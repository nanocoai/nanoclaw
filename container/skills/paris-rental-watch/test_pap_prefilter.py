#!/usr/bin/env python3
"""Unit tests for pap_prefilter.prefilter_pap_card.

Run:
    cd container/skills/paris-rental-watch
    python3 -m unittest test_pap_prefilter -v
"""
import unittest

from pap_prefilter import prefilter_pap_card

PRICE_MAX = 1800
SURFACE_MIN = 30


def _f(card):
    return prefilter_pap_card(card, price_max=PRICE_MAX, surface_min=SURFACE_MIN)


class PreFilter(unittest.TestCase):
    def test_keep_in_bounds(self):
        self.assertEqual(_f({"price_eur": 1500, "surface_m2": 45, "rooms": 3}),
                         (True, None))

    def test_drop_over_price(self):
        self.assertEqual(_f({"price_eur": 2000, "surface_m2": 45})[0], False)
        self.assertEqual(_f({"price_eur": 2000, "surface_m2": 45})[1], "price")

    def test_drop_under_surface(self):
        keep, reason = _f({"price_eur": 1500, "surface_m2": 20})
        self.assertFalse(keep)
        self.assertEqual(reason, "surface")

    def test_at_bounds_is_kept(self):
        # price == max and surface == min are both acceptable (not strictly over/under)
        self.assertEqual(_f({"price_eur": 1800, "surface_m2": 30}), (True, None))

    def test_unknown_surface_is_kept(self):
        # Regression: 1-pièce with unparsed surface must NOT be dropped.
        self.assertEqual(_f({"price_eur": 1200, "surface_m2": None, "rooms": 1}),
                         (True, None))

    def test_unknown_price_is_kept(self):
        self.assertEqual(_f({"price_eur": None, "surface_m2": 40}), (True, None))

    def test_all_unknown_is_kept(self):
        self.assertEqual(_f({"price_eur": None, "surface_m2": None}), (True, None))

    def test_rooms_alone_never_drops(self):
        # 1-pièce, surface unknown → kept (LLM decides), no rooms-only reject.
        self.assertEqual(_f({"rooms": 1, "price_eur": None, "surface_m2": None}),
                         (True, None))

    def test_price_checked_before_surface(self):
        # Both violate; price reason wins (deterministic ordering).
        self.assertEqual(_f({"price_eur": 3000, "surface_m2": 10})[1], "price")


if __name__ == "__main__":
    unittest.main()
