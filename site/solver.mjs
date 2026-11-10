// Calcul des trajets, partagé par site/app.js et tools/*.mjs : les contrôles testent ainsi le code livré.
// createModel(data) prend les données décodées (data-format.mjs) et rend la marche (ponts compris) et les plus
// courts chemins depuis un point.

export const hypot = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// --- Cours d'eau --------------------------------------------------------------
// Les grands cours d'eau (Loire, Garonne, Rhône…) ne se traversent à pied que par un pont : une marche dont la ligne
// droite en coupe un passe par le meilleur pont (un seul : une île se rejoint par ses arrêts). Même règle que build_data.py.

const RIVER_BUCKET = 500;
const MAX_BRIDGE_WALK_METERS = 3000;

function riverKeys(a, b, visit) {
  for (let gx = Math.floor(Math.min(a[0], b[0]) / RIVER_BUCKET); gx <= Math.floor(Math.max(a[0], b[0]) / RIVER_BUCKET); gx += 1) {
    for (let gy = Math.floor(Math.min(a[1], b[1]) / RIVER_BUCKET); gy <= Math.floor(Math.max(a[1], b[1]) / RIVER_BUCKET); gy += 1) {
      if (visit(`${gx},${gy}`)) return true;
    }
  }
  return false;
}

function indexRivers(lines) {
  const buckets = new Map();
  for (const line of lines ?? []) {
    for (let i = 1; i < line.length; i += 1) {
      const segment = [line[i - 1], line[i]];
      riverKeys(segment[0], segment[1], (key) => {
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(segment);
      });
    }
  }
  return buckets;
}

function side(p, q, r) {
  return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
}

// --- Graphe du réseau ---------------------------------------------------------

class MinHeap {
  constructor() {
    this.keys = [];
    this.values = [];
  }

  get size() {
    return this.keys.length;
  }

  push(key, value) {
    const { keys, values } = this;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  pop() {
    const { keys, values } = this;
    const top = values[0];
    const lastKey = keys.pop();
    const lastValue = values.pop();
    if (keys.length) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= keys.length) break;
        if (child + 1 < keys.length && keys[child + 1] < keys[child]) child += 1;
        if (keys[child] >= lastKey) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = lastKey;
      values[i] = lastValue;
    }
    return top;
  }
}

function prepareGraph(data) {
  const count = data.routeStates.length;
  const offsets = new Int32Array(count + 1);
  data.adjacency.forEach((edges, i) => {
    offsets[i + 1] = offsets[i] + edges.length;
  });
  const targets = new Int32Array(offsets[count]);
  const weights = new Float32Array(offsets[count]);
  data.adjacency.forEach((edges, i) => {
    edges.forEach(([target, weight], k) => {
      targets[offsets[i] + k] = target;
      weights[offsets[i] + k] = weight;
    });
  });
  return {
    count,
    offsets,
    targets,
    weights,
    station: Int32Array.from(data.routeStates, (state) => state.stationIndex),
    wait: Float32Array.from(data.routeStates, (state) => state.wait),
    // Accès au quai (escaliers, couloirs du métro), compté à l'entrée comme à la sortie.
    access: Float32Array.from(data.routeStates, (state) => state.access),
    route: data.routeStates.map((state) => state.routeId),
    isBus: Uint8Array.from(data.routeStates, (state) => (data.routeInfo[state.routeId]?.rail ? 0 : 1)),
  };
}

export function createModel(data) {
  const graph = prepareGraph(data);
  const rivers = indexRivers(data.rivers);

  function walkMinutes(meters) {
    return meters / data.meta.walkMetersPerMinute;
  }

  function crossesRiver(a, b) {
    if (!rivers.size) return false;
    return riverKeys(a, b, (key) =>
      (rivers.get(key) ?? []).some(([c, d]) => side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0),
    );
  }

  /** Distance de marche en mètres : en ligne droite, ou par un pont ; infinie sans pont praticable. */
  function walkMeters(a, b) {
    const straight = hypot(a, b);
    if (!crossesRiver(a, b)) return straight;
    // Le plus court détour d'abord : le premier pont dont les deux tronçons restent sur leur rive est le meilleur.
    const detours = [];
    for (const [endA, endB, length] of data.bridges ?? []) {
      detours.push([hypot(a, endA) + length + hypot(endB, b), endA, endB], [hypot(a, endB) + length + hypot(endA, b), endB, endA]);
    }
    detours.sort((x, y) => x[0] - y[0]);
    // Au-delà de 3 km (40 min), marcher n'est jamais le meilleur choix : inutile de tester les ponts lointains.
    const found = detours.find(([meters, near, far]) => meters <= MAX_BRIDGE_WALK_METERS && !crossesRiver(a, near) && !crossesRiver(far, b));
    return found ? found[0] : Infinity;
  }

  /** Plus courts chemins depuis un point : temps d'arrivée à chaque arrêt + prédécesseurs. */
  function solveFrom(point, { includeBus = true } = {}) {
    const dist = new Float64Array(graph.count).fill(Infinity);
    const prev = new Int32Array(graph.count).fill(-1);
    const seedWalk = new Float64Array(graph.count);
    const heap = new MinHeap();

    // Les arrêts les plus proches à vol d'oiseau, puis leur vraie distance à pied (détour par un pont).
    const seeds = data.stations
      .map((station, index) => ({ index, walk: walkMinutes(hypot(point, station.point)) }))
      .filter((seed) => includeBus || data.stations[seed.index].rail)
      .sort((a, b) => a.walk - b.walk)
      .slice(0, data.meta.originStationCount * 4)
      .map((seed) => ({ index: seed.index, walk: walkMinutes(walkMeters(point, data.stations[seed.index].point)) }))
      .filter((seed) => Number.isFinite(seed.walk))
      .sort((a, b) => a.walk - b.walk)
      .slice(0, data.meta.originStationCount);

    for (const seed of seeds) {
      for (const state of data.stationStates[seed.index]) {
        if (!includeBus && graph.isBus[state]) continue;
        const walk = seed.walk + graph.access[state];
        const time = walk + graph.wait[state];
        if (time < dist[state]) {
          dist[state] = time;
          seedWalk[state] = walk;
          heap.push(time, state);
        }
      }
    }

    while (heap.size) {
      const state = heap.pop();
      const base = dist[state];
      for (let e = graph.offsets[state]; e < graph.offsets[state + 1]; e += 1) {
        const next = graph.targets[e];
        if (!includeBus && graph.isBus[next]) continue;
        const time = base + graph.weights[e];
        if (time < dist[next]) {
          dist[next] = time;
          prev[next] = state;
          heap.push(time, next);
        }
      }
    }

    const stationTime = new Float64Array(data.stations.length).fill(Infinity);
    const stationBest = new Int32Array(data.stations.length).fill(-1);
    // Temps pour ressortir dans la rue à chaque arrêt (le métro demande de remonter du quai).
    for (let state = 0; state < graph.count; state += 1) {
      const station = graph.station[state];
      const out = dist[state] + graph.access[state];
      if (out < stationTime[station]) {
        stationTime[station] = out;
        stationBest[station] = state;
      }
    }
    return { point, dist, prev, seedWalk, stationTime, stationBest };
  }

  /** Meilleur temps vers un point quelconque : à pied direct, ou via l'arrêt le plus favorable. */
  function travelTo(solution, point) {
    const direct = walkMinutes(walkMeters(solution.point, point));
    let best = { minutes: direct, station: -1, walk: direct };
    data.stations.forEach((station, index) => {
      const arrival = solution.stationTime[index];
      // La vraie distance (pont), plus coûteuse, seulement pour un arrêt qui peut améliorer le trajet.
      if (!Number.isFinite(arrival) || arrival + walkMinutes(hypot(station.point, point)) >= best.minutes) return;
      const walk = walkMinutes(walkMeters(station.point, point));
      if (arrival + walk < best.minutes) best = { minutes: arrival + walk, station: index, walk };
    });
    return best;
  }

  /** États parcourus jusqu'à un arrêt, du premier embarquement à la descente. */
  function chainTo(solution, station) {
    const chain = [];
    for (let state = solution.stationBest[station]; state !== -1; state = solution.prev[state]) chain.push(state);
    return chain.reverse();
  }

  return { graph, walkMinutes, walkMeters, solveFrom, travelTo, chainTo };
}
