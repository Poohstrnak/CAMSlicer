/**
 * CAMSlicer UI. There is exactly one toolpath generator: the 2.5D engine in ./cam25d, run in a worker,
 * whose output is verified by simulation before anything can be exported.
 */
import type { Job25, Stock25, Tool25 } from './cam25d/types';
import type { VerifyReport } from './cam25d/verify';
import { loadModel, meshBounds, placeOnBed, rotate90 } from './loaders';
import { DEFAULT_TOOLS, loadTools, newTool, saveTools, type Tool } from './tools';
import { Viewer, type Box, type PreviewPath } from './viewer';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (id: string) => parseFloat($<HTMLInputElement>(id).value);

// v2: tab height now means "above the final cut-out depth"; older saved values (e.g. 2 mm from the
// stock bottom) would leave tabs far too tall, so v1 settings are intentionally not restored.
const STATE_KEY = 'camslicer.state.v2';
const FIELDS = ['sZ', 'mTop', 'cutMode', 'cutDepth', 'tabCount', 'tabW', 'tabH', 'clear', 'rapid', 'stlUnits', 'floorPass', 'wallFinish', 'finStep'];

let tools: Tool[] = loadTools();
let selected: string[] = ['o18', 'o116'];
let model: { name: string; pos: Float32Array } | null = null;
let worker: Worker | null = null;

interface Result {
  files: { name: string; text: string; seconds: number; index: number }[];
  fileTools: Tool25[];
  report: Omit<VerifyReport, 'image'>;
  reportText: string;
  png: Uint8Array;
  pngUrl: string;
  previews: Float32Array[];
  stock: Stock25;
  tabs: { x: number; y: number }[];
  tabTop: number;
  finalDepth: number;
  warnings: string[];
  skipped: string[];
}
let result: Result | null = null;

const viewer = new Viewer($('viewport'));

// ---------------------------------------------------------------- persistence
function saveState() {
  const fields = Object.fromEntries(
    FIELDS.map((id) => {
      const el = $<HTMLInputElement>(id);
      return [id, el.type === 'checkbox' ? el.checked : el.value];
    }),
  );
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ fields, selected }));
  } catch {
    /* ignore */
  }
}
function restoreState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null');
    if (s) {
      if (Array.isArray(s.selected)) selected = s.selected;
      for (const [id, v] of Object.entries(s.fields ?? {})) {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = Boolean(v);
        else el.value = String(v);
      }
    }
  } catch {
    /* ignore */
  }
  selected = selected.filter((id) => usableTools().some((t) => t.id === id));
}

// ---------------------------------------------------------------- model & stock
/** Stock block: the part's XY footprint; top = part top + offset, bottom = top - height. */
function stockBox(): Box | null {
  if (!model) return null;
  const b = meshBounds(model.pos);
  const top = b.max[2] + Math.max(0, num('mTop') || 0);
  return { min: [b.min[0], b.min[1], top - (num('sZ') || 0)], max: [b.max[0], b.max[1], top] };
}

function stockProblems(s: Box): string[] {
  const b = meshBounds(model!.pos);
  if (s.min[2] > b.min[2] + 1e-3) return [`too short — needs at least ${(s.max[2] - b.min[2]).toFixed(1)} mm (part height + top offset)`];
  return [];
}

function fitStock() {
  if (!model) return;
  const b = meshBounds(model.pos);
  $<HTMLInputElement>('sZ').value = String(Math.round((b.max[2] - b.min[2] + Math.max(0, num('mTop') || 0)) * 100) / 100);
  saveState();
}

/** Faces that are neither horizontal nor (near-)vertical: machined as stepped flat levels. */
function slopedFaces(pos: Float32Array): number {
  let n = 0;
  for (let t = 0; t < pos.length; t += 9) {
    const ux = pos[t + 3] - pos[t], uy = pos[t + 4] - pos[t + 1], uz = pos[t + 5] - pos[t + 2];
    const wx = pos[t + 6] - pos[t], wy = pos[t + 7] - pos[t + 1], wz = pos[t + 8] - pos[t + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const L = Math.hypot(nx, ny, nz);
    if (!L) continue;
    const c = Math.abs(nz) / L;
    if (c > 0.2 && c < 0.9999) n++;
  }
  return n;
}

function refreshModel(frame = false) {
  invalidate();
  viewer.setPart(model?.pos ?? null);
  if (model && (!(num('sZ') > 0) || stockProblems(stockBox()!).length)) fitStock();
  const s = stockBox();
  viewer.setStock(s);
  if (model && s) {
    const b = meshBounds(model.pos);
    const d = (a: number) => (b.max[a] - b.min[a]).toFixed(1);
    $('fileName').textContent = model.name;
    const sloped = slopedFaces(model.pos);
    $('fileInfo').textContent =
      `${d(0)} × ${d(1)} × ${d(2)} mm · ${(model.pos.length / 9).toLocaleString()} triangles` +
      (sloped ? ` · ⚠ ${sloped} sloped faces will be machined as flat steps` : '');
    showStockInfo(s);
    if (frame) viewer.frame(s);
  }
  updateGenerate();
}

function showStockInfo(s: Box) {
  const info = $('stockInfo');
  const probs = stockProblems(s);
  if (probs.length) {
    info.className = 'warn';
    info.textContent = `⚠ Stock is ${probs.join('; ')}.`;
    return;
  }
  const b = meshBounds(model!.pos);
  const below = b.min[2] - s.min[2];
  const mode = $<HTMLSelectElement>('cutMode').value;
  const final = -(s.max[2] - s.min[2]) - (num('cutDepth') || 0);
  info.className = 'muted';
  if (mode === 'base') {
    info.textContent = 'No cut-out: the part stays in the sheet.';
  } else if (mode === 'through') {
    info.textContent = `Cut-out to Z${final.toFixed(2)}. No tabs: the part comes loose during the last pass.`;
  } else {
    const tabTop = final + (num('tabH') || 0);
    info.textContent = `Cut-out to Z${final.toFixed(2)}; ${num('tabCount')} tabs, top at Z${tabTop.toFixed(2)}, ${num('tabW')} mm flat.`;
    if (tabTop >= 0) {
      info.className = 'warn';
      info.textContent = '⚠ Tab height reaches the stock top.';
    }
  }
  if (below > 1e-3) info.textContent += ` The ${below.toFixed(1)} mm of stock under the part stays attached to it.`;
}

function syncCutoutFields() {
  const mode = $<HTMLSelectElement>('cutMode').value;
  document.querySelectorAll<HTMLElement>('[data-cut]').forEach((el) => (el.hidden = !el.dataset.cut!.split(' ').includes(mode)));
}

function stockChanged() {
  saveState();
  invalidate();
  const s = stockBox();
  viewer.setStock(s);
  if (s) showStockInfo(s);
  updateGenerate();
}

async function openFile(file: File) {
  $('fileName').textContent = 'Loading…';
  $('fileInfo').textContent = file.name;
  try {
    const pos = await loadModel(file, num('stlUnits') || 1);
    placeOnBed(pos);
    model = { name: file.name, pos };
    refreshModel(true);
  } catch (e) {
    $('fileName').textContent = 'Could not load file';
    $('fileInfo').textContent = e instanceof Error ? e.message : String(e);
  }
}

const drop = $('drop');
$<HTMLInputElement>('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) openFile(f);
});
for (const t of [drop, document.body]) {
  t.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  t.addEventListener('dragleave', () => drop.classList.remove('over'));
  t.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = (e as DragEvent).dataTransfer?.files[0];
    if (f) openFile(f);
  });
}
document.querySelectorAll<HTMLButtonElement>('[data-rot]').forEach((b) =>
  b.addEventListener('click', () => {
    if (!model) return;
    rotate90(model.pos, b.dataset.rot as 'x' | 'y' | 'z');
    placeOnBed(model.pos);
    refreshModel(true);
  }),
);
for (const id of ['sZ', 'mTop', 'cutDepth', 'tabCount', 'tabW', 'tabH']) $(id).addEventListener('change', stockChanged);
$('cutMode').addEventListener('change', () => {
  syncCutoutFields();
  stockChanged();
  renderTools();
});
$('fitStock').addEventListener('click', () => {
  fitStock();
  stockChanged();
});
for (const id of ['clear', 'rapid', 'stlUnits', 'floorPass', 'wallFinish', 'finStep']) $(id).addEventListener('change', () => (saveState(), invalidate()));

// ---------------------------------------------------------------- tools
function usableTools() {
  return tools.filter((t) => t.type === 'flat');
}
const toolById = (id: string) => tools.find((t) => t.id === id);

/** Selected tools in the order they will actually run: largest first. */
function orderedSelection(): Tool[] {
  return selected
    .map(toolById)
    .filter((t): t is Tool => !!t && t.type === 'flat')
    .sort((a, b) => b.diameter - a.diameter);
}

function renderTools() {
  const box = $('toolChecks');
  box.innerHTML = '';
  for (const t of usableTools()) {
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox" ${selected.includes(t.id) ? 'checked' : ''} /> <span class="dot" style="background:${t.color}"></span> ${esc(t.name)} <span class="muted">D${t.diameter}</span>`;
    l.querySelector('input')!.addEventListener('change', (e) => {
      const on = (e.target as HTMLInputElement).checked;
      selected = on ? [...selected, t.id] : selected.filter((x) => x !== t.id);
      toolsChanged();
    });
    box.appendChild(l);
  }
  const order = orderedSelection();
  const ol = $('runOrder');
  if (!order.length) {
    ol.innerHTML = '<li class="muted">Select at least one tool.</li>';
    return;
  }
  const items = [`Roughing — T1 ${esc(order[0].name)}`];
  order.slice(1).forEach((t, i) => items.push(`Rest &amp; detail — T${i + 2} ${esc(t.name)}`));
  if ($<HTMLSelectElement>('cutMode').value !== 'base') items.push(`Cut-out — T1 ${esc(order[0].name)}`);
  ol.innerHTML = items.map((x) => `<li>${x}</li>`).join('');
}
function toolsChanged() {
  saveState();
  renderTools();
  invalidate();
  updateGenerate();
}

// ---------------------------------------------------------------- tool library dialog
const COLS: [keyof Tool, string, string][] = [
  ['color', 'Color', 'color'], ['name', 'Name', 'text'], ['diameter', 'Dia (mm)', 'number'],
  ['fluteLength', 'Flute (mm)', 'number'], ['flutes', 'Flutes', 'number'], ['rpm', 'RPM', 'number'],
  ['feed', 'Feed mm/min', 'number'], ['plunge', 'Plunge mm/min', 'number'], ['stepoverPct', 'Stepover %', 'number'],
  ['stepdown', 'Stepdown (mm)', 'number'], ['rampAngle', 'Ramp °', 'number'],
];
function renderLib() {
  const tb = $('libTable');
  tb.innerHTML = `<tr>${COLS.map((c) => `<th>${c[1]}</th>`).join('')}<th></th></tr>`;
  usableTools().forEach((t) => {
    const tr = document.createElement('tr');
    for (const [key, , kind] of COLS) {
      const td = document.createElement('td');
      const el = document.createElement('input');
      el.type = kind;
      if (kind === 'number') el.step = 'any';
      el.value = String(t[key] ?? (key === 'flutes' ? 2 : key === 'rampAngle' ? 2 : ''));
      el.addEventListener('change', () => {
        const v = kind === 'number' ? parseFloat(el.value) : el.value;
        if (kind === 'number' && !(Number(v) > 0)) {
          el.value = String(t[key] ?? '');
          return;
        }
        (t as unknown as Record<string, unknown>)[key as string] = v;
        saveTools(tools);
        renderTools();
        invalidate();
      });
      td.appendChild(el);
      tr.appendChild(td);
    }
    const td = document.createElement('td');
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Delete tool';
    del.addEventListener('click', () => {
      tools = tools.filter((x) => x !== t);
      selected = selected.filter((id) => id !== t.id);
      saveTools(tools);
      renderLib();
      toolsChanged();
    });
    td.appendChild(del);
    tr.appendChild(td);
    tb.appendChild(tr);
  });
}
const dlg = $<HTMLDialogElement>('libDialog');
$('openLib').addEventListener('click', () => {
  renderLib();
  dlg.showModal();
});
$('libClose').addEventListener('click', () => dlg.close());
$('libAdd').addEventListener('click', () => {
  tools.push(newTool(tools));
  saveTools(tools);
  renderLib();
  renderTools();
});
$('libReset').addEventListener('click', () => {
  tools = structuredClone(DEFAULT_TOOLS);
  selected = selected.filter((id) => toolById(id));
  saveTools(tools);
  renderLib();
  toolsChanged();
});

// ---------------------------------------------------------------- generate (the only generator)
function updateGenerate() {
  const s = stockBox();
  $<HTMLButtonElement>('generate').disabled = !model || !orderedSelection().length || !s || stockProblems(s).length > 0;
}

function invalidate() {
  if (!result) return;
  URL.revokeObjectURL(result.pngUrl);
  result = null;
  viewer.clearPaths();
  $('results').hidden = true;
  $('verify').hidden = true;
  $<HTMLSelectElement>('simSel').innerHTML = '<option value="-1">off</option>';
}

function toTool25(t: Tool, number: number): Tool25 {
  return {
    name: t.name, number, diameter: t.diameter, flutes: t.flutes ?? 2, feed: t.feed, plunge: t.plunge, rpm: t.rpm,
    stepdown: t.stepdown, stepover: t.stepoverPct / 100, rampAngle: t.rampAngle ?? 2,
  };
}

/** Job from the UI. Tools are passed in selection order; the engine sorts them largest-first. */
function buildJob(): Job25 {
  const mode = $<HTMLSelectElement>('cutMode').value;
  return {
    partName: model!.name,
    tools: selected.map(toolById).filter((t): t is Tool => !!t && t.type === 'flat').map((t, i) => toTool25(t, i + 1)),
    stockThickness: num('sZ'),
    topOffset: Math.max(0, num('mTop') || 0),
    throughDepth: mode === 'base' ? 0 : Math.max(0, num('cutDepth') || 0),
    skipCutout: mode === 'base',
    tabCount: mode === 'tabs' ? Math.max(1, Math.round(num('tabCount') || 6)) : 0,
    tabWidth: Math.max(0.5, num('tabW') || 6),
    tabHeight: Math.max(0.1, num('tabH') || 0.8),
    floorPass: $<HTMLInputElement>('floorPass').checked,
    wallFinish: $<HTMLInputElement>('wallFinish').checked,
    finishStepover: Math.max(0, num('finStep') || 0),
    clearance: Math.max(1, num('clear') || 5),
    rapidRate: Math.max(100, num('rapid') || 3000),
  };
}

const colorFor = (t: Tool25) => orderedSelection()[t.number - 1]?.color ?? '#888';

$('generate').addEventListener('click', () => {
  if (!model) return;
  const job = buildJob();
  worker?.terminate();
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const prog = $('progress');
  prog.hidden = false;
  const bar = prog.querySelector('div')!, label = prog.querySelector('span')!;
  bar.style.width = '10%';
  label.textContent = 'Slicing, planning and verifying…';
  $<HTMLButtonElement>('generate').disabled = true;
  const t0 = performance.now();
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'done') {
      label.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
      bar.style.width = '100%';
      showResult(m as Omit<Result, 'pngUrl'>);
    } else {
      label.textContent = 'Error: ' + m.message;
    }
    updateGenerate();
    worker?.terminate();
    worker = null;
  };
  const positions = model.pos.slice();
  worker.postMessage({ positions, job }, [positions.buffer]);
});

function showResult(d: Omit<Result, 'pngUrl'>) {
  invalidate();
  const pngUrl = URL.createObjectURL(new Blob([d.png as BlobPart], { type: 'image/png' }));
  result = { ...d, pngUrl };
  const ok = d.report.ok;
  const paths: PreviewPath[] = d.files.map((f, i) => ({
    moves: d.previews[i],
    color: f.name.includes('_cutout_') ? '#e11d48' : colorFor(d.fileTools[i]),
    diameter: d.fileTools[i].diameter,
  }));
  viewer.setPaths(paths);
  viewer.setTabs(d.tabs.map((p) => [p.x, p.y]), d.finalDepth, num('tabW') || 6, d.tabTop - d.finalDepth);

  const title = $('verifyTitle');
  title.textContent = ok ? '✓ Verified — all checks pass' : '✗ Verification failed — export blocked';
  title.className = ok ? 'pass' : 'fail';
  $('verifyTime').textContent = `Est. run time ${fmtTime(d.report.totalSeconds)}`;
  $('checks').innerHTML =
    d.report.checks.map((c) => `<li><span class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'}</span> ${esc(c.name)} <span class="d">— ${esc(c.detail)}</span></li>`).join('') +
    d.skipped.map((w) => `<li><span class="bad">–</span> <span class="d">Not written: ${esc(w)}</span></li>`).join('') +
    d.warnings.map((w) => `<li><span class="bad">⚠</span> <span class="d">${esc(w)}</span></li>`).join('');
  $<HTMLImageElement>('reportImg').src = pngUrl;
  $<HTMLAnchorElement>('reportImgLink').href = pngUrl;
  $('verify').hidden = false;

  const cards = $('cards');
  cards.innerHTML = '';
  d.files.forEach((f, i) => {
    const t = d.fileTools[i];
    const fr = d.report.files.find((x) => x.name === f.name);
    const what = f.name.includes('_roughing_') ? 'Roughing' : f.name.includes('_cutout_') ? 'Cut-out' : 'Rest & detail';
    const card = document.createElement('div');
    card.className = 'card';
    card.style.borderLeftColor = paths[i].color;
    card.innerHTML = `
      <div class="t"><label><input type="checkbox" checked /> ${f.index}. ${what}</label><span class="muted">T${t.number}</span></div>
      <div class="s">${esc(t.name)} · ${fmtTime(f.seconds)}</div>
      <div class="status ${ok && fr?.ok ? 'ok' : 'bad'}">${ok && fr?.ok ? 'Verified' : 'Blocked — see checks'}</div>
      <button ${ok ? '' : 'disabled'} title="${esc(f.name)}">Export file ${f.index}</button>`;
    card.querySelector('input')!.addEventListener('change', (e) => {
      viewer.setPathVisible(i, (e.target as HTMLInputElement).checked);
      scrub();
    });
    card.querySelector('button')!.addEventListener('click', () => exportFile(i));
    cards.appendChild(card);
  });
  $<HTMLSelectElement>('simSel').innerHTML = '<option value="-1">off</option><option value="0">after all files</option>';
  const all = $<HTMLButtonElement>('exportAll');
  all.textContent = `Export all ${d.files.length} files`;
  all.disabled = !ok;
  $('scrubInfo').dataset.total = fmtTime(d.report.totalSeconds);
  $<HTMLInputElement>('scrub').value = '1000';
  scrub();
  $('results').hidden = false;
}

function scrub() {
  const t = Number($<HTMLInputElement>('scrub').value) / 1000;
  const a = viewer.setProgress(t);
  const info = $('scrubInfo');
  if (!a || !result) info.textContent = `Total ${info.dataset.total ?? ''}`;
  else {
    const z = result.previews[a.path][a.move * 4 + 3] - result.stock.top;
    info.textContent = `File ${a.path + 1} · T${result.fileTools[a.path].number} · Z ${z.toFixed(2)}`;
  }
}
$('scrub').addEventListener('input', scrub);
$<HTMLInputElement>('showPart').addEventListener('change', (e) => viewer.setPartVisible((e.target as HTMLInputElement).checked));
$('simSel').addEventListener('change', (e) => {
  const v = Number((e.target as HTMLSelectElement).value);
  viewer.setSim(v >= 0 && result ? result.report.sim : null);
});

// ---------------------------------------------------------------- export (verified files only)
function exportFile(i: number) {
  if (!result?.report.ok) return; // never export unverified G-code
  download(result.files[i].name, result.files[i].text);
}
$('exportAll').addEventListener('click', () => {
  if (!result?.report.ok) return;
  result.files.forEach((_, i) => setTimeout(() => exportFile(i), i * 400));
});
$('dlReport').addEventListener('click', () => {
  if (!result) return;
  const base = (model?.name ?? 'part').replace(/\.[^.]+$/, '');
  download(`${base}_report.txt`, result.reportText);
  const a = document.createElement('a');
  a.href = result.pngUrl;
  a.download = `${base}_report.png`;
  setTimeout(() => a.click(), 300);
});
function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- utils
function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
function fmtTime(s: number) {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.max(1, m)} min`;
}

restoreState();
syncCutoutFields();
renderTools();
updateGenerate();
