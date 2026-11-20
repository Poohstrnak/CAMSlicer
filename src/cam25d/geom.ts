/**
 * Polygon geometry in millimetres on top of Clipper2 (integer coordinates internally).
 * A "Shape" is a set of closed rings with Clipper orientation: outers CCW, holes CW.
 */
import { Clipper, EndType, FillRule, JoinType, type Path64, type Paths64 } from 'clipper2-ts';

export type Pt = { x: number; y: number };
export type Ring = Pt[];
export type Shape = Ring[];

/** 1 unit = 0.1 µm. */
const S = 10000;
/** Default arc tolerance for round offsets (mm). Fine enough that arcs can be refitted within 0.01 mm. */
export const ARC_TOL = 0.002;

function toPaths(shape: Shape): Paths64 {
  const out: Paths64 = [];
  for (const r of shape) {
    if (r.length < 3) continue;
    const p: Path64 = r.map((q) => ({ x: Math.round(q.x * S), y: Math.round(q.y * S) }));
    out.push(p);
  }
  return out;
}

function fromPaths(paths: Paths64): Shape {
  const out: Shape = [];
  for (const p of paths) {
    if (p.length < 3) continue;
    out.push(p.map((q) => ({ x: q.x / S, y: q.y / S })));
  }
  return out;
}

export function union(a: Shape, b: Shape = []): Shape {
  return fromPaths(Clipper.union(toPaths(a), toPaths(b), FillRule.NonZero));
}
/**
 * Union of many small CCW rings (e.g. projected triangles). Clipper slows down badly on one huge
 * input, so union in small batches and merge the results pairwise.
 */
export function unionMany(rings: Shape, batch = 256): Shape {
  if (rings.length <= batch) return union(rings);
  let layer: Shape[] = [];
  for (let i = 0; i < rings.length; i += batch) layer.push(union(rings.slice(i, i + batch)));
  while (layer.length > 1) {
    const next: Shape[] = [];
    for (let i = 0; i < layer.length; i += 2) next.push(i + 1 < layer.length ? union(layer[i], layer[i + 1]) : layer[i]);
    layer = next;
  }
  return layer[0];
}
/** Union of rings given with arbitrary orientation, using even-odd (for raw slice loops). */
export function unionEvenOdd(a: Shape): Shape {
  return fromPaths(Clipper.union(toPaths(a), FillRule.EvenOdd));
}
export function difference(a: Shape, b: Shape): Shape {
  if (!b.length) return a.map((r) => r.slice());
  return fromPaths(Clipper.difference(toPaths(a), toPaths(b), FillRule.NonZero));
}
export function intersect(a: Shape, b: Shape): Shape {
  if (!a.length || !b.length) return [];
  return fromPaths(Clipper.intersect(toPaths(a), toPaths(b), FillRule.NonZero));
}

/** Round-joined offset (positive grows). */
export function offset(a: Shape, delta: number, arcTol = ARC_TOL): Shape {
  if (!a.length) return [];
  if (delta === 0) return a.map((r) => r.slice());
  return fromPaths(Clipper.inflatePaths(toPaths(a), delta * S, JoinType.Round, EndType.Polygon, 2, arcTol * S));
}

/** Morphological opening: the part of `a` a disk of radius r can sweep. */
export function opening(a: Shape, r: number): Shape {
  return offset(offset(a, -r), r);
}

export function ringArea(r: Ring): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j].x + r[i].x) * (r[j].y - r[i].y);
  return -s / 2; // CCW positive
}
export function area(a: Shape): number {
  return a.reduce((s, r) => s + ringArea(r), 0);
}

export function ringLength(r: Ring, closed = true): number {
  let L = 0;
  for (let i = 1; i < r.length; i++) L += Math.hypot(r[i].x - r[i - 1].x, r[i].y - r[i - 1].y);
  if (closed && r.length > 1) L += Math.hypot(r[0].x - r[r.length - 1].x, r[0].y - r[r.length - 1].y);
  return L;
}

/** Ramer–Douglas–Peucker on closed rings. */
export function simplify(a: Shape, tol: number): Shape {
  if (!a.length) return [];
  return fromPaths(Clipper.simplifyPaths(toPaths(a), tol * S, true)).filter((r) => Math.abs(ringArea(r)) > 1e-8);
}

/** Split into connected regions: each is [outer, ...holes]. */
export function regions(a: Shape): Shape[] {
  if (!a.length) return [];
  const norm = union(a); // outers CCW, holes CW
  const outers = norm.filter((r) => ringArea(r) > 0).map((r) => ({ r, area: ringArea(r), holes: [] as Ring[] }));
  for (const h of norm) {
    if (ringArea(h) > 0) continue;
    // a hole belongs to the smallest outer that contains it
    let best: (typeof outers)[number] | null = null;
    const p = h[0];
    for (const o of outers) {
      if (pointInRing(p, o.r) && (!best || o.area < best.area)) best = o;
    }
    best?.holes.push(h);
  }
  return outers.map((o) => [o.r, ...o.holes]);
}

function pointInRing(p: Pt, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a1 = r[i], b1 = r[j];
    if (a1.y > p.y !== b1.y > p.y && p.x < ((b1.x - a1.x) * (p.y - a1.y)) / (b1.y - a1.y) + a1.x) inside = !inside;
  }
  return inside;
}

/** Outer boundaries only (holes filled). */
export function fillHoles(a: Shape): Shape {
  return regions(a).map((r) => r[0]);
}

export function pointInShape(p: Pt, a: Shape): boolean {
  // even-odd over all rings (consistent with outers + holes)
  let inside = false;
  for (const r of a) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a1 = r[i], b1 = r[j];
      if (a1.y > p.y !== b1.y > p.y && p.x < ((b1.x - a1.x) * (p.y - a1.y)) / (b1.y - a1.y) + a1.x) inside = !inside;
    }
  }
  return inside;
}

/** Distance from p to the nearest ring edge. */
export function distToBoundary(p: Pt, a: Shape): number {
  let best = Infinity;
  for (const r of a) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) best = Math.min(best, distPtSeg(p, r[j], r[i]));
  }
  return best;
}

export function distPtSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  const t = L > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function segsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True if the straight segment a→b stays inside the shape (with `margin` clearance from its boundary). */
export function segmentInside(a: Pt, b: Pt, shape: Shape, margin = 0): boolean {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (!pointInShape(mid, shape)) return false;
  for (const r of shape) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if (segsCross(a, b, r[j], r[i])) return false;
      if (margin > 0 && segSegDist(a, b, r[j], r[i]) < margin) return false;
    }
  }
  return true;
}
function segSegDist(a: Pt, b: Pt, c: Pt, d: Pt) {
  if (segsCross(a, b, c, d)) return 0;
  return Math.min(distPtSeg(a, c, d), distPtSeg(b, c, d), distPtSeg(c, a, b), distPtSeg(d, a, b));
}

export function centroid(r: Ring): Pt {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j].x * r[i].y - r[i].x * r[j].y;
    cx += (r[j].x + r[i].x) * f;
    cy += (r[j].y + r[i].y) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-12) return { x: r[0].x, y: r[0].y };
  return { x: cx / (3 * a), y: cy / (3 * a) };
}
