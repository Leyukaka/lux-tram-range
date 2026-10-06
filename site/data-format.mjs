// Format 2 du fichier de données (meta.format = 2, voir build_data.py compact_network) : colonnes au lieu
// d'objets, arêtes à plat, cases repérées par leur rang dans la grille. decode() rend la forme d'origine, que
// site/app.js et tools/*.mjs utilisent tels quels.
export function decode(data) {
  if (data.meta.format !== 2) return data;
  const states = data.routeStates;
  data.routeStates = states.station.map((stationIndex, i) => ({
    stationIndex,
    routeId: data.routeIds[states.route[i]],
    wait: states.wait[i],
    access: states.access[i],
  }));
  data.adjacency = data.adjacency.map((flat) => {
    const edges = [];
    for (let i = 0; i < flat.length; i += 2) edges.push([flat[i], flat[i + 1]]);
    return edges;
  });
  const { bounds, gridCols: cols, gridRows: rows } = data.meta;
  const cellWidth = (bounds[2] - bounds[0]) / cols;
  const cellHeight = (bounds[3] - bounds[1]) / rows;
  const mask = new Array(cols * rows).fill(-1);
  data.cells = data.cells.index.map((index, i) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    mask[index] = i;
    const flat = data.cells.access[i];
    const access = [];
    for (let k = 0; k < flat.length; k += 2) access.push([flat[k], flat[k + 1]]);
    return { row, col, point: [bounds[0] + (col + 0.5) * cellWidth, bounds[1] + (row + 0.5) * cellHeight], access };
  });
  data.mask = mask;
  return data;
}
