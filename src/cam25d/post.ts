/**
 * G-code post-processor with one profile per controller family (GRBL, LinuxCNC, Mach3/4, Marlin, Fanuc/Haas).
 * The toolpaths are identical for every profile; only the file dialect changes:
 * comment style, number format, dwell units, setup/end blocks and tool-change handling.
 * Common rules: lines ≤ 70 chars, single-level comments, arcs < 180° with incremental I/J.
 * Constant-Z feed runs are refitted to G2/G3 arcs where they match within ARC_FIT_TOL.
 */
import type { Job25, MachineId, Move, NcPlan, Stock25, Tool25 } from './types';

export const MAX_LINE = 70;
export const ARC_FIT_TOL = 0.005;

export interface Machine {
  id: MachineId;
  label: string;
  /** Short name used in verification messages. */
  short: string;
  /** One-line hint shown under the picker. */
  note: string;
  ext: string;
  /** ';' comments (Marlin) instead of '( … )'. */
  semicolon: boolean;
  /** Upper-case comments (older Fanuc controls reject lower case). */
  upper: boolean;
  /** Always write a decimal point on X/Y/Z/I/J (Fanuc reads "X10" as 10 µm). */
  decimal: boolean;
  /** G4 P is milliseconds (Fanuc/Haas) rather than seconds. */
  dwellPms: boolean;
  /** Uses T# M6 + G43 H# tool length offsets instead of hand re-zeroing Z. */
  atc: boolean;
  /** Modal setup line; must appear before the first move. */
  setup: string;
  dwell: string;
  /** Lines after the final safe-Z raise. */
  end: string[];
}

export const MACHINES: Record<MachineId, Machine> = {
  grbl: {
    id: 'grbl', label: 'GRBL / FluidNC / grblHAL', short: 'GRBL', ext: 'nc',
    note: 'Shapeoko, X-Carve, Genmitsu, OpenBuilds and most hobby routers.',
    semicolon: false, upper: false, decimal: false, dwellPms: false, atc: false,
    setup: 'G21 G90 G17 G94', dwell: 'G4 P3', end: ['M5', 'M30'],
  },
  linuxcnc: {
    id: 'linuxcnc', label: 'LinuxCNC / PathPilot', short: 'LinuxCNC', ext: 'ngc',
    note: 'Also Tormach PathPilot. Adds G91.1 (incremental arc centres) and G64 P0.01 blending.',
    semicolon: false, upper: false, decimal: false, dwellPms: false, atc: false,
    setup: 'G21 G90 G17 G94 G91.1 G64 P0.01', dwell: 'G4 P3', end: ['M5', 'M30'],
  },
  mach: {
    id: 'mach', label: 'Mach3 / Mach4', short: 'Mach', ext: 'tap',
    note: 'Sets G91.1 so arcs are right whatever the IJ setting. Dwell assumes seconds (the default).',
    semicolon: false, upper: false, decimal: false, dwellPms: false, atc: false,
    setup: 'G21 G90 G17 G94 G91.1 G40 G49', dwell: 'G4 P3', end: ['M5', 'M30'],
  },
  marlin: {
    id: 'marlin', label: 'Marlin (Snapmaker, MPCNC, LowRider)', short: 'Marlin', ext: 'gcode',
    note: '; comments, G4 S dwell, no M30. M3 S is RPM, so set Marlin to RPM or use a manual router.',
    semicolon: true, upper: false, decimal: false, dwellPms: false, atc: false,
    setup: 'G21 G90', dwell: 'G4 S3', end: ['M5'],
  },
  fanuc: {
    id: 'fanuc', label: 'Fanuc / Haas (tool changer)', short: 'Fanuc', ext: 'nc',
    note: 'G54, T# M6 with G43 H# length offsets, decimal points on every axis, G4 P in ms.',
    semicolon: false, upper: true, decimal: true, dwellPms: true, atc: true,
    setup: 'G21 G90 G17 G94 G40 G49 G80', dwell: 'G4 P3000', end: ['M5', 'G91 G28 Z0.', 'G90', 'M30', '%'],
  },
};

export const machineFor = (job: { machine?: MachineId }): Machine => MACHINES[job.machine ?? 'grbl'] ?? MACHINES.grbl;

const num = (v: number, decimal = false) => {
  if (!Number.isFinite(v)) throw new Error(`Refusing to write a non-finite number (${v}) to G-code`);
  let s = v.toFixed(3);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return decimal && !s.includes('.') ? `${s}.` : s;
};

/** Comment safe for the target controller: no parentheses, single line, clipped to fit MAX_LINE. */
export function comment(text: string, m: Machine = MACHINES.grbl): string {
  let clean = text.replace(/[()]/g, '').replace(/[\r\n]+/g, ' ').replace(/;/g, ',').trim();
  if (m.upper) clean = clean.toUpperCase();
  return m.semicolon ? `; ${clean.slice(0, MAX_LINE - 2)}` : `(${clean.slice(0, MAX_LINE - 2)})`;
}

export function toolSlug(t: Tool25) {
  return `T${t.number}_${t.name.replace(/\//g, '-').replace(/[^\w.-]+/g, '-')}`;
}

export function fileName(job: Job25, plan: NcPlan) {
  const base = job.partName.replace(/\.[^.]+$/, '');
  return `${base}_${plan.index}_${plan.title}_${toolSlug(plan.tool)}.${machineFor(job).ext}`;
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
  const m = machineFor(job);
  const n = (v: number) => num(v, m.decimal);
  const c = (text: string) => comment(text, m);
  const ox = stock.minX, oy = stock.minY, oz = stock.top;
  const safe = job.clearance;
  const t = plan.tool;
  const body: string[] = [];
  let seconds = 2; // spindle dwell
  let pos = { x: 0, y: 0, z: safe };
  let mode = -1;
  let lx = '', ly = '', lz = '', lf = -1;
  for (const op of plan.ops) {
    body.push(c(`OP ${op.label}`));
    for (const s of toSegs(op.moves, ox, oy, oz)) {
      const len = segLength(pos, s);
      seconds += s.g === 0 ? (len / job.rapidRate) * 60 : (len / s.f) * 60;
      const sx = n(s.x), sy = n(s.y), sz = n(s.z);
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
      if (arc) parts.push(`I${n(s.i!)}`, `J${n(s.j!)}`);
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
  const base = job.partName.replace(/\.[^.]+$/, '');
  if (m.atc) head.push('%', `O${1000 + plan.index} ${c(`${base} ${plan.index} ${plan.title}`.slice(0, MAX_LINE - 10))}`);
  const cutting = plan.ops.some((o) => o.moves.some((mv) => mv.g !== 0));
  const est = cutting && Number.isFinite(seconds) ? `${Math.max(1, Math.ceil(seconds / 60))} min` : 'no cutting moves';
  head.push(c(`CAMSlicer 2.5D - ${job.partName}`));
  head.push(c(`Post: ${m.label}`));
  head.push(c(`File ${plan.index} of ${fileCount}, run in order: ${plan.title}`));
  head.push(c(`Tool T${t.number}: ${t.name}`));
  head.push(c(`T${t.number} D${num(t.diameter)} mm, ${t.flutes} flute, stepdown ${num(t.stepdown)} mm`));
  head.push(c(`Stepover ${Math.round(t.stepover * 100)} pct, ramp ${num(t.rampAngle)} deg, ${t.rpm} rpm`));
  head.push(c('Tools in this job:'));
  for (const tt of allTools) head.push(c(` T${tt.number} ${tt.name} D${num(tt.diameter)} ${tt.flutes}F SD${num(tt.stepdown)}`));
  head.push(c(`Stock ${num(stock.maxX - stock.minX)} x ${num(stock.maxY - stock.minY)} x ${num(stock.top - stock.bottom)} mm`));
  if (m.atc) {
    head.push(c('G54: XY0 = front-left corner of stock, Z0 = stock top'));
    head.push(c('Tool lengths in H offsets matching the T numbers'));
  } else {
    head.push(c('XY0 = front-left corner of stock, Z0 = stock top'));
    head.push(c('Same XY zero for all files, re-zero Z only after a bit change'));
  }
  head.push(c(`Est. run time ${est}`));
  head.push(m.setup);
  if (m.atc) {
    head.push('G54', `T${t.number} M6`, `G0 G43 H${t.number} Z${n(safe)}`, `S${Math.round(t.rpm)} M3`);
  } else {
    head.push(`G0 Z${n(safe)}`, `M3 S${Math.round(t.rpm)}`);
  }
  head.push(m.dwell);
  seconds += 1;
  while (body.length && body[body.length - 1] === `G0 Z${n(safe)}`) body.pop(); // footer raises Z
  const foot = [`G0 Z${n(safe)}`, ...m.end];
  return { text: [...head, ...body, ...foot].join('\n') + '\n', seconds: seconds + 2 };
}

/** Strip comments in the controller's style. */
export function stripComment(line: string): string {
  return line.replace(/\([^()]*\)/g, '').replace(/;.*$/, '').trim();
}

/** Seconds a G4 line dwells for, in the controller's units. */
export function dwellSeconds(code: string, m: Machine): number {
  const S = code.match(/\bS\s*([\d.]+)/);
  if (S) return parseFloat(S[1]);
  const P = code.match(/\bP\s*([\d.]+)/);
  if (!P) return 0;
  return m.dwellPms && !P[1].includes('.') ? parseFloat(P[1]) / 1000 : parseFloat(P[1]);
}

/** Validate the controller's formatting rules; returns a list of problems (empty = OK). */
export function checkFormat(text: string, m: Machine = MACHINES.grbl): string[] {
  const problems: string[] = [];
  const lines = text.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
  const endStart = lines.length - m.end.length;
  lines.forEach((l, i) => {
    if (/Infinity|NaN/i.test(l)) problems.push(`line ${i + 1} contains Infinity/NaN`);
    if (l.length > MAX_LINE) problems.push(`line ${i + 1} longer than ${MAX_LINE} chars`);
    const noParen = l.replace(/\([^()]*\)/g, '');
    if (m.semicolon ? /[()]/.test(l) : /[()]/.test(noParen)) {
      problems.push(m.semicolon ? `line ${i + 1} uses ( ) comments` : `line ${i + 1} has nested or unbalanced parentheses`);
    }
    const code = stripComment(l);
    if (/\bG(28|30)\b/.test(code) && !(m.atc && i >= endStart)) problems.push(`line ${i + 1} uses G28/G30`);
    if (!m.atc && (/\bM0?6\b/.test(code) || /\bT\d+/.test(code))) problems.push(`line ${i + 1} has a tool change`);
    if (m.decimal && /\b[XYZIJ]-?\d+(?![\d.])/.test(code)) problems.push(`line ${i + 1} has an axis value without a decimal point`);
  });
  const code = lines.map(stripComment).filter((l) => l);
  const isMove = (l: string) => /\bG0*[0-3]\b/.test(l) && /[XY]/.test(l) && !/\bG(28|53)\b/.test(l);
  const firstMove = code.findIndex(isMove);
  const firstCut = code.findIndex((l, i) => i >= firstMove && /\bG0*[1-3]\b/.test(l));
  const setupAt = code.indexOf(m.setup);
  if (setupAt < 0 || (firstMove >= 0 && setupAt > firstMove)) problems.push(`setup line "${m.setup}" missing before the first move`);
  const raise = code.findIndex((l) => /\bG0\b/.test(l) && /Z\d/.test(l));
  if (raise < 0 || (firstMove >= 0 && raise > firstMove)) problems.push('Z is not raised to a safe height before the first XY move');
  const spindle = code.findIndex((l) => /\bM0?3\b/.test(l) && /\bS\d/.test(l));
  if (spindle < 0 || (firstCut >= 0 && spindle > firstCut)) problems.push('spindle start "M3 S…" missing before the first cut');
  const dwell = code.findIndex((l, i) => i > spindle && /\bG0?4\b/.test(l));
  if (spindle >= 0 && (dwell < 0 || (firstCut >= 0 && dwell > firstCut) || dwellSeconds(code[dwell], m) < 1)) {
    problems.push('dwell of at least 1 s after spindle start missing');
  }
  if (m.atc) {
    const tc = code.find((l) => /\bT\d+\s+M0?6\b/.test(l))?.match(/T(\d+)/)?.[1];
    if (!tc) problems.push('tool change "T# M6" missing');
    else if (!code.some((l) => new RegExp(`\\bG43\\b.*\\bH${tc}\\b`).test(l))) problems.push(`G43 H${tc} length offset missing`);
  }
  const tail = code.slice(-(m.end.length + 1));
  if (!/^G0 Z\d/.test(tail[0] ?? '') || tail.slice(1).join('|') !== m.end.join('|')) {
    problems.push(`file must end with G0 Z<safe>, ${m.end.join(', ')}`);
  }
  if (!hasCuttingMoves(text)) problems.push('file has no cutting moves');
  return problems;
}

/** GRBL rules (kept for the CLI and older tests). */
export const checkGrbl = (text: string) => checkFormat(text, MACHINES.grbl);

/** True if any line moves an axis while the modal motion is G1/G2/G3. */
export function hasCuttingMoves(text: string): boolean {
  let mode = 0;
  for (const raw of text.split('\n')) {
    const l = stripComment(raw).toUpperCase();
    const g = l.match(/\bG0*([0-3])\b/);
    if (g) mode = +g[1];
    if (mode >= 1 && /[XYZ]\s*-?[\d.]/.test(l)) return true;
  }
  return false;
}
