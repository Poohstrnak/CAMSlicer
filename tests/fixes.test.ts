/**
 * Regression tests for the "old raster engine still reachable" bug report:
 * single generator, largest-first tool order, no empty files, sane headers, tab geometry, verifier.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkGrbl, hasCuttingMoves, segLength } from '../src/cam25d/post';
import { runJob } from '../src/cam25d/run';
import { DEFAULT_LARGE, DEFAULT_SMALL, defaultJob, type Job25 } from '../src/cam25d/types';
import { verifyJob } from '../src/cam25d/verify';
import { circle, extrude, part, rect, toStl } from './parts';

const ROOT = join(__dirname, '..');
const sixteenth = { ...DEFAULT_SMALL, number: 1 }; // entered first on purpose
const eighth = { ...DEFAULT_LARGE, number: 2 };
const job: Job25 = { ...defaultJob('test-part.stl'), tools: [sixteenth, eighth] };
const out = runJob(part, job);

describe('exactly one generator', () => {
  it('the old raster engine is gone from the source tree', () => {
    expect(existsSync(join(ROOT, 'src/cam'))).toBe(false);
    const files = readdirSync(join(ROOT, 'src'), { recursive: true }) as string[];
    const writers: string[] = [];
    for (const f of files) {
      if (!/\.ts$/.test(f)) continue;
      const src = readFileSync(join(ROOT, 'src', f), 'utf8');
      expect(src, f).not.toMatch(/Roughing - flat endmill/);
      if (src.includes("'G21 G90 G17 G94'")) writers.push(f);
    }
    expect(writers).toEqual(['cam25d/post.ts']); // the only G-code writer
  });

  it('UI export path: the worker hands the UI only runJob output', () => {
    const worker = readFileSync(join(ROOT, 'src/worker.ts'), 'utf8');
    expect(worker).toMatch(/runJob\(/);
    const main = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');
    expect(main).not.toMatch(/toGcode|runCam/);
    // every download of G-code goes through exportFile, which refuses unverified results
    expect(main).toMatch(/function exportFile[\s\S]*?if \(!result\?\.report\.ok\) return;/);
  });

  it('engine entry point: every file starts "(CAMSlicer 2.5D"', () => {
    for (const f of out.files) expect(f.text.split('\n')[0]).toMatch(/^\(CAMSlicer 2\.5D/);
  });

  it('CLI entry point: every written file starts "(CAMSlicer 2.5D"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'camslicer-'));
    const stl = join(dir, 'cli-part.stl');
    writeFileSync(stl, toStl(part));
    execFileSync('npx', ['tsx', 'scripts/cam25d.ts', stl, dir], { cwd: ROOT, stdio: 'pipe' });
    const nc = readdirSync(dir).filter((f) => f.endsWith('.nc'));
    expect(nc).toHaveLength(3);
    for (const f of nc) expect(readFileSync(join(dir, f), 'utf8').split('\n')[0]).toMatch(/^\(CAMSlicer 2\.5D/);
  }, 60_000);
});

describe('tool order', () => {
  it('1/16" entered before 1/8" still gives 1 = 1/8" rough, 2 = 1/16" rest, 3 = 1/8" cut-out', () => {
    expect(out.report.ok).toBe(true);
    expect(out.files.map((f) => f.name.replace('test-part_', ''))).toEqual([
      '1_roughing_T1_1-8in-O-flute.nc',
      '2_rest-detail_T2_1-16in-O-flute.nc',
      '3_cutout_T1_1-8in-O-flute.nc',
    ]);
    expect(out.files[0].text).toMatch(/\(Tool T1: 1\/8in O-flute\)/);
    expect(out.files[1].text).toMatch(/\(Tool T2: 1\/16in O-flute\)/);
    expect(out.files[2].text).toMatch(/\(Tool T1: 1\/8in O-flute\)/);
  });
});

describe('no empty files, sane headers', () => {
  it('every file has cutting moves and no Infinity/NaN', () => {
    for (const f of out.files) {
      expect(hasCuttingMoves(f.text), f.name).toBe(true);
      expect(f.text).not.toMatch(/Infinity|NaN/);
      expect(f.text).not.toMatch(/Est\. run time 0 min/);
      expect(checkGrbl(f.text)).toEqual([]);
    }
  });

  it('a tool with nothing left to cut is skipped with a reason', () => {
    // plate with one big round pocket: the 1/8" reaches everything; with no wall finish the 1/16" has nothing to do
    const tris: number[] = [];
    extrude([rect(0, 0, 40, 40)], 0, 2, tris);
    extrude([rect(0, 0, 40, 40), circle(20, 20, 10).reverse()], 2, 3, tris);
    const r = runJob(new Float32Array(tris), { ...job, wallFinish: false });
    expect(r.files.map((f) => f.name)).not.toContain(expect.stringContaining('1-16in'));
    expect(r.plan.skipped).toEqual(['1/16in O-flute: nothing left to cut after 1/8in O-flute']);
    expect(r.files.map((f) => f.index)).toEqual([1, 2]); // renumbered, no gaps
    for (const f of r.files) expect(f.text).toMatch(new RegExp(`File ${f.index} of 2`));
  });

  it('checkGrbl rejects a file with no cutting moves or non-finite numbers', () => {
    const empty = 'G21 G90 G17 G94\nG0 Z5\nM3 S16000\nG4 P3\nG0 X1 Y1\nZ1\nG0 Z5\nM5\nM30\n';
    expect(checkGrbl(empty)).toContain('file has no cutting moves');
    expect(checkGrbl(empty.replace('G0 X1 Y1', '(min Z Infinity)\nG1 X1 F100')).join()).toMatch(/Infinity/);
  });
});

describe('cut-out tabs', () => {
  const cut = out.files[2].text;
  const thickness = 3, through = job.throughDepth;
  const finalZ = -thickness - through; // -3.3
  const tabTop = finalZ + job.tabHeight; // -2.5

  /** Flat runs of cutting moves at the tab-top Z, with their XY lengths. */
  function flatRunsAt(z: number) {
    const runs: number[] = [];
    let cur = { x: 0, y: 0, z: 5 }, mode = 0, run = -1;
    for (const raw of cut.split('\n')) {
      const l = raw.replace(/\([^)]*\)/g, '');
      const w = Object.fromEntries([...l.matchAll(/([GXYZIJ])(-?[\d.]+)/g)].map((m) => [m[1], parseFloat(m[2])]));
      if (w.G !== undefined && w.G <= 3) mode = w.G;
      if (w.X === undefined && w.Y === undefined && w.Z === undefined) continue;
      const next = { x: w.X ?? cur.x, y: w.Y ?? cur.y, z: w.Z ?? cur.z };
      const flatHere = mode >= 1 && Math.abs(next.z - z) < 1e-6 && Math.abs(cur.z - z) < 1e-6;
      if (flatHere) {
        const len = segLength(cur, { g: mode as 1 | 2 | 3, x: next.x, y: next.y, z: next.z, f: 1, i: w.I, j: w.J });
        if (run < 0) { runs.push(0); run = runs.length - 1; }
        runs[run] += len;
      } else run = -1;
      cur = next;
    }
    return runs.filter((r) => r > 0.01);
  }

  it('tab top = final depth + tab height', () => {
    expect(out.plan.tabTop - out.plan.stock.top).toBeCloseTo(tabTop, 2);
    expect(cut).toMatch(new RegExp(`Z${tabTop.toFixed(1)}\\b`));
    // nothing on the final pass rides higher than the tab top
    const final = cut.slice(cut.indexOf('(OP cutout pass 4/4'));
    const zs = [...final.matchAll(/^G1 .*Z(-?[\d.]+)|^Z(-?[\d.]+)/gm)].map((m) => parseFloat(m[1] ?? m[2]));
    expect(Math.max(...zs.filter((z) => z < 0))).toBeLessThanOrEqual(tabTop + 0.01);
  });

  it('six tabs whose flat top is tab_width long', () => {
    const runs = flatRunsAt(tabTop);
    expect(runs).toHaveLength(6);
    for (const r of runs) expect(Math.abs(r - job.tabWidth)).toBeLessThanOrEqual(0.5);
  });
});

describe('verifier gate', () => {
  it('rejects a cut-out that frees the part without tabs', () => {
    const noTabs = runJob(part, { ...job, tabCount: 0 });
    const files = noTabs.files.map((f, i) => ({ name: f.name, text: f.text, tool: noTabs.plan.files[i].tool }));
    const rep = verifyJob(part, noTabs.plan, { ...job, tabCount: 6 }, files);
    expect(rep.ok).toBe(false);
    expect(rep.checks.find((c) => c.name === 'Part attached by tabs')!.ok).toBe(false);
  });

  it('the CLI writes nothing when verification fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'camslicer-fail-'));
    const stl = join(dir, 'fail-part.stl');
    writeFileSync(stl, toStl(part));
    // tabs narrower than the tool are cut away -> part breaks loose -> verification must fail
    writeFileSync(join(dir, 'p.json'), JSON.stringify({ tabWidth: 2 }));
    let code = 0;
    try {
      execFileSync('npx', ['tsx', 'scripts/cam25d.ts', stl, dir, join(dir, 'p.json')], { cwd: ROOT, stdio: 'pipe' });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(1);
    expect(readdirSync(dir).filter((f) => f.endsWith('.nc'))).toEqual([]);
  }, 60_000);
});
