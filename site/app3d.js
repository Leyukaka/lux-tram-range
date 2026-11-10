import * as THREE from "./vendor/three-0.186.1/three.module.js";
import { OrbitControls } from "./vendor/three-0.186.1/addons/OrbitControls.js";
import { Line2 } from "./vendor/three-0.186.1/addons/Line2.js";
import { LineGeometry } from "./vendor/three-0.186.1/addons/LineGeometry.js";
import { LineMaterial } from "./vendor/three-0.186.1/addons/LineMaterial.js";
import { decode } from "./data-format.mjs";
import { createModel, hypot } from "./solver.mjs";
import * as core from "./map-core.mjs";
// Vue 3D (essai, R17) : la carte des temps posée sur le relief LiDAR, avec le tram, les trains et les lignes de la
// Ville. Les temps, la carte de chaleur, les isochrones et l'itinéraire viennent des mêmes fonctions que la 2D.

const I18N = JSON.parse(document.getElementById("i18n").textContent);
function t(key, vars = {}) {
  const text = I18N.messages[key] ?? I18N.fallback[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`));
}
const CITY = JSON.parse(document.getElementById("city-config").textContent);
const dataUrl = (name, version) => new URL(`./data/${name}.json?v=${version}`, import.meta.url);
const GEOCODER_URL = "https://map.geoportail.lu/fulltextsearch";

const DEFAULT_MAX = CITY.defaultMax ?? 45;
const SCALE_MAX = CITY.scaleMax ?? 90;
const ISOCHRONE_OPTIONS = [15, 30, 45, 60];
const REACH_MINUTES = 30;
const HEAT_ALPHA = { day: 0.78, night: 0.88 };
const BASE_HEIGHT = 100; // mètres : le relief est exagéré au-dessus de ce niveau
const NODATA_HEIGHT = 60; // hors du pays : le socle descend sous le relief
const BRIDGE_REACH = 300; // mètres de part et d'autre : une ligne garde la hauteur des rives pour franchir une vallée
const LINE_LIFT = 8;
const CLICK_SLOP = { mouse: 5, touch: 12 };
const MOBILE = matchMedia("(pointer: coarse)").matches || Math.min(screen.width, screen.height) < 700;
const MAX_VEHICLES = MOBILE ? 120 : 300;

const COLORS = {
  day: { background: "#f1efe9", land: "#e4e2dc", water: "#bcd7e8", park: "rgba(120, 180, 90, 0.18)", outline: "rgba(255, 255, 255, 0.9)", contour: "#111111", halo: "#ffffff", from: "#3aa70b", to: "#111111", route: "#111111" },
  night: { background: "#070a10", land: "#10151f", water: "#0a1626", park: "rgba(80, 140, 90, 0.12)", outline: "rgba(150, 170, 200, 0.35)", contour: "rgba(255, 255, 255, 0.9)", halo: "#070a10", from: "#59e21c", to: "#ffffff", route: "#ffffff" },
};
// Bus de la Ville : 12 teintes par numéro de ligne, voisines éloignées ; le liseré porte le contraste.
const BUS_COLORS = ["#1565C0", "#EF6C00", "#00838F", "#C62828", "#2E7D32", "#AD1457", "#283593", "#F9A825", "#00897B", "#6D4C41", "#D81B60", "#558B2F"];

const $ = (id) => document.getElementById(id);
const canvas = $("sceneCanvas");
const stage = $("mapStage");

const app = {
  data: null,
  model: null,
  lines: null,
  terrain: {},
  from: null,
  to: null,
  includeBus: true,
  showNightLines: false,
  showVehicles: !matchMedia("(prefers-reduced-motion: reduce)").matches,
  night: false,
  heatFrom: "from", // la carte des temps part du départ ou de l'arrivée, comme en 2D (carte=arrivee)
  maxMinutes: DEFAULT_MAX,
  autoScale: true,
  isochrones: [15, 30],
  solution: null,
  grid: null,
};

// --- Textes et petites fonctions ------------------------------------------------

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return t("empty");
  if (minutes < 1) return t("under_minute");
  if (minutes < 60) return t("minutes", {n: Math.round(minutes)});
  const hours = Math.floor(minutes / 60);
  return t("hours", {hours, minutes: String(Math.round(minutes - hours * 60)).padStart(2, "0")});
}

// Texte noir ou blanc selon le contraste WCAG, comme site/app.js et build_pages.py.
function contrastText(hex) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  return (luminance + 0.05) / (0.0056 + 0.05) >= 1.05 / (luminance + 0.05) ? "#111" : "#fff";
}

function lighten(hex, amount) {
  const c = new THREE.Color(hex);
  return "#" + c.lerp(new THREE.Color("#ffffff"), amount).getHexString();
}

const toWorld = (lat, lon) => core.toWorld(app.data.meta, lat, lon);
const toLatLon = (point) => core.toLatLon(app.data.meta, point);
const palette = () => (app.night ? COLORS.night : COLORS.day);

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (element.hidden = true), 2600);
}

function fail(message) {
  $("fallbackText").textContent = message;
  $("fallback3d").hidden = false;
  $("mapCard").setAttribute("aria-busy", "false");
}

// --- Relief -----------------------------------------------------------------------

/** Grille de hauteurs (mètres, NaN hors du pays) depuis le fichier de build_terrain.py. */
function decodeTerrain(raw) {
  const { cols, rows, bounds } = raw;
  const heights = new Float32Array(cols * rows);
  raw.rowsDelta.forEach((row, r) => {
    let value = 0;
    row.forEach((delta, c) => {
      value = c === 0 ? delta : value + delta;
      heights[r * cols + c] = value === 0 ? NaN : value / 10;
    });
  });
  return { cols, rows, bounds, heights };
}

function sampleGrid(grid, x, y) {
  const [left, bottom, right, top] = grid.bounds;
  const fx = ((x - left) / (right - left)) * grid.cols - 0.5;
  const fy = ((y - bottom) / (top - bottom)) * grid.rows - 0.5;
  if (fx < 0 || fy < 0 || fx > grid.cols - 1 || fy > grid.rows - 1) return NaN;
  const c = Math.min(Math.floor(fx), grid.cols - 2);
  const r = Math.min(Math.floor(fy), grid.rows - 2);
  const u = fx - c;
  const v = fy - r;
  const at = (rr, cc) => grid.heights[rr * grid.cols + cc];
  const h00 = at(r, c), h01 = at(r, c + 1), h10 = at(r + 1, c), h11 = at(r + 1, c + 1);
  if (h00 !== h00 || h01 !== h01 || h10 !== h10 || h11 !== h11) {
    const valid = [h00, h01, h10, h11].filter((h) => h === h);
    return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : NaN;
  }
  return (h00 * (1 - u) + h01 * u) * (1 - v) + (h10 * (1 - u) + h11 * u) * v;
}

/** Altitude d'un point du monde : la grille fine de la ville, sinon celle du pays. */
function groundHeight(x, y) {
  const fine = sampleGrid(app.terrain.city, x, y);
  if (fine === fine) return fine;
  const coarse = sampleGrid(app.terrain.country, x, y);
  return coarse === coarse ? coarse : NODATA_HEIGHT;
}

// --- Scène --------------------------------------------------------------------------

let renderer;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 20, 500000);
const relief = new THREE.Group(); // échelle verticale = exagération du relief
scene.add(relief);
const hemisphere = new THREE.HemisphereLight("#ffffff", "#8a8f86", 2.2);
const sun = new THREE.DirectionalLight("#fff4e0", 1.1);
sun.position.set(-1, 1.2, -0.8); // nord-ouest, convention cartographique
scene.add(hemisphere, sun);
let controls;
let origin = [0, 0];
const lineMaterials = new Set();
const surfaces = []; // { bounds, mesh, canvas, base, texture }
let lineGroup = new THREE.Group();
let routeGroup = new THREE.Group();
let vehicles = null;
relief.add(lineGroup, routeGroup);

const toScene = (x, y, h) => new THREE.Vector3(x - origin[0], h - BASE_HEIGHT, -(y - origin[1]));

function buildSurface(bounds, cols, rows, under = null) {
  const [left, bottom, right, top] = bounds;
  // Sous l'emprise de la ville (rétrécie d'une maille), le maillage grossier du pays passe 150 m plus bas : sinon ses
  // facettes percent le maillage fin dans les vallées.
  const margin = Math.max((right - left) / (cols - 1), (top - bottom) / (rows - 1));
  const hidden = (x, y) => under && x > under[0] + margin && x < under[2] - margin && y > under[1] + margin && y < under[3] - margin;
  const positions = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = left + ((right - left) * c) / (cols - 1);
      const y = bottom + ((top - bottom) * r) / (rows - 1);
      const i = r * cols + c;
      const p = toScene(x, y, groundHeight(x, y) - (hidden(x, y) ? 150 : 0));
      positions.set([p.x, p.y, p.z], i * 3);
      uvs.set([c / (cols - 1), r / (rows - 1)], i * 2);
    }
  }
  const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const a = r * cols + c;
      index.set([a, a + 1, a + cols, a + 1, a + cols + 1, a + cols], k);
      k += 6;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  return geometry;
}

function addSurface(bounds, step, maxTexture, behind, under = null) {
  const cols = Math.round((bounds[2] - bounds[0]) / step) + 1;
  const rows = Math.round((bounds[3] - bounds[1]) / step) + 1;
  const textureCanvas = document.createElement("canvas");
  const fit = maxTexture / Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]);
  textureCanvas.width = Math.round((bounds[2] - bounds[0]) * fit);
  textureCanvas.height = Math.round((bounds[3] - bounds[1]) * fit);
  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const material = new THREE.MeshLambertMaterial({ map: texture });
  if (behind) Object.assign(material, { polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
  const mesh = new THREE.Mesh(buildSurface(bounds, cols, rows, under), material);
  relief.add(mesh);
  const surface = { bounds, mesh, canvas: textureCanvas, base: document.createElement("canvas"), texture };
  surfaces.push(surface);
  return surface;
}

/** Transforme le contexte 2D d'une texture en coordonnées monde (mètres, nord en haut). */
function worldTransform(ctx, surface) {
  const [left, bottom, right, top] = surface.bounds;
  const sx = surface.canvas.width / (right - left);
  const sy = surface.canvas.height / (top - bottom);
  ctx.setTransform(sx, 0, 0, -sy, -left * sx, top * sy);
  return sx;
}

function ringPath(path, ring) {
  ring.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
  path.closePath();
}

/** Fond statique d'une texture : terre, parcs, eau, limites de communes (refait au changement d'ambiance). */
function paintBase(surface) {
  const colors = palette();
  surface.base.width = surface.canvas.width;
  surface.base.height = surface.canvas.height;
  const ctx = surface.base.getContext("2d");
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, surface.base.width, surface.base.height);
  const scale = worldTransform(ctx, surface);
  const land = new Path2D();
  for (const commune of app.data.boroughs) for (const polygon of commune.polygons) for (const ring of polygon) ringPath(land, ring);
  ctx.fillStyle = colors.land;
  ctx.fill(land, "evenodd");
  for (const [items, color] of [[app.data.parks, colors.park], [app.data.water, colors.water]]) {
    const path = new Path2D();
    for (const polygon of items) for (const ring of polygon) ringPath(path, ring);
    ctx.fillStyle = color;
    ctx.fill(path, "evenodd");
  }
  const outlines = new Path2D();
  for (const commune of app.data.boroughs) for (const ring of commune.outline) ringPath(outlines, ring);
  ctx.strokeStyle = colors.outline;
  ctx.lineWidth = 1.2 / scale;
  ctx.stroke(outlines);
  surface.land = land;
}

const heatCanvas = document.createElement("canvas");

/** Carte de chaleur et isochrones sur chaque texture, à partir de la même grille que la 2D. */
function paintSurfaces({ fast = false } = {}) {
  if (!app.grid) return;
  const { width, height, data } = core.heatPixels(app.grid, app.maxMinutes, fast ? 1 : core.HEAT_UPSAMPLE);
  heatCanvas.width = width;
  heatCanvas.height = height;
  heatCanvas.getContext("2d").putImageData(new ImageData(data, width, height), 0, 0);
  const [mx, my, mx2, my2] = app.data.meta.bounds;
  const colors = palette();
  const contours = fast ? [] : app.isochrones.map((minutes) => core.contourSegments(app.data.meta.bounds, app.grid, minutes));
  // Pendant un glisser, seule la texture de la ville (la plus petite, au premier plan) est repeinte.
  for (const surface of fast ? surfaces.slice(1) : surfaces) {
    const ctx = surface.canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(surface.base, 0, 0);
    const scale = worldTransform(ctx, surface);
    ctx.save();
    ctx.clip(surface.land, "evenodd");
    ctx.globalAlpha = app.night ? HEAT_ALPHA.night : HEAT_ALPHA.day;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(heatCanvas, mx, my, mx2 - mx, my2 - my);
    ctx.globalAlpha = 1;
    const pixel = 1 / scale;
    const lineScale = Math.max(1, surface.canvas.width / 2048);
    for (const segments of contours) {
      const path = new Path2D();
      for (const [[ax, ay], [bx, by]] of segments) {
        path.moveTo(ax, ay);
        path.lineTo(bx, by);
      }
      ctx.lineCap = "round";
      ctx.strokeStyle = colors.halo;
      ctx.lineWidth = 4.5 * lineScale * pixel;
      ctx.stroke(path);
      ctx.strokeStyle = colors.contour;
      ctx.lineWidth = 2.2 * lineScale * pixel;
      ctx.stroke(path);
    }
    ctx.restore();
    surface.texture.needsUpdate = true;
  }
  requestRender();
}

// --- Lignes ------------------------------------------------------------------------

/** Hauteur d'une ligne : celle des rives pour franchir une vallée (maximum à gauche et à droite sur BRIDGE_REACH). */
function lineHeights(points) {
  const ground = points.map(([x, y]) => groundHeight(x, y));
  const along = [0];
  for (let i = 1; i < points.length; i += 1) along.push(along[i - 1] + hypot(points[i - 1], points[i]));
  return ground.map((h, i) => {
    let left = h;
    let right = h;
    for (let k = i; k >= 0 && along[i] - along[k] <= BRIDGE_REACH; k -= 1) left = Math.max(left, ground[k]);
    for (let k = i; k < ground.length && along[k] - along[i] <= BRIDGE_REACH; k += 1) right = Math.max(right, ground[k]);
    return Math.max(h, Math.min(left, right)) + LINE_LIFT;
  });
}

function densify(points, step) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / step);
    for (let k = 1; k <= n; k += 1) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

function lineMaterial(color, width, extra = {}) {
  const material = new LineMaterial({ color, linewidth: width, worldUnits: false, ...extra });
  material.resolution.set(canvas.clientWidth, canvas.clientHeight);
  lineMaterials.add(material);
  return material;
}

/** Libère les géométries (partagées par le liseré et la ligne) et les matériaux d'un groupe avant de le remplacer. */
function disposeGroup(group) {
  const geometries = new Set();
  group.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.material) {
      lineMaterials.delete(object.material);
      object.material.dispose();
    }
  });
  for (const geometry of geometries) geometry.dispose();
}

function addLine(group, positions, color, width, { halo = true, glow = false, order = 0 } = {}) {
  const geometry = new LineGeometry();
  geometry.setPositions(positions);
  const colors = palette();
  if (glow) {
    // Lueur de nuit : un trait large et transparent sous la ligne, sans mélange additif (qui sature en blanc).
    const light = new Line2(geometry, lineMaterial(color, width * 3, { transparent: true, opacity: 0.18, depthWrite: false }));
    light.renderOrder = order;
    group.add(light);
  } else if (halo) {
    // Le liseré n'écrit pas la profondeur : la ligne de couleur, dessinée après, passe toujours dessus.
    const under = new Line2(geometry, lineMaterial(colors.halo, width + 2, { depthWrite: false }));
    under.renderOrder = order;
    group.add(under);
  }
  const line = new Line2(geometry, lineMaterial(color, width));
  line.renderOrder = order + 1;
  group.add(line);
}

/** Tracés en coordonnées de scène, calculés une fois (le relief ne change pas). */
function inCity([x, y]) {
  const [left, bottom, right, top] = app.terrain.city.bounds;
  return x >= left && x <= right && y >= bottom && y <= top;
}

function prepareLines() {
  const shapes = [];
  const toPositions = (points) => {
    const dense = densify(points, 60).filter((point, i, all) => i === 0 || i === all.length - 1 || inCity(point) || i % 3 === 0);
    const heights = lineHeights(dense);
    const positions = [];
    dense.forEach(([x, y], i) => {
      const p = toScene(x, y, heights[i]);
      positions.push(p.x, p.y, p.z);
    });
    return { dense, positions };
  };
  // Les variantes de trains (par terminus) roulent souvent sur les mêmes voies : une variante dont 90 % du tracé
  // passe dans des cases de 60 m déjà couvertes n'est pas redessinée (moins de triangles, pas de scintillement).
  const covered = new Set();
  const cellOf = ([x, y]) => `${Math.floor(x / 60)},${Math.floor(y / 60)}`;
  const routes = [...app.data.routes].sort((a, b) => b.points.length - a.points.length);
  for (const route of routes) {
    const info = app.data.routeInfo[route.id];
    if (!info) continue;
    const kind = info.mode === "train" ? "train" : "tram";
    if (kind === "train") {
      const dense = densify(route.points, 30);
      if (dense.filter((point) => covered.has(cellOf(point))).length >= dense.length * 0.9) continue;
      for (const point of dense) covered.add(cellOf(point));
    }
    shapes.push({ kind, name: info.name, routeId: route.id, color: info.color, ...toPositions(route.points) });
  }
  for (const line of app.lines.lines) {
    const number = parseInt(line.name.replace(/\D/g, ""), 10) || 0;
    const color = BUS_COLORS[number % BUS_COLORS.length];
    line.color = color;
    line.shapes.forEach((flat, direction) => {
      const points = [];
      let x = 0;
      let y = 0;
      for (let i = 0; i < flat.length; i += 2) {
        x += flat[i];
        y += flat[i + 1];
        points.push([x, y]);
      }
      shapes.push({ kind: line.night ? "night" : "bus", name: line.name, color, headway: line.headways?.[direction] ?? null, ...toPositions(points) });
    });
  }
  // Intervalle des lignes ferrées : deux fois l'attente moyenne au départ (horaire réel du graphe).
  const waits = new Map();
  app.data.routeStates.forEach((state) => {
    if (state.wait >= 99) return; // état de descente (ALIGHT_WAIT de build_data.py), pas une attente
    if (!waits.has(state.routeId)) waits.set(state.routeId, []);
    waits.get(state.routeId).push(state.wait);
  });
  for (const shape of shapes) {
    if (!shape.routeId) continue;
    const values = (waits.get(shape.routeId) ?? []).sort((a, b) => a - b);
    shape.headway = values.length ? Math.max(3, Math.round(values[Math.floor(values.length / 2)] * 2)) : null;
  }
  app.shapes = shapes;
}

function drawLines() {
  relief.remove(lineGroup);
  disposeGroup(lineGroup);
  lineGroup = new THREE.Group();
  const night = app.night;
  for (const shape of app.shapes) {
    if (shape.kind === "night" && !app.showNightLines) continue;
    if (shape.kind === "bus" && !app.includeBus) continue;
    const base = shape.kind === "train" && night ? "#B0BEC5" : shape.color;
    const color = night ? lighten(base, 0.35) : base;
    const width = { tram: 5, train: 4, bus: 2.5, night: 2 }[shape.kind];
    const order = { bus: 2, night: 2, train: 6, tram: 8 }[shape.kind];
    addLine(lineGroup, shape.positions, color, width, { glow: night, order });
  }
  relief.add(lineGroup);
  buildVehicles();
  requestRender();
}

// --- Véhicules (illustratifs) -------------------------------------------------------

const SPEED = { bus: 330, tram: 370, train: 1000 }; // mètres par minute

function buildVehicles() {
  if (vehicles) {
    relief.remove(vehicles.mesh);
    vehicles.mesh.geometry.dispose();
    vehicles.mesh.material.dispose();
    vehicles = null;
  }
  if (!app.showVehicles) return updateLoop();
  const runs = [];
  for (const shape of app.shapes) {
    if (!shape.headway || shape.kind === "night" || (shape.kind === "bus" && !app.includeBus)) continue;
    const along = [0];
    for (let i = 1; i < shape.dense.length; i += 1) along.push(along[i - 1] + hypot(shape.dense[i - 1], shape.dense[i]));
    const length = along.at(-1);
    const speed = SPEED[shape.kind];
    const count = Math.ceil(length / speed / shape.headway);
    for (let k = 0; k < count; k += 1) runs.push({ shape, along, length, speed, offset: k * shape.headway * speed });
  }
  // Plafond : on garde d'abord tram et trains, puis les bus les plus proches du centre de la ville.
  runs.sort((a, b) => (a.shape.kind === "bus") - (b.shape.kind === "bus"));
  const kept = runs.slice(0, MAX_VEHICLES);
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: "#ffffff" }), kept.length);
  kept.forEach((run, i) => mesh.setColorAt(i, new THREE.Color(app.night ? "#fff3d6" : run.shape.color)));
  mesh.frustumCulled = false;
  relief.add(mesh);
  vehicles = { mesh, runs: kept, started: performance.now() };
  updateLoop();
}

const dummy = new THREE.Object3D();
function moveVehicles(now) {
  if (!vehicles) return;
  const minutes = (now - vehicles.started) / 1000; // 1 s à l'écran = 1 min
  const size = Math.max(5, camera.position.distanceTo(controls.target) * 0.0022);
  vehicles.runs.forEach((run, i) => {
    const s = (minutes * run.speed + run.offset) % (run.length + run.shape.headway * run.speed * 0.5);
    const { positions } = run.shape;
    let k = 1;
    while (k < run.along.length - 1 && run.along[k] < s) k += 1;
    if (s > run.length) {
      dummy.scale.setScalar(0.0001);
    } else {
      const f = (s - run.along[k - 1]) / Math.max(1e-6, run.along[k] - run.along[k - 1]);
      dummy.position.set(
        positions[(k - 1) * 3] + (positions[k * 3] - positions[(k - 1) * 3]) * f,
        positions[(k - 1) * 3 + 1] + (positions[k * 3 + 1] - positions[(k - 1) * 3 + 1]) * f + 6,
        positions[(k - 1) * 3 + 2] + (positions[k * 3 + 2] - positions[(k - 1) * 3 + 2]) * f,
      );
      dummy.scale.set(size, size / relief.scale.y, size);
    }
    dummy.updateMatrix();
    vehicles.mesh.setMatrixAt(i, dummy.matrix);
  });
  vehicles.mesh.instanceMatrix.needsUpdate = true;
}

// --- Itinéraire et repères ----------------------------------------------------------

function drawRoute() {
  relief.remove(routeGroup);
  disposeGroup(routeGroup);
  routeGroup = new THREE.Group();
  if (app.to && app.solution) {
    const itinerary = core.buildItinerary(app.model, app.data, app.solution, app.to.point, t);
    const points = [app.from.point, ...itinerary.chain.map((state) => app.data.stations[app.model.graph.station[state]].point), app.to.point];
    const dense = densify(points, 60);
    const heights = lineHeights(dense);
    const positions = [];
    dense.forEach(([x, y], i) => {
      const p = toScene(x, y, heights[i] + 14);
      positions.push(p.x, p.y, p.z);
    });
    addLine(routeGroup, positions, palette().route, 4, { halo: true, order: 20 });
  }
  relief.add(routeGroup);
}

const labels = {};
function label(key, text, color) {
  if (!labels[key]) {
    labels[key] = document.createElement("div");
    labels[key].className = "label-3d";
    $("labels3d").append(labels[key]);
  }
  labels[key].textContent = text;
  labels[key].style.borderLeft = `4px solid ${color}`;
  return labels[key];
}

function placeLabels() {
  const marks = [["from", app.from, t("departure"), palette().from]];
  if (app.to && Number.isFinite(app.toMinutes)) marks.push(["to", app.to, `${t("arrival")} · ${formatMinutes(app.toMinutes)}`, palette().to]);
  for (const key of ["from", "to"]) if (labels[key]) labels[key].hidden = true;
  for (const [key, mark, text, color] of marks) {
    if (!mark) continue;
    const element = label(key, text, color);
    const point = toScene(mark.point[0], mark.point[1], groundHeight(...mark.point) + 20);
    point.y *= relief.scale.y;
    point.project(camera);
    const visible = point.z < 1 && Math.abs(point.x) <= 1.1 && Math.abs(point.y) <= 1.1;
    element.hidden = !visible;
    element.style.left = `${((point.x + 1) / 2) * canvas.clientWidth}px`;
    element.style.top = `${((1 - point.y) / 2) * canvas.clientHeight}px`;
    mark.screen = visible ? [((point.x + 1) / 2) * canvas.clientWidth, ((1 - point.y) / 2) * canvas.clientHeight] : null;
  }
}

// --- Calcul -----------------------------------------------------------------------

function describePlace(point) {
  const stop = core.nearestStopName(app.data, point, 400);
  const commune = core.communeAt(app.data, point);
  return commune && commune !== CITY.name ? t("near_commune", {name: stop, commune}) : t("near", {name: stop});
}

function heatSource() {
  return app.heatFrom === "to" && app.to ? app.to : app.from;
}

function recompute({ fast = false } = {}) {
  if (!app.from) return;
  app.solution = app.model.solveFrom(app.from.point, { includeBus: app.includeBus });
  const source = heatSource();
  app.heatSolution = source === app.from ? app.solution : app.model.solveFrom(source.point, { includeBus: app.includeBus });
  app.grid = core.computeGrid(app.model, app.data, app.heatSolution);
  paintSurfaces({ fast });
  if (!fast) {
    drawRoute();
    updatePanel();
  }
  requestRender();
}

function setFrom(point, labelText = null, { fast = false } = {}) {
  if (!core.isOnLand(app.data, point)) return false;
  app.from = { point, label: labelText ?? describePlace(point) };
  recompute({ fast });
  if (!fast) syncUrl();
  return true;
}

function setTo(point, labelText = null, { quiet = false } = {}) {
  if (!core.isOnLand(app.data, point)) return false;
  app.to = { point, label: labelText ?? describePlace(point) };
  if (app.heatFrom === "to") recompute();
  else {
    drawRoute();
    updatePanel();
  }
  if (!quiet) syncUrl();
  requestRender();
  return true;
}

function setHeatFrom(source) {
  app.heatFrom = source === "to" && app.to ? "to" : "from";
  for (const button of $("heatFrom").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.source === app.heatFrom));
  recompute();
}

function routeLabel(routeId) {
  const info = app.data.routeInfo[routeId];
  return `${t(`mode_${info.mode}`)} ${info.name}`;
}

function updatePanel() {
  $("tripFrom").textContent = app.from?.label ?? t("empty");
  const result = $("tripResult");
  if (!app.to || !app.solution) {
    result.hidden = true;
    $("tripHint").hidden = false;
  } else {
    const itinerary = core.buildItinerary(app.model, app.data, app.solution, app.to.point, t);
    app.toMinutes = itinerary.minutes;
    result.hidden = false;
    $("tripHint").hidden = true;
    $("tripTo").textContent = app.to.label;
    $("tripDuration").textContent = formatMinutes(itinerary.minutes);
    $("tripSteps").replaceChildren(
      ...itinerary.steps
        .filter((step) => step.kind === "ride" || step.minutes >= 0.5)
        .map((step) => {
          const item = document.createElement("li");
          const badge = document.createElement("span");
          badge.className = "badge";
          if (step.kind === "ride") {
            const info = app.data.routeInfo[step.route];
            badge.textContent = info.name;
            badge.style.background = info.color;
            badge.style.color = contrastText(info.color);
            badge.title = info.longName || routeLabel(step.route);
          } else {
            badge.classList.add("walk");
            badge.textContent = t("walk");
          }
          const text = document.createElement("span");
          text.textContent = step.kind === "ride" ? t("wait", {text: step.text, minutes: Math.round(step.wait)}) : step.text;
          const minutes = document.createElement("span");
          minutes.className = "minutes";
          minutes.textContent = formatMinutes(step.minutes);
          item.append(badge, text, minutes);
          return item;
        }),
    );
  }
  if (app.heatSolution) {
    const source = heatSource();
    const rail = app.data.stations.map((station, index) => ({ station, index })).filter(({ station }) => station.rail);
    const reachable = rail.filter(({ station, index }) => Math.min(app.model.walkMinutes(hypot(source.point, station.point)), app.heatSolution.stationTime[index]) <= REACH_MINUTES).length;
    const percent = rail.length ? Math.round((reachable / rail.length) * 100) : 0;
    $("reach").textContent = t("reach", {percent, stations: CITY.railStations, minutes: REACH_MINUTES, where: t(source === app.from ? "reach_from" : "reach_to"),
      modes: app.includeBus ? `${CITY.railNoun} + ${CITY.busNoun}` : CITY.railNoun});
  }
}

function updateLegend() {
  const stops = core.PALETTE.map(([stop, [r, g, b]]) => `rgb(${r}, ${g}, ${b}) ${Math.round(stop * 100)}%`);
  $("legendBar").style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
  $("legendMid").textContent = t("minutes", {n: Math.round(app.maxMinutes / 2)});
  $("legendMax").textContent = t("minutes", {n: app.maxMinutes});
  $("maxValue").textContent = t("minutes", {n: app.maxMinutes});
}

// --- URL ----------------------------------------------------------------------------

function formatPair(point) {
  const { lat, lon } = toLatLon(point);
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

function parsePair(value) {
  const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(value || "");
  return match ? toWorld(Number(match[1]), Number(match[2])) : null;
}

function syncUrl() {
  const params = new URLSearchParams();
  if (app.from) params.set("from", formatPair(app.from.point));
  if (app.to) params.set("to", formatPair(app.to.point));
  if (app.to && app.heatFrom === "to") params.set("carte", "arrivee");
  if (!app.includeBus) params.set("bus", "0");
  if (!app.autoScale) {
    params.set("max", String(app.maxMinutes));
    params.set("iso", [...app.isochrones].sort((a, b) => a - b).join(",") || "0");
  }
  if (app.night) params.set("ambiance", "nuit");
  if (app.showNightLines) params.set("cn", "1");
  const query = params.toString().replaceAll("%2C", ",");
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
  for (const link of document.querySelectorAll("a[data-language], a[data-keep-state]")) link.search = location.search;
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  app.includeBus = params.get("bus") !== "0";
  $("busToggle").checked = app.includeBus;
  app.night = params.get("ambiance") === "nuit";
  app.showNightLines = params.get("cn") === "1";
  $("nightLinesToggle").checked = app.showNightLines;
  $("vehiclesToggle").checked = app.showVehicles;
  const max = Number(params.get("max"));
  if (params.has("max") || params.has("iso")) app.autoScale = false;
  if (max >= 20 && max <= SCALE_MAX && max % 5 === 0) app.maxMinutes = max;
  $("maxRange").max = String(SCALE_MAX);
  $("maxRange").value = String(app.maxMinutes);
  if (params.has("iso")) {
    app.isochrones = [...new Set(params.get("iso").split(",").map(Number))].filter((value) => ISOCHRONE_OPTIONS.includes(value));
  }
  for (const input of $("isoToggles").querySelectorAll("input")) input.checked = app.isochrones.includes(Number(input.value));
  updateLegend();
  setAmbiance(app.night, { quiet: true });
  const from = parsePair(params.get("from"));
  if (!from || !setFrom(from)) setFrom(toWorld(CITY.defaultFrom.lat, CITY.defaultFrom.lon), CITY.defaultFrom.label);
  const to = parsePair(params.get("to"));
  if (to && setTo(to, null, { quiet: true }) && params.get("carte") === "arrivee") setHeatFrom("to");
  syncUrl();
}

// --- Ambiance, échelle, rendu ---------------------------------------------------------

function setAmbiance(night, { quiet = false } = {}) {
  app.night = night;
  const colors = palette();
  scene.background = new THREE.Color(colors.background);
  scene.fog = new THREE.Fog(colors.background, 1, 2);
  stage.classList.toggle("night", night);
  // La nuit vient des couleurs de la texture, pas de l'éclairage : la carte des temps garde ses teintes.
  hemisphere.color.set(night ? "#dfe6ff" : "#ffffff");
  hemisphere.groundColor.set(night ? "#5a6070" : "#8a8f86");
  sun.color.set(night ? "#c9d6ff" : "#fff4e0");
  for (const button of $("ambiance").querySelectorAll("button")) button.setAttribute("aria-pressed", String((button.dataset.ambiance === "nuit") === night));
  for (const surface of surfaces) paintBase(surface);
  if (app.shapes) drawLines();
  paintSurfaces();
  drawRoute();
  if (!quiet) syncUrl();
}

function viewDistance() {
  return camera.position.distanceTo(controls.target);
}

const decimal = new Intl.NumberFormat(document.documentElement.lang, { maximumFractionDigits: 1 });

function smoothstep(a, b, x) {
  const k = core.clamp((x - a) / (b - a), 0, 1);
  return k * k * (3 - 2 * k);
}

/** Exagération du relief, brouillard et échelle des temps selon la distance de la caméra. */
function followCamera() {
  const distance = viewDistance();
  const exaggeration = 1.5 + smoothstep(3000, 12000, distance);
  relief.scale.y = exaggeration;
  const ground = (groundHeight(controls.target.x + origin[0], -controls.target.z + origin[1]) - BASE_HEIGHT) * exaggeration;
  const lift = ground - controls.target.y;
  if (Math.abs(lift) > 1) {
    controls.target.y += lift;
    camera.position.y += lift;
  }
  const below = (groundHeight(camera.position.x + origin[0], -camera.position.z + origin[1]) - BASE_HEIGHT) * exaggeration + 30 - camera.position.y;
  if (below > 0) camera.position.y += below;
  $("exaggeration").textContent = t("relief_exaggeration", {n: decimal.format(exaggeration)});
  const top = camera.position.y > 0 && Math.abs(camera.position.x - controls.target.x) + Math.abs(camera.position.z - controls.target.z) < distance * 0.05;
  scene.fog.near = top ? 1e9 : distance * 2.5;
  scene.fog.far = top ? 2e9 : distance * 6;
  if (app.autoScale && app.grid) {
    const visibleKm = (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect) / 1000;
    const k = core.clamp((visibleKm - 12) / (70 - 12), 0, 1);
    const max = Math.round((45 + k * 45) / 5) * 5;
    const isochrones = max < 60 ? [15, 30] : [30, 60];
    if (max !== app.maxMinutes || isochrones.join() !== app.isochrones.join()) {
      app.maxMinutes = max;
      app.isochrones = isochrones;
      $("maxRange").value = String(max);
      for (const input of $("isoToggles").querySelectorAll("input")) input.checked = isochrones.includes(Number(input.value));
      updateLegend();
      paintSurfaces();
    }
  }
}

let frameRequested = false;
let looping = false;
function renderFrame(now = performance.now()) {
  frameRequested = false;
  controls.update();
  followCamera();
  if (vehicles) moveVehicles(now);
  renderer.render(scene, camera);
  placeLabels();
}

function requestRender() {
  if (!renderer || frameRequested || looping) return;
  frameRequested = true;
  requestAnimationFrame(renderFrame);
}

function updateLoop() {
  const wanted = Boolean(vehicles && renderer) && !document.hidden;
  if (wanted === looping) return;
  looping = wanted;
  let last = 0;
  renderer.setAnimationLoop(wanted ? (now) => {
    if (now - last < 1000 / 30) return; // véhicules : 30 images par seconde suffisent
    last = now;
    renderFrame(now);
  } : null);
  if (!wanted) requestRender();
}

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  renderer.setPixelRatio(Math.min(devicePixelRatio, MOBILE ? 1.5 : 2));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  for (const material of lineMaterials) material.resolution.set(width, height);
  requestRender();
}

// --- Pointeur : clic sur le relief, glisser du départ ------------------------------------

/** Point du sol sous le pointeur : marche le long du rayon jusqu'à passer sous le relief, puis dichotomie. */
function groundAt(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin;
  const d = ray.ray.direction;
  const e = relief.scale.y;
  const above = (s) => {
    const x = o.x + d.x * s + origin[0];
    const y = -(o.z + d.z * s) + origin[1];
    return o.y + d.y * s - (groundHeight(x, y) - BASE_HEIGHT) * e;
  };
  const step = Math.max(15, viewDistance() / 400);
  let previous = 0;
  for (let s = step; s < 400000; s += step) {
    if (above(s) < 0) {
      let lo = previous;
      let hi = s;
      for (let k = 0; k < 20; k += 1) {
        const mid = (lo + hi) / 2;
        if (above(mid) < 0) hi = mid;
        else lo = mid;
      }
      return [o.x + d.x * hi + origin[0], -(o.z + d.z * hi) + origin[1]];
    }
    previous = s;
  }
  return null;
}

let press = null;
let dragFrame = 0;
canvas.addEventListener("pointerdown", (event) => {
  if (!app.data) return;
  const rect = canvas.getBoundingClientRect();
  const at = [event.clientX - rect.left, event.clientY - rect.top];
  const kind = event.pointerType === "touch" ? "touch" : "mouse";
  const onFrom = app.from?.screen && Math.hypot(at[0] - app.from.screen[0], at[1] - app.from.screen[1]) <= (kind === "touch" ? 30 : 18);
  press = { at, kind, moved: false, dragging: onFrom, button: event.button, start: { ...app.from } };
  if (onFrom) {
    controls.enabled = false;
    canvas.classList.add("dragging");
    canvas.setPointerCapture(event.pointerId);
  }
});

canvas.addEventListener("pointermove", (event) => {
  const rect = canvas.getBoundingClientRect();
  const at = [event.clientX - rect.left, event.clientY - rect.top];
  if (!press) {
    const over = app.from?.screen && Math.hypot(at[0] - app.from.screen[0], at[1] - app.from.screen[1]) <= 18;
    canvas.classList.toggle("over-marker", Boolean(over));
    return;
  }
  if (Math.hypot(at[0] - press.at[0], at[1] - press.at[1]) > CLICK_SLOP[press.kind]) press.moved = true;
  if (press.dragging && press.moved) {
    cancelAnimationFrame(dragFrame);
    const { clientX, clientY } = event;
    dragFrame = requestAnimationFrame(() => {
      const point = groundAt(clientX, clientY);
      if (point) setFrom(point, null, { fast: true });
    });
  }
});

/** Fin d'un glisser du départ : le point relâché devient le départ complet (panneau, itinéraire, URL) ;
 * hors du pays ou glisser annulé, le départ d'avant revient. */
function endDrag(event, cancelled) {
  controls.enabled = true;
  canvas.classList.remove("dragging");
  cancelAnimationFrame(dragFrame);
  const point = cancelled || !press.moved ? null : groundAt(event.clientX, event.clientY);
  if (point && setFrom(point)) return;
  if (point) toast(t(`point_outside_${CITY.areaKey}`));
  setFrom(press.start.point, press.start.label);
}

canvas.addEventListener("pointercancel", (event) => {
  if (press?.dragging) endDrag(event, true);
  press = null;
});

canvas.addEventListener("pointerup", (event) => {
  if (!press) return;
  const { dragging, moved, button } = press;
  if (dragging) {
    endDrag(event, false);
    press = null;
    return;
  }
  press = null;
  if (moved || button !== 0) return;
  const point = groundAt(event.clientX, event.clientY);
  if (!point || !setTo(point)) toast(t(`point_outside_${CITY.areaKey}`));
});

// --- Commandes --------------------------------------------------------------------------

$("busToggle").addEventListener("change", (event) => {
  if (!app.data) return;
  app.includeBus = event.target.checked;
  drawLines();
  recompute();
  syncUrl();
});

$("nightLinesToggle").addEventListener("change", (event) => {
  if (!app.data) return;
  app.showNightLines = event.target.checked;
  drawLines();
  syncUrl();
});

$("vehiclesToggle").addEventListener("change", (event) => {
  if (!app.data) return;
  app.showVehicles = event.target.checked;
  buildVehicles();
  requestRender();
});

$("isoToggles").addEventListener("change", () => {
  if (!app.data) return;
  app.autoScale = false;
  app.isochrones = [...$("isoToggles").querySelectorAll("input:checked")].map((input) => Number(input.value));
  paintSurfaces();
  syncUrl();
});

$("maxRange").addEventListener("input", (event) => {
  if (!app.data) return;
  app.autoScale = false;
  app.maxMinutes = Number(event.target.value);
  updateLegend();
  paintSurfaces();
  syncUrl();
});

$("ambiance").addEventListener("click", (event) => {
  if (!app.data) return;
  const value = event.target.closest("button")?.dataset.ambiance;
  if (value && (value === "nuit") !== app.night) setAmbiance(value === "nuit");
});

$("removeTo").addEventListener("click", () => {
  app.to = null;
  if (app.heatFrom === "to") setHeatFrom("from");
  drawRoute();
  updatePanel();
  syncUrl();
  requestRender();
});

$("heatFrom").addEventListener("click", (event) => {
  if (!app.data) return;
  const source = event.target.closest("button")?.dataset.source;
  if (source && source !== app.heatFrom) {
    setHeatFrom(source);
    syncUrl();
  }
});

$("topView").addEventListener("click", () => {
  if (!app.data) return;
  const distance = viewDistance();
  camera.position.set(controls.target.x, controls.target.y + distance, controls.target.z + 0.001);
  camera.up.set(0, 1, 0);
  controls.update();
  requestRender();
});

$("fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else stage.requestFullscreen?.().catch(() => {});
});

$("share").addEventListener("click", async () => {
  const url = location.href;
  if (navigator.share) {
    try {
      await navigator.share({ title: document.title, url });
      return;
    } catch {
      /* partage annulé : on retombe sur la copie */
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(t("link_copied"));
  } catch {
    toast(url);
  }
});

document.addEventListener("visibilitychange", () => updateLoop());

// Clavier, comme la 2D : les flèches déplacent la vue, Entrée pose l'arrivée au centre, Maj + Entrée le départ.
canvas.addEventListener("keydown", (event) => {
  if (!app.data) return;
  const forward = new THREE.Vector3().subVectors(controls.target, camera.position).setY(0);
  if (forward.lengthSq() < 1) forward.set(0, 0, -1);
  forward.normalize().multiplyScalar(viewDistance() * 0.08);
  const right = new THREE.Vector3(-forward.z, 0, forward.x);
  const moves = { ArrowUp: forward, ArrowDown: forward.clone().negate(), ArrowRight: right, ArrowLeft: right.clone().negate() };
  if (moves[event.key]) {
    camera.position.add(moves[event.key]);
    controls.target.add(moves[event.key]);
    requestRender();
  } else if (event.key === "Enter") {
    const rect = canvas.getBoundingClientRect();
    const centre = groundAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const placed = centre && (event.shiftKey ? setFrom(centre) : setTo(centre));
    if (!placed) toast(t(`point_outside_${CITY.areaKey}`));
  } else {
    return;
  }
  event.preventDefault();
});

// --- Recherche d'adresse (même logique que la 2D) ----------------------------------------

const searchInput = $("searchInput");
const searchResults = $("searchResults");
const searchStatus = $("searchStatus");
let searchTimer = null;
let searchController = null;

function searchStops(query) {
  const words = core.normalize(query).split(" ");
  return app.data.stations
    .filter((station) => station.rail && words.every((word) => core.normalize(station.name).includes(word)))
    .slice(0, 3)
    .map((station) => ({
      label: station.name,
      context: t("station_context", {lines: station.routes.filter((id) => app.data.routeInfo[id]?.rail).map((id) => routeLabel(id)).join(", ")}),
      point: station.point,
    }));
}

async function searchAddress(query) {
  const stops = searchStops(query);
  searchController?.abort();
  searchController = new AbortController();
  const params = new URLSearchParams({ query, limit: "6" });
  let payload = { features: [] };
  try {
    const response = await fetch(`${GEOCODER_URL}?${params}`, { signal: searchController.signal, referrerPolicy: "no-referrer", credentials: "omit" });
    payload = await response.json();
  } catch (error) {
    if (error.name === "AbortError" || !stops.length) throw error;
  }
  const aliases = { Adresse: "address", nom_de_rue: "street", Rue: "street", Commune: "locality", commune: "locality", localite: "locality", "Localité": "locality" };
  const addresses = (Array.isArray(payload?.features) ? payload.features : [])
    .map((feature) => {
      const coordinates = core.featureCentre(feature);
      if (!coordinates) return null;
      const [lon, lat] = coordinates;
      const name = feature.properties?.layer_name || "";
      const layer = Object.hasOwn(aliases, name) ? aliases[name] : name;
      const known = ["address", "street", "locality", "lieu_dit"].includes(layer);
      return { label: feature.properties?.label || "", context: known ? t(`layer_${layer}`) : layer, point: toWorld(lat, lon) };
    })
    .filter((result) => result && core.isOnLand(app.data, result.point));
  return [...stops, ...addresses].slice(0, 7);
}

function chooseResult(result) {
  searchResults.hidden = true;
  searchInput.value = result.label;
  if (!setFrom(result.point, result.label)) return;
  const target = toScene(result.point[0], result.point[1], groundHeight(...result.point));
  target.y *= relief.scale.y;
  const offset = camera.position.clone().sub(controls.target);
  controls.target.copy(target);
  camera.position.copy(target).add(offset);
  requestRender();
}

function showResults(results) {
  searchStatus.textContent = results.length ? "" : t("no_results");
  searchResults.replaceChildren(...results.map((result) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = result.label;
    const context = document.createElement("small");
    context.textContent = result.context;
    button.append(context);
    button.addEventListener("click", () => chooseResult(result));
    item.append(button);
    return item;
  }));
  searchResults.hidden = !results.length;
}

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  if (query.length < 3) {
    searchResults.hidden = true;
    searchStatus.textContent = "";
    return;
  }
  searchTimer = setTimeout(async () => {
    searchStatus.textContent = t("searching");
    try {
      showResults(await searchAddress(query));
    } catch (error) {
      if (error.name !== "AbortError") {
        searchResults.hidden = true;
        searchStatus.textContent = t("search_error");
      }
    }
  }, 250);
});

$("searchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = searchInput.value.trim();
  if (query.length < 3) return;
  try {
    const results = await searchAddress(query);
    if (results.length) chooseResult(results[0]);
    else toast(t(`address_outside_${CITY.areaKey}`));
  } catch (error) {
    if (error.name !== "AbortError") toast(t("search_error"));
  }
});

document.addEventListener("click", (event) => {
  if (!$("searchForm").contains(event.target)) searchResults.hidden = true;
});

// --- Démarrage ----------------------------------------------------------------------------

function cityLineChips() {
  $("cityLineChips").replaceChildren(...app.lines.lines.map((line) => {
    const badge = document.createElement("span");
    badge.className = "line-badge";
    badge.textContent = line.name;
    badge.style.background = line.color;
    badge.style.color = contrastText(line.color);
    if (line.night) badge.title = t("night_lines_note");
    return badge;
  }));
}

async function init() {
  if (!document.createElement("canvas").getContext("webgl2")) {
    fail(t("webgl_missing"));
    return;
  }
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, failIfMajorPerformanceCaveat: false });
  } catch {
    fail(t("webgl_missing"));
    return;
  }
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    renderer.setAnimationLoop(null);
    fail(t("context_lost"));
  });
  const load = (name, version) => fetch(dataUrl(name, version)).then((response) => {
    if (!response.ok) throw new Error(`${name}: ${response.status}`);
    return response.json();
  });
  const [data, lines, country, city] = await Promise.all([
    load(CITY.slug, CITY.dataVersion),
    load(`${CITY.slug}-lines`, CITY.linesVersion),
    load(`terrain/${CITY.slug}-country`, CITY.terrainVersions.country),
    load(`terrain/${CITY.slug}-city`, CITY.terrainVersions.city),
  ]);
  app.data = decode(data);
  app.model = createModel(app.data);
  app.lines = lines;
  app.terrain = { country: decodeTerrain(country), city: decodeTerrain(city) };
  const [left, bottom, right, top] = app.data.meta.bounds;
  origin = [(left + right) / 2, (bottom + top) / 2];

  // Textures : pays à environ 25 m par pixel, ville à 5 m (10 m sur mobile).
  const maxTexture = Math.min(renderer.capabilities.maxTextureSize, MOBILE ? 2048 : 3072);
  addSurface(app.data.meta.bounds, MOBILE ? 400 : 250, maxTexture, true, app.terrain.city.bounds);
  addSurface(app.terrain.city.bounds, MOBILE ? 50 : 30, Math.min(maxTexture, 2048), false);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.screenSpacePanning = false;
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.minDistance = 600;
  controls.maxDistance = 120000;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(80);
  controls.addEventListener("change", requestRender);
  const [vl, vb, vr, vt] = app.data.meta.viewBounds;
  const centre = [(vl + vr) / 2, (vb + vt) / 2];
  const target = toScene(centre[0], centre[1], groundHeight(...centre));
  controls.target.copy(target);
  camera.position.set(target.x - 2500, target.y + 9000, target.z + 9000);

  for (const surface of surfaces) paintBase(surface);
  prepareLines();
  cityLineChips();
  new ResizeObserver(resize).observe(canvas);
  resize();
  restoreFromUrl();
  for (const control of document.querySelectorAll("[data-needs-data]")) control.disabled = false;
  $("mapCard").setAttribute("aria-busy", "false");
}

init().catch((error) => {
  console.error(error);
  $("tripFrom").textContent = t("load_error");
  $("tripHint").textContent = t("load_retry");
  fail(`${t("load_error")} ${t("load_retry")}`);
});
