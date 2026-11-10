#!/usr/bin/env python3
"""Relief of the 3D view (R17.2): the LiDAR 2024 terrain model of the ACT (CC0), resampled on the grid of the site.

Usage: python3 build_terrain.py [map] [--gdal "<command>"]
  --gdal: command that runs a shell inside an image with GDAL (default: podman run --rm ghcr.io/osgeo/gdal:...).

The model is a cloud optimized GeoTIFF of 40 GB at 50 cm (EPSG:2169): gdalwarp reads only the overviews it needs
over HTTP. The output grids are in EPSG:4326 and aligned on the meters of the site, which are proportional to
longitude and latitude (x = lon * 111320 * cos(lat0), y = lat * 111320): the browser needs no reprojection.
Country: 2 samples per cell of the map (about 100 m, mean); city (`viewBbox`): about 10 m (bilinear).
Written to site/data/terrain/<map>-country.json and <map>-city.json: heights in decimeters, row 0 to the south,
each row as its first value then differences; 0 marks no data (outside Luxembourg).
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import shlex
import subprocess
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path

from cities import load_city

ROOT = Path(__file__).resolve().parent
DTM_URL = "https://download.data.public.lu/resources/bd-l-lidar2024-releve-3d-du-territoire-luxembourgeois/20241223-093912/MNT_Lidar2024.tif"
DTM_DATASET = "https://data.public.lu/fr/datasets/lidar-2024-releve-3d-du-territoire-luxembourgeois/"
GDAL_IMAGE = "ghcr.io/osgeo/gdal:ubuntu-small-3.10.3"
CITY_STEP_METERS = 10


def grids(city: dict, meta: dict) -> dict:
    """Extent (lon/lat), size and resampling of each grid."""
    k = 111320 * math.cos(math.radians(meta["lat0"]))
    left, bottom, right, top = meta["bounds"]
    south, west, north, east = city["viewBbox"]
    return {
        "country": {
            "extent": [left / k, bottom / 111320, right / k, top / 111320],
            "size": [meta["gridCols"] * 2, meta["gridRows"] * 2],
            "resampling": "average",
        },
        "city": {
            "extent": [west, south, east, north],
            "size": [round((east - west) * k / CITY_STEP_METERS), round((north - south) * 111320 / CITY_STEP_METERS)],
            "resampling": "bilinear",
        },
    }


def run_gdal(command: str, specs: dict) -> dict:
    """Warp each grid in the container and bring back ASCII grids through stdout (a tar, in base64): files written
    to a mounted Windows folder came back empty with the raw drivers."""
    lines = ["set -e", "cd /tmp", "export GDAL_HTTP_MULTIRANGE=YES GDAL_HTTP_MERGE_CONSECUTIVE_RANGES=YES GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR"]
    for name, spec in specs.items():
        extent = " ".join(f"{v:.12f}" for v in spec["extent"])
        cols, rows = spec["size"]
        lines.append(
            f"gdalwarp -q -overwrite -t_srs EPSG:4326 -te {extent} -ts {cols} {rows} -r {spec['resampling']} "
            f"-ot Float32 -dstnodata -9999 /vsicurl/{DTM_URL} {name}.tif"
        )
        lines.append(f"gdal_translate -q -of AAIGrid -co DECIMAL_PRECISION=1 {name}.tif {name}.asc 2>/dev/null")
    lines.append(f"tar cz {' '.join(f'{name}.asc' for name in specs)} | base64 -w0")
    script = "; ".join(lines)
    result = subprocess.run([*shlex.split(command), "sh", "-c", script], capture_output=True, check=True)
    archive = base64.b64decode(result.stdout)
    out = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        for name in specs:
            out[name] = tar.extractfile(f"{name}.asc").read().decode("ascii")
    return out


def parse_ascii_grid(text: str, cols: int, rows: int) -> list:
    """Rows of heights in decimeters, south first (the file starts with the northern row); 0 for no data."""
    lines = text.split("\n")
    header = {}
    while lines and lines[0].split() and not lines[0].split()[0].lstrip("-").replace(".", "").isdigit():
        key, value = lines.pop(0).split()[:2]
        header[key.lower()] = value
    values = [float(v) for line in lines for v in line.split()]
    if (int(header["ncols"]), int(header["nrows"])) != (cols, rows) or len(values) != cols * rows:
        raise RuntimeError(f"Unexpected grid: {header}, {len(values)} values")
    nodata = float(header.get("nodata_value", -9999))
    grid = [[0 if v == nodata or v < 1 else round(v * 10) for v in values[r * cols:(r + 1) * cols]] for r in range(rows)]
    return grid[::-1]


def encode(grid: list) -> list:
    return [[row[0]] + [b - a for a, b in zip(row, row[1:])] for row in grid]


def main() -> None:
    args = sys.argv[1:]
    command = f"podman run --rm {GDAL_IMAGE}"
    if "--gdal" in args:
        command = args[args.index("--gdal") + 1]
        del args[args.index("--gdal"):args.index("--gdal") + 2]
    slug = args[0] if args else "luxembourg"
    city = load_city(slug)
    meta = json.loads((ROOT / "site" / "data" / f"{slug}.json").read_text(encoding="utf-8"))["meta"]
    specs = grids(city, meta)
    print(f"Relief LiDAR 2024 ({', '.join(f'{n} {s[0]}x{s[1]}' for n, s in ((n, v['size']) for n, v in specs.items()))})...")
    texts = run_gdal(command, specs)
    out_dir = ROOT / "site" / "data" / "terrain"
    out_dir.mkdir(parents=True, exist_ok=True)
    k = 111320 * math.cos(math.radians(meta["lat0"]))
    provenance = {}
    for name, spec in specs.items():
        cols, rows = spec["size"]
        grid = parse_ascii_grid(texts[name], cols, rows)
        west, south, east, north = spec["extent"]
        heights = [v for row in grid for v in row if v]
        payload = {
            "bounds": [round(west * k, 1), round(south * 111320, 1), round(east * k, 1), round(north * 111320, 1)],
            "cols": cols,
            "rows": rows,
            "unit": "dm",
            "rowsDelta": encode(grid),
        }
        path = out_dir / f"{slug}-{name}.json"
        path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        provenance[name] = {
            "file": str(path.relative_to(ROOT)).replace("\\", "/"),
            "size": [cols, rows],
            "resampling": spec["resampling"],
            "minMeters": min(heights) / 10,
            "maxMeters": max(heights) / 10,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        print(f"Wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1e6:.2f} MB, {min(heights) / 10:.0f} à {max(heights) / 10:.0f} m)")
    sources = {
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": DTM_URL,
        "dataset": DTM_DATASET,
        "licence": "CC0, Administration du cadastre et de la topographie (ACT)",
        "tool": f"gdalwarp ({GDAL_IMAGE})",
        "grids": provenance,
    }
    path = ROOT / "sources" / f"{slug}-terrain.json"
    path.write_text(json.dumps(sources, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
