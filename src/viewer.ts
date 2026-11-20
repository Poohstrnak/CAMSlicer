import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface Box {
  min: [number, number, number];
  max: [number, number, number];
}
/** A toolpath for preview: packed [kind, x, y, z] moves (kind 0 rapid, 1 feed, 2 plunge). */
export interface PreviewPath {
  moves: Float32Array;
  color: string;
  diameter: number;
}
/** Simulated material (h) and model surface on a regular grid; EMPTY outside the part. */
export interface SimMap {
  x0: number;
  y0: number;
  res: number;
  nx: number;
  ny: number;
  h: Float32Array;
  model: Float32Array;
}
const RAPID = 0;
const PLUNGE = 2;
const EMPTY = -1e9;

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private partMesh: THREE.Mesh | null = null;
  private stockBox: THREE.LineSegments | null = null;
  private grid: THREE.GridHelper;
  private paths: { obj: THREE.LineSegments; count: number; tp: PreviewPath }[] = [];
  private simMesh: THREE.Mesh | null = null;
  private marker: THREE.Mesh;
  private tabGroup = new THREE.Group();
  private needsRender = true;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(120, -160, 140);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => (this.needsRender = true));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(80, -120, 200);
    this.scene.add(sun);

    this.grid = new THREE.GridHelper(400, 40, 0x555555, 0x333333);
    this.grid.rotation.x = Math.PI / 2;
    this.scene.add(this.grid);
    this.scene.add(new THREE.AxesHelper(20));

    this.marker = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 24).rotateX(Math.PI / 2).translate(0, 0, 0.5),
      new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.6, roughness: 0.3, transparent: true, opacity: 0.85 }),
    );
    this.marker.visible = false;
    this.scene.add(this.marker);
    this.scene.add(this.tabGroup);

    new ResizeObserver(() => this.resize()).observe(host);
    this.applyTheme();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.controls.update() || this.needsRender) {
        this.renderer.render(this.scene, this.camera);
        this.needsRender = false;
      }
    };
    loop();
  }

  applyTheme() {
    this.scene.background = new THREE.Color(css('--viewport') || '#1b1e23');
    this.needsRender = true;
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  setPart(pos: Float32Array | null) {
    if (this.partMesh) {
      this.scene.remove(this.partMesh);
      this.partMesh.geometry.dispose();
      this.partMesh = null;
    }
    if (pos) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
      g.computeVertexNormals();
      this.partMesh = new THREE.Mesh(
        g,
        new THREE.MeshStandardMaterial({ color: 0x8fa3b8, metalness: 0.1, roughness: 0.6, flatShading: true, side: THREE.DoubleSide }),
      );
      this.scene.add(this.partMesh);
    }
    this.needsRender = true;
  }

  setPartVisible(v: boolean) {
    if (this.partMesh) this.partMesh.visible = v;
    this.needsRender = true;
  }

  setStock(b: Box | null) {
    if (this.stockBox) {
      this.scene.remove(this.stockBox);
      this.stockBox.geometry.dispose();
      this.stockBox = null;
    }
    if (!b) return;
    const size = new THREE.Vector3(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    const g = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z));
    this.stockBox = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xc8a165 }));
    this.stockBox.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    this.scene.add(this.stockBox);
    this.grid.position.z = b.min[2] - 0.01;
    this.needsRender = true;
  }

  frame(b: Box) {
    const c = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    const r = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 10);
    this.controls.target.copy(c);
    this.camera.position.copy(c).add(new THREE.Vector3(0.9, -1.3, 1.1).multiplyScalar(r * 1.1));
    this.needsRender = true;
  }

  clearPaths() {
    for (const p of this.paths) {
      this.scene.remove(p.obj);
      p.obj.geometry.dispose();
    }
    this.paths = [];
    this.setTabs([], 0, 0, 0);
    this.marker.visible = false;
    this.setSim(null);
  }

  setPaths(tps: PreviewPath[]) {
    this.clearPaths();
    const rapid = new THREE.Color(css('--rapid') || '#d33');
    for (const tp of tps) {
      const m = tp.moves;
      const n = m.length / 4;
      const pos = new Float32Array(Math.max(0, n - 1) * 6);
      const col = new Float32Array(Math.max(0, n - 1) * 6);
      const c = new THREE.Color(tp.color);
      const cPlunge = c.clone().lerp(new THREE.Color(0xffffff), 0.5);
      for (let i = 1; i < n; i++) {
        const o = (i - 1) * 6;
        pos.set([m[(i - 1) * 4 + 1], m[(i - 1) * 4 + 2], m[(i - 1) * 4 + 3], m[i * 4 + 1], m[i * 4 + 2], m[i * 4 + 3]], o);
        const kind = m[i * 4];
        const cc = kind === RAPID ? rapid : kind === PLUNGE ? cPlunge : c;
        col.set([cc.r, cc.g, cc.b, cc.r, cc.g, cc.b], o);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const obj = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
      this.scene.add(obj);
      this.paths.push({ obj, count: n - 1, tp });
    }
    this.needsRender = true;
  }

  /** Small blocks marking where holding tabs were left. */
  setTabs(pts: [number, number][], z0: number, width: number, height: number) {
    for (const c of [...this.tabGroup.children]) {
      this.tabGroup.remove(c);
      (c as THREE.Mesh).geometry.dispose();
    }
    const mat = new THREE.MeshStandardMaterial({ color: 0xf0b04a, transparent: true, opacity: 0.85 });
    const s = Math.max(1, width);
    for (const [x, y] of pts) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, height), mat);
      m.position.set(x, y, z0 + height / 2);
      this.tabGroup.add(m);
    }
    this.needsRender = true;
  }

  setPathVisible(index: number, v: boolean) {
    const p = this.paths[index];
    if (p) p.obj.visible = v;
    this.needsRender = true;
  }

  /**
   * Show progress through the visible toolpaths: `t` in [0,1] across all visible paths in order.
   * Returns the active toolpath index and move index (or null when showing everything).
   */
  setProgress(t: number): { path: number; move: number } | null {
    const visible = this.paths.filter((p) => p.obj.visible);
    const total = visible.reduce((s, p) => s + p.count, 0);
    let remaining = Math.round(t * total);
    let active: { path: number; move: number } | null = null;
    for (const p of this.paths) {
      if (!p.obj.visible) continue;
      const shown = Math.max(0, Math.min(p.count, remaining));
      remaining -= shown;
      p.obj.geometry.setDrawRange(0, shown * 2);
      if (!active && shown < p.count) active = { path: this.paths.indexOf(p), move: shown };
    }
    if (active && t < 1) {
      const p = this.paths[active.path];
      const m = p.tp.moves;
      const i = Math.min(active.move, m.length / 4 - 1);
      const r = p.tp.diameter / 2;
      this.marker.scale.set(r, r, 10);
      this.marker.position.set(m[i * 4 + 1], m[i * 4 + 2], m[i * 4 + 3]);
      this.marker.visible = true;
    } else {
      this.marker.visible = false;
    }
    this.needsRender = true;
    return t < 1 ? active : null;
  }

  /** Render the simulated remaining stock, coloured by leftover material above the part. */
  setSim(sim: SimMap | null) {
    if (this.simMesh) {
      this.scene.remove(this.simMesh);
      this.simMesh.geometry.dispose();
      this.simMesh = null;
    }
    this.needsRender = true;
    if (!sim) return;
    const grid = sim, part = sim.model, S = sim.h;
    const step = Math.max(1, Math.ceil(Math.max(grid.nx, grid.ny) / 400));
    const cx = Math.floor((grid.nx - 1) / step) + 1;
    const cy = Math.floor((grid.ny - 1) / step) + 1;
    const pos = new Float32Array(cx * cy * 3);
    const col = new Float32Array(cx * cy * 3);
    const ok = new Uint8Array(cx * cy);
    const good = new THREE.Color('#4caf7d'), mid = new THREE.Color('#e8b33c'), bad = new THREE.Color('#d9534f');
    const tmp = new THREE.Color();
    for (let b = 0; b < cy; b++) {
      for (let a = 0; a < cx; a++) {
        const i = a * step, j = b * step;
        const k = j * grid.nx + i;
        const v = b * cx + a;
        const z = S[k];
        ok[v] = z > EMPTY / 2 ? 1 : 0;
        pos.set([grid.x0 + i * grid.res, grid.y0 + j * grid.res, ok[v] ? z : 0], v * 3);
        const dev = z - part[k];
        if (part[k] <= EMPTY / 2) tmp.set(0x8a8f98); // outside the part: neutral
        else if (dev < 0.1) tmp.copy(good);
        else if (dev < 1) tmp.copy(good).lerp(mid, (dev - 0.1) / 0.9);
        else tmp.copy(mid).lerp(bad, Math.min(1, (dev - 1) / 4));
        col.set([tmp.r, tmp.g, tmp.b], v * 3);
      }
    }
    const idx: number[] = [];
    for (let b = 0; b < cy - 1; b++) {
      for (let a = 0; a < cx - 1; a++) {
        const v = b * cx + a;
        if (ok[v] && ok[v + 1] && ok[v + cx] && ok[v + cx + 1]) idx.push(v, v + 1, v + cx + 1, v, v + cx + 1, v + cx);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.simMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }));
    this.scene.add(this.simMesh);
  }
}
