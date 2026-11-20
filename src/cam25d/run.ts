/** One-call pipeline: plan → post → verify. Shared by the CLI, the worker and tests. */
import { planJob, type Plan } from './plan';
import { fileName, postFile } from './post';
import { verifyJob, type VerifyReport } from './verify';
import type { Job25 } from './types';

export interface JobOutput {
  plan: Plan;
  files: { name: string; text: string; seconds: number; index: number }[];
  report: VerifyReport;
}

export function runJob(pos: Float32Array, job: Job25): JobOutput {
  const plan = planJob(pos, job);
  const files = plan.files.map((f) => {
    const r = postFile(job, f, plan.stock, plan.tools, plan.files.length);
    return { name: fileName(job, f), text: r.text, seconds: r.seconds, index: f.index };
  });
  const report = verifyJob(
    pos,
    plan,
    job,
    files.map((f, i) => ({ name: f.name, text: f.text, tool: plan.files[i].tool })),
  );
  return { plan, files, report };
}

export function formatReport(out: JobOutput): string {
  const { report } = out;
  const L: string[] = [];
  const mins = (s: number) => `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}m`;
  L.push(`Verification: ${report.ok ? 'PASS' : 'FAIL'}`);
  for (const c of report.checks) L.push(`  [${c.ok ? 'ok' : 'FAIL'}] ${c.name}: ${c.detail}`);
  L.push('');
  L.push(`Estimated run time: ${mins(report.totalSeconds)} total`);
  for (const f of report.files) L.push(`  ${f.name}: ${mins(f.seconds)}`);
  L.push('');
  L.push('Per-operation summary:');
  L.push('  file  op                          time    cut m   moves  max axial mm');
  for (const o of report.ops) {
    const idx = out.files.find((f) => f.name === o.file)?.index ?? '?';
    L.push(`  ${String(idx).padEnd(5)} ${o.op.padEnd(27)} ${mins(o.seconds).padStart(7)} ${(o.cutLength / 1000).toFixed(2).padStart(7)} ${String(o.moves).padStart(7)}  ${o.maxEngagement.toFixed(3)}`);
  }
  if (out.plan.warnings.length || out.plan.skipped.length) {
    L.push('');
    for (const w of out.plan.skipped) L.push(`Skipped: ${w}`);
    for (const w of out.plan.warnings) L.push(`Warning: ${w}`);
  }
  return L.join('\n') + '\n';
}
