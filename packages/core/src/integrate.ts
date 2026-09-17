/**
 * Numerical integration, for `int`.
 *
 * The workhorse is adaptive Gauss–Kronrod: a 15-point rule with an embedded
 * 7-point rule whose difference estimates the error, and the worst interval
 * is split until the total is within tolerance. Its nodes never touch an
 * endpoint, so sin(t)/t from 0 is fine. Infinite ranges are mapped onto finite
 * ones first. When the error still won't come down, which is what an
 * integrable singularity at an endpoint does, tanh-sinh quadrature takes over;
 * it clusters points toward the ends doubly exponentially and handles such
 * singularities with ease.
 *
 * Regions are integrated by finding where the region's boundary crosses the
 * innermost variable's line, then integrating only the pieces inside, so a
 * disc's edge never sits in the middle of a quadrature interval.
 */

export interface Quadrature {
  readonly value: number;
  /** Estimated absolute error. */
  readonly error: number;
}

export interface QuadratureOptions {
  /** Relative tolerance, applied as absolute for values below 1. */
  readonly tolerance?: number;
  readonly maxIntervals?: number;
  /** Try tanh-sinh when Gauss–Kronrod doesn't converge. Too costly inside nested integrals. */
  readonly fallback?: boolean;
  /** Samples used to find where a region's boundary crosses the line. */
  readonly regionSamples?: number;
}

const XGK = [
  0.991455371120812639206854697526329, 0.949107912342758524526189684047851, 0.864864423359769072789712788640926,
  0.741531185599394439863864773280788, 0.586087235467691130294144845693013, 0.405845151377397166906606412076961,
  0.207784955007898467600689403773245, 0,
];
const WGK = [
  0.02293532201052922496373200805897, 0.063092092629978553290700663189204, 0.104790010322250183839876322541518,
  0.140653259715525918745189590510238, 0.16900472663926790282658342659855, 0.190350578064785409913256402421014,
  0.204432940075298892414161999234649, 0.209482141084727828012999174891714,
];
/** Gauss weights for the nodes XGK[1], XGK[3], XGK[5] and the centre. */
const WG = [0.129484966168869693270611432679082, 0.27970539148927666790146777142378, 0.381830050505118944950369775488975, 0.417959183673469387755102040816327];

interface Segment extends Quadrature {
  readonly a: number;
  readonly b: number;
}

function gaussKronrod(f: (x: number) => number, a: number, b: number): Segment {
  const center = (a + b) / 2;
  const half = (b - a) / 2;
  const fc = f(center);
  let kronrod = fc * WGK[7]!;
  let gauss = fc * WG[3]!;
  for (let j = 0; j < 7; j++) {
    const dx = half * XGK[j]!;
    const pair = f(center - dx) + f(center + dx);
    kronrod += WGK[j]! * pair;
    if (j % 2 === 1) gauss += WG[(j - 1) / 2]! * pair;
  }
  const value = kronrod * half;
  const error = Math.abs((kronrod - gauss) * half);
  return Number.isFinite(value) ? { value, error, a, b } : { value: Number.NaN, error: Infinity, a, b };
}

function adaptive(f: (x: number) => number, a: number, b: number, tolerance: number, maxIntervals: number): Quadrature {
  const segments = [gaussKronrod(f, a, b)];
  for (;;) {
    let value = 0;
    let error = 0;
    let worst = 0;
    segments.forEach((s, i) => {
      value += s.value;
      error += s.error;
      if (s.error > segments[worst]!.error) worst = i;
    });
    const goal = tolerance * (Number.isFinite(value) ? Math.max(1, Math.abs(value)) : 1);
    if (error <= goal || segments.length >= maxIntervals) return { value, error };
    const s = segments[worst]!;
    const middle = (s.a + s.b) / 2;
    if (!(middle > s.a && middle < s.b)) return { value, error };
    segments.splice(worst, 1, gaussKronrod(f, s.a, middle), gaussKronrod(f, middle, s.b));
  }
}

function tanhSinh(f: (x: number) => number, a: number, b: number, tolerance: number): Quadrature {
  const HALF_PI = Math.PI / 2;
  const half = (b - a) / 2;
  const centre = f(a + half);
  let sum = Number.isFinite(centre) ? HALF_PI * centre : 0;
  let previous = Number.NaN;
  let estimate = Number.NaN;
  let error = Infinity;
  for (let level = 0; level <= 9; level++) {
    const h = 2 ** -level;
    // Each level adds the odd multiples of its step; level 0 takes every multiple.
    for (let k = 1; ; k += level === 0 ? 1 : 2) {
      const t = k * h;
      const u = HALF_PI * Math.sinh(t);
      const cosh = Math.cosh(u);
      const weight = (HALF_PI * Math.cosh(t)) / (cosh * cosh);
      // Distance from each end, half * (1 - tanh u), written so it doesn't round to zero.
      const gap = (half * Math.exp(-u)) / cosh;
      if (!(weight > 0) || !(gap > 0) || t > 7) break;
      const left = f(a + gap);
      const right = f(b - gap);
      sum += weight * ((Number.isFinite(left) ? left : 0) + (Number.isFinite(right) ? right : 0));
    }
    estimate = sum * h * half;
    if (level >= 3) {
      error = Math.abs(estimate - previous);
      if (error <= tolerance * Math.max(1, Math.abs(estimate))) break;
    }
    previous = estimate;
  }
  return { value: estimate, error };
}

/** The integral of f from a to b. Either bound may be infinite, and b may be below a. */
export function quadrature(f: (x: number) => number, a: number, b: number, options: QuadratureOptions = {}): Quadrature {
  const tolerance = options.tolerance ?? 1e-10;
  const maxIntervals = options.maxIntervals ?? 200;
  if (Number.isNaN(a) || Number.isNaN(b)) return { value: Number.NaN, error: Infinity };
  if (a === b) return { value: 0, error: 0 };
  if (b < a) {
    const flipped = quadrature(f, b, a, options);
    return { value: -flipped.value, error: flipped.error };
  }

  let g = f;
  let lo = a;
  let hi = b;
  if (!Number.isFinite(a) && !Number.isFinite(b)) {
    // x = t / (1 - t^2) maps (-1, 1) onto the whole line.
    g = (t) => {
      const s = 1 - t * t;
      return (f(t / s) * (1 + t * t)) / (s * s);
    };
    lo = -1;
    hi = 1;
  } else if (!Number.isFinite(b)) {
    g = (t) => f(a + t / (1 - t)) / ((1 - t) * (1 - t));
    lo = 0;
    hi = 1;
  } else if (!Number.isFinite(a)) {
    g = (t) => f(b - t / (1 - t)) / ((1 - t) * (1 - t));
    lo = 0;
    hi = 1;
  }
  // Far enough out, a decaying integrand times a growing Jacobian is 0 times infinity.
  const guarded = g === f ? f : (t: number) => {
    const value = g(t);
    return Number.isFinite(value) ? value : 0;
  };

  const first = adaptive(guarded, lo, hi, tolerance, maxIntervals);
  if (first.error <= tolerance * Math.max(1, Math.abs(first.value)) || options.fallback === false) return first;
  const second = tanhSinh(guarded, lo, hi, tolerance);
  return Number.isFinite(second.value) && (second.error < first.error || !Number.isFinite(first.value)) ? second : first;
}

/** Where `region` changes sign between x0 and x1, by the Illinois method. */
function crossing(region: (x: number) => number, x0: number, x1: number, v0: number, v1: number): number {
  const inside0 = v0 <= 0;
  let lo = x0;
  let hi = x1;
  let flo = v0;
  let fhi = v1;
  let retained = 0;
  for (let i = 0; i < 100; i++) {
    const secant = Number.isFinite(flo) && Number.isFinite(fhi) && fhi !== flo ? hi - (fhi * (hi - lo)) / (fhi - flo) : Number.NaN;
    const x = secant > lo && secant < hi ? secant : (lo + hi) / 2;
    const fx = region(x);
    if (fx === 0) return x;
    if (fx <= 0 === inside0) {
      lo = x;
      flo = fx;
      // The other end has stayed put twice: halve it so the secant stops creeping.
      if (retained === -1) fhi /= 2;
      retained = -1;
    } else {
      hi = x;
      fhi = fx;
      if (retained === 1) flo /= 2;
      retained = 1;
    }
    if (hi - lo <= 1e-12 * Math.max(1, Math.abs(x))) break;
  }
  return (lo + hi) / 2;
}

/** The integral of f from a to b over the points where region(x) <= 0. */
export function quadratureWhere(
  f: (x: number) => number,
  region: (x: number) => number,
  a: number,
  b: number,
  options: QuadratureOptions = {},
): number {
  if (a === b) return 0;
  if (b < a) return -quadratureWhere(f, region, b, a, options);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return quadrature((x) => (region(x) <= 0 ? f(x) : 0), a, b, options).value;
  }
  const samples = options.regionSamples ?? 32;
  let total = 0;
  let previousX = a;
  let previousValue = region(a);
  let start: number | null = previousValue <= 0 ? a : null;
  for (let i = 1; i <= samples; i++) {
    const x = i === samples ? b : a + ((b - a) * i) / samples;
    const value = region(x);
    if (previousValue <= 0 !== value <= 0) {
      const edge = crossing(region, previousX, x, previousValue, value);
      if (start === null) {
        start = edge;
      } else {
        total += quadrature(f, start, edge, options).value;
        start = null;
      }
    }
    previousX = x;
    previousValue = value;
  }
  if (start !== null) total += quadrature(f, start, b, options).value;
  return total;
}
