#!/usr/bin/env python3
"""Unit tests for dedup.listing_fingerprint / fingerprint_of.

Run:
    cd container/skills/paris-rental-watch
    python3 -m unittest test_dedup -v
"""
import unittest

from dedup import fingerprint_of, listing_fingerprint


class Fingerprint(unittest.TestCase):
    def test_basic_key(self):
        self.assertEqual(
            listing_fingerprint(zip_or_arr="75005", area_m2=38, price_eur=1650,
                                rooms="T2"),
            "75005|38|1650|t2",
        )

    def test_reposts_share_one_fingerprint(self):
        # Same unit, different agent-rewritten titles / fields → same key.
        a = listing_fingerprint(zip_or_arr="75005", area_m2=38, price_eur=1650, rooms="T2")
        b = listing_fingerprint(zip_or_arr="75005", area_m2=38.0, price_eur=1650, rooms="t2")
        c = listing_fingerprint(zip_or_arr="Paris 75005", area_m2="38", price_eur=1650, rooms="T2")
        self.assertEqual(a, b)
        self.assertEqual(a, c)

    def test_float_area_rounds(self):
        self.assertEqual(
            listing_fingerprint(zip_or_arr="75013", area_m2=51.6, price_eur=1650, rooms="T2"),
            "75013|52|1650|t2",
        )

    def test_rooms_unknown_and_missing_collapse_to_qmark(self):
        for r in (None, "", "unknown", "UNKNOWN"):
            self.assertEqual(
                listing_fingerprint(zip_or_arr="75019", area_m2=42, price_eur=1550, rooms=r),
                "75019|42|1550|?",
            )

    def test_different_rooms_do_not_merge(self):
        t2 = listing_fingerprint(zip_or_arr="75019", area_m2=42, price_eur=1550, rooms="T2")
        t3 = listing_fingerprint(zip_or_arr="75019", area_m2=42, price_eur=1550, rooms="T3")
        self.assertNotEqual(t2, t3)

    def test_none_when_zip_missing(self):
        self.assertIsNone(
            listing_fingerprint(zip_or_arr="", area_m2=38, price_eur=1650, rooms="T2"))
        self.assertIsNone(
            listing_fingerprint(zip_or_arr="Paris centre", area_m2=38, price_eur=1650))

    def test_none_when_area_missing(self):
        self.assertIsNone(
            listing_fingerprint(zip_or_arr="75005", area_m2=None, price_eur=1650))

    def test_none_when_price_missing(self):
        self.assertIsNone(
            listing_fingerprint(zip_or_arr="75005", area_m2=38, price_eur=None))

    def test_non_numeric_price_is_missing(self):
        # "협의" / "negotiable" → not a number → no fingerprint (ID-only dedup).
        self.assertIsNone(
            listing_fingerprint(zip_or_arr="75005", area_m2=38, price_eur="협의"))

    def test_bool_is_not_a_number(self):
        self.assertIsNone(
            listing_fingerprint(zip_or_arr="75005", area_m2=True, price_eur=1650))


class FingerprintOf(unittest.TestCase):
    def test_pulls_from_listing_dict(self):
        listing = {"zip_or_arr": "75012", "area_m2": 37, "price_eur": 1600,
                   "rooms": "T2", "title": "irrelevant"}
        self.assertEqual(fingerprint_of(listing), "75012|37|1600|t2")

    def test_missing_fields_yield_none(self):
        self.assertIsNone(fingerprint_of({"title": "no numbers here"}))


if __name__ == "__main__":
    unittest.main()
