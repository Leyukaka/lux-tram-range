"""Map configurations (cities/<slug>.json), completed with defaults shared by every script.

A config only needs what cannot be deduced: name, network, sources, centre of the map and the `kind` of rail
network. Maps built from the same feed share a network file (networks/<gtfsShared>.json: line colours, links
missing from the feed). Everything else has a default below and can be overridden in the JSON.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CITIES_DIR = ROOT / "cities"
NETWORKS_DIR = ROOT / "networks"

# Labels in French, the reference language; the pages translate them through i18n/<lang>.json.
RAIL_NOUN = {"tram": "tram", "metro": "métro", "metro+tram": "métro et tram", "train+tram": "train et tram"}
RAIL_LABEL = {"tram": "Tram", "metro": "Métro", "metro+tram": "Métro et tram", "train+tram": "Train et tram"}
RAIL_STATIONS = {
    "tram": "stations de tram",
    "metro": "stations de métro",
    "metro+tram": "stations de métro et de tram",
    "train+tram": "gares et stations de tram",
}
# Half-sizes (degrees of latitude, longitude) of the OSM areas around the centre.
OSM_HALF_SIZE = (0.22, 0.32)
PARKS_HALF_SIZE = (0.06, 0.08)


def with_defaults(raw: dict) -> dict:
    city = dict(raw)
    if city.get("gtfsShared"):
        network = json.loads((NETWORKS_DIR / f"{city['gtfsShared']}.json").read_text(encoding="utf-8"))
        city = {**network, **city}
    kind = city.setdefault("kind", "tram")
    lat, lon = city["defaultFrom"]["lat"], city["defaultFrom"]["lon"]
    city.setdefault("path", f"{city['slug']}/")
    city.setdefault("railNoun", RAIL_NOUN[kind])
    city.setdefault("railLabel", RAIL_LABEL[kind])
    city.setdefault("railStations", RAIL_STATIONS[kind])
    city.setdefault("title", f"{city['name']} à portée de tram")
    city.setdefault("titleSuffix", f"Temps de trajet en transports en commun ({city['network']})")
    city.setdefault("busNoun", "bus")
    city.setdefault("busLabel", "Bus")
    city.setdefault("territory", city["name"])
    city.setdefault("areaKey", "city")
    city.setdefault("railGeometry", "gtfs")
    city.setdefault("lat0", round(lat, 2))
    city.setdefault("gridCellMeters", 200)
    city.setdefault("maxWait", 15)
    # Raw GTFS location under data/: shared by every map of the same feed, other sources stay in data/<slug>/.
    city.setdefault("gtfsDir", f"_shared/{city['gtfsShared']}" if city.get("gtfsShared") else city["slug"])
    city.setdefault("osmBbox", [round(lat - OSM_HALF_SIZE[0], 2), round(lon - OSM_HALF_SIZE[1], 2),
                                round(lat + OSM_HALF_SIZE[0], 2), round(lon + OSM_HALF_SIZE[1], 2)])
    city.setdefault("parksBbox", [round(lat - PARKS_HALF_SIZE[0], 2), round(lon - PARKS_HALF_SIZE[1], 2),
                                  round(lat + PARKS_HALF_SIZE[0], 2), round(lon + PARKS_HALF_SIZE[1], 2)])
    city.setdefault("osmRailBbox", city["osmBbox"])
    return city


def load_city(slug: str) -> dict:
    return with_defaults(json.loads((CITIES_DIR / f"{slug}.json").read_text(encoding="utf-8")))


def load_cities() -> list[dict]:
    cities = [with_defaults(json.loads(path.read_text(encoding="utf-8"))) for path in CITIES_DIR.glob("*.json")]
    return sorted(cities, key=lambda city: city["order"])
