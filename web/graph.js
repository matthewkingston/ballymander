/* Data Zone adjacency graph — who borders whom.
 *
 * Mirrors scripts/dz_graph.py against the same artifact, so an answer in the
 * console and an answer in a build script cannot disagree:
 *   const g = await DZGraph.load('data/dz_adjacency.json');
 *   g.neighbours('N20001651')                    // ['N20001659']  Rathlin -> the ferry
 *   g.areNeighbours('N20003391', 'N20003778')    // true           Strangford Narrows
 *
 * Two zones are neighbours when they share a length of boundary, or when they
 * are one of the declared water crossings. Zones meeting at a single point are
 * not neighbours — see pointTouches().
 */
'use strict';

class DZGraph {
  constructor(doc) {
    this.meta = doc.meta;
    this.zones = doc.zones;
    this.edges = doc.edges;

    this._adj = new Map(doc.zones.map((code) => [code, new Set()]));
    this._edge = new Map();
    for (const edge of doc.edges) {
      this._adj.get(edge.a).add(edge.b);
      this._adj.get(edge.b).add(edge.a);
      this._edge.set(DZGraph._key(edge.a, edge.b), edge);
    }

    this._touch = new Map();
    for (const touch of doc.point_touches || []) {
      for (const [x, y] of [[touch.a, touch.b], [touch.b, touch.a]]) {
        if (!this._touch.has(x)) this._touch.set(x, new Set());
        this._touch.get(x).add(y);
      }
    }
  }

  static _key(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  _set(code) {
    const set = this._adj.get(code);
    if (!set) throw new Error(`unknown zone code ${code}`);
    return set;
  }

  neighbours(code) {
    return [...this._set(code)].sort();
  }

  areNeighbours(a, b) {
    return this._set(a).has(b);
  }

  degree(code) {
    return this._set(code).size;
  }

  /* The full edge record, or undefined if the two are not neighbours. */
  edge(a, b) {
    this._set(a);
    this._set(b);
    return this._edge.get(DZGraph._key(a, b));
  }

  /* Metres of shared boundary; 0 across a crossing, null if not neighbours. */
  sharedM(a, b) {
    const edge = this.edge(a, b);
    return edge ? edge.shared_m : null;
  }

  /* Zones meeting `code` at a single point only. Deliberately not neighbours. */
  pointTouches(code) {
    this._set(code);
    return [...(this._touch.get(code) || [])].sort();
  }

  static async load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`);
    return new DZGraph(await res.json());
  }
}
