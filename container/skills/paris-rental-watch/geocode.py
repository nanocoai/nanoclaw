#!/usr/bin/env python3
"""
Geocode a Korean-language Paris real-estate location string.

Order:
  1. Static lookup of common Paris métro/RER stations (~60)
  2. Static lookup of arrondissement (1–20구) and inner-suburb (92/93/94 zip prefix)
  3. Nominatim (OSM) free API
  4. Fallback to Paris centroid (48.8566, 2.3522) with source="fallback"

Usage:
    python3 geocode.py "15구 Convention역 근처"
"""
import json
import re
import sys
import urllib.parse
import urllib.request

PARIS_CENTROID = (48.8566, 2.3522)

# Common métro/RER stations frequently referenced in francezone posts.
# Coords from Wikidata; rounded to 4 decimals.
METRO: dict[str, tuple[float, float]] = {
    "convention": (48.8378, 2.3013),
    "republique": (48.8675, 2.3636),
    "république": (48.8675, 2.3636),
    "bastille": (48.8531, 2.3697),
    "nation": (48.8485, 2.3958),
    "opera": (48.8704, 2.3318),
    "opéra": (48.8704, 2.3318),
    "chatelet": (48.8584, 2.3470),
    "châtelet": (48.8584, 2.3470),
    "saint-michel": (48.8534, 2.3441),
    "saint michel": (48.8534, 2.3441),
    "odeon": (48.8517, 2.3389),
    "odéon": (48.8517, 2.3389),
    "montparnasse": (48.8421, 2.3219),
    "gare montparnasse": (48.8421, 2.3219),
    "gare du nord": (48.8809, 2.3553),
    "gare de l'est": (48.8762, 2.3593),
    "gare de lyon": (48.8443, 2.3736),
    "gare saint-lazare": (48.8757, 2.3247),
    "saint-lazare": (48.8757, 2.3247),
    "saint lazare": (48.8757, 2.3247),
    "trocadero": (48.8631, 2.2876),
    "trocadéro": (48.8631, 2.2876),
    "passy": (48.8576, 2.2855),
    "iena": (48.8651, 2.2939),
    "iéna": (48.8651, 2.2939),
    "alma marceau": (48.8645, 2.3014),
    "champs-elysees": (48.8718, 2.3045),
    "champs-élysées": (48.8718, 2.3045),
    "george v": (48.8722, 2.3007),
    "franklin roosevelt": (48.8687, 2.3092),
    "concorde": (48.8657, 2.3214),
    "tuileries": (48.8649, 2.3296),
    "louvre rivoli": (48.8607, 2.3413),
    "palais royal": (48.8627, 2.3361),
    "pyramides": (48.8657, 2.3349),
    "havre caumartin": (48.8736, 2.3286),
    "auber": (48.8716, 2.3300),
    "place clichy": (48.8839, 2.3275),
    "blanche": (48.8838, 2.3327),
    "pigalle": (48.8826, 2.3378),
    "barbes": (48.8843, 2.3491),
    "barbès": (48.8843, 2.3491),
    "stalingrad": (48.8842, 2.3680),
    "jaures": (48.8830, 2.3712),
    "jaurès": (48.8830, 2.3712),
    "belleville": (48.8723, 2.3766),
    "menilmontant": (48.8649, 2.3845),
    "ménilmontant": (48.8649, 2.3845),
    "pere lachaise": (48.8636, 2.3856),
    "père lachaise": (48.8636, 2.3856),
    "gambetta": (48.8651, 2.3984),
    "alesia": (48.8285, 2.3273),
    "alésia": (48.8285, 2.3273),
    "denfert-rochereau": (48.8338, 2.3330),
    "denfert rochereau": (48.8338, 2.3330),
    "porte d'orleans": (48.8232, 2.3258),
    "porte de versailles": (48.8324, 2.2879),
    "porte de vanves": (48.8294, 2.3019),
    "balard": (48.8378, 2.2776),
    "porte de saint-cloud": (48.8385, 2.2570),
    "porte d'auteuil": (48.8470, 2.2588),
    "boulogne pont de saint-cloud": (48.8420, 2.2330),
    "boulogne jean jaures": (48.8460, 2.2400),
    "neuilly": (48.8845, 2.2700),
    "porte maillot": (48.8782, 2.2828),
    "argentine": (48.8761, 2.2895),
    "ternes": (48.8783, 2.2987),
    "etoile": (48.8738, 2.2950),
    "étoile": (48.8738, 2.2950),
    "charles de gaulle etoile": (48.8738, 2.2950),
    "wagram": (48.8839, 2.3023),
    "monceau": (48.8810, 2.3098),
    "villiers": (48.8824, 2.3147),
    "ledru-rollin": (48.8513, 2.3759),
    "voltaire": (48.8580, 2.3793),
    "charonne": (48.8572, 2.3852),
    "alexandre dumas": (48.8569, 2.3936),
    "porte de vincennes": (48.8475, 2.4109),
    "porte dorée": (48.8358, 2.4067),
    "porte doree": (48.8358, 2.4067),
    "porte d'italie": (48.8190, 2.3585),
    "place d'italie": (48.8313, 2.3556),
    "tolbiac": (48.8259, 2.3592),
    "bibliotheque francois mitterrand": (48.8298, 2.3756),
    "bibliothèque françois mitterrand": (48.8298, 2.3756),
}

# Arrondissement centroids (rough; good enough for a fallback pin).
ARRONDISSEMENT: dict[int, tuple[float, float]] = {
    1: (48.8625, 2.3361),
    2: (48.8676, 2.3434),
    3: (48.8631, 2.3617),
    4: (48.8546, 2.3578),
    5: (48.8447, 2.3501),
    6: (48.8496, 2.3331),
    7: (48.8567, 2.3128),
    8: (48.8721, 2.3128),
    9: (48.8770, 2.3370),
    10: (48.8761, 2.3603),
    11: (48.8589, 2.3805),
    12: (48.8404, 2.3950),
    13: (48.8322, 2.3625),
    14: (48.8331, 2.3264),
    15: (48.8412, 2.2997),
    16: (48.8602, 2.2748),
    17: (48.8870, 2.3076),
    18: (48.8922, 2.3486),
    19: (48.8870, 2.3829),
    20: (48.8631, 2.3994),
}

# Suburbs (92/93/94 mostly, by city name)
SUBURBS: dict[str, tuple[float, float]] = {
    "boulogne": (48.8358, 2.2406),
    "boulogne-billancourt": (48.8358, 2.2406),
    "neuilly-sur-seine": (48.8846, 2.2685),
    "levallois": (48.8957, 2.2870),
    "levallois-perret": (48.8957, 2.2870),
    "courbevoie": (48.8975, 2.2566),
    "issy-les-moulineaux": (48.8244, 2.2730),
    "issy": (48.8244, 2.2730),
    "vanves": (48.8228, 2.2899),
    "malakoff": (48.8197, 2.3007),
    "montrouge": (48.8186, 2.3220),
    "ivry": (48.8131, 2.3870),
    "ivry-sur-seine": (48.8131, 2.3870),
    "vincennes": (48.8474, 2.4399),
    "saint-mande": (48.8412, 2.4173),
    "saint-mandé": (48.8412, 2.4173),
    "saint-ouen": (48.9119, 2.3343),
    "saint ouen": (48.9119, 2.3343),
    "clichy": (48.9039, 2.3045),
    "asnieres": (48.9156, 2.2880),
    "asnières": (48.9156, 2.2880),
    "puteaux": (48.8852, 2.2392),
    "la défense": (48.8920, 2.2398),
    "la defense": (48.8920, 2.2398),
    "suresnes": (48.8716, 2.2236),
    "saint-cloud": (48.8403, 2.2049),
    "saint cloud": (48.8403, 2.2049),
    # Korean alias 추가 (francezone 게시글에서 자주 쓰는 표기)
    "블로뉴": (48.8358, 2.2406),
    "뇌이": (48.8846, 2.2685),
    "르발루아": (48.8957, 2.2870),
    "이씨": (48.8244, 2.2730),
    "방브": (48.8228, 2.2899),
    "말라코프": (48.8197, 2.3007),
    "몽루즈": (48.8186, 2.3220),
    "이브리": (48.8131, 2.3870),
    "뱅센": (48.8474, 2.4399),
    "생망데": (48.8412, 2.4173),
    "생투앙": (48.9119, 2.3343),
    "클리시": (48.9039, 2.3045),
    "아니에르": (48.9156, 2.2880),
    "퓌토": (48.8852, 2.2392),
    "라데팡스": (48.8920, 2.2398),
    "쉬렌": (48.8716, 2.2236),
    "생클루": (48.8403, 2.2049),
    "샤랑통": (48.8211, 2.4115),
    "샤랑통르퐁": (48.8211, 2.4115),
    "팡탱": (48.8954, 2.4001),
    "오베르빌리에": (48.9151, 2.3839),
    "바뇰레": (48.8676, 2.4221),
    "쿠르브부아": (48.8975, 2.2566),
    # RER 30분 권 — 지오코드는 함, ambig 분류는 분류기에서 결정
    "비트리": (48.7884, 2.4046),
    "vitry-sur-seine": (48.7884, 2.4046),
    "vitry sur seine": (48.7884, 2.4046),
    "빌쥐프": (48.7937, 2.3654),
    "villejuif": (48.7937, 2.3654),
    "로니": (48.8744, 2.4825),
    "rosny-sous-bois": (48.8744, 2.4825),
    "rosny sous bois": (48.8744, 2.4825),
    "크레테이": (48.7837, 2.4622),
    "creteil": (48.7837, 2.4622),
    "créteil": (48.7837, 2.4622),
    "샹피니": (48.8163, 2.5135),
    "champigny": (48.8163, 2.5135),
    "오를리": (48.7434, 2.4036),
    "orly": (48.7434, 2.4036),
    "바뇨": (48.7975, 2.3105),
    "bagneux": (48.7975, 2.3105),
    "카샹": (48.7935, 2.3306),
    "cachan": (48.7935, 2.3306),
    "레 릴라스": (48.8779, 2.4153),
    "les lilas": (48.8779, 2.4153),
    # 외곽 (분류기에서 reject 되지만 지도엔 정확히 표시되도록)
    "베르사유": (48.8014, 2.1301),
    "versailles": (48.8014, 2.1301),
}


def normalize(s: str) -> str:
    return s.lower().strip()


def find_metro(text: str) -> tuple[float, float] | None:
    t = normalize(text)
    # Korean "역" suffix → strip it: "Convention역" → "convention"
    t = re.sub(r"역\b", " ", t)
    for name, coords in METRO.items():
        if name in t:
            return coords
    return None


def find_arrondissement(text: str) -> tuple[float, float] | None:
    # "15구", "15 구", "15ème", "15e", "75015", "Paris 8E", etc.
    m = re.search(r"\b75\s?0(\d{2})\b", text)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 20:
            return ARRONDISSEMENT[n]
    m = re.search(r"\b([12]?\d)\s*구\b", text)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 20:
            return ARRONDISSEMENT[n]
    m = re.search(r"\b([12]?\d)\s*(?:ème|eme|er|ER|ÈME)\b", text)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 20:
            return ARRONDISSEMENT[n]
    # pap.fr style: "Paris 8E" / "Paris 18E" — zip not always included
    m = re.search(r"Paris\s+([12]?\d)[Ee]\b", text)
    if m:
        n = int(m.group(1))
        if 1 <= n <= 20:
            return ARRONDISSEMENT[n]
    # Fallback: bare "<n>E" / "<n>e" if very short text
    m = re.search(r"\b([12]?\d)[Ee]\b", text)
    if m and len(text) < 50:
        n = int(m.group(1))
        if 1 <= n <= 20:
            return ARRONDISSEMENT[n]
    return None


def find_suburb(text: str) -> tuple[float, float] | None:
    t = normalize(text)
    for name, coords in SUBURBS.items():
        if name in t:
            return coords
    return None


def nominatim(query: str) -> tuple[float, float] | None:
    """Free OSM geocoder. Rate limit: 1 req/sec, no key needed.
    User-Agent must be descriptive per ToS."""
    try:
        url = (
            "https://nominatim.openstreetmap.org/search?"
            + urllib.parse.urlencode(
                {
                    "q": f"{query}, Paris, France",
                    "format": "json",
                    "limit": "1",
                    "countrycodes": "fr",
                }
            )
        )
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "nanoclaw-francezone-watch/1.0 (personal real-estate alerts)",
                "Accept-Language": "ko,fr,en",
            },
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode())
        if data:
            return float(data[0]["lat"]), float(data[0]["lon"])
    except Exception:
        pass
    return None


def _try_metro_osm(query: str) -> dict | None:
    """First-priority lookup: comprehensive IDF station OSM dataset (~800 stations).

    Surfaces ``metro_lines`` from the augmented ``idf_stations.json`` (added
    2026-05) so the map's metro-line filter can match listings without re-
    geocoding. May be empty if the matched station is on a Transilien/SNCF
    line that's out of the M1-M14 / RER A-E / T1-T13 filter scope.
    """
    try:
        from metro_lookup import find_station_in_text
    except ImportError:
        return None
    hit = find_station_in_text(query)
    if hit:
        return {
            "lat": hit["lat"],
            "lng": hit["lng"],
            "source": "metro-osm",
            "matched_station": hit["name"],
            "metro_lines": hit.get("lines", []),
        }
    return None


def geocode(query: str) -> dict:
    """Resolve a location string to {lat, lng, source}.

    Priority order:
      1. metro-osm:    OSM IDF station dataset (~800 stations) — most precise
      2. metro:        legacy static lookup with Korean aliases
      3. suburb:       inner suburb city centers (Boulogne, Vincennes, etc.)
      4. nominatim:    OSM Nominatim free geocoder (street-level, ~1 req/sec)
      5. arrondissement: 75XXX → centroid (low precision)
      6. fallback:     Paris centroid
    """
    if not query or not query.strip():
        return {"lat": PARIS_CENTROID[0], "lng": PARIS_CENTROID[1], "source": "fallback"}

    # 1. Comprehensive IDF metro/RER/tram dataset
    osm_hit = _try_metro_osm(query)
    if osm_hit:
        return osm_hit

    # 2. Legacy static metro lookup (Korean aliases)
    coords = find_metro(query)
    if coords:
        return {"lat": coords[0], "lng": coords[1], "source": "metro"}

    # 3. Inner suburb city
    coords = find_suburb(query)
    if coords:
        return {"lat": coords[0], "lng": coords[1], "source": "suburb"}

    # 4. Nominatim (street-level)
    coords = nominatim(query)
    if coords:
        return {"lat": coords[0], "lng": coords[1], "source": "nominatim"}

    # 5. Arrondissement centroid
    coords = find_arrondissement(query)
    if coords:
        return {"lat": coords[0], "lng": coords[1], "source": "arrondissement"}

    return {"lat": PARIS_CENTROID[0], "lng": PARIS_CENTROID[1], "source": "fallback"}


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: geocode.py <location string>"}))
        sys.exit(2)
    query = " ".join(sys.argv[1:])
    print(json.dumps(geocode(query), ensure_ascii=False))


if __name__ == "__main__":
    main()
