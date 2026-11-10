// Calculs de la carte sans DOM, partagés par la carte 2D (site/app.js), la vue 3D (site/app3d.js) et les
// contrôles de tools/ : grille des temps, image de la carte de chaleur, isochrones, itinéraire, géographie.
import { hypot } from "./solver.mjs";

// Du plus proche (vert) au plus lointain (rouge) ; au-delà du max : gris.
export const PALETTE = [
  [0, [47, 150, 18]],
  [0.25, [126, 200, 80]],
  [0.5, [226, 228, 120]],
  [0.75, [244, 182, 112]],
  [1, [226, 120, 120]],
];
// Au-delà du max, la couleur s'efface progressivement jusqu'à laisser voir le fond.
export const BEYOND_FADE = 0.15;
export const HEAT_UPSAMPLE = 3;
const LUT_SIZE = 512;
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const RIVER_BRIDGE_CELLS = 4; // cases de 200 m : de quoi traverser le Rhône ou la Garonne

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function paletteColor(t) {
  for (let i = 1; i < PALETTE.length; i += 1) {
    const [stop, color] = PALETTE[i];
    if (t <= stop) {
      const [prevStop, prevColor] = PALETTE[i - 1];
      const mix = (t - prevStop) / (stop - prevStop);
      return prevColor.map((channel, c) => Math.round(channel + (color[c] - channel) * mix));
    }
  }
  return PALETTE[PALETTE.length - 1][1];
}

// --- Géographie -----------------------------------------------------------------

function metersPerDegree(meta) {
  const lat = 111320;
  return { lat, lon: lat * Math.cos((meta.lat0 * Math.PI) / 180) };
}

export function toWorld(meta, lat, lon) {
  const m = metersPerDegree(meta);
  return [lon * m.lon, lat * m.lat];
}

export function toLatLon(meta, point) {
  const m = metersPerDegree(meta);
  return { lat: point[1] / m.lat, lon: point[0] / m.lon };
}

export function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInPolygon(point, polygon) {
  return pointInRing(point, polygon[0]) && !polygon.slice(1).some((hole) => pointInRing(point, hole));
}

export function isOnLand(data, point) {
  if (data.water.some((polygon) => pointInPolygon(point, polygon))) return false;
  return data.boroughs.some((commune) => commune.polygons.some((polygon) => pointInPolygon(point, polygon)));
}

export function communeAt(data, point) {
  const inside = (area) => area.polygons.some((polygon) => pointInPolygon(point, polygon));
  return ((data.arrondissements ?? []).find(inside) ?? data.boroughs.find(inside))?.name;
}

/** Nom de lieu : la station de tram/métro proche si elle existe (plus parlante qu'un arrêt de bus), sinon l'arrêt le plus proche. */
export function nearestStopName(data, point, railRadius) {
  let best = null;
  let bestDistance = Infinity;
  let rail = null;
  let railDistance = Infinity;
  for (const station of data.stations) {
    const d = hypot(point, station.point);
    if (d < bestDistance) {
      bestDistance = d;
      best = station.name;
    }
    if (station.rail && d < railDistance) {
      railDistance = d;
      rail = station.name;
    }
  }
  return railDistance <= railRadius ? rail : best;
}

// --- Itinéraire -------------------------------------------------------------------

/** Reconstitue l'itinéraire (marche, lignes, correspondances) vers un point. `t` donne les textes traduits.
 * `chain` : états du graphe parcourus (vide à pied) ; `states` d'une étape « ride » : états de début et de fin. */
export function buildItinerary(model, data, solution, point, t) {
  const { graph } = model;
  const result = model.travelTo(solution, point);
  if (result.station === -1) {
    return { minutes: result.minutes, steps: [{ kind: "walk", text: t("walk_all"), minutes: result.minutes }], chain: [] };
  }

  const chain = model.chainTo(solution, result.station);

  const name = (state) => data.stations[graph.station[state]].name;
  const steps = [{ kind: "walk", text: t("walk_to", {name: name(chain[0])}), minutes: solution.seedWalk[chain[0]] }];
  let legStart = chain[0];
  let legWait = graph.wait[legStart];
  const closeLeg = (legEnd) => {
    steps.push({
      kind: "ride",
      route: graph.route[legStart],
      text: t("ride_leg", {from: name(legStart), to: name(legEnd)}),
      wait: legWait,
      minutes: solution.dist[legEnd] - solution.dist[legStart],
      states: [legStart, legEnd],
    });
  };
  for (let i = 1; i < chain.length; i += 1) {
    const from = chain[i - 1];
    const to = chain[i];
    if (graph.route[from] === graph.route[to] && graph.station[from] !== graph.station[to]) continue;
    closeLeg(from);
    let walk = 0;
    if (graph.station[from] !== graph.station[to]) {
      const meters = model.walkMeters(data.stations[graph.station[from]].point, data.stations[graph.station[to]].point);
      walk = model.walkMinutes(meters);
      steps.push({ kind: "walk", text: t("transfer_to", {name: name(to)}), minutes: walk });
    }
    // Attente de cette correspondance précise (horaire réel), et non l'attente moyenne d'un départ à pied.
    const access = (graph.access[from] + graph.access[to]) / 2;
    legWait = Math.max(0, solution.dist[to] - solution.dist[from] - walk - (data.meta.transferWalk ?? 1.5) - access);
    legStart = to;
  }
  closeLeg(chain[chain.length - 1]);
  // La sortie du quai (métro) est comptée avec la marche finale.
  const exit = graph.access[chain[chain.length - 1]];
  steps.push({ kind: "walk", text: t("walk_final"), minutes: result.walk + exit });
  return { minutes: result.minutes, steps, chain };
}

// --- Grille des temps ---------------------------------------------------------

/** Comble les cases sans valeur (eau, hors carte) avec la moyenne de leurs voisines, `passes` fois. */
export function fillGaps(values, cols, rows, passes) {
  const filled = Float32Array.from(values);
  for (let pass = 0; pass < passes; pass += 1) {
    const source = Float32Array.from(filled);
    for (let index = 0; index < source.length; index += 1) {
      if (!Number.isNaN(source[index])) continue;
      const row = Math.floor(index / cols);
      const col = index % cols;
      let sum = 0;
      let count = 0;
      for (const [dr, dc] of NEIGHBOURS) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
        const value = source[r * cols + c];
        if (!Number.isNaN(value)) {
          sum += value;
          count += 1;
        }
      }
      if (count) filled[index] = sum / count;
    }
  }
  return filled;
}

export function computeGrid(model, data, solution) {
  const { cells, meta } = data;
  const { gridCols: cols, gridRows: rows } = meta;
  const times = new Float32Array(cols * rows).fill(NaN);
  for (const cell of cells) {
    // cell.access donne déjà la vraie distance à pied (build_data.py) ; la marche directe se calcule ici.
    let best = Infinity;
    for (const [station, meters] of cell.access) {
      const time = solution.stationTime[station] + model.walkMinutes(meters);
      if (time < best) best = time;
    }
    if (model.walkMinutes(hypot(solution.point, cell.point)) < best) best = Math.min(best, model.walkMinutes(model.walkMeters(solution.point, cell.point)));
    // Case enclavée derrière un cours d'eau, sans arrêt de son côté : très loin, sans infini qui contaminerait le lissage.
    times[cell.row * cols + cell.col] = Math.min(best, 180);
  }
  // Les isochrones enjambent les fleuves (comblés avec les valeurs des rives) au lieu d'en faire le tour ;
  // elles sont ensuite découpées sur la terre ferme au dessin.
  const bridged = fillGaps(times, cols, rows, RIVER_BRIDGE_CELLS);
  return { times, smooth: smoothGrid(bridged, cols, rows), cols, rows, contours: {} };
}

/** Moyenne 3×3 limitée à la terre ferme, pour des isochrones moins crénelées. */
export function smoothGrid(times, cols, rows) {
  const out = new Float32Array(times.length).fill(NaN);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      if (Number.isNaN(times[index])) continue;
      let sum = 0;
      let weight = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const r = row + dy;
          const c = col + dx;
          if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
          const value = times[r * cols + c];
          if (Number.isNaN(value)) continue;
          const w = dx === 0 && dy === 0 ? 2 : 1;
          sum += value * w;
          weight += w;
        }
      }
      out[index] = sum / weight;
    }
  }
  return out;
}

/** Pixels RGBA de la carte de chaleur (`upsample`² pixels par cellule, interpolation bilinéaire, ligne 0 au sud). */
export function heatPixels(grid, maxMinutes, upsample = HEAT_UPSAMPLE) {
  const { cols, rows, times } = grid;
  const width = cols * upsample;
  const height = rows * upsample;
  const data = new Uint8ClampedArray(width * height * 4);

  // Étend les valeurs d'un cran hors de la terre pour que le lissage ne fonce pas les côtes.
  const filled = fillGaps(times, cols, rows, 2);

  // Table de couleurs précalculée : t ∈ [0, 1 + BEYOND_FADE] découpé en LUT_SIZE pas.
  const lutMax = 1 + BEYOND_FADE;
  const lut = new Uint32Array(LUT_SIZE);
  const lutBytes = new Uint8Array(lut.buffer);
  for (let i = 0; i < LUT_SIZE; i += 1) {
    const t = (i / (LUT_SIZE - 1)) * lutMax;
    const [r, g, b] = paletteColor(Math.min(t, 1));
    const alpha = t <= 1 ? 255 : Math.round(clamp(1 - (t - 1) / BEYOND_FADE, 0, 1) * 255);
    lutBytes.set([r, g, b, alpha], i * 4);
  }
  const pixels = new Uint32Array(data.buffer);
  const toLut = (LUT_SIZE - 1) / (maxMinutes * lutMax);
  const step = 1 / upsample;
  for (let y = 0; y < height; y += 1) {
    const gy = (y + 0.5) * step - 0.5;
    const row0 = clamp(Math.floor(gy), 0, rows - 1);
    const row1 = Math.min(row0 + 1, rows - 1);
    const ty = clamp(gy - row0, 0, 1);
    for (let x = 0; x < width; x += 1) {
      const gx = (x + 0.5) * step - 0.5;
      const col0 = clamp(Math.floor(gx), 0, cols - 1);
      const col1 = Math.min(col0 + 1, cols - 1);
      const tx = clamp(gx - col0, 0, 1);
      const v00 = filled[row0 * cols + col0];
      const v01 = filled[row0 * cols + col1];
      const v10 = filled[row1 * cols + col0];
      const v11 = filled[row1 * cols + col1];
      let sum = 0;
      let weight = 0;
      let w = (1 - tx) * (1 - ty);
      if (v00 === v00) { sum += v00 * w; weight += w; }
      w = tx * (1 - ty);
      if (v01 === v01) { sum += v01 * w; weight += w; }
      w = (1 - tx) * ty;
      if (v10 === v10) { sum += v10 * w; weight += w; }
      w = tx * ty;
      if (v11 === v11) { sum += v11 * w; weight += w; }
      if (weight < 0.25) continue;
      const index = Math.round((sum / weight) * toLut);
      if (index < LUT_SIZE) pixels[y * width + x] = lut[index];
    }
  }
  return { width, height, data };
}

/** Marching squares sur les centres de cellules ; renvoie des segments en coordonnées monde. */
export function contourSegments(bounds, grid, threshold) {
  const { cols, rows, smooth } = grid;
  const [minX, minY, maxX, maxY] = bounds;
  const cellW = (maxX - minX) / cols;
  const cellH = (maxY - minY) / rows;
  const value = (row, col) => {
    const v = smooth[row * cols + col];
    return Number.isNaN(v) ? Infinity : v;
  };
  const center = (row, col) => [minX + (col + 0.5) * cellW, minY + (row + 0.5) * cellH];
  const between = (pa, va, pb, vb) => {
    const t = Number.isFinite(va) && Number.isFinite(vb) ? clamp((threshold - va) / (vb - va), 0, 1) : 0.5;
    return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
  };

  const segments = [];
  for (let row = 0; row < rows - 1; row += 1) {
    for (let col = 0; col < cols - 1; col += 1) {
      // Coins dans le sens trigonométrique : bas-gauche, bas-droite, haut-droite, haut-gauche.
      const corners = [
        [center(row, col), value(row, col)],
        [center(row, col + 1), value(row, col + 1)],
        [center(row + 1, col + 1), value(row + 1, col + 1)],
        [center(row + 1, col), value(row + 1, col)],
      ];
      const inside = corners.map(([, v]) => v <= threshold);
      const crossings = [];
      for (let k = 0; k < 4; k += 1) {
        const a = corners[k];
        const b = corners[(k + 1) % 4];
        if (inside[k] !== inside[(k + 1) % 4]) crossings.push(between(a[0], a[1], b[0], b[1]));
      }
      if (crossings.length === 2) segments.push(crossings);
      else if (crossings.length === 4) segments.push([crossings[0], crossings[1]], [crossings[2], crossings[3]]);
    }
  }
  return segments;
}

// --- Recherche ------------------------------------------------------------------

export function normalize(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function featureCentre(feature) {
  const geometry = feature.geometry;
  if (!geometry) return null;
  if (geometry.type === "Point") return geometry.coordinates;
  if (Array.isArray(feature.bbox) && feature.bbox.length === 4 && feature.bbox.every(Number.isFinite)) {
    return [(feature.bbox[0] + feature.bbox[2]) / 2, (feature.bbox[1] + feature.bbox[3]) / 2];
  }
  const vertices = [];
  function visit(coords) {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      if (coords.slice(0, 2).every(Number.isFinite)) vertices.push(coords);
    } else coords.forEach(visit);
  }
  visit(geometry.coordinates);
  return vertices.length ? [0, 1].map(axis => vertices.reduce((sum, vertex) => sum + vertex[axis], 0) / vertices.length) : null;
}
