import type { NumericFunction, ParamValues } from "./compile-js.js";
import type { Plot2D, Range, Surface3D } from "./plot.js";

/**
 * Time-dependent PDEs on a box in one to three space dimensions:
 *
 *   F(point, t, u, u_a..., u_aa..., u_ab..., u_t, s) = 0
 *
 * with s the highest time derivative, found at every node as in the 1D solver.
 * Central differences on a uniform grid and RK4 in time. Faces are Dirichlet,
 * Neumann or periodic. The grid shrinks until the explicit step count fits a
 * fixed budget, which is what keeps a 3D heat equation to about a second.
 */

export type FaceCondition =
  | { readonly kind: "dirichlet" | "neumann"; readonly value: (point: readonly number[], t: number) => number }
  | { readonly kind: "periodic" };

export interface FieldProblem {
  readonly timeOrder: 1 | 2;
  /** Arguments: point, t, u, first derivatives, second derivatives, mixed, u_t, s, params. */
  readonly F: NumericFunction;
  readonly Fs: NumericFunction;
  readonly linear: boolean;
  readonly params: ParamValues;
  readonly box: readonly Range[];
  readonly time: Range;
  readonly initial: (point: readonly number[]) => number;
  readonly initialVelocity: ((point: readonly number[]) => number) | null;
  /** Low and high face per axis. Periodic applies to both. */
  readonly faces: readonly (readonly [FaceCondition, FaceCondition])[];
  /** Mixed second derivatives F reads, as axis pairs, in argument order. */
  readonly mixed: readonly (readonly [number, number])[];
}

export interface FieldSolution {
  readonly sizes: readonly number[];
  readonly box: readonly Range[];
  readonly time: Range;
  /** Stored time levels, evenly spaced across `time`. */
  readonly frames: number;
  /** Frame f, node i is values[f * total + i]; node index runs x first. */
  readonly values: Float32Array;
  readonly min: number;
  readonly max: number;
  readonly blewUpAt: number | null;
  readonly steps: number;
}

const BUDGET = 4e7;
const BLOW_UP = 1e8;
const START = [101, 64, 28];
const SMALLEST = [21, 16, 10];
const FRAMES = [161, 81, 41];

type Closure = (...values: (number | ParamValues)[]) => number;

function makeGrid(problem: FieldProblem, size: number) {
  const d = problem.box.length;
  const m = problem.mixed.length;
  const sizes = problem.box.map(() => size);
  const periodic = problem.faces.map((f) => f[0].kind === "periodic");
  const h = problem.box.map((r, a) => (r.hi - r.lo) / (periodic[a] ? size : size - 1));
  const stride = sizes.map((_, a) => sizes.slice(0, a).reduce((p, n) => p * n, 1));
  const total = sizes.reduce((p, n) => p * n, 1);
  const coord = sizes.map((_, a) => Int32Array.from({ length: total }, (_, i) => Math.floor(i / stride[a]!) % size));
  const point = new Array<number>(d).fill(0);
  const pointOf = (flat: number): number[] => {
    for (let a = 0; a < d; a++) point[a] = problem.box[a]!.lo + coord[a]![flat]! * h[a]!;
    return point;
  };

  // A Dirichlet face pins its nodes; the first such face wins at corners.
  const pinnedFace: (FaceCondition | null)[] = Array.from({ length: total }, (_, i) => {
    for (let a = 0; a < d; a++) {
      const [lo, hi] = problem.faces[a]!;
      if (coord[a]![i] === 0 && lo.kind === "dirichlet") return lo;
      if (coord[a]![i] === size - 1 && hi.kind === "dirichlet") return hi;
    }
    return null;
  });

  /** u one step along an axis, using the face condition past the edge. */
  const neighbor = (u: ArrayLike<number>, flat: number, a: number, offset: number, t: number): number => {
    const target = coord[a]![flat]! + offset;
    if (target >= 0 && target < size) return u[flat + offset * stride[a]!]!;
    const face = problem.faces[a]![target < 0 ? 0 : 1]!;
    if (face.kind === "periodic") return u[flat + (offset + (target < 0 ? size : -size)) * stride[a]!]!;
    const mirror = u[flat - offset * stride[a]!]!;
    const g = face.value(pointOf(flat), t);
    if (face.kind === "dirichlet") return 2 * g - mirror;
    return target < 0 ? mirror - 2 * h[a]! * g : mirror + 2 * h[a]! * g;
  };

  const diagonal = (u: ArrayLike<number>, flat: number, a: number, sa: number, b: number, sb: number, t: number): number => {
    const target = coord[b]![flat]! + sb;
    let shifted: number;
    if (target >= 0 && target < size) shifted = flat + sb * stride[b]!;
    else if (periodic[b]) shifted = flat + (sb + (target < 0 ? size : -size)) * stride[b]!;
    else return Number.NaN;
    return neighbor(u, shifted, a, sa, t);
  };

  const args: (number | ParamValues)[] = new Array(3 * d + m + 5);
  const sSlot = 3 * d + m + 3;
  args[sSlot + 1] = problem.params;

  /** Fills the arguments for node `flat`, all but s. */
  const load = (u: ArrayLike<number>, flat: number, t: number, v: number): void => {
    const p = pointOf(flat);
    for (let a = 0; a < d; a++) args[a] = p[a]!;
    args[d] = t;
    const u0 = u[flat]!;
    args[d + 1] = u0;
    for (let a = 0; a < d; a++) {
      const up = neighbor(u, flat, a, 1, t);
      const um = neighbor(u, flat, a, -1, t);
      args[d + 2 + a] = (up - um) / (2 * h[a]!);
      args[2 * d + 2 + a] = (up - 2 * u0 + um) / (h[a]! * h[a]!);
    }
    problem.mixed.forEach(([a, b], j) => {
      const value =
        (diagonal(u, flat, a, 1, b, 1, t) - diagonal(u, flat, a, 1, b, -1, t) - diagonal(u, flat, a, -1, b, 1, t) + diagonal(u, flat, a, -1, b, -1, t)) /
        (4 * h[a]! * h[b]!);
      args[3 * d + 2 + j] = Number.isFinite(value) ? value : 0;
    });
    args[sSlot - 1] = v;
  };

  const F = problem.F as unknown as Closure;
  const Fs = problem.Fs as unknown as Closure;
  const solveS = (seed: number): number => {
    if (problem.linear) {
      args[sSlot] = 0;
      const fs = Fs(...args);
      return Math.abs(fs) > 1e-14 ? -F(...args) / fs : Number.NaN;
    }
    let s = seed;
    for (let k = 0; k < 20; k++) {
      args[sSlot] = s;
      const f = F(...args);
      const fs = Fs(...args);
      if (!Number.isFinite(f) || !Number.isFinite(fs) || Math.abs(fs) < 1e-14) return Number.NaN;
      const step = f / fs;
      s -= step;
      if (Math.abs(step) <= 1e-10 * (1 + Math.abs(s))) return s;
    }
    return s;
  };

  /** A stable RK4 step at state (u, v), from how strongly s responds to each slot. */
  const stableStep = (u: ArrayLike<number>, v: ArrayLike<number>, t: number): number => {
    const span = problem.time.hi - problem.time.lo;
    let react = 0;
    let advect = 0;
    let diffuse = 0;
    const probe = (flat: number, slot: number): number => {
      load(u, flat, t, v[flat] ?? 0);
      const base = solveS(0);
      const saved = args[slot] as number;
      args[slot] = saved + 1e-6;
      const bumped = solveS(base);
      args[slot] = saved;
      return Math.abs((bumped - base) / 1e-6);
    };
    const step = Math.max(1, Math.floor(total / 150));
    for (let flat = 0; flat < total; flat += step) {
      if (pinnedFace[flat]) continue;
      react = Math.max(react, probe(flat, d + 1) || 0);
      let a1 = 0;
      let a2 = 0;
      for (let a = 0; a < d; a++) {
        a1 += (probe(flat, d + 2 + a) || 0) / h[a]!;
        a2 += (probe(flat, 2 * d + 2 + a) || 0) / (h[a]! * h[a]!);
      }
      problem.mixed.forEach(([a, b], j) => (a2 += (probe(flat, 3 * d + 2 + j) || 0) / (h[a]! * h[b]!)));
      advect = Math.max(advect, a1);
      diffuse = Math.max(diffuse, a2);
    }
    let limit = span / 200;
    if (problem.timeOrder === 1) {
      if (react > 0) limit = Math.min(limit, 2 / react);
      if (advect > 0) limit = Math.min(limit, 1 / advect);
      if (diffuse > 0) limit = Math.min(limit, 0.6 / diffuse);
    } else {
      if (diffuse > 0) limit = Math.min(limit, 1.1 / Math.sqrt(diffuse));
      if (advect > 0) limit = Math.min(limit, Math.sqrt(1 / advect));
      if (react > 0) limit = Math.min(limit, 1.4 / Math.sqrt(react));
    }
    return limit;
  };

  return { d, sizes, total, pointOf, pinnedFace, load, solveS, stableStep };
}

type Grid = ReturnType<typeof makeGrid>;

function initialState(problem: FieldProblem, grid: Grid): { u: Float64Array; v: Float64Array } {
  const u = new Float64Array(grid.total);
  const v = new Float64Array(grid.total);
  for (let i = 0; i < grid.total; i++) {
    const p = grid.pointOf(i);
    const pinned = grid.pinnedFace[i];
    u[i] = pinned && pinned.kind === "dirichlet" ? pinned.value(p, problem.time.lo) : problem.initial(p);
    v[i] = problem.initialVelocity?.(grid.pointOf(i)) ?? 0;
  }
  return { u, v };
}

export function solveField(problem: FieldProblem): FieldSolution {
  const d = problem.box.length;
  let size = START[d - 1]!;
  let grid = makeGrid(problem, size);
  for (;;) {
    const { u, v } = initialState(problem, grid);
    const steps = (problem.time.hi - problem.time.lo) / grid.stableStep(u, v, problem.time.lo);
    if (steps * 4 * grid.total <= BUDGET || size <= SMALLEST[d - 1]!) break;
    size = Math.max(SMALLEST[d - 1]!, Math.round(size * 0.8));
    grid = makeGrid(problem, size);
  }
  return run(problem, grid);
}

function run(problem: FieldProblem, grid: Grid): FieldSolution {
  const { total } = grid;
  const frames = FRAMES[grid.d - 1]!;
  const second = problem.timeOrder === 2;
  const { u, v } = initialState(problem, grid);
  const values = new Float32Array(frames * total).fill(Number.NaN);
  const record = (frame: number): void => {
    for (let i = 0; i < total; i++) values[frame * total + i] = u[i]!;
  };
  record(0);

  const seeds = new Float64Array(total);
  const ku = [0, 1, 2, 3].map(() => new Float64Array(total));
  const kv = [0, 1, 2, 3].map(() => new Float64Array(total));
  const tu = new Float64Array(total);
  const tv = new Float64Array(total);

  const rhs = (t: number, uu: Float64Array, vv: Float64Array, outU: Float64Array, outV: Float64Array): boolean => {
    for (let i = 0; i < total; i++) {
      if (grid.pinnedFace[i]) {
        outU[i] = 0;
        outV[i] = 0;
        continue;
      }
      grid.load(uu, i, t, second ? vv[i]! : 0);
      const s = grid.solveS(seeds[i]!);
      if (!Number.isFinite(s)) return false;
      seeds[i] = s;
      if (second) {
        outU[i] = vv[i]!;
        outV[i] = s;
      } else {
        outU[i] = s;
      }
    }
    return true;
  };
  const pin = (t: number): void => {
    for (let i = 0; i < total; i++) {
      const face = grid.pinnedFace[i];
      if (face && face.kind === "dirichlet") u[i] = face.value(grid.pointOf(i), t);
    }
  };

  const { time } = problem;
  let t = time.lo;
  let dt = grid.stableStep(u, v, t);
  let steps = 0;
  let blewUpAt: number | null = null;
  const frameDt = (time.hi - time.lo) / (frames - 1);
  outer: for (let frame = 1; frame < frames; frame++) {
    const target = time.lo + frame * frameDt;
    while (t < target - 1e-12) {
      const h = Math.min(dt, target - t);
      if (!rhs(t, u, v, ku[0]!, kv[0]!)) break outer;
      for (let i = 0; i < total; i++) {
        tu[i] = u[i]! + 0.5 * h * ku[0]![i]!;
        tv[i] = v[i]! + 0.5 * h * kv[0]![i]!;
      }
      if (!rhs(t + 0.5 * h, tu, tv, ku[1]!, kv[1]!)) break outer;
      for (let i = 0; i < total; i++) {
        tu[i] = u[i]! + 0.5 * h * ku[1]![i]!;
        tv[i] = v[i]! + 0.5 * h * kv[1]![i]!;
      }
      if (!rhs(t + 0.5 * h, tu, tv, ku[2]!, kv[2]!)) break outer;
      for (let i = 0; i < total; i++) {
        tu[i] = u[i]! + h * ku[2]![i]!;
        tv[i] = v[i]! + h * kv[2]![i]!;
      }
      if (!rhs(t + h, tu, tv, ku[3]!, kv[3]!)) break outer;
      let finite = true;
      for (let i = 0; i < total; i++) {
        u[i] = u[i]! + (h / 6) * (ku[0]![i]! + 2 * ku[1]![i]! + 2 * ku[2]![i]! + ku[3]![i]!);
        v[i] = v[i]! + (h / 6) * (kv[0]![i]! + 2 * kv[1]![i]! + 2 * kv[2]![i]! + kv[3]![i]!);
        if (!Number.isFinite(u[i]!) || Math.abs(u[i]!) > BLOW_UP) finite = false;
      }
      t += h;
      pin(t);
      steps++;
      if (!finite) {
        blewUpAt = t;
        break outer;
      }
      if (steps % 100 === 0 && !problem.linear) dt = grid.stableStep(u, v, t);
    }
    record(frame);
  }
  if (blewUpAt === null && t < time.hi - 1e-9) blewUpAt = t;

  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 1;
  }
  return { sizes: grid.sizes, box: problem.box, time, frames, values, min, max, blewUpAt, steps };
}

/** u at time t on every node, blended between stored frames. */
export function frameAt(solution: FieldSolution, t: number, out?: Float32Array): Float32Array {
  const total = solution.sizes.reduce((p, n) => p * n, 1);
  const result = out ?? new Float32Array(total);
  const { frames, time, values } = solution;
  const f = Math.min(frames - 1, Math.max(0, ((t - time.lo) / (time.hi - time.lo || 1)) * (frames - 1)));
  const f0 = Math.floor(f);
  const f1 = Math.min(frames - 1, f0 + 1);
  const w = f - f0;
  for (let i = 0; i < total; i++) result[i] = values[f0 * total + i]! * (1 - w) + values[f1 * total + i]! * w;
  return result;
}

/** Trilinear, or bilinear, interpolation of a frame at a point in the box. */
export function sampleFrame(solution: FieldSolution, frame: Float32Array, point: readonly number[]): number {
  const d = solution.sizes.length;
  const base: number[] = [];
  const weight: number[] = [];
  for (let a = 0; a < d; a++) {
    const n = solution.sizes[a]!;
    const r = solution.box[a]!;
    const f = Math.min(n - 1, Math.max(0, ((point[a]! - r.lo) / (r.hi - r.lo)) * (n - 1)));
    const i = Math.min(n - 2, Math.floor(f));
    base.push(i);
    weight.push(f - i);
  }
  let sum = 0;
  for (let corner = 0; corner < 1 << d; corner++) {
    let w = 1;
    let flat = 0;
    let stride = 1;
    for (let a = 0; a < d; a++) {
      const bit = (corner >> a) & 1;
      w *= bit ? weight[a]! : 1 - weight[a]!;
      flat += (base[a]! + bit) * stride;
      stride *= solution.sizes[a]!;
    }
    if (w > 0) sum += w * frame[flat]!;
  }
  return sum;
}

/** What a PDE line in two or three space dimensions solved, and how to show it. */
export interface FieldInfo {
  readonly dependent: string;
  readonly space: readonly string[];
  readonly time: string;
  readonly solution: FieldSolution;
  readonly display: "heatmap" | "surface" | "isosurface";
  /** The value the isosurface is drawn at. */
  readonly level: number;
}

/** The solution at time t as 2D plots: a heatmap over the first two space variables. */
export function fieldPlots(info: FieldInfo, t: number, color: string): Plot2D[] {
  if (info.display !== "heatmap") return [];
  const { solution } = info;
  return [
    {
      kind: "heatmap",
      color,
      values: frameAt(solution, t),
      cols: solution.sizes[0]!,
      rows: solution.sizes[1]!,
      h: solution.box[0]!,
      v: solution.box[1]!,
      min: solution.min,
      max: solution.max,
    },
  ];
}

/** The solution at time t in 3D: a height surface over x and y, or an isosurface in a box. */
export function fieldSurfaces(info: FieldInfo, t: number, color: string): Surface3D[] {
  const { solution } = info;
  if (info.display === "heatmap") return [];
  const frame = frameAt(solution, t);
  if (info.display === "surface") {
    return [
      {
        kind: "gridSurface",
        color,
        values: frame,
        cols: solution.sizes[0]!,
        rows: solution.sizes[1]!,
        x: solution.box[0]!,
        y: solution.box[1]!,
        min: solution.min,
        max: solution.max,
      },
    ];
  }
  const point = [0, 0, 0];
  return [
    {
      kind: "implicitSurface",
      color,
      F: (x, y, z) => {
        point[0] = x;
        point[1] = y;
        point[2] = z;
        return sampleFrame(solution, frame, point) - info.level;
      },
      box: [solution.box[0]!, solution.box[1]!, solution.box[2]!],
      fit: false,
    },
  ];
}
