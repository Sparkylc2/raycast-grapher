import type { NumericFunction, ParamValues } from "./compile-js.js";
import type { Range } from "./plot.js";

/**
 * Partial differential equations in one space dimension that evolve in time,
 * such as heat, wave, advection, reaction-diffusion and beam equations:
 *
 *   F(x, t, u, u_x, u_xx, u_xxx, u_xxxx, u_t, s) = 0
 *
 * where s is the highest time derivative, u_t or u_tt. As with the ODE solver,
 * s need not be isolated; it is solved for at every grid point.
 *
 * Space is discretised with central differences on a uniform grid and time is
 * stepped with RK4, the method of lines. The step size comes from measuring
 * how strongly s responds to each spatial derivative, which is the diffusion,
 * dispersion or wave-speed coefficient that sets the stability limit.
 */

export type Boundary =
  | { readonly kind: "dirichlet"; readonly value: (t: number) => number }
  | { readonly kind: "neumann"; readonly value: (t: number) => number };

export interface PdeProblem {
  readonly timeOrder: 1 | 2;
  readonly spaceOrder: number;
  /** F(x, t, u, u_x, u_xx, u_xxx, u_xxxx, u_t, s, params). */
  readonly F: NumericFunction;
  readonly Fs: NumericFunction;
  readonly linear: boolean;
  readonly params: ParamValues;
  readonly space: Range;
  readonly time: Range;
  readonly initial: (x: number) => number;
  /** u_t at the start, for second order in time. Zero when omitted. */
  readonly initialVelocity: ((x: number) => number) | null;
  readonly left: Boundary;
  readonly right: Boundary;
}

export interface PdeSolution {
  readonly space: Range;
  readonly time: Range;
  /** Grid points in space. */
  readonly cols: number;
  /** Stored time levels, evenly spaced from time.lo to time.hi. */
  readonly rows: number;
  /** u at row r and column c is values[r * cols + c]. NaN after a blow-up. */
  readonly values: Float32Array;
  readonly min: number;
  readonly max: number;
  /** Time at which the solution left finite values, if it did. */
  readonly blewUpAt: number | null;
  readonly steps: number;
}

const ROWS = 161;
const MAX_STEPS = 30000;
const BLOW_UP = 1e8;
const NEUMANN_ZERO: Boundary = { kind: "neumann", value: () => 0 };
export const DEFAULT_BOUNDARY = NEUMANN_ZERO;

export function solvePde(problem: PdeProblem): PdeSolution {
  // Higher spatial order means a far smaller stable step, so the grid starts coarser.
  let cols = problem.spaceOrder >= 4 ? 61 : problem.spaceOrder === 3 ? 81 : 101;
  for (;;) {
    const estimate = estimateSteps(problem, cols);
    if (estimate <= MAX_STEPS || cols <= 21) break;
    cols = Math.max(21, Math.round(cols * 0.75));
  }
  return run(problem, cols);
}

/** Shared finite-difference machinery for a grid of `cols` points. */
function grid(problem: PdeProblem, cols: number) {
  const { F, Fs, params: P, space, left, right } = problem;
  const dx = (space.hi - space.lo) / (cols - 1);
  const xs = Float64Array.from({ length: cols }, (_, i) => space.lo + i * dx);
  // Two ghost points each side cover stencils up to fourth order.
  const padded = new Float64Array(cols + 4);

  const fillGhosts = (u: ArrayLike<number>, t: number): void => {
    for (let i = 0; i < cols; i++) padded[i + 2] = u[i]!;
    const l = left.value(t);
    const r = right.value(t);
    for (let k = 1; k <= 2; k++) {
      padded[2 - k] = left.kind === "dirichlet" ? 2 * l - padded[2 + k]! : padded[2 + k]! - 2 * k * dx * l;
      const last = cols + 1;
      padded[last + k] =
        right.kind === "dirichlet" ? 2 * r - padded[last - k]! : padded[last - k]! + 2 * k * dx * r;
    }
  };

  const derivatives = (i: number, out: Float64Array): void => {
    const p = i + 2;
    const um2 = padded[p - 2]!;
    const um1 = padded[p - 1]!;
    const u0 = padded[p]!;
    const up1 = padded[p + 1]!;
    const up2 = padded[p + 2]!;
    out[0] = u0;
    out[1] = (up1 - um1) / (2 * dx);
    out[2] = (up1 - 2 * u0 + um1) / (dx * dx);
    out[3] = (up2 - 2 * up1 + 2 * um1 - um2) / (2 * dx * dx * dx);
    out[4] = (up2 - 4 * up1 + 6 * u0 - 4 * um1 + um2) / (dx * dx * dx * dx);
  };

  const solveS = (x: number, t: number, d: Float64Array, v: number, seed: number): number => {
    if (problem.linear) {
      const fs = Fs(x, t, d[0]!, d[1]!, d[2]!, d[3]!, d[4]!, v, 0, P);
      if (!(Math.abs(fs) > 1e-14)) return NaN;
      return -F(x, t, d[0]!, d[1]!, d[2]!, d[3]!, d[4]!, v, 0, P) / fs;
    }
    let s = seed;
    for (let k = 0; k < 20; k++) {
      const f = F(x, t, d[0]!, d[1]!, d[2]!, d[3]!, d[4]!, v, s, P);
      const fs = Fs(x, t, d[0]!, d[1]!, d[2]!, d[3]!, d[4]!, v, s, P);
      if (!Number.isFinite(f) || !Number.isFinite(fs) || Math.abs(fs) < 1e-14) return NaN;
      const step = f / fs;
      s -= step;
      if (Math.abs(step) <= 1e-10 * (1 + Math.abs(s))) return s;
    }
    return s;
  };

  return { dx, xs, fillGhosts, derivatives, solveS };
}

/**
 * Largest stable RK4 step, from the sensitivity of s to each spatial
 * derivative at the initial state. RK4 is stable to about 2.8 on both the
 * negative real axis, which diffusion needs, and the imaginary axis, which
 * advection and waves need; the factors below keep a margin under that.
 */
function stableStep(problem: PdeProblem, cols: number, u: ArrayLike<number>, v: ArrayLike<number>, t: number): number {
  const g = grid(problem, cols);
  const d = new Float64Array(5);
  g.fillGhosts(u, t);
  const span = problem.time.hi - problem.time.lo;
  let limit = span / 200;
  const probe = (i: number, slot: number, h: number): number => {
    g.derivatives(i, d);
    const vi = v[i] ?? 0;
    const base = g.solveS(g.xs[i]!, t, d, vi, 0);
    d[slot] = d[slot]! + h;
    const bumped = g.solveS(g.xs[i]!, t, d, vi, base);
    return Math.abs((bumped - base) / h);
  };
  const stride = Math.max(1, Math.floor(cols / 25));
  for (let i = 0; i < cols; i += stride) {
    const dx = g.dx;
    // Relative perturbations keep the probe meaningful whatever the scale of u.
    const react = probe(i, 0, 1e-6);
    const advect = probe(i, 1, 1e-6);
    const diffuse = probe(i, 2, 1e-6);
    const disperse = probe(i, 3, 1e-6);
    const beam = probe(i, 4, 1e-6);
    if (problem.timeOrder === 1) {
      if (react > 0) limit = Math.min(limit, 2 / react);
      if (advect > 0) limit = Math.min(limit, dx / advect);
      if (diffuse > 0) limit = Math.min(limit, (0.6 * dx * dx) / diffuse);
      if (disperse > 0) limit = Math.min(limit, (0.8 * dx * dx * dx) / disperse);
      if (beam > 0) limit = Math.min(limit, (0.15 * dx * dx * dx * dx) / beam);
    } else {
      // u_tt = c² u_xx has eigenvalues about ±2ic/dx.
      if (diffuse > 0) limit = Math.min(limit, (1.1 * dx) / Math.sqrt(diffuse));
      if (advect > 0) limit = Math.min(limit, Math.sqrt(dx / advect));
      if (beam > 0) limit = Math.min(limit, (0.5 * dx * dx) / Math.sqrt(beam));
      if (react > 0) limit = Math.min(limit, 1.4 / Math.sqrt(react));
    }
  }
  return limit;
}

function initialState(problem: PdeProblem, cols: number): { u: Float64Array; v: Float64Array } {
  const g = grid(problem, cols);
  const u = Float64Array.from(g.xs, (x) => problem.initial(x));
  const v = Float64Array.from(g.xs, (x) => problem.initialVelocity?.(x) ?? 0);
  applyDirichlet(problem, u, problem.time.lo);
  return { u, v };
}

function applyDirichlet(problem: PdeProblem, u: Float64Array, t: number): void {
  if (problem.left.kind === "dirichlet") u[0] = problem.left.value(t);
  if (problem.right.kind === "dirichlet") u[u.length - 1] = problem.right.value(t);
}

function estimateSteps(problem: PdeProblem, cols: number): number {
  const { u, v } = initialState(problem, cols);
  const dt = stableStep(problem, cols, u, v, problem.time.lo);
  return Math.ceil((problem.time.hi - problem.time.lo) / dt);
}

function run(problem: PdeProblem, cols: number): PdeSolution {
  const g = grid(problem, cols);
  const { time } = problem;
  const second = problem.timeOrder === 2;
  const state = initialState(problem, cols);
  const u = state.u;
  const v = state.v;

  const values = new Float32Array(ROWS * cols).fill(Number.NaN);
  const record = (row: number): void => {
    for (let i = 0; i < cols; i++) values[row * cols + i] = u[i]!;
  };
  record(0);

  const d = new Float64Array(5);
  const seeds = new Float64Array(cols);
  // RK4 stage buffers: du/dt and, for second order, dv/dt.
  const ku = [0, 1, 2, 3].map(() => new Float64Array(cols));
  const kv = [0, 1, 2, 3].map(() => new Float64Array(cols));
  const tu = new Float64Array(cols);
  const tv = new Float64Array(cols);

  const rhs = (t: number, uu: Float64Array, vv: Float64Array, outU: Float64Array, outV: Float64Array): boolean => {
    g.fillGhosts(uu, t);
    for (let i = 0; i < cols; i++) {
      const pinned =
        (i === 0 && problem.left.kind === "dirichlet") || (i === cols - 1 && problem.right.kind === "dirichlet");
      if (pinned) {
        outU[i] = 0;
        outV[i] = 0;
        continue;
      }
      g.derivatives(i, d);
      const s = g.solveS(g.xs[i]!, t, d, second ? vv[i]! : 0, seeds[i]!);
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

  let t = time.lo;
  let dt = stableStep(problem, cols, u, v, t);
  let steps = 0;
  let blewUpAt: number | null = null;
  const rowDt = (time.hi - time.lo) / (ROWS - 1);

  outer: for (let row = 1; row < ROWS; row++) {
    const target = time.lo + row * rowDt;
    while (t < target - 1e-12) {
      // Land exactly on each stored time level.
      const h = Math.min(dt, target - t);
      if (!rhs(t, u, v, ku[0]!, kv[0]!)) break outer;
      for (let i = 0; i < cols; i++) {
        tu[i] = u[i]! + 0.5 * h * ku[0]![i]!;
        tv[i] = v[i]! + 0.5 * h * kv[0]![i]!;
      }
      if (!rhs(t + 0.5 * h, tu, tv, ku[1]!, kv[1]!)) break outer;
      for (let i = 0; i < cols; i++) {
        tu[i] = u[i]! + 0.5 * h * ku[1]![i]!;
        tv[i] = v[i]! + 0.5 * h * kv[1]![i]!;
      }
      if (!rhs(t + 0.5 * h, tu, tv, ku[2]!, kv[2]!)) break outer;
      for (let i = 0; i < cols; i++) {
        tu[i] = u[i]! + h * ku[2]![i]!;
        tv[i] = v[i]! + h * kv[2]![i]!;
      }
      if (!rhs(t + h, tu, tv, ku[3]!, kv[3]!)) break outer;

      let finite = true;
      for (let i = 0; i < cols; i++) {
        u[i] = u[i]! + (h / 6) * (ku[0]![i]! + 2 * ku[1]![i]! + 2 * ku[2]![i]! + ku[3]![i]!);
        v[i] = v[i]! + (h / 6) * (kv[0]![i]! + 2 * kv[1]![i]! + 2 * kv[2]![i]! + kv[3]![i]!);
        if (!Number.isFinite(u[i]!) || Math.abs(u[i]!) > BLOW_UP) finite = false;
      }
      t += h;
      applyDirichlet(problem, u, t);
      steps++;
      if (!finite) {
        blewUpAt = t;
        break outer;
      }
      // Nonlinear problems can stiffen as they evolve, so the limit is re-measured.
      if (steps % 200 === 0 && !problem.linear) dt = stableStep(problem, cols, u, v, t);
      if (steps > MAX_STEPS * 2) {
        blewUpAt = t;
        break outer;
      }
    }
    record(row);
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
  return { space: problem.space, time, cols, rows: ROWS, values, min, max, blewUpAt, steps };
}

/** u across space at time `t`, interpolated between stored levels. */
export function profileAt(solution: PdeSolution, t: number, out?: Float64Array): Float64Array {
  const { cols, rows, values, time } = solution;
  const result = out ?? new Float64Array(cols);
  const f = Math.min(rows - 1, Math.max(0, ((t - time.lo) / (time.hi - time.lo)) * (rows - 1)));
  const r0 = Math.floor(f);
  const r1 = Math.min(rows - 1, r0 + 1);
  const w = f - r0;
  for (let i = 0; i < cols; i++) {
    result[i] = values[r0 * cols + i]! * (1 - w) + values[r1 * cols + i]! * w;
  }
  return result;
}
