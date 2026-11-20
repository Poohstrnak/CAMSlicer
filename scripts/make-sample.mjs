// Generates samples/test-part.stl: a closed 60x40 heightfield solid with a dome, a pocket and a slot.
import { writeFileSync } from 'node:fs';
const W = 60, H = 40, step = 0.5;
const f = (x, y) => {
  if (x > 6 && x < 18 && y > 6 && y < 18) return 6; // square pocket
  if (y > 29 && y < 33 && x > 8 && x < 52) return 9; // slot
  const d = Math.hypot(x - 38, y - 16);
  if (d < 12) return 12 + 8 * Math.cos((d / 12) * Math.PI / 2); // dome
  return 12;
};
const tris = [];
const nx = Math.round(W / step), ny = Math.round(H / step);
const P = (i, j) => [i * step, j * step, f(i * step, j * step)];
for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
  const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
  tris.push([a, b, c], [a, c, d]);
}
const B = (x, y) => [x, y, 0];
tris.push([B(0, 0), B(W, H), B(W, 0)], [B(0, 0), B(0, H), B(W, H)]);
for (let i = 0; i < nx; i++) {
  tris.push([B(i * step, 0), B((i + 1) * step, 0), P(i + 1, 0)], [B(i * step, 0), P(i + 1, 0), P(i, 0)]);
  tris.push([B((i + 1) * step, H), B(i * step, H), P(i, ny)], [B((i + 1) * step, H), P(i, ny), P(i + 1, ny)]);
}
for (let j = 0; j < ny; j++) {
  tris.push([B(0, (j + 1) * step), B(0, j * step), P(0, j)], [B(0, (j + 1) * step), P(0, j), P(0, j + 1)]);
  tris.push([B(W, j * step), B(W, (j + 1) * step), P(nx, j + 1)], [B(W, j * step), P(nx, j + 1), P(nx, j)]);
}
const buf = Buffer.alloc(84 + tris.length * 50);
buf.write('CAMSlicer sample', 0);
buf.writeUInt32LE(tris.length, 80);
tris.forEach((t, k) => {
  let o = 84 + k * 50 + 12;
  for (const v of t) for (const c of v) { buf.writeFloatLE(c, o); o += 4; }
});
writeFileSync(new URL('../samples/test-part.stl', import.meta.url), buf);
console.log(`wrote ${tris.length} triangles`);
