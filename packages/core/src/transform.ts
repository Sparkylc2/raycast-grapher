import { Matrix, SingularValueDecomposition } from "ml-matrix";
import type { Plot2D, Surface3D } from "./plot.js";

/**
 * Watching matrices move space.
 *
 * A line like `A * B * x` is a sequence of steps applied right to left: x is
 * drawn, B moves the plane, then A. Progress runs from 0, nothing applied, to
 * the number of steps, everything applied; 1.5 means B is done and A is half
 * way.
 *
 * Blending straight from the identity to a matrix makes a half turn shrink
 * through a point. So each matrix is split into a rotation, a possible
 * reflection and a stretch, M = R D S, and the rotation turns while the stretch
 * grows. A reflection flattens to a fold halfway and opens out mirrored.
 */

export interface TransformStep {
  /** The factor as written, such as `A` or `[2, 0; 0, 1]`. */
  readonly label: string;
  readonly matrix: readonly (readonly number[])[];
}

export interface TransformInfo {
  readonly dimension: 2 | 3;
  /** In the order they are applied, rightmost factor first. */
  readonly steps: readonly TransformStep[];
  /** Vectors the steps act on, from a trailing vector factor. */
  readonly vectors: readonly (readonly number[])[];
}

export interface TransformColors {
  readonly grid: string;
  readonly square: string;
  /** One colour per basis vector. */
  readonly basis: readonly string[];
  readonly vector: string;
}

type Mat = number[][];

const identity = (n: number): Mat => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

const multiply = (a: readonly (readonly number[])[], b: readonly (readonly number[])[]): Mat =>
  a.map((row) => b[0]!.map((_, j) => row.reduce((sum, value, k) => sum + value * b[k]![j]!, 0)));

const apply = (m: readonly (readonly number[])[], v: readonly number[]): number[] =>
  m.map((row) => row.reduce((sum, value, k) => sum + value * v[k]!, 0));

export function determinantOf(m: readonly (readonly number[])[]): number {
  if (m.length === 2) return m[0]![0]! * m[1]![1]! - m[0]![1]! * m[1]![0]!;
  const [a, b, c] = m as number[][];
  return (
    a![0]! * (b![1]! * c![2]! - b![2]! * c![1]!) -
    a![1]! * (b![0]! * c![2]! - b![2]! * c![0]!) +
    a![2]! * (b![0]! * c![1]! - b![1]! * c![0]!)
  );
}

/** A rotation by `angle` about the unit `axis`, by Rodrigues' formula. */
function rotation3(axis: readonly number[], angle: number): Mat {
  const [x, y, z] = axis as [number, number, number];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

interface Polar {
  /** A proper rotation. */
  readonly rotation: (fraction: number) => Mat;
  readonly reflect: boolean;
  readonly stretch: Mat;
}

function polar(m: readonly (readonly number[])[]): Polar {
  const n = m.length;
  const svd = new SingularValueDecomposition(new Matrix(m.map((row) => [...row])));
  const U = svd.leftSingularVectors;
  const V = svd.rightSingularVectors;
  const sigma = svd.diagonal;
  const Q = U.mmul(V.transpose()).to2DArray();
  const stretch = V.mmul(Matrix.diag(sigma)).mmul(V.transpose()).to2DArray();
  const reflect = determinantOf(Q) < 0;
  // Q = R D with D flipping the last axis, so R = Q D.
  const R = reflect ? Q.map((row) => row.map((value, j) => (j === n - 1 ? -value : value))) : Q;

  if (n === 2) {
    const angle = Math.atan2(R[1]![0]!, R[0]![0]!);
    return {
      rotation: (f) => [
        [Math.cos(f * angle), -Math.sin(f * angle)],
        [Math.sin(f * angle), Math.cos(f * angle)],
      ],
      reflect,
      stretch,
    };
  }

  const trace = R[0]![0]! + R[1]![1]! + R[2]![2]!;
  const angle = Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2)));
  let axis = [R[2]![1]! - R[1]![2]!, R[0]![2]! - R[2]![0]!, R[1]![0]! - R[0]![1]!];
  let length = Math.hypot(...axis);
  if (length < 1e-9 && angle > 1) {
    // A half turn: the axis is the column of R + I with the most length.
    const columns = [0, 1, 2].map((j) => [0, 1, 2].map((i) => R[i]![j]! + (i === j ? 1 : 0)));
    axis = columns.reduce((best, column) => (Math.hypot(...column) > Math.hypot(...best) ? column : best));
    length = Math.hypot(...axis);
  }
  const unit = length > 1e-12 ? axis.map((value) => value / length) : [0, 0, 1];
  return { rotation: (f) => rotation3(unit, f * angle), reflect, stretch };
}

/** The matrix partway through one step: the identity at 0 and `m` itself at 1. */
export function interpolateStep(m: readonly (readonly number[])[], fraction: number): Mat {
  const n = m.length;
  if (fraction <= 0) return identity(n);
  if (fraction >= 1) return m.map((row) => [...row]);
  const { rotation, reflect, stretch } = polar(m);
  const grown = stretch.map((row, i) => row.map((value, j) => (1 - fraction) * (i === j ? 1 : 0) + fraction * value));
  const folded = reflect ? grown.map((row, i) => row.map((value) => (i === n - 1 ? (1 - 2 * fraction) * value : value))) : grown;
  return multiply(rotation(fraction), folded);
}

/** Everything applied up to `progress`, as one matrix. */
export function matrixAt(info: TransformInfo, progress: number): Mat {
  const clamped = Math.min(info.steps.length, Math.max(0, progress));
  const whole = Math.floor(clamped);
  let total = identity(info.dimension);
  for (let i = 0; i < whole && i < info.steps.length; i++) total = multiply(info.steps[i]!.matrix, total);
  const step = info.steps[whole];
  if (step && clamped > whole) total = multiply(interpolateStep(step.matrix, clamped - whole), total);
  return total;
}

/** A readout such as "Applying B, step 1 of 2" or "B then A applied". */
export function describeTransform(info: TransformInfo, progress: number): string {
  const count = info.steps.length;
  const determinant = determinantOf(matrixAt(info, progress));
  const det = `det ${Number(determinant.toPrecision(4))}`;
  if (progress >= count) return `${info.steps.map((s) => s.label).join(" then ")} applied  ·  ${det}`;
  if (progress <= 0) return `Before ${info.steps[0]!.label}  ·  ${det}`;
  const index = Math.min(count - 1, Math.floor(progress));
  const current = progress === index && index > 0 ? index - 1 : index;
  return `Applying ${info.steps[current]!.label}, step ${current + 1} of ${count}  ·  ${det}`;
}

const GRID_EXTENT = 6;

/** The transformed grid, unit square, basis and vectors, as ordinary 2D plots. */
export function transformPlots(info: TransformInfo, progress: number, colors: TransformColors): Plot2D[] {
  const T = matrixAt(info, progress);
  const [[a, b], [c, d]] = T as [[number, number], [number, number]];
  const range = { lo: -GRID_EXTENT, hi: GRID_EXTENT };
  const plots: Plot2D[] = [];

  const det = a * d - b * c;
  if (Math.abs(det) > 1e-9) {
    // A point is in the moved unit square when mapping it back lands in [0, 1]^2.
    plots.push({
      kind: "field",
      color: colors.square,
      F: (h, v) => {
        const u = (d * h - b * v) / det;
        const w = (-c * h + a * v) / det;
        return Math.max(Math.abs(u - 0.5), Math.abs(w - 0.5)) - 0.5;
      },
      region: { strict: false },
      clipH: null,
      clipV: null,
    });
  }
  for (let k = -GRID_EXTENT; k <= GRID_EXTENT; k++) {
    plots.push({ kind: "parametric", color: colors.grid, x: (t) => a * k + b * t, y: (t) => c * k + d * t, range });
    plots.push({ kind: "parametric", color: colors.grid, x: (t) => a * t + b * k, y: (t) => c * t + d * k, range });
  }
  [
    [a, c],
    [b, d],
  ].forEach(([x1, y1], i) => plots.push({ kind: "arrow", color: colors.basis[i] ?? colors.vector, x0: 0, y0: 0, x1: x1!, y1: y1! }));
  for (const vector of info.vectors) {
    const [x1, y1] = apply(T, vector) as [number, number];
    plots.push({ kind: "arrow", color: colors.vector, x0: 0, y0: 0, x1, y1 });
  }
  return plots;
}

/** The transformed unit cube, basis and vectors, as 3D curves and arrows. */
export function transformSurfaces(info: TransformInfo, progress: number, colors: TransformColors): Surface3D[] {
  const T = matrixAt(info, progress);
  const surfaces: Surface3D[] = [];
  const range = { lo: 0, hi: 1 };
  const corners = [0, 1];
  // Each cube edge runs along one axis with the other two coordinates fixed at 0 or 1.
  for (let axis = 0; axis < 3; axis++) {
    for (const p of corners) {
      for (const q of corners) {
        const at = (t: number): number[] => {
          const point = [0, 0, 0];
          point[axis] = t;
          point[(axis + 1) % 3] = p;
          point[(axis + 2) % 3] = q;
          return apply(T, point);
        };
        surfaces.push({ kind: "curve3d", color: colors.grid, x: (t) => at(t)[0]!, y: (t) => at(t)[1]!, z: (t) => at(t)[2]!, range });
      }
    }
  }
  for (let i = 0; i < 3; i++) {
    const tip = T.map((row) => row[i]!);
    surfaces.push({ kind: "arrow3d", color: colors.basis[i] ?? colors.vector, x: tip[0]!, y: tip[1]!, z: tip[2]! });
  }
  for (const vector of info.vectors) {
    const [x, y, z] = apply(T, vector) as [number, number, number];
    surfaces.push({ kind: "arrow3d", color: colors.vector, x, y, z });
  }
  return surfaces;
}
