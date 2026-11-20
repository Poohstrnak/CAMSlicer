/** Curved parts have thousands of distinct vertex heights; slicing must stay fast and exact. */
import { describe, expect, it } from 'vitest';
import { area } from '../src/cam25d/geom';
import { SlicedModel } from '../src/cam25d/slice';

/** Closed dome (hemisphere of radius R on a flat base): `bands` latitude rings × `seg` segments. */
function dome(R: number, bands: number, seg: number): Float32Array {
  const out: number[] = [];
  const ring = (i: number) => {
    const phi = (Math.PI / 2) * (i / bands);
    return { r: R * Math.cos(phi), z: R * Math.sin(phi) };
  };
  const p = (r: number, a: number, z: number) => [r * Math.cos(a), r * Math.sin(a), z];
  for (let i = 0; i < bands; i++) {
    const lo = ring(i), hi = ring(i + 1);
    for (let j = 0; j < seg; j++) {
      const a0 = (2 * Math.PI * j) / seg, a1 = (2 * Math.PI * (j + 1)) / seg;
      out.push(...p(lo.r, a0, lo.z), ...p(lo.r, a1, lo.z), ...p(hi.r, a1, hi.z)); // CCW from outside
      if (i < bands - 1) out.push(...p(lo.r, a0, lo.z), ...p(hi.r, a1, hi.z), ...p(hi.r, a0, hi.z));
    }
  }
  for (let j = 0; j < seg; j++) {
    const a0 = (2 * Math.PI * j) / seg, a1 = (2 * Math.PI * (j + 1)) / seg;
    out.push(0, 0, 0, ...p(R, a1, 0), ...p(R, a0, 0)); // base, facing down
  }
  return new Float32Array(out);
}

describe('slicing curved parts', () => {
  it('a 1500-height dome slices in fast and the shadow is exact', () => {
    const R = 20;
    const pos = dome(R, 1500, 64); // ~190k triangles, 1500 distinct Z
    const t0 = performance.now();
    const m = new SlicedModel(pos);
    for (const z of [15, 10, 5]) {
      const above = area(m.keepAbove(z));
      const r = Math.sqrt(R * R - z * z);
      expect(above / (Math.PI * r * r)).toBeCloseTo(0.998, 2); // 64-gon area ≈ 0.9984 of the circle
    }
    expect(area(m.outline) / (Math.PI * R * R)).toBeCloseTo(0.998, 2);
    expect(performance.now() - t0).toBeLessThan(5_000);
  }, 30_000);
});
