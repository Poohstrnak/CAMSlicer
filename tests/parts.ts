/** Synthetic 2.5D test parts shared by the test suites. */
import { Clipper } from 'clipper2-ts';
import { difference, union, type Ring, type Shape } from '../src/cam25d/geom';

// ------------------------------------------------------------------ synthetic 2.5D parts

export const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];
export const circle = (cx: number, cy: number, r: number, n = 96): Ring =>
  Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) }));

/** Closed prism of a shape between z0 and z1 (top/bottom triangulated, side walls). */
export function extrude(shape: Shape, z0: number, z1: number, out: number[]) {
  const S = 1e4;
  const tri = Clipper.triangulate(shape.map((r) => r.map((p) => ({ x: Math.round(p.x * S), y: Math.round(p.y * S) }))));
  for (const t of tri.solution) {
    const [a, b, c] = t.map((p) => ({ x: p.x / S, y: p.y / S }));
    out.push(a.x, a.y, z1, b.x, b.y, z1, c.x, c.y, z1); // top
    out.push(a.x, a.y, z0, c.x, c.y, z0, b.x, b.y, z0); // bottom
  }
  for (const r of shape) {
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      out.push(p.x, p.y, z0, q.x, q.y, z0, q.x, q.y, z1, p.x, p.y, z0, q.x, q.y, z1, p.x, p.y, z1);
    }
  }
}

export const outline: Shape = [rect(0, 0, 60, 40)];
export const pocketA: Shape = [circle(15, 22, 8)]; // floor Z1
export const pocketB: Shape = difference([rect(30, 13, 52, 31)], [circle(41, 22, 3)]); // floor Z2, island inside
export const slot: Shape = [rect(10, 3, 50, 5.4)]; // 2.4 mm wide, floor Z2 — too narrow for the 1/8" tool
export function testPart(): Float32Array {
  const tris: number[] = [];
  extrude(outline, 0, 1, tris);
  extrude(difference(outline, pocketA), 1, 2, tris);
  extrude(difference(outline, union(pocketA, union(pocketB, slot))), 2, 3, tris);
  return new Float32Array(tris);
}
export const part = testPart();


/** Binary STL bytes for a triangle soup. */
export function toStl(pos: Float32Array): Uint8Array {
  const n = pos.length / 9;
  const buf = new Uint8Array(84 + n * 50);
  const dv = new DataView(buf.buffer);
  dv.setUint32(80, n, true);
  for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) dv.setFloat32(84 + i * 50 + 12 + k * 4, pos[i * 9 + k], true);
  return buf;
}
