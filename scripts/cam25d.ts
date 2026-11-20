/**
 * CLI: generate and verify 2.5D G-code for a part.
 *   npx tsx scripts/cam25d.ts <model.stl> [outDir] [params.json]
 * Writes the .nc files only if every verification check passes; always writes report.png / report.txt.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { encodePng } from '../src/cam25d/png';
import { formatReport, runJob } from '../src/cam25d/run';
import { parseStl } from '../src/cam25d/stl';
import { defaultJob, type Job25 } from '../src/cam25d/types';

const [model, outDir = '.', paramsPath] = process.argv.slice(2);
if (!model) {
  console.error('usage: tsx scripts/cam25d.ts <model.stl> [outDir] [params.json]');
  process.exit(2);
}
const job: Job25 = { ...defaultJob(basename(model)), ...(paramsPath ? JSON.parse(readFileSync(paramsPath, 'utf8')) : {}) };
const t0 = performance.now();
const out = runJob(parseStl(readFileSync(model)), job);
mkdirSync(outDir, { recursive: true });
const base = job.partName.replace(/\.[^.]+$/, '');
const text = formatReport(out);
writeFileSync(join(outDir, `${base}_report.txt`), text);
writeFileSync(join(outDir, `${base}_report.png`), await encodePng(out.report.image.width, out.report.image.height, out.report.image.rgba));
if (out.report.ok) for (const f of out.files) writeFileSync(join(outDir, f.name), f.text);
process.stdout.write(text);
console.log(`${out.report.ok ? 'Wrote' : 'NOT written (verification failed):'} ${out.files.map((f) => f.name).join(', ')}`);
console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(out.report.ok ? 0 : 1);
