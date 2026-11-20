/**
 * Vector slicing of a triangle mesh: plane cross-sections as polygons, and flat-level detection.
 */
import { difference, fillHoles, simplify, union, unionEvenOdd, type Pt, type Ring, type Shape } from './geom';

/** Simplification tolerance applied to every slice (mm). */
export const SLICE_TOL = 0.005;

/**
 * Cross-section of the mesh with the plane Z = z as a normalized shape (outers CCW, holes CW).
 * Segment endpoints are keyed by the mesh edge they lie on, so loops chain exactly.
 */
export function sliceMesh(pos: Float32Array | number[], z: number): Shape {
  const segs = new Map<string, string[]>();
  const pts = new Map<string, Pt>();
  const vkey = (i: number) => `${pos[i]},${pos[i + 1]},${pos[i + 2]}`;
  const edgePoint = (a: number, b: number): string => {
    const ka = vkey(a), kb = vkey(b);
    const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
    if (!pts.has(key)) {
      const za = pos[a + 2], zb = pos[b + 2];
      const t = (z - za) / (zb - za);
      pts.set(key, { x: pos[a] + (pos[b] - pos[a]) * t, y: pos[a + 1] + (pos[b + 1] - pos[a + 1]) * t });
    }
    return key;
  };
  const link = (p: string, q: string) => {
    if (p === q) return;
    (segs.get(p) ?? segs.set(p, []).get(p)!).push(q);
    (segs.get(q) ?? segs.set(q, []).get(q)!).push(p);
  };
  for (let t = 0; t < pos.length; t += 9) {
    const v = [t, t + 3, t + 6];
    const above = v.map((i) => pos[i + 2] > z);
    const n = above.filter(Boolean).length;
    if (n === 0 || n === 3) continue;
    // the lone vertex is on one side; the two crossing edges touch it
    const lone = above.findIndex((a) => (n === 1 ? a : !a));
    const o1 = v[(lone + 1) % 3], o2 = v[(lone + 2) % 3];
    link(edgePoint(v[lone], o1), edgePoint(v[lone], o2));
  }
  // chain into loops
  const used = new Set<string>();
  const loops: Ring[] = [];
  for (const start of segs.keys()) {
    if (used.has(start)) continue;
    const ring: Ring = [];
    let prev = '';
    let cur = start;
    for (;;) {
      used.add(cur);
      ring.push(pts.get(cur)!);
      const next = segs.get(cur)!.find((k) => k !== prev && !used.has(k));
      if (!next) break;
      prev = cur;
      cur = next;
    }
    if (ring.length >= 3) loops.push(ring);
  }
  return simplify(unionEvenOdd(loops), SLICE_TOL);
}

export interface Levels {
  top: number;
  bottom: number;
  /** Z of up-facing horizontal faces, descending (includes the top). */
  flats: number[];
  /** All distinct vertex Z values, ascending. */
  vertexZ: number[];
}

/** Detect horizontal up-facing faces (flat floors) and their Z values. */
export function detectLevels(pos: Float32Array | number[], minArea = 0.5): Levels {
  const areaByZ = new Map<number, number>();
  const vz = new Set<number>();
  let top = -Infinity, bottom = Infinity;
  for (let t = 0; t < pos.length; t += 9) {
    for (let k = 0; k < 3; k++) {
      const z = pos[t + k * 3 + 2];
      top = Math.max(top, z);
      bottom = Math.min(bottom, z);
      vz.add(Math.round(z * 1e4) / 1e4);
    }
    const ux = pos[t + 3] - pos[t], uy = pos[t + 4] - pos[t + 1], uz = pos[t + 5] - pos[t + 2];
    const wx = pos[t + 6] - pos[t], wy = pos[t + 7] - pos[t + 1], wz = pos[t + 8] - pos[t + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const L = Math.hypot(nx, ny, nz);
    if (L === 0 || nz / L < 0.9999) continue; // up-facing and horizontal only
    const z = Math.round(((pos[t + 2] + pos[t + 5] + pos[t + 8]) / 3) * 1e4) / 1e4;
    areaByZ.set(z, (areaByZ.get(z) ?? 0) + L / 2);
  }
  const flats = [...areaByZ].filter(([, a]) => a >= minArea).map(([z]) => z);
  flats.sort((a, b) => b - a);
  return { top, bottom, flats, vertexZ: [...vz].sort((a, b) => a - b) };
}

/**
 * 2.5D model: for any depth z, the region inside the part outline that can be cleared down to z
 * (no part material anywhere above z). Drafted walls are handled by keeping the union of the
 * cross-sections at every vertex height above z, so the widest point of each wall is respected.
 */
export class SlicedModel {
  readonly levels: Levels;
  /** Footprint of the whole part (union of all sections), including through-holes as holes. */
  readonly footprint: Shape;
  /** Footprint with holes filled: the outer outline(s). */
  readonly outline: Shape;
  private cache = new Map<number, Shape>();
  private sampleZ: number[];

  constructor(readonly pos: Float32Array | number[]) {
    this.levels = detectLevels(pos);
    const eps = 0.002;
    const zs = new Set<number>();
    const { vertexZ, top, bottom } = this.levels;
    for (let i = 0; i < vertexZ.length; i++) {
      const v = vertexZ[i];
      if (v - eps > bottom) zs.add(v - eps);
      if (v + eps < top) zs.add(v + eps);
      if (i + 1 < vertexZ.length) zs.add((v + vertexZ[i + 1]) / 2);
    }
    this.sampleZ = [...zs].sort((a, b) => b - a);
    this.footprint = union(this.sampleZ.flatMap((z) => this.slice(z)));
    this.outline = fillHoles(this.footprint);
  }

  slice(z: number): Shape {
    const k = Math.round(z * 1e5);
    let s = this.cache.get(k);
    if (!s) {
      s = sliceMesh(this.pos, z);
      this.cache.set(k, s);
    }
    return s;
  }

  /** Union of all part material strictly above z. */
  keepAbove(z: number): Shape {
    return union(this.sampleZ.filter((s) => s > z + 1e-6).flatMap((s) => this.slice(s)));
  }

  /** Region inside the outline that is clear of part material above z. */
  clearAt(z: number): Shape {
    return difference(this.outline, this.keepAbove(z));
  }
}
