#!/usr/bin/env python3
"""Unit tests for parse_pap.py — the pap.fr listings-index card parser.

Run:
    cd container/skills/paris-rental-watch
    python3 -m unittest test_parse_pap -v
"""
import unittest

import parse_pap


def _card(tags_html, *, price="1 750 € / mois", title='Appartement Paris 15e',
          name="r123456", href="/annonces/location-paris-15-r123456"):
    return (
        "<html><body>"
        '<div class="search-list-item-alt">'
        f'<a class="item-title" name="{name}" href="{href}">{title}</a>'
        f'<span class="item-price">{price}</span>'
        f'<ul class="item-tags">{tags_html}</ul>'
        '<span class="h1">Paris 15e (75015)</span>'
        '<p class="item-description">Bel appart.</p>'
        '<img src="//cdn.pap.fr/photo1.jpg">'
        "</div></body></html>"
    )


class SurfaceParsing(unittest.TestCase):
    def test_basic_surface(self):
        cards = parse_pap.parse_list(_card("<li>3 pièces</li><li>45 m²</li>"))
        self.assertEqual(cards[0]["surface_m2"], 45)
        self.assertEqual(cards[0]["rooms"], 3)

    def test_walk_time_tag_before_surface_does_not_steal_surface(self):
        # Regression: a "2 min métro" tag preceding the surface tag used to
        # match `(\d+)\s*m` and set surface_m2=2, dropping a valid 32 m² flat.
        html = _card("<li>2 min métro</li><li>1 pièce</li><li>32 m²</li>")
        cards = parse_pap.parse_list(html)
        self.assertEqual(cards[0]["surface_m2"], 32)
        self.assertEqual(cards[0]["rooms"], 1)

    def test_surface_m2_spelling_variants(self):
        for tag, expect in (("45 m²", 45), ("45 m2", 45), ("45 m", 45)):
            cards = parse_pap.parse_list(_card(f"<li>{tag}</li>"))
            self.assertEqual(cards[0]["surface_m2"], expect, tag)

    def test_minutes_only_tags_yield_no_surface(self):
        cards = parse_pap.parse_list(_card("<li>5 min marche</li><li>2 pièces</li>"))
        self.assertIsNone(cards[0]["surface_m2"])
        self.assertEqual(cards[0]["rooms"], 2)


class CoreFields(unittest.TestCase):
    def test_price_id_url_photo(self):
        cards = parse_pap.parse_list(_card("<li>40 m²</li>"))
        c = cards[0]
        self.assertEqual(c["pap_id"], "r123456")
        self.assertEqual(c["price_eur"], 1750)
        self.assertEqual(c["detail_url"],
                         "https://www.pap.fr/annonces/location-paris-15-r123456")
        self.assertEqual(c["photo_url"], "https://cdn.pap.fr/photo1.jpg")

    def test_id_falls_back_to_href_when_name_missing(self):
        html = (
            "<html><body>"
            '<div class="search-list-item-alt">'
            '<a class="item-title" href="/loc-r777">T</a>'
            '<span class="item-price">800 €</span>'
            '<ul class="item-tags"><li>31 m²</li></ul>'
            "</div></body></html>"
        )
        cards = parse_pap.parse_list(html)
        self.assertEqual(cards[0]["pap_id"], "777")

    def test_empty_page_returns_empty_list(self):
        self.assertEqual(parse_pap.parse_list("<html><body>no cards</body></html>"), [])

    def test_multiple_cards(self):
        html = _card("<li>40 m²</li>", name="r1", href="/a-r1") + \
            _card("<li>50 m²</li>", name="r2", href="/b-r2")
        cards = parse_pap.parse_list(html)
        self.assertEqual(len(cards), 2)


if __name__ == "__main__":
    unittest.main()
