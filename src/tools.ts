export interface Tool {
  id: string;
  name: string;
  type: 'flat' | 'ball';
  diameter: number; // mm
  fluteLength: number; // mm
  rpm: number;
  feed: number; // mm/min
  plunge: number; // mm/min, also ramps
  stepoverPct: number; // % of diameter
  stepdown: number; // max axial depth per layer, mm
  color: string; // preview colour
  flutes?: number;
  rampAngle?: number; // degrees
}

const KEY = 'camslicer.tools.v2';
const OLD_KEY = 'camslicer.tools.v1';
const PALETTE = ['#f97316', '#22c55e', '#3b82f6', '#e11d48', '#a855f7', '#eab308', '#14b8a6', '#ec4899'];

// Flat end mills only (the 2.5D generator uses flat-bottom tools). Edit to suit your machine and material.
export const DEFAULT_TOOLS: Tool[] = [
  // single-flute O-flute bits for acrylic (2.5D defaults)
  { id: 'o18', name: '1/8in O-flute', type: 'flat', diameter: 3.175, fluteLength: 12, rpm: 16000, feed: 800, plunge: 200, stepoverPct: 40, stepdown: 1, color: '#f97316', flutes: 1, rampAngle: 2 },
  { id: 'o116', name: '1/16in O-flute', type: 'flat', diameter: 1.5875, fluteLength: 6, rpm: 16000, feed: 350, plunge: 100, stepoverPct: 40, stepdown: 0.35, color: '#3b82f6', flutes: 1, rampAngle: 1 },
  { id: 't6f', name: '6 mm flat 2F', type: 'flat', diameter: 6, fluteLength: 22, rpm: 18000, feed: 1500, plunge: 400, stepoverPct: 45, stepdown: 2, color: PALETTE[0] },
  { id: 't3f', name: '1/8" flat 2F', type: 'flat', diameter: 3.175, fluteLength: 12, rpm: 18000, feed: 1000, plunge: 300, stepoverPct: 40, stepdown: 1, color: PALETTE[1] },
];

export function loadTools(): Tool[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const t = JSON.parse(raw) as Tool[];
      if (Array.isArray(t) && t.length) return t;
    }
    // migrate a v1 library: keep the user's tools, add the new O-flute defaults
    const old = localStorage.getItem(OLD_KEY);
    if (old) {
      const t = JSON.parse(old) as Tool[];
      if (Array.isArray(t) && t.length) {
        const merged = [...DEFAULT_TOOLS.filter((d) => d.id.startsWith('o') && !t.some((x) => x.id === d.id)).map((d) => ({ ...d })), ...t];
        saveTools(merged);
        return merged;
      }
    }
  } catch {
    /* ignore */
  }
  return structuredClone(DEFAULT_TOOLS);
}

export function saveTools(tools: Tool[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(tools));
  } catch {
    /* ignore */
  }
}

export function newTool(existing: Tool[]): Tool {
  return {
    id: 't' + Math.random().toString(36).slice(2, 8),
    name: 'New tool',
    type: 'flat',
    diameter: 4,
    fluteLength: 15,
    rpm: 18000,
    feed: 1200,
    plunge: 300,
    stepoverPct: 40,
    stepdown: 1.5,
    color: PALETTE[existing.length % PALETTE.length],
    flutes: 2,
    rampAngle: 2,
  };
}
