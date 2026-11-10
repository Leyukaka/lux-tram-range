// Formats compacts du fichier de données (meta.format, voir build_data.py compact_network). decode() rend la forme
// d'origine, que site/app.js, site/solver.mjs et tools/*.mjs utilisent telle quelle. Le format 2 reste lu : une page
// encore en cache peut demander l'ancien fichier juste après un déploiement.
export function decode(data) {
  const format = data.meta.format;
  if (format !== 2 && format !== 3) throw new Error(`Format de données inconnu : ${format}`);
  const states = data.routeStates;
  data.routeStates = states.station.map((stationIndex, i) => ({
    stationIndex,
    routeId: data.routeIds[states.route[i]],
    wait: states.wait[i],
    access: states.access[i],
  }));
  const { bounds, gridCols: cols, gridRows: rows } = data.meta;
  const cellWidth = (bounds[2] - bounds[0]) / cols;
  const cellHeight = (bounds[3] - bounds[1]) / rows;
  const cellAt = (index, access) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    return { row, col, point: [bounds[0] + (col + 0.5) * cellWidth, bounds[1] + (row + 0.5) * cellHeight], access };
  };
  return format === 2 ? decodeTwo(data, cellAt) : decodeThree(data, cellAt);
}

function pairs(flat) {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

function decodeTwo(data, cellAt) {
  data.adjacency = data.adjacency.map(pairs);
  data.cells = data.cells.index.map((index, i) => cellAt(index, pairs(data.cells.access[i])));
  return data;
}

// Ligne ou anneau au mètre, en écarts : [x0, y0, dx1, dy1, ...].
function ring(flat) {
  const out = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < flat.length; i += 2) {
    x += flat[i];
    y += flat[i + 1];
    out.push([x, y]);
  }
  return out;
}

const polygons = (list) => list.map((polygon) => polygon.map(ring));

function decodeThree(data, cellAt) {
  data.stationStates = data.stations.map(() => []);
  data.routeStates.forEach((state, i) => data.stationStates[state.stationIndex].push(i));

  const { targets, weights } = data.adjacency;
  data.adjacency = targets.map((row, source) => {
    const edges = [];
    let target = source;
    for (let k = 0; k < row.length; k += 1) {
      target += row[k];
      edges.push([target, weights[source][k] / 10]);
    }
    return edges;
  });

  // Marche vers les arrêts d'une case : la ligne droite depuis son centre, sauf les détours par un pont fournis.
  const { runs, stops, bridged } = data.cells;
  const bridgedMeters = new Map();
  for (let i = 0; i < bridged.length; i += 3) bridgedMeters.set(`${bridged[i]},${bridged[i + 1]}`, bridged[i + 2]);
  data.cells = [];
  let index = -1;
  for (let r = 0; r < runs.length; r += 2) {
    index += runs[r];
    for (let k = 0; k < runs[r + 1]; k += 1) {
      index += 1;
      const i = data.cells.length;
      const cell = cellAt(index, null);
      cell.access = stops[i].map((station, rank) => {
        const point = data.stations[station].point;
        const meters = bridgedMeters.get(`${i},${rank}`) ?? Math.round(Math.hypot(cell.point[0] - point[0], cell.point[1] - point[1]));
        return [station, meters];
      });
      data.cells.push(cell);
    }
  }

  for (const area of [...data.boroughs, ...(data.arrondissements ?? [])]) {
    area.polygons = polygons(area.polygons);
    area.outline = area.polygons.map((polygon) => polygon[0]);
  }
  data.context = polygons(data.context);
  data.water = polygons(data.water);
  data.parks = polygons(data.parks);
  for (const route of data.routes) route.points = ring(route.points);
  return data;
}
