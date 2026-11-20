/**
 * Job planning for 2.5D parts: Z levels, layer splitting, rest regions and the three output files:
 *   1. roughing (+ floor pass) with the large tool
 *   2. rest machining (+ floor pass) and wall finishing with the small tool
 *   3. profile cut-out with tabs, large tool
 */
import { area, difference, intersect, offset, opening, regions, type Shape } from './geom';
import { SlicedModel } from './slice';
import { Builder, cutout, placeTabs, PathLoop, pocketLayer, takeOp, wallFinish } from './toolpath';
import type { Job25, NcPlan, Op, Stock25, Tool25 } from './types';

/** Drop regions smaller than `minArea` mm² (slivers from slicing tolerance). */
export function clean(s: Shape, minArea = 0.01): Shape {
  return regions(s)
    .filter((r) => area(r) >= minArea)
    .flat();
}

/** Evenly split (from, to] into the fewest layers with no layer deeper than maxStep. Returns depths, last = to. */
export function splitLayers(from: number, to: number, maxStep: number): number[] {
  const n = Math.max(1, Math.ceil((from - to) / maxStep - 1e-9));
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? to : from - ((i + 1) * (from - to)) / n));
}

export interface Band {
  /** Floor level of this band. */
  level: number;
  /** Top of this band (previous level or stock top). */
  from: number;
  /** Region clear of the part above `level` (pocket region for every layer in the band). */
  region: Shape;
  /** Area whose floor is exactly at `level`. */
  floor: Shape;
}

/** Large-tool sweep of a region (centre domain shrunk by tool radius + wall stock, grown back by the radius). */
export function swept(region: Shape, r: number, wallStock: number): Shape {
  return offset(offset(region, -(r + wallStock)), r);
}

/** Region the small tool must clear after the large tool: (region shrunk by wall stock) minus the large sweep. */
export function restRegion(region: Shape, largeR: number, wallStock: number): Shape {
  const rest = difference(offset(region, -wallStock), swept(region, largeR, wallStock));
  // slivers thinner than ~0.02 mm are arc/simplification noise (below the 0.1 mm verification grid)
  return clean(opening(rest, 0.01), 0.002);
}

export interface Plan {
  model: SlicedModel;
  stock: Stock25;
  bands: Band[];
  files: NcPlan[];
  /** Tools in use order (largest first) with their assigned T numbers. */
  tools: Tool25[];
  /** Files that were not written, with the reason. */
  skipped: string[];
  tabTop: number;
  finalDepth: number;
  tabs: { x: number; y: number }[];
  warnings: string[];
}

export function planJob(pos: Float32Array, job: Job25): Plan {
  const model = new SlicedModel(pos);
  const { top, bottom } = model.levels;
  const stockTop = top + job.topOffset;
  const thickness = job.stockThickness ?? stockTop - bottom;
  const stockBottom = stockTop - thickness;
  if (stockBottom > bottom + 1e-6) throw new Error('Stock is thinner than the part plus top offset.');
  const ob = bounds(model.outline);
  const stock: Stock25 = { ...ob, top: stockTop, bottom: stockBottom };
  const warnings: string[] = [];
  const ws = job.wallFinish ? job.finishStepover : 0;
  const safeZ = stockTop + job.clearance;

  // --- bands between flat levels
  const levels = model.levels.flats.filter((L) => L < stockTop - 1e-6 && L > bottom + 1e-6);
  const bands: Band[] = [];
  let from = stockTop;
  const regionsByLevel = levels.map((L) => clean(model.clearAt(L)));
  levels.forEach((L, i) => {
    const region = regionsByLevel[i];
    const deeper = regionsByLevel[i + 1] ?? [];
    bands.push({ level: L, from, region, floor: clean(difference(region, deeper)) });
    from = L;
  });
  // through-holes (pockets reaching the bottom) are pocketed to the cut-out depth
  const finalDepth = stockBottom - job.throughDepth;
  const holes = clean(model.clearAt(bottom + 1e-3), 0.05);
  if (area(holes) > 0.05) {
    bands.push({ level: finalDepth, from, region: holes, floor: [] });
    warnings.push('Part has through-holes; they are pocketed out to the cut-out depth.');
  }

  // Tools are always used largest-first, whatever order they were entered in:
  // the largest roughs and cuts out; each smaller one only machines what the next larger one could not reach.
  const tools = sortTools(job.tools);
  if (!tools.length) throw new Error('No tools selected.');
  const L = tools[0];
  const rL = L.diameter / 2;
  const smallest = tools[tools.length - 1];
  const candidates: NcPlan[] = [];
  const skipped: string[] = [];

  // ---------------------------------------------------------------- roughing (largest tool)
  {
    const b = new Builder(L, safeZ, stockTop);
    const ops: Op[] = [];
    for (const band of bands) {
      const T = offset(band.region, -(rL + ws));
      let zAbove = band.from;
      for (const z of splitLayers(band.from, band.level, L.stepdown)) {
        const at = b.moves.length;
        pocketLayer(b, T, z, zAbove);
        if (b.moves.length > at) ops.push(takeOp(b, at, `rough Z${fmtZ(z - stockTop)}`, 'rough'));
        zAbove = z;
      }
      if (job.floorPass && band.floor.length) {
        const Tf = intersect(T, offset(band.floor, rL - 0.005));
        const at = b.moves.length;
        pocketLayer(b, Tf, band.level, band.level, { allowed: T });
        if (b.moves.length > at) ops.push(takeOp(b, at, `floor Z${fmtZ(band.level - stockTop)}`, 'floor'));
      }
    }
    if (tools.length === 1 && job.wallFinish) ops.push(...wallOps(b, bands, L, ws, stockTop));
    b.retract();
    closeLast(ops, b);
    candidates.push({ index: 0, title: 'roughing', tool: L, ops });
  }

  // ---------------------------------------------------------------- rest + detail (each smaller tool)
  for (let ti = 1; ti < tools.length; ti++) {
    const Sm = tools[ti];
    const prev = tools[ti - 1];
    const rP = prev.diameter / 2;
    const rS = Sm.diameter / 2;
    const b = new Builder(Sm, safeZ, stockTop);
    const ops: Op[] = [];
    for (const band of bands) {
      const rest = restRegion(band.region, rP, ws);
      if (!rest.length) continue;
      const T = intersect(offset(band.region, -(rS + ws)), offset(rest, rS - 0.005));
      if (!T.length) continue;
      // plunge into area the larger tools already cleared to the band floor, then feed into the rest region
      const As = offset(band.region, -(rS + ws)); // every centre here keeps the footprint off the walls
      const air = intersect(offset(swept(band.region, rP, ws), -(rS + 0.02)), As);
      let zAbove = band.from;
      for (const z of splitLayers(band.from, band.level, Sm.stepdown)) {
        const at = b.moves.length;
        pocketLayer(b, T, z, zAbove, { air, airDepth: band.level, allowed: As });
        if (b.moves.length > at) ops.push(takeOp(b, at, `rest Z${fmtZ(z - stockTop)}`, 'rest'));
        zAbove = z;
      }
      if (job.floorPass && band.floor.length) {
        const Tf = intersect(T, offset(intersect(rest, band.floor), rS - 0.005));
        const at = b.moves.length;
        if (Tf.length) pocketLayer(b, Tf, band.level, band.level, { air, airDepth: band.level, allowed: As });
        if (b.moves.length > at) ops.push(takeOp(b, at, `floor Z${fmtZ(band.level - stockTop)}`, 'floor'));
      }
    }
    if (Sm === smallest && job.wallFinish) ops.push(...wallOps(b, bands, Sm, ws, stockTop));
    b.retract();
    closeLast(ops, b);
    const plan: NcPlan = { index: 0, title: 'rest-detail', tool: Sm, ops };
    if (!hasCutting(plan)) skipped.push(`${Sm.name}: nothing left to cut after ${prev.name}`);
    candidates.push(plan);
  }

  // ---------------------------------------------------------------- cut-out (largest tool)
  const tabTop = finalDepth + job.tabHeight;
  const tabsXY: { x: number; y: number }[] = [];
  if (!job.skipCutout) {
    if (job.tabCount > 0 && job.tabWidth <= L.diameter) {
      warnings.push(`Tab width ${job.tabWidth} mm is not wider than the ${L.name} (D${L.diameter}): the tabs would be cut away.`);
    }
    const b = new Builder(L, safeZ, stockTop);
    const ops: Op[] = [];
    const zs = splitLayers(stockTop, finalDepth, job.cutoutStepdown ?? L.stepdown);
    const paths = offset(model.outline, rL).filter((r) => ringArea2(r) > 0);
    for (const ring of paths) {
      const cw = ring.slice().reverse(); // climb around the outside
      const loop = new PathLoop(cw);
      const tabs = placeTabs(loop, job.tabCount, job.tabWidth, L.diameter);
      for (const t of tabs) tabsXY.push(loop.at(t.s));
      let at = b.moves.length;
      cutout(b, cw, zs, tabs, tabTop, (k, z) => {
        ops.push(takeOp(b, at, `cutout pass ${k + 1}/${zs.length} Z${fmtZ(z - stockTop)}`, 'cutout'));
        at = b.moves.length;
      });
      if (b.moves.length > at) ops[ops.length - 1].moves.push(...b.moves.slice(at));
    }
    b.retract();
    closeLast(ops, b);
    candidates.push({ index: 0, title: 'cutout', tool: L, ops });
  }

  // never emit a file without cutting moves; number the rest in run order
  const files = candidates.filter((f) => hasCutting(f));
  for (const f of candidates) {
    if (!hasCutting(f) && f.title !== 'rest-detail') skipped.push(`${f.tool.name} ${f.title}: no cutting moves`);
  }
  files.forEach((f, i) => (f.index = i + 1));

  return { model, stock, bands, files, tools, skipped, tabTop, finalDepth, tabs: tabsXY, warnings };
}

/** Largest first; T numbers follow that order (T1 = largest). */
export function sortTools(list: Tool25[]): Tool25[] {
  return list
    .slice()
    .sort((a, b) => b.diameter - a.diameter)
    .map((t, i) => ({ ...t, number: i + 1 }));
}

/** True if the file contains at least one feed or arc move. */
export function hasCutting(f: NcPlan): boolean {
  return f.ops.some((o) => o.moves.some((m) => m.g !== 0));
}

function wallOps(b: Builder, bands: Band[], tool: Tool25, ws: number, stockTop: number): Op[] {
  const ops: Op[] = [];
  const r = tool.diameter / 2;
  for (const band of bands) {
    const path = offset(band.region, -r);
    if (!path.length) continue;
    const cleared = offset(band.region, -(r + ws + 0.02));
    const at = b.moves.length;
    wallFinish(b, path, cleared, band.level);
    if (b.moves.length > at) ops.push(takeOp(b, at, `wall finish Z${fmtZ(band.level - stockTop)}`, 'wall'));
  }
  return ops;
}

/** Make sure moves after the last op boundary (final retract) belong to the last op. */
function closeLast(ops: Op[], b: Builder) {
  const used = ops.reduce((s, o) => s + o.moves.length, 0);
  if (ops.length && used < b.moves.length) ops[ops.length - 1].moves.push(...b.moves.slice(used));
}

function ringArea2(r: { x: number; y: number }[]) {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j].x + r[i].x) * (r[j].y - r[i].y);
  return -s / 2;
}

function bounds(s: Shape) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of s) for (const p of r) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

const fmtZ = (z: number) => (Math.abs(z) < 5e-4 ? '0' : z.toFixed(3));
