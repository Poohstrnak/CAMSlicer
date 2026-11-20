import { describe, expect, it } from 'vitest';
import { area, difference, regions, union } from '../src/cam25d/geom';
import { restRegion, splitLayers } from '../src/cam25d/plan';
import { checkFormat, checkGrbl, comment, MACHINES, MAX_LINE, stripComment } from '../src/cam25d/post';
import { runJob } from '../src/cam25d/run';
import { detectLevels, SlicedModel, sliceMesh } from '../src/cam25d/slice';
import { PathLoop, placeTabs } from '../src/cam25d/toolpath';
import { defaultJob, type MachineId } from '../src/cam25d/types';
import { verifyJob } from '../src/cam25d/verify';

import { circle, outline, part, pocketA, pocketB, rect, slot } from './parts';

// ------------------------------------------------------------------ slicing & levels

describe('vector slicing', () => {
  it('cross-sections are exact polygons, not grid samples', () => {
    const s = sliceMesh(part, 2.5);
    const expected = area(difference(outline, union(pocketA, union(pocketB, slot))));
    expect(area(s)).toBeCloseTo(expected, 1);
    // circle vertices survive with sub-0.01 mm accuracy (simplification ≤ 0.01)
    const ringPts = s.flat();
    const onCircleA = ringPts.filter((p) => Math.abs(Math.hypot(p.x - 15, p.y - 22) - 8) < 0.01);
    expect(onCircleA.length).toBeGreaterThan(20);
    // not quantised to a 0.25 / 0.1 grid
    const offGrid = ringPts.filter((p) => Math.abs(p.x * 10 - Math.round(p.x * 10)) > 1e-3);
    expect(offGrid.length).toBeGreaterThan(10);
  });

  it('the sliced model reports clearable regions per level', () => {
    const m = new SlicedModel(part);
    expect(area(m.outline)).toBeCloseTo(2400, 0);
    expect(area(m.clearAt(1))).toBeCloseTo(area(pocketA), 0);
    expect(area(m.clearAt(2))).toBeCloseTo(area(union(pocketA, union(pocketB, slot))), 0);
    expect(regions(m.clearAt(2)).length).toBe(3); // A, B (with island hole), slot
  });
});

describe('level detection', () => {
  it('finds every horizontal up-facing level', () => {
    const lv = detectLevels(part);
    expect(lv.top).toBe(3);
    expect(lv.bottom).toBe(0);
    expect(lv.flats).toEqual(expect.arrayContaining([3, 2, 1]));
    expect(lv.flats).not.toContain(0); // the bottom faces down
  });

  it('splits stepdowns evenly and lands exactly on the level', () => {
    expect(splitLayers(3, 2, 1)).toEqual([2]);
    const l = splitLayers(2, 1, 0.35);
    expect(l).toHaveLength(3);
    expect(l[2]).toBe(1);
    for (let i = 0, prev = 2; i < l.length; prev = l[i++]) expect(prev - l[i]).toBeLessThanOrEqual(0.35 + 1e-9);
    expect(splitLayers(3, -0.3, 1)).toHaveLength(4);
  });
});

// ------------------------------------------------------------------ rest regions

describe('rest-region computation', () => {
  it('square pocket: only the four corners are left for the small tool', () => {
    const r = 3.175 / 2;
    const rest = restRegion([rect(0, 0, 20, 20)], r, 0);
    const parts = regions(rest);
    expect(parts).toHaveLength(4);
    // each corner fillet area = r² (1 − π/4)
    for (const p of parts) expect(area(p)).toBeCloseTo(r * r * (1 - Math.PI / 4), 1);
  });

  it('round pocket: nothing left over', () => {
    expect(regions(restRegion([circle(0, 0, 10, 256)], 1.5875, 0))).toHaveLength(0);
  });

  it('slot narrower than the large tool is entirely rest', () => {
    const rest = restRegion(slot, 1.5875, 0);
    expect(area(rest)).toBeCloseTo(area(slot), 0);
  });
});

// ------------------------------------------------------------------ tabs

describe('tab placement', () => {
  const ring = rect(0, 0, 100, 50).reverse(); // CW like a cut-out path
  const loop = new PathLoop(ring);
  const tabs = placeTabs(loop, 6, 6, 3.175);

  it('places the requested count, roughly evenly spaced', () => {
    expect(tabs).toHaveLength(6);
    const gaps = tabs.map((t, i) => loop.wrap(tabs[(i + 1) % tabs.length].s - t.s));
    for (const g of gaps) expect(g).toBeGreaterThan(loop.length / 6 * 0.4);
  });

  it('keeps every tab off the corners', () => {
    for (const t of tabs) expect(loop.turning(t.s0 - 3.175, t.s1 + 3.175)).toBeLessThan(12);
  });
});

// ------------------------------------------------------------------ GRBL formatting

describe('GRBL formatting rules', () => {
  it('flags violations', () => {
    const good = 'G21 G90 G17 G94\nG0 Z5\nM3 S16000\nG4 P3\nG1 X1 F100\nG0 Z5\nM5\nM30\n';
    expect(checkGrbl(good)).toEqual([]);
    expect(checkGrbl(good.replace('G1 X1 F100', 'T1 M6'))).not.toEqual([]);
    expect(checkGrbl(good.replace('G1 X1 F100', 'G28'))).not.toEqual([]);
    expect(checkGrbl(good.replace('G1 X1 F100', '(a (nested) comment)'))).not.toEqual([]);
    expect(checkGrbl(good.replace('G1 X1 F100', 'G1 X' + '1'.repeat(80)))).not.toEqual([]);
    expect(checkGrbl(good.replace('M3 S16000\n', ''))).not.toEqual([]);
    expect(checkGrbl(good.replace('M5\nM30\n', 'M30\n'))).not.toEqual([]);
  });

  it('comments are sanitised and fit the line limit', () => {
    const c = comment('Tool (1/8") '.repeat(20));
    expect(c.length).toBeLessThanOrEqual(MAX_LINE);
    expect(c.slice(1, -1)).not.toMatch(/[()]/);
  });
});

// ------------------------------------------------------------------ end to end with verification

describe('2.5D job end to end', () => {
  const job = defaultJob('test-part.stl');
  const out = runJob(part, job);

  it('produces three verified files in run order', () => {
    if (!out.report.ok) console.log(out.report.checks);
    expect(out.report.ok).toBe(true);
    expect(out.files.map((f) => f.index)).toEqual([1, 2, 3]);
    expect(out.files[0].name).toContain('T1_1-8in-O-flute');
    expect(out.files[1].name).toContain('T2_1-16in-O-flute');
    expect(out.files[2].name).toMatch(/_3_cutout_T1_/);
    for (const f of out.files) expect(checkGrbl(f.text)).toEqual([]);
  });

  it('uses unique tool numbers and documents tools in the header', () => {
    expect(out.files[0].text).toMatch(/\(Tool T1: 1\/8in O-flute\)/);
    expect(out.files[1].text).toMatch(/\(Tool T2: 1\/16in O-flute\)/);
    expect(out.files[1].text).toMatch(/T2 D1.587 mm, 1 flute, stepdown 0.35 mm/);
  });

  it('outputs arcs and off-grid coordinates', () => {
    const t = out.files[0].text;
    expect(t).toMatch(/^G[23] /m);
    const xs = [...t.matchAll(/X(-?\d+\.\d+)/g)].map((m) => parseFloat(m[1]));
    expect(xs.filter((x) => Math.abs(x * 4 - Math.round(x * 4)) > 1e-3).length).toBeGreaterThan(xs.length / 2);
  });

  it('only rapids at safe Z or 1 mm above the stock', () => {
    for (const f of out.files) {
      for (const l of f.text.split('\n')) {
        const m = l.match(/^G0 .*Z(-?[\d.]+)/);
        if (m) expect(parseFloat(m[1])).toBeGreaterThanOrEqual(1 - 1e-9);
      }
    }
  });

  it('the small tool only machines rest areas (much less than the rough)', () => {
    const cut = (i: number) => out.report.ops.filter((o) => o.file === out.files[i].name && o.op.startsWith('rest')).reduce((s, o) => s + o.cutLength, 0);
    const rough = out.report.ops.filter((o) => o.file === out.files[0].name).reduce((s, o) => s + o.cutLength, 0);
    expect(cut(1)).toBeGreaterThan(0);
    expect(cut(1)).toBeLessThan(rough);
  });

  it('places tabs and keeps the part attached', () => {
    expect(out.plan.tabs).toHaveLength(6);
    expect(out.report.checks.find((c) => c.name === 'Part attached by tabs')!.ok).toBe(true);
  });

  it('the verifier catches a gouge and a rapid into material', () => {
    const files = out.files.map((f, i) => ({ name: f.name, text: f.text, tool: out.plan.files[i].tool }));
    const bad = files.map((f) => ({ ...f }));
    // plunge into the part top (X25 Y35 is solid at full height) and rapid through stock
    bad[0].text = bad[0].text.replace(/G0 Z5\nM5\nM30\n$/, 'G0 X25 Y35 Z1\nG1 Z-1.5 F100\nG0 Z1\nG0 X5 Y38 Z-0.5\nG0 Z5\nM5\nM30\n');
    const rep = verifyJob(part, out.plan, job, bad);
    expect(rep.ok).toBe(false);
    expect(rep.checks.find((c) => c.name === 'No gouge')!.ok).toBe(false);
    expect(rep.checks.find((c) => c.name === 'Rapids clear')!.ok).toBe(false);
  });

  it('the verifier catches a part that breaks loose without tabs', () => {
    const noTabs = runJob(part, { ...job, tabCount: 0 });
    // allowed to come free only at the very end; still every other check must pass
    expect(noTabs.report.ok).toBe(true);
    const rep = verifyJob(part, noTabs.plan, { ...job, tabCount: 6 }, noTabs.files.map((f, i) => ({ name: f.name, text: f.text, tool: noTabs.plan.files[i].tool })));
    expect(rep.checks.find((c) => c.name === 'Part attached by tabs')!.ok).toBe(false);
  });
});



// ------------------------------------------------------------------ controller dialects

describe('post-processor per controller', () => {
  const ids = Object.keys(MACHINES) as MachineId[];
  const outs = Object.fromEntries(ids.map((id) => [id, runJob(part, { ...defaultJob('test-part.stl'), machine: id })]));
  const code = (text: string) => text.split('\n').map(stripComment).filter(Boolean);

  it.each(ids)('%s: every file verifies and passes its own format rules', (id) => {
    const out = outs[id];
    if (!out.report.ok) console.log(id, out.report.checks.filter((c) => !c.ok));
    expect(out.report.ok).toBe(true);
    for (const f of out.files) {
      expect(f.name.endsWith(`.${MACHINES[id].ext}`)).toBe(true);
      expect(checkFormat(f.text, MACHINES[id])).toEqual([]);
    }
  });

  it('toolpaths are identical across controllers (same time estimates)', () => {
    const secs = (id: MachineId) => outs[id].report.files.map((f) => Math.round(f.seconds));
    for (const id of ids) expect(secs(id)).toEqual(secs('grbl'));
  });

  it('GRBL output is unchanged: seconds dwell, ( ) comments, M30', () => {
    const c = code(outs.grbl.files[0].text);
    expect(c.slice(0, 4)).toEqual(['G21 G90 G17 G94', 'G0 Z5', 'M3 S16000', 'G4 P3']);
    expect(c.slice(-3)).toEqual(['G0 Z5', 'M5', 'M30']);
  });

  it('LinuxCNC and Mach force incremental arc centres', () => {
    expect(outs.linuxcnc.files[0].text).toContain('G91.1');
    expect(outs.mach.files[0].text).toContain('G91.1');
  });

  it('Marlin: ; comments only, G4 S dwell, no G94/M30', () => {
    const t = outs.marlin.files[0].text;
    expect(t).not.toMatch(/[()]/);
    expect(t).toMatch(/^; OP /m);
    expect(t).toContain('\nG4 S3\n');
    expect(t).not.toMatch(/\bG94\b|\bM30\b/);
    expect(code(t).slice(-2)).toEqual(['G0 Z5', 'M5']);
  });

  it('Fanuc/Haas: program wrapper, tool change with length offset, ms dwell, decimal points', () => {
    const files = outs.fanuc.files;
    files.forEach((f, i) => {
      const lines = f.text.trimEnd().split('\n');
      expect(lines[0]).toBe('%');
      expect(lines[1]).toMatch(new RegExp(`^O${1001 + i} \\(`));
      expect(lines.at(-1)).toBe('%');
      const tn = outs.fanuc.plan.files[i].tool.number;
      expect(f.text).toContain(`\nT${tn} M6\nG0 G43 H${tn} Z5.\n`);
      expect(f.text).toContain('\nG4 P3000\n');
      expect(f.text).toContain('\nG91 G28 Z0.\nG90\nM30\n%\n');
      for (const l of code(f.text)) expect(l).not.toMatch(/\b[XYZIJ]-?\d+(?![\d.])/);
      expect(f.text).not.toMatch(/[a-z]/); // upper-case only
    });
  });

  it('format checker catches dialect mistakes', () => {
    const fan = outs.fanuc.files[0].text;
    expect(checkFormat(fan.replace(/X(\d+)\./, 'X$1'), MACHINES.fanuc).join()).toMatch(/decimal point/);
    expect(checkFormat(fan.replace('G4 P3000', 'G4 P3'), MACHINES.fanuc).join()).toMatch(/dwell/);
    expect(checkFormat(fan.replace(/G43 H\d+ /, ''), MACHINES.fanuc).join()).toMatch(/G43/);
    const mar = outs.marlin.files[0].text;
    expect(checkFormat(mar.replace('; OP', '(OP') , MACHINES.marlin).join()).toMatch(/\( \) comments/);
    expect(checkFormat(outs.grbl.files[0].text, MACHINES.marlin)).not.toEqual([]);
    expect(checkFormat(outs.marlin.files[0].text, MACHINES.grbl).join()).toMatch(/dwell|M30/);
  });
});
