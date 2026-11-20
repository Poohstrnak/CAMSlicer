/** Minimal STL parser (binary or ASCII) → triangle soup, no dependencies (usable in Node and browser). */
export function parseStl(data: ArrayBuffer | Uint8Array): Float32Array {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === u8.byteLength) {
      const out = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12;
        for (let k = 0; k < 9; k++) out[i * 9 + k] = dv.getFloat32(o + k * 4, true);
      }
      return out;
    }
  }
  const text = new TextDecoder().decode(u8);
  const nums: number[] = [];
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) nums.push(+m[1], +m[2], +m[3]);
  if (!nums.length || nums.length % 9) throw new Error('Not a valid STL file');
  return new Float32Array(nums);
}
