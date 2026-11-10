import fs from "fs";
import crypto from "crypto";
import { decode } from "../site/data-format.mjs";
import { createModel } from "../site/solver.mjs";
import { computeGrid, heatPixels, contourSegments, toWorld } from "../site/map-core.mjs";
// Empreinte de la grille des temps, de l'image de la carte de chaleur et des isochrones pour quelques départs.
// Usage : node tools/check_grid.mjs [carte]
// Sert à vérifier qu'un changement de site/map-core.mjs (ou de son usage par la 2D et la 3D) ne change pas la carte.
const slug = process.argv[2] || "luxembourg";
const d = decode(JSON.parse(fs.readFileSync(`site/data/${slug}.json`)));
const model = createModel(d);
const ORIGINS = [
  ["Gare Centrale", 49.59989, 6.13364],
  ["Kirchberg, Philharmonie", 49.619486, 6.142026],
  ["Esch-sur-Alzette", 49.493911, 5.985087],
  ["Clervaux", 50.0547, 6.0313],
];
const digest = (bytes) => crypto.createHash("sha1").update(bytes).digest("hex").slice(0, 12);
for (const [name, lat, lon] of ORIGINS) {
  for (const includeBus of [true, false]) {
    const solution = model.solveFrom(toWorld(d.meta, lat, lon), { includeBus });
    const grid = computeGrid(model, d, solution);
    const heat = heatPixels(grid, 45);
    const iso = [15, 30, 60].map((minutes) => contourSegments(d.meta.bounds, grid, minutes).length).join("/");
    const times = new Uint8Array(grid.times.buffer);
    const smooth = new Uint8Array(grid.smooth.buffer);
    console.log(`${name.padEnd(24)} ${includeBus ? "bus " : "rail"}  temps ${digest(times)}  lissé ${digest(smooth)}  image ${digest(heat.data)}  isochrones ${iso}`);
  }
}
