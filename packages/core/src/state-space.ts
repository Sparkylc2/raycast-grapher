import type { NumericFunction, ParamValues } from "./compile-js.js";
import { eigenvalues } from "./linalg.js";
import type { Range, Surface3D } from "./plot.js";

/**
 * First-order systems X' = f(t, X), where X is a vector of two or more
 * components. A second-order equation becomes one by naming its velocity, as
 * in the pendulum X' = [X(2); -sin(X(1))].
 */

export interface StateSystem {
  readonly size: number;
  /** One rate per component: f_k(t, x_1, ..., x_n, params). */
  readonly rates: readonly NumericFunction[];
  readonly params: ParamValues;
}

export interface Orbit {
  /** Times, ascending. */
  readonly t: Float64Array;
  /** One array per component, aligned with `t`. */
  readonly states: readonly Float64Array[];
  readonly t0: number;
  readonly start: readonly number[];
}

/** What a system line solved, for playback. */
export interface SystemInfo {
  readonly name: string;
  readonly time: string;
  readonly size: number;
  readonly span: Range;
  readonly orbits: readonly Orbit[];
}

/** A component of an orbit at time `at`, interpolated between samples. */
export function orbitValueAt(t: Float64Array, values: Float64Array, at: number): number {
  const n = t.length;
  if (at <= t[0]!) return values[0]!;
  if (at >= t[n - 1]!) return values[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid]! <= at) lo = mid;
    else hi = mid;
  }
  const w = (at - t[lo]!) / (t[hi]! - t[lo]! || 1);
  return values[lo]! + (values[hi]! - values[lo]!) * w;
}

/** A three-component system's orbits as 3D curves, cut at the playhead when there is one. */
export function orbitSurfaces(info: SystemInfo, color: string, playhead: number | null): Surface3D[] {
  return info.orbits.flatMap((o): Surface3D[] => {
    const first = o.t[0]!;
    const last = o.t[o.t.length - 1]!;
    const hi = playhead === null ? last : Math.min(last, playhead);
    const at = (k: number) => (s: number) => orbitValueAt(o.t, o.states[k]!, s);
    const start: Surface3D = { kind: "point3d", color, x: o.start[0]!, y: o.start[1]!, z: o.start[2]! };
    return hi > first ? [start, { kind: "curve3d", color, x: at(0), y: at(1), z: at(2), range: { lo: first, hi } }] : [start];
  });
}

export interface Equilibrium {
  readonly point: readonly number[];
  /** Every eigenvalue of the Jacobian has a negative real part. */
  readonly stable: boolean;
}

const BLOW_UP = 1e8;

type Closure = (...values: (number | ParamValues)[]) => number;

/** Evaluates every rate at (t, state) into `out`. */
export function stateRates(system: StateSystem): (t: number, state: ArrayLike<number>, out: Float64Array | number[]) => void {
  const { size, rates, params } = system;
  const args: (number | ParamValues)[] = new Array(size + 2);
  args[size + 1] = params;
  return (t, state, out) => {
    args[0] = t;
    for (let i = 0; i < size; i++) args[i + 1] = state[i]!;
    for (let k = 0; k < size; k++) out[k] = (rates[k] as unknown as Closure)(...args);
  };
}

function march(system: StateSystem, t0: number, start: readonly number[], tEnd: number, steps: number): { t: number[]; states: number[][] } {
  const n = system.size;
  const rate = stateRates(system);
  const h = (tEnd - t0) / Math.max(1, steps);
  const y = Float64Array.from(start);
  const k = [0, 1, 2, 3].map(() => new Float64Array(n));
  const tmp = new Float64Array(n);
  const ts = [t0];
  const states = Array.from({ length: n }, (_, i) => [y[i]!]);
  let t = t0;
  for (let step = 0; step < steps; step++) {
    rate(t, y, k[0]!);
    for (let i = 0; i < n; i++) tmp[i] = y[i]! + 0.5 * h * k[0]![i]!;
    rate(t + 0.5 * h, tmp, k[1]!);
    for (let i = 0; i < n; i++) tmp[i] = y[i]! + 0.5 * h * k[1]![i]!;
    rate(t + 0.5 * h, tmp, k[2]!);
    for (let i = 0; i < n; i++) tmp[i] = y[i]! + h * k[2]![i]!;
    rate(t + h, tmp, k[3]!);
    let ok = true;
    for (let i = 0; i < n; i++) {
      y[i] = y[i]! + (h / 6) * (k[0]![i]! + 2 * k[1]![i]! + 2 * k[2]![i]! + k[3]![i]!);
      if (!Number.isFinite(y[i]!) || Math.abs(y[i]!) > BLOW_UP) ok = false;
    }
    if (!ok) break;
    t += h;
    ts.push(t);
    for (let i = 0; i < n; i++) states[i]!.push(y[i]!);
  }
  return { t: ts, states };
}

/** Integrates backward and forward across `span` from a start at t0, with RK4. */
export function solveOrbit(system: StateSystem, t0: number, start: readonly number[], span: Range, stepsAcrossSpan = 3000): Orbit {
  const width = Math.max(span.hi - span.lo, 1e-9);
  const steps = (end: number): number => Math.ceil((Math.abs(end - t0) / width) * stepsAcrossSpan);
  const empty = { t: [t0], states: start.map((v) => [v]) };
  const back = span.lo < t0 ? march(system, t0, start, span.lo, steps(span.lo)) : empty;
  const forward = span.hi > t0 ? march(system, t0, start, span.hi, steps(span.hi)) : empty;
  const count = back.t.length + forward.t.length - 1;
  const t = new Float64Array(count);
  const states = start.map(() => new Float64Array(count));
  let j = 0;
  for (let i = back.t.length - 1; i >= 0; i--, j++) {
    t[j] = back.t[i]!;
    states.forEach((s, c) => (s[j] = back.states[c]![i]!));
  }
  for (let i = 1; i < forward.t.length; i++, j++) {
    t[j] = forward.t[i]!;
    states.forEach((s, c) => (s[j] = forward.states[c]![i]!));
  }
  return { t, states, t0, start };
}

/** Solves J d = r for small n by Gaussian elimination with partial pivoting. Null when singular. */
function solveLinear(J: number[][], r: number[]): number[] | null {
  const n = r.length;
  const a = J.map((row, i) => [...row, r[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
    if (Math.abs(a[pivot]![col]!) < 1e-14) return null;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    for (let row = col + 1; row < n; row++) {
      const factor = a[row]![col]! / a[col]![col]!;
      for (let c = col; c <= n; c++) a[row]![c] = a[row]![c]! - factor * a[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = a[row]![n]!;
    for (let c = row + 1; c < n; c++) sum -= a[row]![c]! * x[c]!;
    x[row] = sum / a[row]![row]!;
  }
  return x;
}

/**
 * Equilibria of an autonomous system inside `box`: Newton's method from a grid
 * of starts, with the exact Jacobian, keeping distinct points that converge.
 * Stability comes from the Jacobian's eigenvalues there.
 */
export function findEquilibria(system: StateSystem, jacobian: readonly NumericFunction[], box: readonly Range[], t = 0): Equilibrium[] {
  const n = system.size;
  const rate = stateRates(system);
  const args: (number | ParamValues)[] = new Array(n + 2);
  args[n + 1] = system.params;
  const jacobianAt = (x: readonly number[]): number[][] => {
    args[0] = t;
    for (let i = 0; i < n; i++) args[i + 1] = x[i]!;
    return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => (jacobian[r * n + c] as unknown as Closure)(...args)));
  };
  const perAxis = n === 2 ? 7 : n === 3 ? 4 : 3;
  const total = perAxis ** n;
  const found: Equilibrium[] = [];
  const scale = Math.max(...box.map((r) => r.hi - r.lo));
  const f = new Float64Array(n);
  for (let cell = 0; cell < total; cell++) {
    let rest = cell;
    const x = box.map((r) => {
      const i = rest % perAxis;
      rest = Math.floor(rest / perAxis);
      return r.lo + ((r.hi - r.lo) * (i + 0.5)) / perAxis;
    });
    let converged = false;
    for (let iteration = 0; iteration < 40; iteration++) {
      rate(t, x, f);
      if (!f.every(Number.isFinite)) break;
      if (Math.hypot(...f) < 1e-11 * (1 + Math.hypot(...x))) {
        converged = true;
        break;
      }
      const step = solveLinear(jacobianAt(x), Array.from(f));
      if (!step) break;
      for (let i = 0; i < n; i++) x[i] = x[i]! - step[i]!;
    }
    if (!converged) continue;
    const inside = x.every((v, i) => v >= box[i]!.lo - 1e-9 * scale && v <= box[i]!.hi + 1e-9 * scale);
    if (!inside || found.some((e) => Math.hypot(...e.point.map((v, i) => v - x[i]!)) < 1e-6 * scale)) continue;
    const { real, complex } = eigenvalues(jacobianAt(x));
    const stable = real.every((v) => v < 0) && complex.every((c) => c.re < 0);
    found.push({ point: x.map((v) => (Math.abs(v) < 1e-12 * scale ? 0 : v)), stable });
  }
  return found;
}
