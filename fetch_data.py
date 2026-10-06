#!/usr/bin/env python3
"""Download the raw sources of a map into data/<slug>/ (the GTFS into data/<gtfsDir>/, shared between maps).

Usage: python3 fetch_data.py <slug> [--gtfs-only | --osm-only | --rivers-only]
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import time
from datetime import datetime, timezone
import urllib.parse
import urllib.request
from pathlib import Path

from cities import load_city

ROOT = Path(__file__).resolve().parent
USER_AGENT = "lux-tram-range (build script; https://github.com/Leyukaka/lux-tram-range)"
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]


def bbox(values) -> str:
    return ",".join(str(v) for v in values)


def download(url: str, data: bytes | None = None) -> bytes:
    request = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=300) as response:
        return response.read()


def overpass(query: str) -> bytes:
    payload = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(6):
        for url in OVERPASS_URLS:
            try:
                body = download(url, payload)
                json.loads(body)
                return body
            except Exception as error:  # noqa: BLE001 - Overpass is often busy, just retry
                print(f"  {url} failed ({error}), retrying…")
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"Overpass unavailable for: {query[:120]}")


def record(out: Path, name: str, source: str, how: str = "download", extra: dict | None = None) -> None:
    """Note in <dir>/manifest.json where each raw file comes from and when it was fetched."""
    manifest_path = out / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    path = out / name
    manifest[name] = {
        "source": source,
        "how": how,
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "bytes": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        **(extra or {}),
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def latest_udata_resource(api_url: str) -> dict:
    """data.public.lu (udata) publishes each weekly GTFS as a new resource of the dataset: take the newest zip."""
    dataset = json.loads(download(api_url))
    resources = [
        resource for resource in dataset.get("resources", [])
        if (resource.get("format") or "").lower() == "zip" or resource.get("url", "").lower().endswith(".zip")
    ]
    if not resources:
        raise RuntimeError(f"No GTFS zip in {api_url}")
    return max(resources, key=lambda resource: resource.get("last_modified") or resource.get("created_at") or "")


def fetch_gtfs(city: dict) -> None:
    out = ROOT / "data" / city["gtfsDir"]
    out.mkdir(parents=True, exist_ok=True)
    print(f"GTFS {city['network']}…")
    if city.get("gtfsResolve") == "udata":
        resource = latest_udata_resource(city["gtfsApi"])
        url = resource["url"]
        manifest_path = out / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
        if (out / "gtfs.zip").exists() and manifest.get("gtfs.zip", {}).get("source") == url:
            print(f"  déjà à jour ({resource.get('title')})")
            return
        print(f"  {resource.get('title')} ({resource.get('last_modified')})")
        (out / "gtfs.zip").write_bytes(download(url))
        record(out, "gtfs.zip", url, extra={"resource": resource.get("title"), "lastModified": resource.get("last_modified")})
    else:
        (out / "gtfs.zip").write_bytes(download(city["gtfsUrl"]))
        record(out, "gtfs.zip", city["gtfsUrl"])


def fetch_communes(city: dict, out: Path) -> None:
    """Communes of Luxembourg: OSM administrative boundaries (admin_level 8), with their full geometry."""
    print("Communes (OSM)…")
    query = (
        '[out:json][timeout:180];area["ISO3166-1"="LU"][admin_level=2]->.lu;'
        'relation(area.lu)["boundary"="administrative"]["admin_level"="8"];out geom;'
    )
    body = overpass(query)
    count = len(json.loads(body)["elements"])
    if count < 90:
        raise RuntimeError(f"Only {count} communes returned by Overpass, expected about 100")
    (out / "osm_communes.json").write_bytes(body)
    record(out, "osm_communes.json", f"Overpass API: {query}")


def fetch_rivers(city: dict, out: Path) -> None:
    """Rivers crossed on foot only by a bridge (`"rivers"`: names; `"riverWaterways"`: OSM waterway values)."""
    if not city.get("rivers"):
        return
    print("Cours d'eau (OSM)…")
    names = "|".join(re.escape(name) for name in city["rivers"])
    waterways = "|".join(city.get("riverWaterways", ["river"]))
    query = (
        f'[out:json][timeout:110];way["waterway"~"^({waterways})$"]["name"~"^({names})( - .*)?$"]["tunnel"!~"."]'
        f'({bbox(city["osmBbox"])});out geom;'
    )
    (out / "osm_rivers.json").write_bytes(overpass(query))
    record(out, "osm_rivers.json", f"Overpass API: {query}")
    # Bridges open to pedestrians: the ones over these rivers are kept by build_data.py.
    query = (
        '[out:json][timeout:110];way["bridge"]["highway"]'
        '["highway"!~"^(motorway|motorway_link|trunk|trunk_link|construction|proposed)$"]["foot"!="no"]'
        f'({bbox(city["osmBbox"])});out geom;'
    )
    (out / "osm_bridges.json").write_bytes(overpass(query))
    record(out, "osm_bridges.json", f"Overpass API: {query}")


def fetch_water_parks(city: dict, out: Path) -> None:
    print("Eau et parcs (OSM)…")
    area, parks = bbox(city["osmBbox"]), bbox(city["parksBbox"])
    query = (
        "[out:json][timeout:180];("
        f'relation["natural"="water"]({area});'
        f'way["natural"="water"]({area});'
        f'relation["leisure"="park"]({parks});'
        f'way["leisure"="park"]({parks});'
        ");out geom;"
    )
    (out / "osm_water_parks.json").write_bytes(overpass(query))
    record(out, "osm_water_parks.json", f"Overpass API: {query}")


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    city = load_city(sys.argv[1])
    out = ROOT / "data" / city["slug"]
    out.mkdir(parents=True, exist_ok=True)
    if "--rivers-only" in sys.argv:
        fetch_rivers(city, out)
        return
    if "--osm-only" not in sys.argv:
        fetch_gtfs(city)
    if "--gtfs-only" in sys.argv:
        return
    fetch_communes(city, out)
    fetch_water_parks(city, out)
    fetch_rivers(city, out)


if __name__ == "__main__":
    main()
