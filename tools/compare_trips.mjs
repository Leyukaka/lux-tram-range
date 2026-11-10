import fs from "fs";
import { decode } from "../site/data-format.mjs";
import { createModel } from "../site/solver.mjs";
// Comparaison des temps du modèle avec des calculateurs d'itinéraire (mobiliteit.lu, Google Maps).
// Usage : node tools/compare_trips.mjs [carte]   (carte par défaut : luxembourg)
//
// Le modèle donne un temps moyen : marche, attente égale à la moitié de l'intervalle, trajet. Un calculateur donne
// des correspondances à heure fixe. Pour comparer, chaque relevé de docs/benchmark/references.json liste les
// correspondances (départ, arrivée) autour de la fenêtre : on en déduit le temps moyen porte à porte d'un voyageur
// qui se présente à une minute quelconque de la fenêtre (attente comprise), comme le modèle.
const slug = process.argv[2] || "luxembourg";
const d = decode(JSON.parse(fs.readFileSync(`site/data/${slug}.json`)));
const bench = JSON.parse(fs.readFileSync("docs/benchmark/trips.json"));
const refs = fs.existsSync("docs/benchmark/references.json") ? JSON.parse(fs.readFileSync("docs/benchmark/references.json")) : {};
const rs = d.routeStates, st = d.stations, ri = d.routeInfo;
const m = 111320, toW = (lat, lon) => [lon * m * Math.cos(d.meta.lat0 * Math.PI / 180), lat * m];

// Le solveur du site (site/solver.mjs), bus compris, ponts compris.
const model = createModel(d);
function travel(from, to, bus = true) {
  const origin = toW(from.lat, from.lon), target = toW(to.lat, to.lon);
  const solution = model.solveFrom(origin, { includeBus: bus });
  const best = model.travelTo(solution, target);
  const lines = [];
  if (best.station !== -1) for (const k of model.chainTo(solution, best.station)) { const name = ri[rs[k].routeId].name; if (lines.at(-1) !== name) lines.push(name); }
  return { minutes: best.minutes, lines: lines.length ? lines.join(">") : "à pied" };
}

const minutes = (hhmm) => { const [h, mm] = hhmm.split(":").map(Number); return h * 60 + mm; };
// Temps moyen porte à porte sur la fenêtre, pour un départ uniforme à la minute près.
function expected(connections, [start, end]) {
  const list = connections.map(([dep, arr]) => [minutes(dep), minutes(arr) + (minutes(arr) < minutes(dep) ? 1440 : 0)]);
  let sum = 0, count = 0;
  for (let t = minutes(start); t < minutes(end); t++) {
    const options = list.filter(([dep]) => dep >= t).map(([, arr]) => arr - t);
    if (!options.length) return NaN; // relevé trop court pour couvrir la fenêtre
    sum += Math.min(...options); count++;
  }
  return sum / count;
}

const sources = [...new Set(Object.values(refs).flatMap((byTrip) => Object.keys(byTrip)))].sort();
const rows = [];
for (const trip of bench.trips) {
  const model = travel(trip.from, trip.to);
  const row = { id: trip.id, model: model.minutes, lines: model.lines };
  for (const source of sources) {
    const conns = refs[trip.id]?.[source];
    row[source] = conns ? expected(conns, bench.window) : NaN;
  }
  rows.push(row);
}
const fmt = (v) => (isFinite(v) ? v.toFixed(0).padStart(4) : "   -");
const delta = (a, b) => (isFinite(a) && isFinite(b) ? `${a - b >= 0 ? "+" : ""}${(a - b).toFixed(0)}`.padStart(5) : "    -");
console.log(`Carte ${slug}, fenêtre ${bench.window.join("-")} du ${bench.date}, minutes porte à porte (arrêt à arrêt)`);
console.log(`${"trajet".padEnd(22)} modèle ${sources.map((s) => `${s.padStart(10)}  écart`).join(" ")}  lignes (modèle)`);
for (const row of rows) {
  console.log(`${row.id.padEnd(22)} ${fmt(row.model)}   ${sources.map((s) => `${fmt(row[s]).padStart(10)} ${delta(row.model, row[s])}`).join(" ")}  ${row.lines}`);
}
for (const source of sources) {
  const diffs = rows.filter((r) => isFinite(r[source])).map((r) => r.model - r[source]);
  if (!diffs.length) continue;
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const mae = diffs.reduce((a, b) => a + Math.abs(b), 0) / diffs.length;
  console.log(`${source} : ${diffs.length} trajets, écart moyen ${mean >= 0 ? "+" : ""}${mean.toFixed(1)} min, écart absolu moyen ${mae.toFixed(1)} min`);
}
