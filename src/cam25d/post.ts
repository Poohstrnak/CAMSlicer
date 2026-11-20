/**
 * GRBL 1.1 post-processor.
 * Rules: no G28/G30, no M6; parenthesised comments without nesting; lines ≤ 70 chars;
 * header G21 G90 G17 G94, safe Z, M3 S…, dwell; footer safe Z, M5, M30.
 * Constant-Z feed runs are refitted to G2/G3 arcs where they match within ARC_FIT_TOL.
 */
import type { Job25, Move, NcPlan, Stock25, Tool25 } from './types';

export const MAX_LINE = 70;
export const ARC_FIT_TOL = 0.005;

const num = (v: number) => {
  if (!Number.isFinite(v)) throw new Error(`Refusing to write a non-finite number (${v}) to G-code`);
  let s = v.toFixed(3);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};

/** Comment text safe for GRBL: no parentheses, single line, clipped to fit MAX_LINE. */
export function comment(text: string): string {
  const clean = text.replace(/[()]/g, '').replace(/[\r\n]+/g, ' ').trim();
  return `(${clean.slice(0, MAX_LINE - 2)})`;
}

export function toolSlug(t: Tool25) {
  return `T${t.number}_${t.name.replace(/\//g, '-').replace(/[^\w.-]+/g, '-')}`;
}

export function fileName(job: Job25, plan: NcPlan) {
  const base = job.partName.replace(/\.[^.]+$/, '');
  return `${base}_${plan.index}_${plan.title}_${toolSlug(plan.tool)}.nc`;
}

export interface PostResult {
  text: string;
  seconds: number;
}

/** Expand moves into lines/arcs with arc fitting, in work coordinates. */
interface Seg {
  g: 0 | 1 | 2 | 3;
  x: number;
  y: number;
  z: number;
  f: number;
  i?: number;
  j?: number;
}

function fitArcs(pts: { x: number; y: number }[], z: number, f: number, out: Seg[]) {
  // pts[0] is the current position; emit segments to pts[1..]
  let i = 0;
  const n = pts.length;
  while (i < n - 1) {
    let best = -1;
    let bestC: { cx: number; cy: number; ccw: boolean } | null = null;
    for (let j = i + 3; j < n && j <= i + 600; j++) {
      const c = circleFit(pts, i, j);
      if (!c) break;
      bestC = c;
      best = j;
    }
    if (best > 0 && bestC) {
      const e = pts[best];
      out.push({ g: bestC.ccw ? 3 : 2, x: e.x, y: e.y, z, f, i: bestC.cx - pts[i].x, j: bestC.cy - pts[i].y });
      i = best;
    } else {
      out.push({ g: 1, x: pts[i + 1].x, y: pts[i + 1].y, z, f });
      i++;
    }
  }
}

/** Circle through pts[i], pts[mid], pts[j] if every point and every chord lies within tolerance. */
function circleFit(p: { x: number; y: number }[], i: number, j: number) {
  const a = p[i], m = p[(i + j) >> 1], c = p[j];
  const d = 2 * (a.x * (m.y - c.y) + m.x * (c.y - a.y) + c.x * (a.y - m.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y, m2 = m.x * m.x + m.y * m.y, c2 = c.x * c.x + c.y * c.y;
  const cx = (a2 * (m.y - c.y) + m2 * (c.y - a.y) + c2 * (a.y - m.y)) / d;
  const cy = (a2 * (c.x - m.x) + m2 * (a.x - c.x) + c2 * (m.x - a.x)) / d;
  const R = Math.hypot(a.x - cx, a.y - cy);
  if (R < 0.05 || R > 2000) return null;
  const ccw = (m.x - a.x) * (c.y - m.y) - (m.y - a.y) * (c.x - m.x) > 0;
  let sweep = 0;
  let prevAng = Math.atan2(a.y - cy, a.x - cx);
  for (let k = i + 1; k <= j; k++) {
    const q = p[k];
    if (Math.abs(Math.hypot(q.x - cx, q.y - cy) - R) > ARC_FIT_TOL) return null;
    // chord midpoint must also be on the circle (segment hugs the arc)
    const pm = { x: (q.x + p[k - 1].x) / 2, y: (q.y + p[k - 1].y) / 2 };
    if (Math.abs(Math.hypot(pm.x - cx, pm.y - cy) - R) > ARC_FIT_TOL) return null;
    const ang = Math.atan2(q.y - cy, q.x - cx);
    let dA = ang - prevAng;
    while (dA > Math.PI) dA -= 2 * Math.PI;
    while (dA < -Math.PI) dA += 2 * Math.PI;
    if (ccw ? dA <= 0 : dA >= 0) return null; // must progress monotonically in one direction
    sweep += Math.abs(dA);
    prevAng = ang;
  }
  if (sweep > Math.PI * 0.999) return null; // keep arcs under 180° for unambiguous GRBL arcs
  return { cx, cy, ccw };
}

function toSegs(moves: Move[], ox: number, oy: number, oz: number): Seg[] {
  const out: Seg[] = [];
  let k = 0;
  let cur: { x: number; y: number; z: number } | null = null;
  while (k < moves.length) {
    const m = moves[k];
    const w = { x: m.x - ox, y: m.y - oy, z: m.z - oz };
    if (m.g === 1 && cur && Math.abs(w.z - cur.z) < 1e-9) {
      // gather a constant-Z, constant-feed G1 run
      const run: { x: number; y: number; z: number }[] = [cur];
      while (k < moves.length) {
        const q = moves[k];
        if (q.g !== 1 || Math.abs(q.z - oz - cur.z) > 1e-9 || q.f !== m.f) break;
        run.push({ x: q.x - ox, y: q.y - oy, z: q.z - oz });
        k++;
      }
      fitArcs(run, cur.z, m.f, out);
      const last: { x: number; y: number } = run[run.length - 1];
      cur = { x: last.x, y: last.y, z: cur.z };
      continue;
    }
    if (m.g === 2 || m.g === 3) {
      out.push({ g: m.g, x: w.x, y: w.y, z: w.z, f: m.f, i: m.cx! - ox - cur!.x, j: m.cy! - oy - cur!.y });
    } else {
      out.push({ g: m.g, x: w.x, y: w.y, z: w.z, f: m.f });
    }
    cur = w;
    k++;
  }
  return out;
}

export function segLength(prev: { x: number; y: number; z: number }, s: Seg): number {
  if (s.g === 2 || s.g === 3) {
    const cx = prev.x + s.i!, cy = prev.y + s.j!;
    const R = Math.hypot(s.i!, s.j!);
    let a0 = Math.atan2(prev.y - cy, prev.x - cx), a1 = Math.atan2(s.y - cy, s.x - cx);
    let sw = s.g === 3 ? a1 - a0 : a0 - a1;
    while (sw <= 1e-9) sw += 2 * Math.PI;
    return Math.hypot(sw * R, s.z - prev.z);
  }
  return Math.hypot(s.x - prev.x, s.y - prev.y, s.z - prev.z);
}

export function postFile(job: Job25, plan: NcPlan, stock: Stock25, allTools: Tool25[], fileCount = 3): PostResult {
  const ox = stock.minX, oy = stock.minY, oz = stock.top;
  const safe = job.clearance;
  const t = plan.tool;
  const body: string[] = [];
  let seconds = 2; // spindle dwell
  let pos = { x: 0, y: 0, z: safe };
  let mode = -1;
  let lx = '', ly = '', lz = '', lf = -1;
  for (const op of plan.ops) {
    body.push(comment(`OP ${op.label}`));
    for (const s of toSegs(op.moves, ox, oy, oz)) {
      const len = segLength(pos, s);
      seconds += s.g === 0 ? (len / job.rapidRate) * 60 : (len / s.f) * 60;
      const sx = num(s.x), sy = num(s.y), sz = num(s.z);
      const arc = s.g >= 2;
      const axes: string[] = [];
      if (sx !== lx || arc) axes.push(`X${sx}`);
      if (sy !== ly || arc) axes.push(`Y${sy}`);
      if (sz !== lz) axes.push(`Z${sz}`);
      pos = { x: s.x, y: s.y, z: s.z };
      if (!axes.length) continue; // no motion after rounding
      const parts: string[] = [];
      if (s.g !== mode || arc) parts.push(`G${s.g}`);
      parts.push(...axes);
      if (arc) parts.push(`I${num(s.i!)}`, `J${num(s.j!)}`);
      if (s.g !== 0 && s.f !== lf) {
        parts.push(`F${Math.round(s.f)}`);
        lf = s.f;
      }
      mode = s.g;
      lx = sx; ly = sy; lz = sz;
      body.push(parts.join(' '));
    }
  }

  const head: string[] = [];
  const cutting = plan.ops.some((o) => o.moves.some((m) => m.g !== 0));
  const est = cutting && Number.isFinite(seconds) ? `${Math.max(1, Math.ceil(seconds / 60))} min` : 'no cutting moves';
  head.push(comment(`CAMSlicer 2.5D - ${job.partName}`));
  head.push(comment(`File ${plan.index} of ${fileCount}, run in order: ${plan.title}`));
  head.push(comment(`Tool T${t.number}: ${t.name}`));
  head.push(comment(`T${t.number} D${num(t.diameter)} mm, ${t.flutes} flute, stepdown ${num(t.stepdown)} mm`));
  head.push(comment(`Stepover ${Math.round(t.stepover * 100)} pct, ramp ${num(t.rampAngle)} deg, ${t.rpm} rpm`));
  head.push(comment('Tools in this job:'));
  for (const tt of allTools) head.push(comment(` T${tt.number} ${tt.name} D${num(tt.diameter)} ${tt.flutes}F SD${num(tt.stepdown)}`));
  head.push(comment(`Stock ${num(stock.maxX - stock.minX)} x ${num(stock.maxY - stock.minY)} x ${num(stock.top - stock.bottom)} mm`));
  head.push(comment('XY0 = front-left corner of stock, Z0 = stock top'));
  head.push(comment('Same XY zero for all files; re-zero Z only after a bit change'));
  head.push(comment(`Est. run time ${est}`));
  head.push('G21 G90 G17 G94');
  head.push(`G0 Z${num(safe)}`);
  head.push(`M3 S${Math.round(t.rpm)}`);
  head.push('G4 P3');
  seconds += 1;
  while (body.length && body[body.length - 1] === `G0 Z${num(safe)}`) body.pop(); // footer raises Z
  const foot = [`G0 Z${num(safe)}`, 'M5', 'M30'];
  return { text: [...head, ...body, ...foot].join('\n') + '\n', seconds: seconds + 2 };
}

/** Validate the GRBL formatting rules; returns a list of problems (empty = OK). */
export function checkGrbl(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
  lines.forEach((l, i) => {
    if (/Infinity|NaN/i.test(l)) problems.push(`line ${i + 1} contains Infinity/NaN`);
    if (l.length > MAX_LINE) problems.push(`line ${i + 1} longer than ${MAX_LINE} chars`);
    const code = l.replace(/\([^()]*\)/g, '');
    if (/[()]/.test(code)) problems.push(`line ${i + 1} has nested or unbalanced parentheses`);
    if (/\bG(28|30)\b/.test(code)) problems.push(`line ${i + 1} uses G28/G30`);
    if (/\bM0?6\b/.test(code) || /\bT\d+/.test(code)) problems.push(`line ${i + 1} has a tool change`);
  });
  const code = lines.filter((l) => !l.startsWith('('));
  if (code[0] !== 'G21 G90 G17 G94') problems.push('first code line is not "G21 G90 G17 G94"');
  if (!/^G0 Z\d/.test(code[1] ?? '')) problems.push('second code line does not raise Z to a safe height');
  if (!/^M3 S\d+$/.test(code[2] ?? '')) problems.push('spindle start "M3 S…" missing after safe Z');
  if (!/^G4 P[\d.]+$/.test(code[3] ?? '')) problems.push('dwell after spindle start missing');
  const end = code.slice(-3);
  if (!/^G0 Z\d/.test(end[0] ?? '') || end[1] !== 'M5' || end[2] !== 'M30') problems.push('file must end with G0 Z<safe>, M5, M30');
  if (!hasCuttingMoves(text)) problems.push('file has no cutting moves');
  return problems;
}

/** True if any line moves an axis while the modal motion is G1/G2/G3. */
export function hasCuttingMoves(text: string): boolean {
  let mode = 0;
  for (const raw of text.split('\n')) {
    const l = raw.replace(/\([^)]*\)/g, '').toUpperCase();
    const g = l.match(/\bG0*([0-3])\b/);
    if (g) mode = +g[1];
    if (mode >= 1 && /[XYZ]\s*-?[\d.]/.test(l)) return true;
  }
  return false;
}
