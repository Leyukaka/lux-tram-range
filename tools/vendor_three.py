#!/usr/bin/env python3
"""Copy three.js into site/vendor/ for the 3D view (R17.6): the CSP allows scripts from the site only.

Usage: python3 tools/vendor_three.py
Downloads the npm archive of a pinned version, checks its SHA-512 against the value published by npm (pinned
below), keeps the few files the page uses and rewrites the `three` imports of the add-ons as relative paths (an
import map would be an inline script, refused by `script-src 'self'`).
"""

from __future__ import annotations

import base64
import hashlib
import io
import re
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = "0.186.1"
TARBALL = f"https://registry.npmjs.org/three/-/three-{VERSION}.tgz"
INTEGRITY = "sha512-blFeqb49wRCSGUGj7gtpfnSGHy2lwDk94RhUmS1c/hTby70kvChbWpkJ4Pm1390LqzzvTmzgXKHPEafJwCb8jA=="
OUT = ROOT / "site" / "vendor" / f"three-{VERSION}"
# Path in the archive -> path under OUT.
FILES = {
    "build/three.core.js": "three.core.js",
    "build/three.module.js": "three.module.js",
    "examples/jsm/controls/OrbitControls.js": "addons/OrbitControls.js",
    "examples/jsm/lines/Line2.js": "addons/Line2.js",
    "examples/jsm/lines/LineSegments2.js": "addons/LineSegments2.js",
    "examples/jsm/lines/LineGeometry.js": "addons/LineGeometry.js",
    "examples/jsm/lines/LineSegmentsGeometry.js": "addons/LineSegmentsGeometry.js",
    "examples/jsm/lines/LineMaterial.js": "addons/LineMaterial.js",
    "LICENSE": "LICENSE",
}


def main() -> None:
    request = urllib.request.Request(TARBALL, headers={"User-Agent": "lux-tram-range (vendor script)"})
    with urllib.request.urlopen(request, timeout=120) as response:
        archive = response.read()
    digest = "sha512-" + base64.b64encode(hashlib.sha512(archive).digest()).decode()
    if digest != INTEGRITY:
        raise SystemExit(f"Unexpected archive checksum: {digest}")
    OUT.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        for source, target in FILES.items():
            text = tar.extractfile(f"package/{source}").read().decode("utf-8")
            if target.startswith("addons/"):
                text = re.sub(r"""from\s+(['"])three\1""", "from '../three.module.js'", text)
            path = OUT / target
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8", newline="\n")
            print(f"{path.relative_to(ROOT)} ({path.stat().st_size // 1024} Ko)")


if __name__ == "__main__":
    main()
