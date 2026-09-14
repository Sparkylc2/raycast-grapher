import type { Camera3D } from "./camera.js";
import type { Mesh, Scene3D } from "./mesh.js";
import type { Range } from "./plot.js";
import type { RasterSize } from "./raster.js";
import { Canvas, type LabelInk, formatTick, makeInk, niceStep, paletteOf } from "./render.js";
import { type GraphTheme, type RGB, DEFAULT_THEME, hexToRgb } from "./theme.js";
import type { Typeface } from "./typeface.js";

/**
 * A small software rasteriser for the 3D view.
 *
 * The plotting box is scaled onto a cube, so a surface spanning [-5, 5] by
 * [0, 1] stays readable instead of collapsing to a sliver. Triangles are
 * filled with a depth buffer and per-vertex lighting; lines and the box are
 * depth-tested against the surfaces so hidden edges disappear behind them.
 * Z points up.
 */

export interface Render3DOptions {
  readonly transparent?: boolean;
  readonly pixelRatio?: number;
  readonly labelSize?: number;
  readonly typeface?: Typeface;
  readonly axisNames?: readonly [string, string, string] | null;
}

/** An orbit around the cube that shows all three axes. */
export const DEFAULT_ORBIT: Camera3D = {
  target: [0, 0, 0],
  distance: 5.4,
  yaw: -Math.PI / 3,
  pitch: 0.5,
  fovY: Math.PI / 4,
};

interface Projected {
  sx: number;
  sy: number;
  /** 1 / depth, larger is nearer; zero marks a point behind the camera. */
  iz: number;
}

export function renderScene3D(
  scene: Scene3D,
  camera: Camera3D,
  size: RasterSize,
  theme: GraphTheme = DEFAULT_THEME,
  options: Render3DOptions = {},
): Uint8ClampedArray {
  const { width, height } = size;
  const ratio = options.pixelRatio ?? 1;
  const palette = paletteOf(theme);
  const canvas = new Canvas(width, height, options.transparent ? null : palette.background);
  const depth = new Float32Array(width * height);

  const [bx, by, bz] = scene.bounds;
  const centre = [(bx.lo + bx.hi) / 2, (by.lo + by.hi) / 2, (bz.lo + bz.hi) / 2] as const;
  const scale = [2 / (bx.hi - bx.lo), 2 / (by.hi - by.lo), 2 / (bz.hi - bz.lo)] as const;

  const { yaw, pitch, distance, fovY } = camera;
  const eye = [
    distance * Math.cos(pitch) * Math.cos(yaw),
    distance * Math.cos(pitch) * Math.sin(yaw),
    distance * Math.sin(pitch),
  ] as const;
  const forward = normalize([-eye[0], -eye[1], -eye[2]]);
  const right = normalize(cross(forward, [0, 0, 1]));
  const up = cross(right, forward);
  const focal = height / 2 / Math.tan(fovY / 2);

  const project = (nx: number, ny: number, nz: number, out: Projected): Projected => {
    const px = nx - eye[0];
    const py = ny - eye[1];
    const pz = nz - eye[2];
    const zv = px * forward[0] + py * forward[1] + pz * forward[2];
    if (zv < 0.05) {
      out.iz = 0;
      return out;
    }
    const xv = px * right[0] + py * right[1] + pz * right[2];
    const yv = px * up[0] + py * up[1] + pz * up[2];
    out.sx = width / 2 + (xv / zv) * focal;
    out.sy = height / 2 - (yv / zv) * focal;
    out.iz = 1 / zv;
    return out;
  };
  const toCube = (x: number, y: number, z: number): [number, number, number] => [
    (x - centre[0]) * scale[0],
    (y - centre[1]) * scale[1],
    (z - centre[2]) * scale[2],
  ];

  // A key light from above and to the left of the viewer, plus fill so nothing goes black.
  const light = normalize([
    -0.45 * right[0] + 0.7 * up[0] - 0.55 * forward[0],
    -0.45 * right[1] + 0.7 * up[1] - 0.55 * forward[1],
    -0.45 * right[2] + 0.7 * up[2] - 0.55 * forward[2],
  ]);

  for (const mesh of scene.meshes) drawMesh(mesh, canvas, depth, project, toCube, scale, light);

  const grid = palette.grid;
  const corners = [-1, 1];
  const cubeEdges: [[number, number, number], [number, number, number]][] = [];
  for (const a of corners) {
    for (const b of corners) {
      cubeEdges.push([[-1, a, b], [1, a, b]]);
      cubeEdges.push([[a, -1, b], [a, 1, b]]);
      cubeEdges.push([[a, b, -1], [a, b, 1]]);
    }
  }
  for (const [p, q] of cubeEdges) drawLine3D(canvas, depth, project, p, q, grid, 0.6 * ratio, 0.55);

  for (const line of scene.lines) {
    const color = hexToRgb(line.color);
    const pts = line.points;
    for (let i = 3; i < pts.length; i += 3) {
      const a = toCube(pts[i - 3]!, pts[i - 2]!, pts[i - 1]!);
      const b = toCube(pts[i]!, pts[i + 1]!, pts[i + 2]!);
      if (!a.every(Number.isFinite) || !b.every(Number.isFinite)) continue;
      drawLine3D(canvas, depth, project, a, b, color, 1.3 * ratio, 1);
    }
  }

  const scratch: Projected = { sx: 0, sy: 0, iz: 0 };
  for (const point of scene.points) {
    const [nx, ny, nz] = toCube(point.x, point.y, point.z);
    const p = project(nx, ny, nz, scratch);
    if (p.iz === 0) continue;
    canvas.disc(p.sx, p.sy, 5 * ratio, palette.background, 0.9);
    canvas.disc(p.sx, p.sy, 4 * ratio, hexToRgb(point.color));
  }

  const ink = makeInk(canvas, options.typeface, (options.labelSize ?? 11) * ratio, ratio, palette);
  drawBoxLabels(canvas, ink, project, eye, scene.bounds, options.axisNames ?? null, options.typeface !== undefined, ratio);
  return canvas.data;
}

type Vec3 = readonly [number, number, number];

/** Three significant figures: enough for a box corner, which need not be a round number. */
const formatEnd = (value: number): string => (Math.abs(value) < 1e-9 ? "0" : String(Number(value.toPrecision(3))));

function normalize(v: Vec3): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: Vec3, b: Vec3): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function drawMesh(
  mesh: Mesh,
  canvas: Canvas,
  depth: Float32Array,
  project: (x: number, y: number, z: number, out: Projected) => Projected,
  toCube: (x: number, y: number, z: number) => [number, number, number],
  scale: Vec3,
  light: Vec3,
): void {
  const base = hexToRgb(mesh.color);
  const count = mesh.positions.length / 3;
  const sx = new Float32Array(count);
  const sy = new Float32Array(count);
  const iz = new Float32Array(count);
  const shade = new Float32Array(count * 3);
  const scratch: Projected = { sx: 0, sy: 0, iz: 0 };

  for (let v = 0; v < count; v++) {
    const [nx, ny, nz] = toCube(mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!);
    const p = project(nx, ny, nz, scratch);
    sx[v] = p.sx;
    sy[v] = p.sy;
    iz[v] = p.iz;

    // Normals transform by the inverse of the box scaling.
    const n = normalize([
      mesh.normals[v * 3]! / scale[0],
      mesh.normals[v * 3 + 1]! / scale[1],
      mesh.normals[v * 3 + 2]! / scale[2],
    ]);
    // Two-sided, since an open surface is seen from both sides.
    const diffuse = Math.abs(n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
    const intensity = 0.34 + 0.66 * diffuse;
    // Higher parts lift slightly toward white, which reads as height at a glance.
    const lift = ((nz + 1) / 2) * 0.16;
    for (let c = 0; c < 3; c++) {
      const tinted = base[c]! + (255 - base[c]!) * lift;
      shade[v * 3 + c] = tinted * intensity;
    }
  }

  const { width, height, data } = canvas;
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!;
    const b = idx[t + 1]!;
    const c = idx[t + 2]!;
    if (iz[a] === 0 || iz[b] === 0 || iz[c] === 0) continue;
    const ax = sx[a]!;
    const ay = sy[a]!;
    const bx = sx[b]!;
    const by = sy[b]!;
    const cx = sx[c]!;
    const cy = sy[c]!;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) continue;

    const left = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const right = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const top = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const bottom = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    if (left > right || top > bottom) continue;

    for (let py = top; py <= bottom; py++) {
      const pcy = py + 0.5;
      for (let px = left; px <= right; px++) {
        const pcx = px + 0.5;
        const w0 = ((bx - pcx) * (cy - pcy) - (by - pcy) * (cx - pcx)) / area;
        const w1 = ((cx - pcx) * (ay - pcy) - (cy - pcy) * (ax - pcx)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * iz[a]! + w1 * iz[b]! + w2 * iz[c]!;
        const i = py * width + px;
        if (z <= depth[i]!) continue;
        depth[i] = z;
        const o = i * 4;
        data[o] = w0 * shade[a * 3]! + w1 * shade[b * 3]! + w2 * shade[c * 3]!;
        data[o + 1] = w0 * shade[a * 3 + 1]! + w1 * shade[b * 3 + 1]! + w2 * shade[c * 3 + 1]!;
        data[o + 2] = w0 * shade[a * 3 + 2]! + w1 * shade[b * 3 + 2]! + w2 * shade[c * 3 + 2]!;
        data[o + 3] = 255;
      }
    }
  }
}

/** A depth-tested antialiased line, stamped along its projected length. */
function drawLine3D(
  canvas: Canvas,
  depth: Float32Array,
  project: (x: number, y: number, z: number, out: Projected) => Projected,
  a: Vec3,
  b: Vec3,
  color: RGB,
  halfWidth: number,
  alpha: number,
): void {
  const pa = project(a[0], a[1], a[2], { sx: 0, sy: 0, iz: 0 });
  const pb = project(b[0], b[1], b[2], { sx: 0, sy: 0, iz: 0 });
  if (pa.iz === 0 || pb.iz === 0) return;
  const length = Math.hypot(pb.sx - pa.sx, pb.sy - pa.sy);
  const steps = Math.max(1, Math.ceil(length * 1.5));
  const { width, height } = canvas;
  const r = Math.ceil(halfWidth + 1);
  const seen = new Map<number, number>();

  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = pa.sx + (pb.sx - pa.sx) * t;
    const y = pa.sy + (pb.sy - pa.sy) * t;
    const z = pa.iz + (pb.iz - pa.iz) * t;
    for (let py = Math.floor(y) - r; py <= Math.floor(y) + r; py++) {
      if (py < 0 || py >= height) continue;
      for (let px = Math.floor(x) - r; px <= Math.floor(x) + r; px++) {
        if (px < 0 || px >= width) continue;
        const i = py * width + px;
        // Slightly generous, so lines lying on a surface are not hidden by it.
        if (depth[i]! > 0 && z < depth[i]! * 0.985) continue;
        const d = Math.hypot(px + 0.5 - x, py + 0.5 - y);
        const cover = Math.max(0, Math.min(1, halfWidth + 0.5 - d));
        if (cover <= (seen.get(i) ?? 0)) continue;
        seen.set(i, cover);
      }
    }
  }
  for (const [i, cover] of seen) canvas.blend(i % width, Math.floor(i / width), color, cover * alpha);
}

/**
 * Tick values and axis names on the three box edges nearest the viewer, the
 * way a printed 3D plot labels them.
 */
function drawBoxLabels(
  canvas: Canvas,
  ink: LabelInk,
  project: (x: number, y: number, z: number, out: Projected) => Projected,
  eye: Vec3,
  bounds: readonly [Range, Range, Range],
  names: readonly [string, string, string] | null,
  hasLetters: boolean,
  ratio: number,
): void {
  const sx = eye[0] >= 0 ? 1 : -1;
  const sy = eye[1] >= 0 ? 1 : -1;
  // Each axis runs along the edge on the near side, at the bottom of the box.
  const edges: { axis: 0 | 1 | 2; from: Vec3; to: Vec3; out: Vec3 }[] = [
    { axis: 0, from: [-1, sy, -1], to: [1, sy, -1], out: [0, sy * 0.18, -0.12] },
    { axis: 1, from: [sx, -1, -1], to: [sx, 1, -1], out: [sx * 0.18, 0, -0.12] },
    { axis: 2, from: [sx, -sy, -1], to: [sx, -sy, 1], out: [sx * 0.12, -sy * 0.12, 0] },
  ];
  const scratch: Projected = { sx: 0, sy: 0, iz: 0 };
  const place = (text: string, p: Vec3): void => {
    const q = project(p[0], p[1], p[2], scratch);
    if (q.iz === 0) return;
    ink.stamp(text, q.sx - ink.width(text) / 2, q.sy - ink.height / 2);
  };

  for (const { axis, from, to, out } of edges) {
    const range = bounds[axis];
    const a = project(from[0], from[1], from[2], { sx: 0, sy: 0, iz: 0 });
    const b = project(to[0], to[1], to[2], { sx: 0, sy: 0, iz: 0 });
    const pixels = Math.hypot(b.sx - a.sx, b.sy - a.sy) / ratio;
    const step = niceStep(range.hi - range.lo, pixels, 60);
    const span = range.hi - range.lo;
    // Both ends are always labelled, so a box whose round ends fall between
    // tick steps still says what it spans; interior ticks keep clear of them.
    const ticks: { t: number; text: string }[] = [
      { t: 0, text: formatEnd(range.lo) },
      { t: 1, text: formatEnd(range.hi) },
    ];
    for (let v = Math.ceil(range.lo / step) * step; v <= range.hi + step * 1e-9; v += step) {
      const t = (v - range.lo) / span;
      if (t * span < 0.35 * step || (1 - t) * span < 0.35 * step) continue;
      ticks.push({ t, text: formatTick(v, step) });
    }
    for (const { t, text } of ticks) {
      // The y and z edges start where the previous edge ends; that corner is already labelled.
      if (axis !== 0 && t < 1e-6) continue;
      const p: Vec3 = [
        from[0] + (to[0] - from[0]) * t + out[0],
        from[1] + (to[1] - from[1]) * t + out[1],
        from[2] + (to[2] - from[2]) * t + out[2],
      ];
      place(text, p);
    }
    if (names && hasLetters) {
      const mid: Vec3 = [
        (from[0] + to[0]) / 2 + out[0] * 2.4,
        (from[1] + to[1]) / 2 + out[1] * 2.4,
        (from[2] + to[2]) / 2 + out[2] * 2.4,
      ];
      place(names[axis], mid);
    }
  }
}
