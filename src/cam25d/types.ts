export interface Tool25 {
  name: string; // e.g. 1/8in O-flute
  number: number; // T number, unique per tool
  diameter: number; // mm
  flutes: number;
  feed: number; // mm/min
  plunge: number; // mm/min, also used for ramps
  rpm: number;
  stepdown: number; // max axial depth per layer (mm)
  stepover: number; // fraction of diameter for pocketing
  rampAngle: number; // degrees
}

export type MachineId = 'grbl' | 'linuxcnc' | 'mach' | 'marlin' | 'fanuc';

export interface Job25 {
  partName: string;
  /** G-code dialect; default GRBL. */
  machine?: MachineId;
  /** Tools in any order; they are used largest-first. */
  tools: Tool25[];
  /** Stock thickness; default = model height + topOffset. */
  stockThickness?: number;
  /** Material above the model top (mm). */
  topOffset: number;
  throughDepth: number;
  /** Leave the part attached to a base: no cut-out file. */
  skipCutout?: boolean;
  /** Cut-out stepdown; default = large tool stepdown. */
  cutoutStepdown?: number;
  tabCount: number;
  tabWidth: number;
  /** Tab height above the final cut-out depth. */
  tabHeight: number;
  floorPass: boolean;
  wallFinish: boolean;
  /** Radial stock left for (and removed by) the wall-finishing pass. */
  finishStepover: number;
  /** Safe Z above stock top for travel moves. */
  clearance: number;
  /** For time estimates only. */
  rapidRate: number;
}

export type MoveKind = 0 | 1 | 2 | 3; // G0, G1, G2 (CW), G3 (CCW)

export interface Move {
  g: MoveKind;
  x: number;
  y: number;
  z: number;
  f: number; // feed (ignored for G0)
  /** Arc centre (absolute, model coords) for G2/G3. */
  cx?: number;
  cy?: number;
}

export interface Op {
  /** Short label used in G-code comments and the verifier, e.g. "rough Z2.000". */
  label: string;
  kind: 'rough' | 'floor' | 'rest' | 'wall' | 'cutout';
  moves: Move[];
}

export interface NcPlan {
  /** File order: 1 rough, 2 rest/detail, 3 cut-out. */
  index: number;
  title: string;
  tool: Tool25;
  ops: Op[];
}

export interface Stock25 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  top: number;
  bottom: number;
}

export const DEFAULT_LARGE: Tool25 = {
  name: '1/8in O-flute', number: 1, diameter: 3.175, flutes: 1, feed: 800, plunge: 200, rpm: 16000,
  stepdown: 1.0, stepover: 0.4, rampAngle: 2,
};
export const DEFAULT_SMALL: Tool25 = {
  name: '1/16in O-flute', number: 2, diameter: 1.5875, flutes: 1, feed: 350, plunge: 100, rpm: 16000,
  stepdown: 0.35, stepover: 0.4, rampAngle: 1,
};

export function defaultJob(partName: string): Job25 {
  return {
    partName,
    tools: [{ ...DEFAULT_LARGE }, { ...DEFAULT_SMALL }],
    topOffset: 0,
    throughDepth: 0.3,
    tabCount: 6,
    tabWidth: 6,
    tabHeight: 0.8,
    floorPass: true,
    wallFinish: true,
    finishStepover: 0.1,
    clearance: 5,
    rapidRate: 3000,
  };
}
