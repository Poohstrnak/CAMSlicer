import { copyFileSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'vite';

// Ship the OpenCascade (STEP/IGES) WASM build as static files; it is loaded on demand.
const occtDir = 'node_modules/occt-import-js/dist';
mkdirSync('public/occt', { recursive: true });
for (const f of ['occt-import-js.js', 'occt-import-js.wasm']) copyFileSync(`${occtDir}/${f}`, `public/occt/${f}`);

// Build label shown in the sidebar: commit + date in CI, "dev" locally.
const sha = (process.env.GITHUB_SHA ?? '').slice(0, 7);
const build = sha ? `${sha} · ${new Date().toISOString().slice(0, 10)}` : 'dev';

export default defineConfig({
  base: './',
  define: { __BUILD__: JSON.stringify(build) },
  worker: { format: 'es' },
});
