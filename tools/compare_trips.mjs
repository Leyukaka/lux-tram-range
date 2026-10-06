import fs from "fs";
// Comparaison des temps du modèle avec des calculateurs d'itinéraire (mobiliteit.lu, Google Maps).
// Usage : node tools/compare_trips.mjs [carte]   (carte par défaut : luxembourg)
//
// Le modèle donne un temps moyen : marche, attente égale à la moitié de l'intervalle, trajet. Un calculateur donne
// des correspondances à heure fixe. Pour comparer, chaque relevé de docs/benchmark/references.json liste les
// correspondances (départ, arrivée) autour de la fenêtre : on en déduit le temps moyen porte à porte d'un voyageur
// qui se présente à une minute quelconque de la fenêtre (attente comprise), comme le modèle.
const slug = process.argv[2] || "luxembourg";
const d = JSON.parse(fs.readFileSync(`site/data/${slug}.json`));
const bench = JSON.parse(fs.readFileSync("docs/benchmark/trips.json"));
const refs = fs.existsSync("docs/benchmark/references.json") ? JSON.parse(fs.readFileSync("docs/benchmark/references.json")) : {};
const rs = d.routeStates, st = d.stations, ri = d.routeInfo;
const W = d.meta.walkMetersPerMinute, N = d.meta.originStationCount;
const hyp = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const m = 111320, toW = (lat, lon) => [lon * m * Math.cos(d.meta.lat0 * Math.PI / 180), lat * m];

// Même modèle que site/app.js (bus compris), sans le détour par les ponts : les trajets du banc partent d'un arrêt.
function solve(origin, bus = true) {
  const usable = (k) => bus || ri[rs[k].routeId].rail;
  const dist = new Float64Array(rs.length).fill(Infinity), prev = new Int32Array(rs.length).fill(-1);
  const seeds = st.map((s, i) => [hyp(origin, s.point) / W, i]).sort((a, b) => a[0] - b[0]).slice(0, N);
  for (const [walk, i] of seeds) for (const k of d.stationStates[i]) if (usable(k)) dist[k] = Math.min(dist[k], walk + rs[k].access + rs[k].wait);
  const done = new Uint8Array(rs.length);
  // Tas binaire minimal : 16 000 états sur la carte du pays.
  const heap = [];
  const push = (v, k) => { heap.push([v, k]); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < heap.length && heap[l][0] < heap[s][0]) s = l; if (r < heap.length && heap[r][0] < heap[s][0]) s = r; if (s === i) break; [heap[s], heap[i]] = [heap[i], heap[s]]; i = s; } } return top; };
  dist.forEach((v, k) => { if (isFinite(v)) push(v, k); });
  while (heap.length) {
    const [v, u] = pop();
    if (done[u] || v > dist[u]) continue;
    done[u] = 1;
    for (const [t, w] of d.adjacency[u]) if (usable(t) && v + w < dist[t]) { dist[t] = v + w; prev[t] = u; push(dist[t], t); }
  }
  return { dist, prev };
}

function travel(from, to, bus = true) {
  const origin = toW(from.lat, from.lon), target = toW(to.lat, to.lon);
  const { dist, prev } = solve(origin, bus);
  let best = hyp(origin, target) / W, bestState = -1;
  const near = st.map((s, i) => [hyp(target, s.point), i]).sort((a, b) => a[0] - b[0]).slice(0, N);
  for (const [meters, i] of near) for (const k of d.stationStates[i]) {
    const t = dist[k] + rs[k].access + meters / W;
    if (t < best) { best = t; bestState = k; }
  }
  const lines = [];
  for (let k = bestState; k !== -1; k = prev[k]) { const name = ri[rs[k].routeId].name; if (lines[0] !== name) lines.unshift(name); }
  return { minutes: best, lines: lines.length ? lines.join(">") : "à pied" };
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
