/**
 * Vector slicing of a triangle mesh: plane cross-sections as polygons, and flat-level detection.
 */
import { difference, fillHoles, simplify, union, unionEvenOdd, unionMany, type Pt, type Ring, type Shape } from './geom';

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
 * (no part material anywhere above z).
 *
 * The material above z, seen from above, is exactly the union of the up-facing triangles clipped to
 * Z > z and projected onto XY (every vertical line through a closed solid leaves it through an
 * up-facing face). That handles drafted and curved walls exactly, needs no per-height slicing, and
 * lets each depth build on the result for the depth above it.
 */
export class SlicedModel {
  readonly levels: Levels;
  /** Footprint of the whole part (shadow from above), including through-holes as holes. */
  readonly footprint: Shape;
  /** Footprint with holes filled: the outer outline(s). */
  readonly outline: Shape;
  /** Up-facing triangles as [x0,y0,z0, x1,y1,z1, x2,y2,z2], sorted by max Z descending. */
  private up: Float64Array;
  private upMaxZ: Float64Array;
  /** keepAbove results, keyed by depth (descending order of computation is not required). */
  private above: { z: number; shape: Shape; n: number }[] = [];

  constructor(readonly pos: Float32Array | number[]) {
    this.levels = detectLevels(pos);
    const tris: { k: number; maxZ: number }[] = [];
    for (let t = 0; t < pos.length; t += 9) {
      const ux = pos[t + 3] - pos[t], uy = pos[t + 4] - pos[t + 1];
      const wx = pos[t + 6] - pos[t], wy = pos[t + 7] - pos[t + 1];
      if (ux * wy - uy * wx <= 1e-12) continue; // down-facing or vertical: no new shadow
      tris.push({ k: t, maxZ: Math.max(pos[t + 2], pos[t + 5], pos[t + 8]) });
    }
    tris.sort((a, b) => b.maxZ - a.maxZ);
    this.up = new Float64Array(tris.length * 9);
    this.upMaxZ = new Float64Array(tris.length);
    tris.forEach(({ k, maxZ }, i) => {
      for (let j = 0; j < 9; j++) this.up[i * 9 + j] = pos[k + j];
      this.upMaxZ[i] = maxZ;
    });
    this.footprint = this.keepAbove(this.levels.bottom - 1);
    this.outline = fillHoles(this.footprint);
  }

  /** Cross-section at Z = z. */
  slice(z: number): Shape {
    return sliceMesh(this.pos, z);
  }

  /** Union of all part material strictly above z (projected to XY). */
  keepAbove(z: number): Shape {
    const zc = z + ABOVE_EPS; // material within float/rounding noise of a floor belongs to the floor
    const hit = this.above.find((a) => Math.abs(a.z - zc) < 1e-9);
    if (hit) return hit.shape;
    // start from the deepest already-computed depth above this one
    let base: { z: number; shape: Shape; n: number } | undefined;
    for (const a of this.above) if (a.z > zc && (!base || a.z < base.z)) base = a;
    // triangles reaching above zc; those fully above base.z are already in base.shape
    let n = 0;
    while (n < this.upMaxZ.length && this.upMaxZ[n] > zc) n++;
    const pieces: Ring[] = [];
    const u = this.up;
    for (let i = 0; i < n; i++) {
      const o = i * 9;
      const minZ = Math.min(u[o + 2], u[o + 5], u[o + 8]);
      if (base && i < base.n && minZ >= base.z) continue;
      const ring = clipAbove(u, o, zc);
      if (ring.length >= 3) pieces.push(ring);
    }
    let shape = base ? union(base.shape, unionMany(pieces)) : unionMany(pieces);
    shape = simplify(shape, SLICE_TOL);
    this.above.push({ z: zc, shape, n });
    return shape;
  }

  /** Region inside the outline that is clear of part material above z. */
  clearAt(z: number): Shape {
    return difference(this.outline, this.keepAbove(z));
  }
}

/** Material closer than this above a depth counts as that depth's floor (mm). */
const ABOVE_EPS = 0.002;

/** Part of triangle u[o..o+9] with Z > z, projected to XY (CCW for an up-facing triangle). */
function clipAbove(u: Float64Array, o: number, z: number): Ring {
  const out: Pt[] = [];
  for (let k = 0; k < 3; k++) {
    const a = o + k * 3, b = o + ((k + 1) % 3) * 3;
    const za = u[a + 2], zb = u[b + 2];
    if (za > z) out.push({ x: u[a], y: u[a + 1] });
    if (za > z !== zb > z) {
      const t = (z - za) / (zb - za);
      out.push({ x: u[a] + (u[b] - u[a]) * t, y: u[a + 1] + (u[b + 1] - u[a + 1]) * t });
    }
  }
  return out;
}
