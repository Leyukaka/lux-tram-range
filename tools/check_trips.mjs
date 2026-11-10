import fs from "fs";
import { decode } from "../site/data-format.mjs";
import { createModel } from "../site/solver.mjs";
// Sondage des trajets : temps depuis le centre jusqu'aux terminus et aux gares, avec la vitesse porte à porte.
// Usage : node tools/check_trips.mjs <carte>
// Une vitesse anormale est signalée par "!" ; les trajets de référence ("checks" de la config) hors fourchette
// font échouer le script (code de sortie 1).
const slug = process.argv[2] || "luxembourg";
const d = decode(JSON.parse(fs.readFileSync(`site/data/${slug}.json`)));
const city = JSON.parse(fs.readFileSync(`cities/${slug}.json`));
const rs = d.routeStates, st = d.stations, ri = d.routeInfo, rail = (r) => ri[r].rail;
// Vitesse maximale crédible porte à porte, selon le mode le plus rapide emprunté.
const MAX_KMH = { train: 90, tram: 35, funicular: 35, metro: 35 };
const hyp = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const m = 111320, toW = (lat, lon) => [lon * m * Math.cos(d.meta.lat0 * Math.PI / 180), lat * m];
const origin = toW(city.defaultFrom.lat, city.defaultFrom.lon);
// Le solveur du site (site/solver.mjs), réseau ferré seulement.
const model = createModel(d);
const sol = model.solveFrom(origin, { includeBus: false });
const out = sol.stationTime;
const pathOf = (i) => { const lines = [], modes = new Set(); for (const k of model.chainTo(sol, i)) { const info = ri[rs[k].routeId]; modes.add(info.mode); if (lines.at(-1) !== info.name) lines.push(info.name); } return { lines, modes }; };
// Cibles : terminus de chaque ligne ferrée (stations les plus éloignées) et stations nommées "Gare".
const targets = new Map();
for (const [id, info] of Object.entries(ri)) { if (!info.rail) continue;
  const sts = [...new Set(rs.filter((r) => r.routeId === id).map((r) => r.stationIndex))];
  let a = sts[0], bb = sts[0], md = 0; for (const i of sts) for (const j of sts) { const dd = hyp(st[i].point, st[j].point); if (dd > md) { md = dd; a = i; bb = j; } }
  targets.set(a, `terminus ${info.name}`); targets.set(bb, `terminus ${info.name}`); }
st.forEach((s, i) => { if (s.rail && /^gare\b|gare\b/i.test(s.name) && !targets.has(i)) targets.set(i, "gare"); });
const rows = [];
let warnings = 0;
for (const [i, why] of targets) { const t = out[i]; const km = hyp(origin, st[i].point) / 1000; const kmh = km / (t / 60);
  const { lines, modes } = pathOf(i);
  const max = Math.max(35, ...[...modes].map((mode) => MAX_KMH[mode] || 35));
  const flag = !isFinite(t) ? "  ! INJOIGNABLE" : (kmh < 8 && km > 2) || kmh > max ? "  ! vitesse" : "";
  if (flag) warnings++;
  rows.push(`  ${st[i].name.slice(0, 34).padEnd(34)} ${why.padEnd(12)} ${km.toFixed(1).padStart(5)} km ${isFinite(t) ? t.toFixed(0).padStart(3) : "  -"} min ${isFinite(kmh) ? kmh.toFixed(0).padStart(3) : "  -"} km/h [${lines.join(">")}]${flag}`); }
console.log(`== ${city.name} (depuis ${city.defaultFrom.label})`); console.log(rows.join("\n"));
// Trajets de référence (exigence R14.3).
let failures = 0;
for (const check of city.checks || []) {
  const i = st.findIndex((s) => s.name === check.station);
  const t = i < 0 ? NaN : out[i];
  const ok = t >= check.min && t <= check.max;
  if (!ok) failures++;
  console.log(`${ok ? "ok " : "KO "} ${check.station} : ${isFinite(t) ? t.toFixed(1) : "introuvable"} min (attendu ${check.min} à ${check.max}) [${i < 0 ? "" : pathOf(i).lines.join(">")}]`);
}
console.log(`${warnings} alerte(s) de vitesse, ${failures} trajet(s) de référence hors fourchette`);
process.exit(failures ? 1 : 0);
