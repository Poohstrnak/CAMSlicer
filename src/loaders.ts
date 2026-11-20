import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

/** Load a model file and return a non-indexed triangle soup (xyz per vertex, mm). */
export async function loadModel(file: File, stlUnitScale = 1): Promise<Float32Array> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  const buf = await file.arrayBuffer();
  if (ext === 'stl') {
    const geom = new STLLoader().parse(buf);
    const g = geom.index ? geom.toNonIndexed() : geom;
    const pos = new Float32Array(g.getAttribute('position').array as ArrayLike<number>);
    if (stlUnitScale !== 1) for (let i = 0; i < pos.length; i++) pos[i] *= stlUnitScale;
    return pos;
  }
  if (ext === 'step' || ext === 'stp' || ext === 'iges' || ext === 'igs') {
    const occt = await getOcct();
    const params = {
      linearUnit: 'millimeter',
      linearDeflectionType: 'absolute_value',
      linearDeflection: 0.02,
      angularDeflection: 0.15,
    };
    const data = new Uint8Array(buf);
    const res = ext.startsWith('i') ? occt.ReadIgesFile(data, params) : occt.ReadStepFile(data, params);
    if (!res.success) throw new Error('Could not parse CAD file');
    const out: number[] = [];
    for (const m of res.meshes) {
      const p = m.attributes.position.array as number[];
      const idx = m.index.array as number[];
      for (let i = 0; i < idx.length; i++) {
        const v = idx[i] * 3;
        out.push(p[v], p[v + 1], p[v + 2]);
      }
    }
    if (!out.length) throw new Error('CAD file contains no solid geometry');
    return new Float32Array(out);
  }
  throw new Error(`Unsupported file type: .${ext}`);
}

interface Occt {
  ReadStepFile(d: Uint8Array, p: object): OcctResult;
  ReadIgesFile(d: Uint8Array, p: object): OcctResult;
}
interface OcctResult {
  success: boolean;
  meshes: { attributes: { position: { array: number[] } }; index: { array: number[] } }[];
}

let occtPromise: Promise<Occt> | null = null;
function getOcct(): Promise<Occt> {
  if (!occtPromise) {
    const base = new URL('occt/', document.baseURI).href;
    occtPromise = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = base + 'occt-import-js.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load STEP importer'));
      document.head.appendChild(s);
    }).then(() =>
      (window as unknown as { occtimportjs: (o: object) => Promise<Occt> }).occtimportjs({
        locateFile: (f: string) => base + f,
      }),
    );
  }
  return occtPromise;
}

/** Rotate a triangle soup 90° about an axis, in place. */
export function rotate90(pos: Float32Array, axis: 'x' | 'y' | 'z') {
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (axis === 'x') { pos[i + 1] = -z; pos[i + 2] = y; }
    else if (axis === 'y') { pos[i] = z; pos[i + 2] = -x; }
    else { pos[i] = -y; pos[i + 1] = x; }
  }
}

/** Translate so the part sits on Z=0 centred on the XY origin. */
export function placeOnBed(pos: Float32Array) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    minX = Math.min(minX, pos[i]); maxX = Math.max(maxX, pos[i]);
    minY = Math.min(minY, pos[i + 1]); maxY = Math.max(maxY, pos[i + 1]);
    minZ = Math.min(minZ, pos[i + 2]);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] -= cx; pos[i + 1] -= cy; pos[i + 2] -= minZ;
  }
}

/** Axis-aligned bounds of a triangle soup. */
export function meshBounds(pos: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = pos[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}
