import { copyFileSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'vite';

// Ship the OpenCascade (STEP/IGES) WASM build as static files; it is loaded on demand.
const occtDir = 'node_modules/occt-import-js/dist';
mkdirSync('public/occt', { recursive: true });
for (const f of ['occt-import-js.js', 'occt-import-js.wasm']) copyFileSync(`${occtDir}/${f}`, `public/occt/${f}`);

export default defineConfig({
  base: './',
  worker: { format: 'es' },
});
