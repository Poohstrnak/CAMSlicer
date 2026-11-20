/**
 * 2.5D toolpath strategies working on polygon regions:
 *  - contour-parallel pocketing (climb, spiral-out, stay-down links, helical/contour ramp entry)
 *  - wall finishing contours with tangent arc lead-in/out
 *  - profile cut-out with tabs and zig-zag ramps
 * All coordinates are model coordinates (mm).
 */
import {
  union as unionShapes,
  centroid,
  distToBoundary,
  offset,
  pointInShape,
  regions,
  ringLength,
  segmentInside,
  simplify,
  type Pt,
  type Ring,
  type Shape,
} from './geom';
import type { Move, Op, Tool25 } from './types';

const EPS = 1e-9;
/** Simplification tolerance for generated tool-centre rings (mm). */
export const PATH_TOL = 0.004;

/** Counters for diagnostics. */
export const stats = { helix: 0, contourRamp: 0, airEntry: 0, retracts: 0, straight: 0, dogleg: 0, airPlunge: 0, reentry: 0, regions: 0, firstEntries: 0 };

export interface PocketOpts {
  /** Tool-centre domain where the footprint is already cleared down to `airDepth` (straight plunge allowed). */
  air?: Shape;
  airDepth?: number;
  /** Tool-centre domain that is safe to move through at depth (defaults to the pocket domain). */
  allowed?: Shape;
}

/** State shared by all regions of one layer. */
interface LayerState {
  down: boolean;
  cut: Ring[]; // rings already cut at this depth: every point on them is cleared air
}

export class Builder {
  moves: Move[] = [];
  x = NaN;
  y = NaN;
  z = NaN;
  constructor(
    readonly tool: Tool25,
    readonly safeZ: number,
    readonly stockTop: number,
  ) {}

  private push(m: Move) {
    if (m.g <= 1 && Math.abs(m.x - this.x) < EPS && Math.abs(m.y - this.y) < EPS && Math.abs(m.z - this.z) < EPS) return;
    this.moves.push(m);
    this.x = m.x;
    this.y = m.y;
    this.z = m.z;
  }
  rapid(x: number, y: number, z: number) {
    this.push({ g: 0, x, y, z, f: 0 });
  }
  feed(x: number, y: number, z: number, f = this.tool.feed) {
    this.push({ g: 1, x, y, z, f });
  }
  arc(ccw: boolean, x: number, y: number, z: number, cx: number, cy: number, f = this.tool.feed) {
    this.push({ g: ccw ? 3 : 2, x, y, z, f, cx, cy });
  }
  get started() {
    return !Number.isNaN(this.x);
  }
  retract() {
    if (this.started && this.z < this.safeZ) this.rapid(this.x, this.y, this.safeZ);
  }
  /** Travel height between cuts inside a file: 1 mm above the stock top. */
  get hopZ() {
    return this.stockTop + 1;
  }
  /**
   * Go to (x,y) and feed down to zTarget. Rapids happen only at or above 1 mm over the stock top, or
   * down to 1 mm above `clearedFloor` (a depth already cleared under the tool's whole footprint).
   * Everything below that is fed at the plunge rate.
   */
  approach(x: number, y: number, zTarget: number, clearedFloor = this.stockTop) {
    if (!this.started) this.rapid(x, y, this.safeZ);
    else {
      if (this.z < this.hopZ) this.rapid(this.x, this.y, this.hopZ);
      this.rapid(x, y, Math.max(this.z, this.hopZ));
    }
    const rz = Math.min(this.z, Math.max(zTarget, Math.min(this.hopZ, clearedFloor + 1)));
    if (rz < this.z) this.rapid(x, y, rz);
    if (zTarget < this.z) this.feed(x, y, zTarget, this.tool.plunge);
  }
}

const rampSlope = (t: Tool25) => Math.tan((t.rampAngle * Math.PI) / 180);

/** Rotate a closed ring so it starts at the vertex nearest p. */
function startNearest(r: Ring, p: Pt): Ring {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < r.length; i++) {
    const d = (r[i].x - p.x) ** 2 + (r[i].y - p.y) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  return r.slice(bi).concat(r.slice(0, bi));
}

/**
 * Feed along a closed ring starting at ring[0], descending linearly from zFrom to zTo over `length`
 * (repeating laps as needed). Ends somewhere on the ring at zTo; returns the index reached.
 */
function rampAlongRing(b: Builder, ring: Ring, zFrom: number, zTo: number, f: number): number {
  const total = (zFrom - zTo) / rampSlope(b.tool);
  let travelled = 0;
  let i = 0;
  const n = ring.length;
  for (let guard = 0; guard < 1e6; guard++) {
    const a = ring[i % n], c = ring[(i + 1) % n];
    const seg = Math.hypot(c.x - a.x, c.y - a.y);
    if (travelled + seg >= total) {
      const u = seg > 0 ? (total - travelled) / seg : 1;
      b.feed(a.x + (c.x - a.x) * u, a.y + (c.y - a.y) * u, zTo, f);
      // finish to the next vertex at depth so we continue on-ring
      b.feed(c.x, c.y, zTo);
      return (i + 1) % n;
    }
    travelled += seg;
    b.feed(c.x, c.y, zFrom - (zFrom - zTo) * (travelled / total), f);
    i++;
  }
  return 0;
}

function lapFrom(b: Builder, ring: Ring, start: number, z: number) {
  const n = ring.length;
  for (let k = 1; k <= n; k++) {
    const p = ring[(start + k) % n];
    b.feed(p.x, p.y, z);
  }
}

interface PocketNode {
  shape: Shape; // one region: [outer, ...holes]
  children: PocketNode[];
}

function buildTree(region: Shape, step: number, depth = 0): PocketNode {
  const node: PocketNode = { shape: region, children: [] };
  if (depth > 2000) return node;
  // inner clearing rings don't define walls: a coarser arc tolerance keeps them light (still inside T)
  const inner = simplify(offset(region, -step, 0.02), 0.01);
  for (const r of regions(inner)) {
    if (ringLength(r[0]) < 0.05) continue;
    node.children.push(buildTree(r, step, depth + 1));
  }
  return node;
}

/**
 * Contour-parallel pocketing of the tool-centre domain T at depth z.
 * Material above z is assumed already cleared down to zAbove (so the approach can feed straight down to it).
 */
/**
 * The connected parts of a tool-centre domain that pocketLayer really cuts. Planning uses the same
 * function to decide what counts as cut, so the two can never disagree (a sliver that simplifies away
 * or a ring shorter than 0.05 mm is never cut).
 */
export function pocketRegions(T: Shape): Shape[] {
  return regions(simplify(T, PATH_TOL)).filter((r) => ringLength(r[0]) >= 0.05);
}

export function pocketLayer(b: Builder, T: Shape, z: number, zAbove: number, opts: PocketOpts = {}) {
  const tool = b.tool;
  const step = tool.diameter * tool.stepover;
  const regs = pocketRegions(T);
  const state: LayerState = { down: false, cut: [] };
  const done = new Set<Shape>();
  while (done.size < regs.length) {
    // nearest region next
    let best: Shape | null = null, bd = Infinity;
    for (const r of regs) {
      if (done.has(r)) continue;
      const d = b.started ? Math.min(...r[0].map((p) => Math.hypot(p.x - b.x, p.y - b.y))) : 0;
      if (d < bd) { bd = d; best = r; }
    }
    done.add(best!);
    cutRegion(b, best!, z, zAbove, step, opts, state);
  }
}

/**
 * Spiral-in pocketing of one connected tool-centre region.
 * Ring 0 (along the walls) keeps Clipper orientation (outer CCW / holes CW = climb against the wall);
 * inner rings are reversed so the uncut core is on the right of travel (climb).
 * Links stay down when a straight move (or a dog-leg through an already-cut ring point) stays inside
 * the domain; otherwise the tool lifts and re-plunges straight onto an already-cut ring (cleared air).
 */
function cutRegion(b: Builder, domain: Shape, z: number, zAbove: number, step: number, opts: PocketOpts, state: LayerState) {
  const tool = b.tool;
  const tree = buildTree(domain, step);
  const cut = state.cut;
  // links at depth must stay where material is at most one layer thick: this region, or pre-cleared air
  const allowed = opts.air?.length ? union2(domain, opts.air) : domain;
  // stay down only if we are already at this depth (a previous region of the same layer)
  let down = state.down && Math.abs(b.z - z) < 1e-9;

  const here = () => ({ x: b.x, y: b.y });
  const nearestCutPoints = (d: Pt, k: number) => {
    const c: { p: Pt; d: number }[] = [];
    for (const r of cut) {
      const q = nearestOnRing(r, d);
      if (q) c.push({ p: q, d: Math.hypot(q.x - d.x, q.y - d.y) });
    }
    return c.sort((u, v) => u.d - v.d).slice(0, k);
  };

  /** First entry into the region (no cut ring yet): air plunge, helix, or contour ramp. */
  stats.regions++;
  const firstEntry = (ring: Ring): Ring => {
    stats.firstEntries++;
    const zAir = Math.min(zAbove + 0.1, b.stockTop + 0.1);
    if (opts.air?.length && opts.airDepth !== undefined && opts.airDepth <= z + 1e-9) {
      const r = startNearest(ring, b.started ? here() : ring[0]);
      const P = nearestOnShape(opts.air, r[0]);
      if (P && Math.hypot(P.x - r[0].x, P.y - r[0].y) < tool.diameter * 3 && segmentInside(P, r[0], allowed)) {
        b.approach(P.x, P.y, z, opts.airDepth);
        b.feed(r[0].x, r[0].y, z);
        stats.airEntry++;
        return r;
      }
    }
    // helix at the deepest point we know: centroid of the innermost leaf
    let leaf = tree;
    while (leaf.children.length) leaf = leaf.children.reduce((m, c) => (area1(c.shape) > area1(m.shape) ? c : m));
    const c = centroid(leaf.shape[0]);
    if (pointInShape(c, domain)) {
      const d = distToBoundary(c, domain);
      const rh = Math.min(tool.diameter * 0.45, d - 0.01);
      if (rh >= tool.diameter * 0.1) {
        helix(b, c, rh, zAir, z, zAbove);
        stats.helix++;
        const r = startNearest(ring, here());
        if (segmentInside(here(), r[0], allowed)) {
          b.feed(r[0].x, r[0].y, z);
          return r;
        }
        b.retract();
      }
    }
    const r = startNearest(ring, b.started ? here() : ring[0]);
    b.approach(r[0].x, r[0].y, zAir, zAbove);
    const at = rampAlongRing(b, r, zAir, z, tool.plunge);
    stats.contourRamp++;
    return r.slice(at).concat(r.slice(0, at));
  };

  /** Move to the start of `ring` (rotated to begin near the tool), staying down when possible. */
  const goTo = (ring: Ring): Ring => {
    if (!down) {
      down = true;
      return firstEntry(ring);
    }
    const r = startNearest(ring, here());
    const D = r[0];
    if (segmentInside(here(), D, allowed)) {
      b.feed(D.x, D.y, z);
      stats.straight++;
      return r;
    }
    const cands = nearestCutPoints(D, 6);
    for (const c of cands) {
      if (segmentInside(here(), c.p, allowed) && segmentInside(c.p, D, allowed)) {
        b.feed(c.p.x, c.p.y, z);
        b.feed(D.x, D.y, z);
        stats.dogleg++;
        return r;
      }
    }
    for (const c of cands) {
      if (segmentInside(c.p, D, allowed)) {
        stats.retracts++;
        b.approach(c.p.x, c.p.y, z, z); // straight plunge onto an already-cut ring = cleared air
        b.feed(D.x, D.y, z);
        stats.airPlunge++;
        return r;
      }
    }
    stats.retracts++;
    stats.reentry++;
    down = false;
    return goTo(ring);
  };

  const cutRing = (ring: Ring) => {
    if (ring.length < 3 || ringLength(ring) < 0.05) return;
    const r = goTo(ring);
    lapFrom(b, r, 0, z);
    cut.push(r);
  };

  const visit = (node: PocketNode, depth: number) => {
    // this node's rings first (outer, then holes nearest-first), then children
    const rings = node.shape.map((r) => (depth === 0 ? r : r.slice().reverse()));
    const todo = rings.slice();
    while (todo.length) {
      let bi = 0;
      if (b.started) {
        let bd = Infinity;
        todo.forEach((r, i) => {
          const q = nearestOnRing(r, here());
          const d = q ? Math.hypot(q.x - b.x, q.y - b.y) : Infinity;
          if (d < bd) { bd = d; bi = i; }
        });
      }
      cutRing(todo.splice(bi, 1)[0]);
    }
    const kids = node.children.slice();
    while (kids.length) {
      let bi = 0, bd = Infinity;
      kids.forEach((k, i) => {
        const q = nearestOnRing(k.shape[0], here());
        const d = q ? Math.hypot(q.x - b.x, q.y - b.y) : Infinity;
        if (d < bd) { bd = d; bi = i; }
      });
      visit(kids.splice(bi, 1)[0], depth + 1);
    }
  };
  visit(tree, 0);
  state.down = down;
}

function area1(s: Shape) {
  let a = 0;
  for (const r of s) for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j].x + r[i].x) * (r[j].y - r[i].y);
  return -a / 2;
}

function nearestOnRing(r: Ring, p: Pt): Pt | null {
  return nearestOnShape([r], p);
}

/** Helical ramp (CCW, climb for pockets) around c from zFrom down to zTo, then one flat lap. */
export function helix(b: Builder, c: Pt, rh: number, zFrom: number, zTo: number, clearedFloor = zFrom) {
  const tool = b.tool;
  const perRev = 2 * Math.PI * rh * rampSlope(tool);
  const revs = Math.max(1, Math.ceil((zFrom - zTo) / perRev - 1e-9));
  const dzHalf = (zFrom - zTo) / (revs * 2);
  const sx = c.x + rh, sy = c.y;
  b.approach(sx, sy, zFrom, clearedFloor);
  let zz = zFrom;
  for (let i = 0; i < revs; i++) {
    zz -= dzHalf;
    b.arc(true, c.x - rh, c.y, zz, c.x, c.y, tool.plunge);
    zz -= dzHalf;
    b.arc(true, sx, sy, zz, c.x, c.y, tool.plunge);
  }
  b.arc(true, c.x - rh, c.y, zTo, c.x, c.y);
  b.arc(true, sx, sy, zTo, c.x, c.y);
}

/**
 * Single full-depth wall-finishing pass along each ring of `path` (tool-centre path, climb orientation),
 * entering and leaving with tangent quarter arcs from inside `cleared` (tool-centre domain known to be air).
 * Where there is no room for an arc, it enters with a short straight move from the nearest cleared point.
 * Rings with no cleared air beside them (the roughing tool never fit there) are skipped, never plunged:
 * returns how many were skipped.
 */
export function wallFinish(b: Builder, path: Shape, cleared: Shape, z: number, wallStock: number): number {
  let skipped = 0;
  for (const ring0 of path) {
    if (ringLength(ring0) < 0.1) continue;
    const n = ring0.length;
    // candidate start points: midpoints of the longest edges
    const edges = ring0.map((p, i) => ({ i, len: Math.hypot(ring0[(i + 1) % n].x - p.x, ring0[(i + 1) % n].y - p.y) }));
    edges.sort((a, c) => c.len - a.len);
    let placed = false;
    for (const e of edges.slice(0, 40)) {
      const a = ring0[e.i], c = ring0[(e.i + 1) % n];
      if (e.len < 1e-6) break;
      const tx = (c.x - a.x) / e.len, ty = (c.y - a.y) / e.len;
      const S = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
      const nx = -ty, ny = tx; // left normal = towards the cleared pocket
      for (const rho of [0.6, 0.4, 0.25]) {
        const C0 = { x: S.x + nx * rho, y: S.y + ny * rho };
        const P = { x: C0.x - tx * rho, y: C0.y - ty * rho };
        const Q = { x: C0.x + tx * rho, y: C0.y + ty * rho };
        if (!pointInShape(P, cleared) || !pointInShape(Q, cleared) || !pointInShape(C0, cleared)) continue;
        // ring starting at S
        const ring: Ring = [S, ...ring0.slice(e.i + 1), ...ring0.slice(0, e.i + 1)];
        b.approach(P.x, P.y, z, z);
        b.arc(true, S.x, S.y, z, C0.x, C0.y);
        lapFrom(b, ring, 0, z);
        b.feed(S.x, S.y, z);
        b.arc(true, Q.x, Q.y, z, C0.x, C0.y);
        placed = true;
        break;
      }
      if (placed) break;
    }
    if (!placed) {
      // No room for an arc lead-in. Only the cleared domain is known to be air down to z, so drop in
      // there and feed straight across the wall stock onto the ring. The ring itself is not cleared:
      // the wall stock (and, where the roughing tool never fit, the full stock height) is still on it.
      let bi = -1, bd = Infinity, bp: Pt | null = null;
      for (let i = 0; i < ring0.length; i++) {
        const P = nearestOnShape(cleared, ring0[i]);
        if (!P) break;
        const d = Math.hypot(P.x - ring0[i].x, P.y - ring0[i].y);
        if (d < bd) { bd = d; bi = i; bp = P; }
      }
      if (!bp || bd > wallStock + 0.1) {
        skipped++;
        continue;
      }
      const ring = ring0.slice(bi).concat(ring0.slice(0, bi));
      b.approach(bp.x, bp.y, z, z);
      b.feed(ring[0].x, ring[0].y, z);
      lapFrom(b, ring, 0, z);
      b.feed(ring[0].x, ring[0].y, z);
      b.feed(bp.x, bp.y, z);
    }
  }
  return skipped;
}

// ---------------------------------------------------------------------------------------------
// Cut-out profile with tabs
// ---------------------------------------------------------------------------------------------

/** A closed polyline with cumulative arc length, for positions along the path. */
export class PathLoop {
  readonly cum: number[];
  readonly length: number;
  constructor(readonly pts: Ring) {
    this.cum = [0];
    for (let i = 1; i <= pts.length; i++) {
      const a = pts[i - 1], c = pts[i % pts.length];
      this.cum.push(this.cum[i - 1] + Math.hypot(c.x - a.x, c.y - a.y));
    }
    this.length = this.cum[pts.length];
  }
  wrap(s: number) {
    return ((s % this.length) + this.length) % this.length;
  }
  at(s: number): Pt {
    s = this.wrap(s);
    let lo = 0, hi = this.pts.length;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.cum[m] <= s) lo = m;
      else hi = m;
    }
    const a = this.pts[lo], c = this.pts[(lo + 1) % this.pts.length];
    const seg = this.cum[lo + 1] - this.cum[lo];
    const u = seg > 0 ? (s - this.cum[lo]) / seg : 0;
    return { x: a.x + (c.x - a.x) * u, y: a.y + (c.y - a.y) * u };
  }
  /** Vertices strictly between arc lengths s0 < s1 (no wrap handling beyond one lap), in order. */
  between(s0: number, s1: number): Pt[] {
    const out: Pt[] = [];
    const L = this.length;
    for (let lap = 0; lap < 3; lap++) {
      for (let i = 0; i < this.pts.length; i++) {
        const s = this.cum[i] + lap * L;
        if (s > s0 + 1e-9 && s < s1 - 1e-9) out.push(this.pts[i]);
      }
    }
    return out;
  }
  /** Vertices strictly between s0 < s1 with their (unwrapped) arc lengths. */
  betweenS(s0: number, s1: number): { p: Pt; s: number }[] {
    const out: { p: Pt; s: number }[] = [];
    const L = this.length;
    for (let lap = 0; lap < 3; lap++) {
      for (let i = 0; i < this.pts.length; i++) {
        const s = this.cum[i] + lap * L;
        if (s > s0 + 1e-9 && s < s1 - 1e-9) out.push({ p: this.pts[i], s });
      }
    }
    return out;
  }
  /** Total absolute heading change (degrees) over the arc-length window [s0, s1]. */
  turning(s0: number, s1: number): number {
    const pts = [this.at(s0), ...this.between(s0, s1), this.at(s1)];
    let tot = 0;
    let prev: number | null = null;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
      if (Math.hypot(dx, dy) < 1e-6) continue;
      const h = Math.atan2(dy, dx);
      if (prev !== null) {
        let d = h - prev;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        tot += Math.abs(d);
      }
      prev = h;
    }
    return (tot * 180) / Math.PI;
  }
}

export interface TabSpan {
  /** Centre arc length along the path. */
  s: number;
  /** Raised span [s0, s1] along the tool path: flat at the tab top for exactly the tab width. */
  s0: number;
  s1: number;
}

/**
 * Evenly spaced tabs along the cut-out path, nudged away from sharp corners:
 * each tab's raised span (plus a margin) must turn less than `maxTurn` degrees if possible.
 */
export function placeTabs(loop: PathLoop, count: number, tabWidth: number, toolD: number, maxTurn = 12): TabSpan[] {
  if (count <= 0 || loop.length <= 0) return [];
  // the tool rides flat at the tab top for exactly `tabWidth` along its path; the window checked for
  // corners also covers the ramp-down that follows and the tool radius on both sides
  const half = tabWidth / 2;
  const window = half + toolD * 1.5;
  if (2 * window * count > loop.length * 0.8) count = Math.max(1, Math.floor((loop.length * 0.8) / (2 * window)));
  const spacing = loop.length / count;
  const tabs: TabSpan[] = [];
  for (let i = 0; i < count; i++) {
    const nominal = (i + 0.5) * spacing;
    let best = nominal, bestTurn = Infinity;
    const range = spacing * 0.35;
    for (let d = 0; d <= range; d += 0.5) {
      for (const s of d === 0 ? [nominal] : [nominal + d, nominal - d]) {
        const t = loop.turning(s - window, s + window);
        if (t < maxTurn) { best = s; bestTurn = t; break; }
        if (t < bestTurn) { bestTurn = t; best = s; }
      }
      if (bestTurn < maxTurn) break;
    }
    const s = loop.wrap(best);
    tabs.push({ s, s0: s - half, s1: s + half });
  }
  return tabs.sort((a, c) => a.s - c.s);
}

/**
 * Cut-out of one closed tool-centre path (CW = climb around the part), stepping down through `zs`
 * (descending, last = final depth). Tabs rise to `tabTop` on passes below it. Each pass starts with a
 * zig-zag ramp along the path from the previous depth.
 */
export function cutout(
  b: Builder,
  pathRing: Ring,
  zs: number[],
  tabs: TabSpan[],
  tabTop: number,
  onPass: (k: number, z: number) => void,
) {
  const tool = b.tool;
  const loop0 = new PathLoop(pathRing);
  // start halfway between the first two tabs (or anywhere straight if no tabs)
  let s0 = 0;
  if (tabs.length >= 2) s0 = (tabs[0].s + tabs[1].s) / 2;
  else if (tabs.length === 1) s0 = tabs[0].s + loop0.length / 2;
  const S = loop0.at(s0);
  // re-base the loop at the start point
  const rebased: Ring = [S, ...loop0.between(s0, s0 + loop0.length)];
  const loop = new PathLoop(rebased);
  const shift = (s: number) => loop.wrap(s - s0);
  const spans = tabs
    .map((t) => ({ a: shift(t.s0), c: shift(t.s1) }))
    .map((t) => (t.c < t.a ? { a: t.a, c: t.c + loop.length } : t))
    .sort((p, q) => p.a - q.a);

  const slope = rampSlope(tool);
  /** Zig-zag ramp starting at arc length s (forward then back), from zFrom to zTo. Room = forward space. */
  const zigzag = (s: number, zFrom: number, zTo: number, room: number) => {
    const L = (zFrom - zTo) / slope;
    const m = Math.max(1, Math.ceil(L / (2 * Math.max(0.5, room)) - 1e-9));
    const leg = L / (2 * m);
    const dz = (zFrom - zTo) / (2 * m);
    const inner = loop.betweenS(s, s + leg);
    let z = zFrom;
    for (let k = 0; k < m; k++) {
      // forward leg
      for (const q of inner) b.feed(q.p.x, q.p.y, z - (dz * (q.s - s)) / leg, tool.plunge);
      const fwd = loop.at(s + leg);
      z -= dz;
      b.feed(fwd.x, fwd.y, z, tool.plunge);
      // back leg
      for (const q of inner.slice().reverse()) b.feed(q.p.x, q.p.y, z - (dz * (s + leg - q.s)) / leg, tool.plunge);
      const back = loop.at(s);
      z -= dz;
      b.feed(back.x, back.y, z, tool.plunge);
    }
  };

  b.approach(S.x, S.y, b.stockTop + 0.1);
  let zPrev = b.stockTop + 0.1;
  zs.forEach((z, k) => {
    const firstSpan = spans.length ? spans[0].a : loop.length;
    zigzag(0, zPrev, z, Math.min(firstSpan, loop.length) * 0.9);
    // lap
    let s = 0;
    const raised = z < tabTop - 1e-6;
    for (const sp of raised ? spans : []) {
      for (const p of loop.between(s, sp.a)) b.feed(p.x, p.y, z);
      const pa = loop.at(sp.a);
      b.feed(pa.x, pa.y, z);
      b.feed(pa.x, pa.y, tabTop); // rise over the tab
      for (const p of loop.between(sp.a, sp.c)) b.feed(p.x, p.y, tabTop);
      const pc = loop.at(sp.c);
      b.feed(pc.x, pc.y, tabTop);
      const next = spans.find((q) => q.a > sp.c + 1e-9);
      const room = (next ? next.a : loop.length) - sp.c;
      zigzag(sp.c, tabTop, z, room * 0.9);
      s = sp.c;
    }
    for (const p of loop.between(s, loop.length)) b.feed(p.x, p.y, z);
    b.feed(S.x, S.y, z);
    onPass(k, z);
    zPrev = z;
  });
  // lead-out: continue 2 mm along the already-cut channel (waste side), then lift
  const exitPt = loop.at(Math.min(2, loop.length * 0.5));
  for (const p of loop.between(0, Math.min(2, loop.length * 0.5))) b.feed(p.x, p.y, b.z);
  b.feed(exitPt.x, exitPt.y, b.z);
  b.retract();
}

/** Split builder moves into an Op starting from index `from`. */
export function takeOp(b: Builder, from: number, label: string, kind: Op['kind']): Op {
  return { label, kind, moves: b.moves.slice(from) };
}

/** Nearest point on the boundary of a shape to p (slightly inside, along the edge). */
function nearestOnShape(shape: Shape, p: Pt): Pt | null {
  let best: Pt | null = null, bd = Infinity;
  for (const r of shape) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[j], c = r[i];
      const dx = c.x - a.x, dy = c.y - a.y;
      const L = dx * dx + dy * dy;
      const t = L > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
      const q = { x: a.x + t * dx, y: a.y + t * dy };
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd) { bd = d; best = q; }
    }
  }
  return best;
}

const unionCache = new WeakMap<Shape, WeakMap<Shape, Shape>>();
function union2(a: Shape, b: Shape): Shape {
  let m = unionCache.get(a);
  if (!m) unionCache.set(a, (m = new WeakMap()));
  let u = m.get(b);
  if (!u) m.set(b, (u = unionShapes(a, b)));
  return u;
}
