import type { NumericFunction, ParamValues } from "./compile-js.js";

/**
 * Ordinary differential equations written implicitly, F(t, y, y', ..., y⁽ⁿ⁾) = 0.
 *
 * Nothing requires the highest derivative to be isolated. At every step the
 * solver finds s = y⁽ⁿ⁾ with F(..., s) = 0: in closed form when F is linear in
 * s, which the analyzer proves symbolically, otherwise by Newton's method
 * seeded from the previous step so a solution stays on one branch.
 */

export interface OdeSystem {
  /** Order n of the highest derivative. */
  readonly order: number;
  /** F(t, y, y', ..., y⁽ⁿ⁻¹⁾, s, params). */
  readonly F: NumericFunction;
  /** ∂F/∂s with the same arguments. */
  readonly Fs: NumericFunction;
  /** True when F is affine in s, so s = -F(s=0) / ∂F/∂s exactly. */
  readonly linear: boolean;
  readonly params: ParamValues;
}

export interface IvpSolution {
  /** Times, ascending. */
  readonly t: Float64Array;
  /** y at each time. */
  readonly y: Float64Array;
  /** Where the initial condition was given. */
  readonly t0: number;
}

/** Beyond this magnitude a solution is treated as having blown up. */
const BLOW_UP = 1e8;

/** Samples for the root scan: sinh-spaced, dense near zero and reaching ±1000. */
const SCAN = (() => {
  const count = 96;
  const reach = Math.asinh(1000);
  return Float64Array.from({ length: count }, (_, i) => Math.sinh(-reach + (2 * reach * i) / (count - 1)));
})();

/**
 * Builds the evaluation helpers for one system. Arguments go through a reused
 * array, with direct calls for the common low orders to avoid spreading.
 */
function evaluators(system: OdeSystem) {
  const { F, Fs, order, params: P } = system;
  const args: (number | ParamValues)[] = new Array(order + 3);
  const call = (fn: NumericFunction, t: number, state: ArrayLike<number>, s: number): number => {
    if (order === 1) return fn(t, state[0]!, s, P);
    if (order === 2) return fn(t, state[0]!, state[1]!, s, P);
    args[0] = t;
    for (let i = 0; i < order; i++) args[i + 1] = state[i]!;
    args[order + 1] = s;
    args[order + 2] = P;
    return (fn as (...a: (number | ParamValues)[]) => number)(...args);
  };
  return {
    F: (t: number, state: ArrayLike<number>, s: number) => call(F, t, state, s),
    Fs: (t: number, state: ArrayLike<number>, s: number) => call(Fs, t, state, s),
  };
}

export type HighestSolver = (t: number, state: ArrayLike<number>, seed: number) => number;

/**
 * Every real s in [-1000, 1000] with F(t, state, s) = 0, into `out`.
 * Linear systems have at most one.
 */
export function highestRoots(system: OdeSystem, t: number, state: ArrayLike<number>, out: number[]): void {
  out.length = 0;
  const e = evaluators(system);
  if (system.linear) {
    const fs = e.Fs(t, state, 0);
    const s = -e.F(t, state, 0) / fs;
    if (Number.isFinite(s) && Math.abs(fs) > 1e-12) out.push(s);
    return;
  }
  let prevS = SCAN[0]!;
  let prevF = e.F(t, state, prevS);
  for (let i = 1; i < SCAN.length; i++) {
    const s = SCAN[i]!;
    const f = e.F(t, state, s);
    if (f === 0) {
      out.push(s);
    } else if (Number.isFinite(f) && Number.isFinite(prevF) && prevF !== 0 && f < 0 !== prevF < 0) {
      // Bisection: F need not be smooth between samples, so no Newton here.
      let lo = prevS;
      let hi = s;
      let flo = prevF;
      for (let k = 0; k < 48; k++) {
        const mid = 0.5 * (lo + hi);
        const fm = e.F(t, state, mid);
        if (fm === 0 || !Number.isFinite(fm)) {
          lo = hi = mid;
          break;
        }
        if (fm < 0 === flo < 0) {
          lo = mid;
          flo = fm;
        } else {
          hi = mid;
        }
      }
      const root = 0.5 * (lo + hi);
      // A sign change across a pole is not a root.
      if (Math.abs(e.F(t, state, root)) < 1e-6 * (1 + Math.abs(root))) out.push(root);
    }
    prevS = s;
    prevF = f;
  }
}

/** Returns a solver for s near `seed`, NaN where no real solution exists. */
export function highestSolver(system: OdeSystem): HighestSolver {
  const e = evaluators(system);
  const roots: number[] = [];

  if (system.linear) {
    return (t, state) => {
      const fs = e.Fs(t, state, 0);
      if (!(Math.abs(fs) > 1e-14)) return NaN;
      return -e.F(t, state, 0) / fs;
    };
  }

  return (t, state, seed) => {
    let s = Number.isFinite(seed) ? seed : 0;
    for (let i = 0; i < 16; i++) {
      const f = e.F(t, state, s);
      const d = e.Fs(t, state, s);
      if (!Number.isFinite(f) || !Number.isFinite(d) || Math.abs(d) < 1e-14) break;
      const step = f / d;
      s -= step;
      if (Math.abs(step) <= 1e-11 * (1 + Math.abs(s))) return s;
    }
    // Newton wandered off; fall back to the root closest to the seed.
    highestRoots(system, t, state, roots);
    let best = NaN;
    for (const r of roots) {
      if (Number.isNaN(best) || Math.abs(r - seed) < Math.abs(best - seed)) best = r;
    }
    return best;
  };
}

/**
 * Classical RK4 from (t0, initial) to tEnd in `steps` steps. Stops early, and
 * returns what it has, when the solution blows up or leaves the real domain.
 */
export function integrate(
  system: OdeSystem,
  t0: number,
  initial: readonly number[],
  tEnd: number,
  steps: number,
): { t: number[]; y: number[] } {
  const n = system.order;
  const solve = highestSolver(system);
  const h = (tEnd - t0) / Math.max(1, steps);

  const Y = Float64Array.from({ length: n }, (_, i) => initial[i] ?? 0);
  const k = [0, 1, 2, 3].map(() => new Float64Array(n));
  const tmp = new Float64Array(n);

  // Start on the branch closest to zero; afterwards each step seeds the next.
  const startRoots: number[] = [];
  highestRoots(system, t0, Y, startRoots);
  let seed = startRoots.length ? startRoots.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a)) : 0;

  const derivative = (t: number, state: Float64Array, out: Float64Array): boolean => {
    for (let i = 0; i < n - 1; i++) out[i] = state[i + 1]!;
    const s = solve(t, state, seed);
    if (!Number.isFinite(s)) return false;
    out[n - 1] = s;
    return true;
  };

  const ts = [t0];
  const ys = [Y[0]!];
  let t = t0;
  for (let step = 0; step < steps; step++) {
    if (!derivative(t, Y, k[0]!)) break;
    seed = k[0]![n - 1]!;
    for (let i = 0; i < n; i++) tmp[i] = Y[i]! + 0.5 * h * k[0]![i]!;
    if (!derivative(t + 0.5 * h, tmp, k[1]!)) break;
    for (let i = 0; i < n; i++) tmp[i] = Y[i]! + 0.5 * h * k[1]![i]!;
    if (!derivative(t + 0.5 * h, tmp, k[2]!)) break;
    for (let i = 0; i < n; i++) tmp[i] = Y[i]! + h * k[2]![i]!;
    if (!derivative(t + h, tmp, k[3]!)) break;

    let ok = true;
    for (let i = 0; i < n; i++) {
      Y[i] = Y[i]! + (h / 6) * (k[0]![i]! + 2 * k[1]![i]! + 2 * k[2]![i]! + k[3]![i]!);
      if (!Number.isFinite(Y[i]!) || Math.abs(Y[i]!) > BLOW_UP) ok = false;
    }
    if (!ok) break;
    t += h;
    ts.push(t);
    ys.push(Y[0]!);
  }
  return { t: ts, y: ys };
}

/**
 * Solves an initial value problem across `span`, integrating backward and
 * forward from wherever the condition was given.
 */
export function solveIvp(
  system: OdeSystem,
  t0: number,
  initial: readonly number[],
  span: readonly [number, number],
  stepsAcrossSpan = 2400,
): IvpSolution {
  const width = Math.max(span[1] - span[0], 1e-9);
  const steps = (end: number): number => Math.ceil((Math.abs(end - t0) / width) * stepsAcrossSpan);

  const back = span[0] < t0 ? integrate(system, t0, initial, span[0], steps(span[0])) : { t: [t0], y: [initial[0] ?? 0] };
  const forward = span[1] > t0 ? integrate(system, t0, initial, span[1], steps(span[1])) : { t: [t0], y: [initial[0] ?? 0] };

  const count = back.t.length + forward.t.length - 1;
  const t = new Float64Array(count);
  const y = new Float64Array(count);
  let j = 0;
  for (let i = back.t.length - 1; i >= 0; i--, j++) {
    t[j] = back.t[i]!;
    y[j] = back.y[i]!;
  }
  for (let i = 1; i < forward.t.length; i++, j++) {
    t[j] = forward.t[i]!;
    y[j] = forward.y[i]!;
  }
  return { t, y, t0 };
}
