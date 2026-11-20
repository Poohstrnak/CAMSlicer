/**
 * Built-in verification: simulates the exported G-code (parsed back from text) on a heightmap
 * with a flat-end tool and checks gouges, floors, rapids, axial engagement, tab attachment and depth.
 */
import { intersect, offset, opening, type Shape } from './geom';
import type { Plan } from './plan';
import { checkFormat, dwellSeconds, machineFor, stripComment, type Machine } from './post';
import type { Job25, Tool25 } from './types';

export const SIM_RES = 0.1;
const NONE = -1e9;

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
export interface OpSummary {
  file: string;
  op: string;
  tool: string;
  seconds: number;
  cutLength: number;
  moves: number;
  maxEngagement: number;
}
export interface FileReport {
  name: string;
  ok: boolean;
  seconds: number;
  problems: string[];
}
export interface VerifyReport {
  ok: boolean;
  checks: Check[];
  files: FileReport[];
  ops: OpSummary[];
  totalSeconds: number;
  image: { width: number; height: number; rgba: Uint8ClampedArray };
  /** Final simulated material and model surface on the sim grid (NONE = -1e9 outside the part). */
  sim: { x0: number; y0: number; res: number; nx: number; ny: number; h: Float32Array; model: Float32Array };
}

export interface SimFile {
  name: string;
  text: string;
  tool: Tool25;
}

class SimGrid {
  readonly nx: number;
  readonly ny: number;
  readonly h: Float32Array; // remaining material top
  readonly model: Float32Array; // part top surface (NONE outside the part)
  readonly gouge: Uint8Array;
  readonly rapidHit: Uint8Array;
  constructor(
    readonly x0: number,
    readonly y0: number,
    w: number,
    hgt: number,
    top: number,
  ) {
    this.nx = Math.ceil(w / SIM_RES) + 1;
    this.ny = Math.ceil(hgt / SIM_RES) + 1;
    const n = this.nx * this.ny;
    this.h = new Float32Array(n).fill(top);
    this.model = new Float32Array(n).fill(NONE);
    this.gouge = new Uint8Array(n);
    this.rapidHit = new Uint8Array(n);
  }
  x(i: number) {
    return this.x0 + i * SIM_RES;
  }
  y(j: number) {
    return this.y0 + j * SIM_RES;
  }
}

/** Exact top-surface sampling at cell centres (no edge dilation, so vertical walls stay sharp). */
function rasterizeModel(g: SimGrid, pos: Float32Array) {
  for (let t = 0; t < pos.length; t += 9) {
    const ax = pos[t], ay = pos[t + 1], az = pos[t + 2];
    const bx = pos[t + 3], by = pos[t + 4], bz = pos[t + 5];
    const cx = pos[t + 6], cy = pos[t + 7], cz = pos[t + 8];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) continue;
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - g.x0) / SIM_RES));
    const i1 = Math.min(g.nx - 1, Math.floor((Math.max(ax, bx, cx) - g.x0) / SIM_RES));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - g.y0) / SIM_RES));
    const j1 = Math.min(g.ny - 1, Math.floor((Math.max(ay, by, cy) - g.y0) / SIM_RES));
    for (let j = j0; j <= j1; j++) {
      const py = g.y(j);
      for (let i = i0; i <= i1; i++) {
        const px = g.x(i);
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
        if (l1 < -1e-9) continue;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
        if (l2 < -1e-9) continue;
        const l3 = 1 - l1 - l2;
        if (l3 < -1e-9) continue;
        const z = l1 * az + l2 * bz + l3 * cz;
        const k = j * g.nx + i;
        if (z > g.model[k]) g.model[k] = z;
      }
    }
  }
}

/** Point-in-shape mask (even-odd scanline fill) on the sim grid. */
function rasterizeShape(g: SimGrid, shape: Shape): Uint8Array {
  const mask = new Uint8Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++) {
    const y = g.y(j);
    const xs: number[] = [];
    for (const r of shape) {
      for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
        const p = r[a], q = r[b];
        if (p.y > y !== q.y > y) xs.push(p.x + ((y - p.y) * (q.x - p.x)) / (q.y - p.y));
      }
    }
    xs.sort((u, v) => u - v);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const i0 = Math.max(0, Math.ceil((xs[s] - g.x0) / SIM_RES));
      const i1 = Math.min(g.nx - 1, Math.floor((xs[s + 1] - g.x0) / SIM_RES));
      for (let i = i0; i <= i1; i++) mask[j * g.nx + i] = 1;
    }
  }
  return mask;
}

interface Motion {
  g: number;
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
  f: number;
  op: string;
  kind: string;
}

/** Parse G-code (any supported dialect) into straight motions (arcs linearised), in model coordinates. */
function parseGcode(text: string, ox: number, oy: number, oz: number, m: Machine, onOp: (label: string) => void) {
  const out: Motion[] = [];
  let x = 0, y = 0, z = 0, f = 0, g = 0;
  let known = false;
  let op = '', kind = '';
  let dwell = 0;
  for (const raw of text.split('\n')) {
    const cm = raw.match(/^(?:\(OP ([^)]*)\)|; OP (.*))$/i);
    if (cm) {
      op = cm[1] ?? cm[2];
      kind = op.split(' ')[0].toLowerCase();
      onOp(op);
      out.push({ g: -1, x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, f: 0, op, kind }); // marker
      continue;
    }
    const line = stripComment(raw).toUpperCase();
    if (!line) continue;
    if (/\bG(28|53)\b/.test(line)) continue; // machine-coordinate return (Fanuc footer), not a work move
    if (/\bG0?4\b/.test(line)) { dwell += dwellSeconds(line, m); continue; }
    const words = [...line.matchAll(/([A-Z])\s*(-?[\d.]+)/g)].map((m) => [m[1], parseFloat(m[2])] as const);
    let nx = x, ny = y, nz = z, I = 0, J = 0, move = false;
    for (const [L, v] of words) {
      if (L === 'G') {
        if (v <= 3) g = v;
      } else if (L === 'X') { nx = v + ox; move = true; }
      else if (L === 'Y') { ny = v + oy; move = true; }
      else if (L === 'Z') { nz = v + oz; move = true; }
      else if (L === 'I') I = v;
      else if (L === 'J') J = v;
      else if (L === 'F') f = v;
    }
    if (!move) continue;
    if (!known) {
      // first positioning move: only Z may be known; treat position as current
      if (!words.some(([L]) => L === 'X')) nx = x;
      if (!words.some(([L]) => L === 'Y')) ny = y;
    }
    if ((g === 2 || g === 3) && known) {
      const cx = x + I, cy = y + J;
      const R = Math.hypot(x - cx, y - cy);
      let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx);
      let sweep = g === 3 ? a1 - a0 : a0 - a1;
      while (sweep <= 1e-9) sweep += 2 * Math.PI;
      const steps = Math.max(2, Math.ceil(sweep / (2 * Math.acos(Math.max(-1, 1 - 0.002 / Math.max(R, 0.003))))));
      let px = x, py = y, pz = z;
      for (let s = 1; s <= steps; s++) {
        const a = a0 + (g === 3 ? 1 : -1) * (sweep * s) / steps;
        const qx = s === steps ? nx : cx + R * Math.cos(a), qy = s === steps ? ny : cy + R * Math.sin(a);
        const qz = z + ((nz - z) * s) / steps;
        out.push({ g, x0: px, y0: py, z0: pz, x1: qx, y1: qy, z1: qz, f, op, kind });
        px = qx; py = qy; pz = qz;
      }
    } else if (known) {
      out.push({ g, x0: x, y0: y, z0: z, x1: nx, y1: ny, z1: nz, f, op, kind });
    }
    x = nx; y = ny; z = nz;
    if (words.some(([L]) => L === 'X') && words.some(([L]) => L === 'Y')) known = true;
    else if (!known) known = false;
  }
  return { motions: out, dwell };
}

export function verifyJob(pos: Float32Array, plan: Plan, job: Job25, files: SimFile[]): VerifyReport {
  const { stock } = plan;
  const machine = machineFor(job);
  const maxD = Math.max(...files.map((f) => f.tool.diameter));
  const margin = maxD + 5;
  const g = new SimGrid(stock.minX - margin, stock.minY - margin, stock.maxX - stock.minX + 2 * margin, stock.maxY - stock.minY + 2 * margin, stock.top);
  rasterizeModel(g, pos);
  const { nx, ny } = g;
  const finalDepth = stock.bottom - job.throughDepth;
  const checks: Check[] = [];
  const ops: OpSummary[] = [];
  const fileReports: FileReport[] = [];
  const minTool = Math.min(...files.map((f) => f.tool.diameter)) / 2;

  // part cells (for attachment) and the outer sheet border
  const partCells: number[] = [];
  for (let k = 0; k < g.model.length; k += 7) if (g.model[k] > NONE / 2) partCells.push(k);

  let gougeCount = 0, gougeMax = 0, rapidCount = 0, plungeCount = 0;
  let rapidFirst = '';
  const rapidFiles = new Map<string, number>();
  let engageFail = 0, engageWorst = 0, engageWhere = '';
  let minZ = Infinity;
  const attachFails: string[] = [];
  let totalSeconds = 0;

  const attached = (): boolean => {
    const mat = (k: number) => g.h[k] > stock.bottom + 0.01;
    const seen = new Uint8Array(nx * ny);
    const stack: number[] = [];
    for (let i = 0; i < nx; i++) for (const j of [0, ny - 1]) { const k = j * nx + i; if (mat(k)) { seen[k] = 1; stack.push(k); } }
    for (let j = 0; j < ny; j++) for (const i of [0, nx - 1]) { const k = j * nx + i; if (mat(k) && !seen[k]) { seen[k] = 1; stack.push(k); } }
    while (stack.length) {
      const k = stack.pop()!;
      const i = k % nx;
      const nb = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, k - nx, k + nx];
      for (const q of nb) {
        if (q < 0 || q >= nx * ny || seen[q] || !mat(q)) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    return partCells.some((k) => seen[k]);
  };

  for (const file of files) {
    const problems = checkFormat(file.text, machine).map((p) => `${machine.short} format: ${p}`);
    const r = file.tool.diameter / 2;
    const rG = r - 0.02; // footprint for gouge detection (0.02 mm XY tolerance)
    const rE = r - 0.03; // footprint for engagement / rapid checks (ignore grazing the edge of a wall)
    const maxSd = file.tool.stepdown + 0.05;
    let opSum: OpSummary | null = null;
    let seconds = 0;
    const cutoutPasses: string[] = [];
    const { motions, dwell } = parseGcode(file.text, stock.minX, stock.minY, stock.top, machine, () => {});
    seconds += dwell;
    let lastWasCutout = false;
    const closeCutoutPass = (label: string, isLast: boolean) => {
      const ok = attached();
      if (!ok && !(isLast && job.tabCount === 0)) attachFails.push(`${file.name}: part loose after ${label}`);
    };
    for (let mi = 0; mi < motions.length; mi++) {
      const m = motions[mi];
      if (m.g === -1) {
        if (lastWasCutout && opSum) closeCutoutPass(opSum.op, false);
        opSum = { file: file.name, op: m.op, tool: file.tool.name, seconds: 0, cutLength: 0, moves: 0, maxEngagement: 0 };
        ops.push(opSum);
        lastWasCutout = m.kind === 'cutout';
        if (lastWasCutout) cutoutPasses.push(m.op);
        continue;
      }
      const dx = m.x1 - m.x0, dy = m.y1 - m.y0, dz = m.z1 - m.z0;
      const len = Math.hypot(dx, dy, dz);
      const t = m.g === 0 ? (len / job.rapidRate) * 60 : m.f > 0 ? (len / m.f) * 60 : 0;
      seconds += t;
      if (opSum) {
        opSum.seconds += t;
        opSum.moves++;
        if (m.g !== 0) opSum.cutLength += len;
      }
      if (m.g !== 0) minZ = Math.min(minZ, m.z0, m.z1);
      const xy = Math.hypot(dx, dy);
      const isRamp = m.g !== 0 && dz < -1e-6 && xy > 1e-6;
      const isPlunge = m.g !== 0 && dz < -1e-6 && xy <= 1e-6;
      const exempt = m.kind === 'wall' || isRamp;

      // sweep the footprint
      const bx0 = Math.max(0, Math.floor((Math.min(m.x0, m.x1) - r - g.x0) / SIM_RES));
      const bx1 = Math.min(nx - 1, Math.ceil((Math.max(m.x0, m.x1) + r - g.x0) / SIM_RES));
      const by0 = Math.max(0, Math.floor((Math.min(m.y0, m.y1) - r - g.y0) / SIM_RES));
      const by1 = Math.min(ny - 1, Math.ceil((Math.max(m.y0, m.y1) + r - g.y0) / SIM_RES));
      const a = dx * dx + dy * dy;
      let engage = 0;
      for (let j = by0; j <= by1; j++) {
        const qy = g.y(j);
        for (let i = bx0; i <= bx1; i++) {
          const qx = g.x(i);
          const px = m.x0 - qx, py = m.y0 - qy;
          const c = px * px + py * py;
          // t-interval where the cell centre is under the tool (|p(t)-q| <= r)
          let t0: number, t1: number;
          if (a < 1e-12) {
            if (c > r * r) continue;
            t0 = 0; t1 = 1;
          } else {
            const b = 2 * (dx * px + dy * py);
            const disc = b * b - 4 * a * (c - r * r);
            if (disc < 0) continue;
            const sq = Math.sqrt(disc);
            t0 = Math.max(0, (-b - sq) / (2 * a));
            t1 = Math.min(1, (-b + sq) / (2 * a));
            if (t0 > t1) continue;
          }
          const zc = Math.min(m.z0 + dz * t0, m.z0 + dz * t1);
          const k = j * nx + i;
          const hk = g.h[k];
          if (hk > zc + 1e-6) {
            // is the cell inside the slightly smaller check footprint?
            let core: boolean;
            if (a < 1e-12) core = c <= rE * rE;
            else {
              const b2 = 2 * (dx * px + dy * py);
              const d2 = b2 * b2 - 4 * a * (c - rE * rE);
              core = d2 >= 0 && Math.max(0, (-b2 - Math.sqrt(d2)) / (2 * a)) <= Math.min(1, (-b2 + Math.sqrt(d2)) / (2 * a));
            }
            if (core) {
              if (m.g === 0) {
                if (hk > zc + 0.005) {
                  g.rapidHit[k] = 1;
                  rapidCount++;
                  rapidFiles.set(file.name, (rapidFiles.get(file.name) ?? 0) + 1);
                  if (!rapidFirst) {
                    const w = (v: number) => v.toFixed(2);
                    rapidFirst = `first in file ${file.name.match(/_(\d+)_[^_]+_T\d+/)?.[1] ?? file.name}, ${m.op || 'header'}: ` +
                      `G0 to X${w(m.x1 - stock.minX)} Y${w(m.y1 - stock.minY)} Z${w(m.z1 - stock.top)} ` +
                      `passes Z${w(zc - stock.top)} over material at Z${w(hk - stock.top)} (X${w(qx - stock.minX)} Y${w(qy - stock.minY)})`;
                  }
                }
              } else if (!exempt) {
                const e = hk - zc;
                if (e > engage) engage = e;
              }
            }
            g.h[k] = zc;
          }
          // gouge test on the slightly smaller footprint
          if (g.model[k] > NONE / 2 && zc < g.model[k] - 0.02) {
            let inside = a < 1e-12 ? c <= rG * rG : false;
            if (!inside && a >= 1e-12) {
              const b = 2 * (dx * px + dy * py);
              const disc = b * b - 4 * a * (c - rG * rG);
              if (disc >= 0) {
                const sq = Math.sqrt(disc);
                inside = Math.max(0, (-b - sq) / (2 * a)) <= Math.min(1, (-b + sq) / (2 * a));
              }
            }
            if (inside) {
              if (!g.gouge[k]) gougeCount++;
              g.gouge[k] = 1;
              gougeMax = Math.max(gougeMax, g.model[k] - zc);
            }
          }
        }
      }
      if (isPlunge && engage > 0.05) plungeCount++;
      if (!isPlunge && engage > maxSd) {
        engageFail++;
        if (engage > engageWorst) {
          engageWorst = engage;
          engageWhere = `${file.name} ${m.op} at X${(m.x1 - stock.minX).toFixed(2)} Y${(m.y1 - stock.minY).toFixed(2)}`;
        }
      }
      if (opSum && !isPlunge) opSum.maxEngagement = Math.max(opSum.maxEngagement, engage);
    }
    if (lastWasCutout && opSum) closeCutoutPass(opSum.op, true);
    fileReports.push({ name: file.name, ok: problems.length === 0, seconds, problems });
    totalSeconds += seconds;
  }

  // floors: each flat level within ±0.02 where the smallest tool can reach
  const floorFails: string[] = [];
  const failMask = new Uint8Array(nx * ny);
  const ws = job.wallFinish ? 0 : job.finishStepover;
  for (const band of plan.bands) {
    if (band.level <= stock.bottom) continue;
    // reachable floor of this level, kept 0.1 mm (one grid cell) away from every wall and deeper pocket
    const reach = intersect(offset(opening(band.region, minTool), -(ws + 0.1)), offset(band.floor, -0.1));
    const mask = rasterizeShape(g, reach);
    let n = 0, bad = 0, worst = 0;
    for (let k = 0; k < mask.length; k++) {
      if (!mask[k] || Math.abs(g.model[k] - band.level) > 1e-3) continue;
      n++;
      const dev = g.h[k] - band.level;
      if (Math.abs(dev) > 0.02) {
        bad++;
        failMask[k] = 1;
        if (Math.abs(dev) > Math.abs(worst)) worst = dev;
      }
    }
    if (bad) floorFails.push(`Z${(band.level - stock.top).toFixed(3)}: ${bad}/${n} cells off by up to ${worst.toFixed(3)} mm`);
  }

  const grblProblems = fileReports.flatMap((f) => f.problems);
  checks.push({ name: `${machine.short} format`, ok: grblProblems.length === 0, detail: grblProblems.slice(0, 5).join('; ') || 'all rules pass' });
  checks.push({ name: 'No gouge', ok: gougeCount === 0, detail: gougeCount ? `${gougeCount} cells, up to ${gougeMax.toFixed(3)} mm into the part` : 'never below the model surface (0.02 mm tolerance)' });
  checks.push({ name: 'Floors exact', ok: floorFails.length === 0, detail: floorFails.join('; ') || 'all flat levels within ±0.02 mm' });
  checks.push({ name: 'Rapids clear', ok: rapidCount === 0, detail: rapidCount ? `${rapidCount} cells hit by G0 moves (${[...rapidFiles].map(([f, n]) => `file ${f.match(/_(\d+)_[^_]+_T\d+/)?.[1] ?? f}: ${n}`).join(', ')}); ${rapidFirst}` : 'no G0 move touches material' });
  checks.push({ name: 'Axial engagement', ok: engageFail === 0 && plungeCount === 0, detail: [engageFail ? `${engageFail} moves exceed stepdown, worst ${engageWorst.toFixed(3)} mm (${engageWhere})` : '', plungeCount ? `${plungeCount} straight plunges into material` : ''].filter(Boolean).join('; ') || 'within stepdown + 0.05 mm (ramps and wall finish exempt); plunges only into air' });
  checks.push({ name: 'Part attached by tabs', ok: attachFails.length === 0, detail: attachFails.slice(0, 3).join('; ') || 'attached after every cut-out pass' });
  checks.push({ name: 'Cut depth', ok: minZ >= finalDepth - 1e-3, detail: `deepest cut Z${(minZ - stock.top).toFixed(3)}, limit Z${(finalDepth - stock.top).toFixed(3)}` });

  const image = renderImage(g, stock.bottom - job.throughDepth, stock.top, failMask);
  const ok = checks.every((c) => c.ok);
  const sim = { x0: g.x0, y0: g.y0, res: SIM_RES, nx, ny, h: g.h, model: g.model };
  return { ok, checks, files: fileReports, ops, totalSeconds, image, sim };
}

/** Top-down heightmap: grey by depth, part outline tinted, gouges red, rapid hits magenta, floor misses yellow. */
function renderImage(g: SimGrid, zLo: number, zHi: number, floorFail: Uint8Array) {
  const { nx, ny } = g;
  const rgba = new Uint8ClampedArray(nx * ny * 4);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const o = ((ny - 1 - j) * nx + i) * 4; // flip so +Y is up
      const v = Math.max(0, Math.min(1, (g.h[k] - zLo) / (zHi - zLo)));
      let r = 40 + v * 200, gg = 40 + v * 200, b = 45 + v * 200;
      if (g.model[k] > NONE / 2) { r *= 0.85; gg *= 0.95; b = Math.min(255, b * 1.08); }
      if (floorFail[k]) { r = 240; gg = 200; b = 40; }
      if (g.rapidHit[k]) { r = 220; gg = 40; b = 220; }
      if (g.gouge[k]) { r = 255; gg = 0; b = 0; }
      rgba[o] = r; rgba[o + 1] = gg; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  }
  return { width: nx, height: ny, rgba };
}
