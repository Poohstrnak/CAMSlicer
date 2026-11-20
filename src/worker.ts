/** Background worker: the single toolpath generator (2.5D engine + verifier). */
import { encodePng } from './cam25d/png';
import { formatReport, runJob } from './cam25d/run';
import type { Job25, Move } from './cam25d/types';

export interface GenerateMessage {
  positions: Float32Array;
  job: Job25;
}

/** Arcs → short segments, packed as [kind, x, y, z] (kind 0 rapid, 1 feed, 2 plunge) for the viewer. */
function packMoves(moves: Move[]): Float32Array {
  const out: number[] = [];
  let px = NaN, py = NaN, pz = NaN;
  for (const m of moves) {
    if ((m.g === 2 || m.g === 3) && !Number.isNaN(px)) {
      const cx = m.cx!, cy = m.cy!;
      const R = Math.hypot(px - cx, py - cy);
      const a0 = Math.atan2(py - cy, px - cx), a1 = Math.atan2(m.y - cy, m.x - cx);
      let sw = m.g === 3 ? a1 - a0 : a0 - a1;
      while (sw <= 1e-9) sw += 2 * Math.PI;
      const n = Math.max(2, Math.ceil(sw / 0.15));
      for (let i = 1; i <= n; i++) {
        const a = a0 + ((m.g === 3 ? 1 : -1) * sw * i) / n;
        out.push(1, i === n ? m.x : cx + R * Math.cos(a), i === n ? m.y : cy + R * Math.sin(a), pz + ((m.z - pz) * i) / n);
      }
    } else {
      const kind = m.g === 0 ? 0 : m.z < pz - 1e-9 && Math.hypot(m.x - px, m.y - py) < 1e-9 ? 2 : 1;
      out.push(kind, m.x, m.y, m.z);
    }
    px = m.x; py = m.y; pz = m.z;
  }
  return new Float32Array(out);
}

self.onmessage = async (e: MessageEvent<GenerateMessage>) => {
  try {
    const { positions, job } = e.data;
    const out = runJob(positions, job);
    const png = await encodePng(out.report.image.width, out.report.image.height, out.report.image.rgba);
    const previews = out.plan.files.map((f) => packMoves(f.ops.flatMap((o) => o.moves)));
    const { image: _img, ...report } = out.report;
    void _img;
    self.postMessage(
      {
        type: 'done',
        files: out.files,
        fileTools: out.plan.files.map((f) => f.tool),
        report,
        reportText: formatReport(out),
        png,
        previews,
        stock: out.plan.stock,
        tabs: out.plan.tabs,
        tabTop: out.plan.tabTop,
        finalDepth: out.plan.finalDepth,
        warnings: out.plan.warnings,
        skipped: out.plan.skipped,
      },
      { transfer: [png.buffer, report.sim.h.buffer, report.sim.model.buffer, ...previews.map((p) => p.buffer)] },
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
