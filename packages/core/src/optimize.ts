/**
 * Minimisation over a box, for `min`, `max`, `argmin` and `argmax`.
 *
 * Global minimisation has no general guarantee, so the strategy is to look
 * everywhere coarsely and then refine locally. One variable: dense sampling,
 * then Brent's method around the best sample, which is exact to about ten
 * digits for smooth functions and never leaves the bracket. Two or three
 * variables: a grid, then Nelder-Mead from the best few cells, then Brent along
 * each coordinate to polish. Endpoints and faces of the box count, so a
 * minimum on the boundary is found too.
 */

export interface Optimum {
  readonly point: readonly number[];
  readonly value: number;
}

export type Objective = (point: readonly number[]) => number;

const GOLDEN = 0.3819660112501051;

/** Treats values that aren't real as worse than anything real. */
const safe = (value: number): number => (Number.isFinite(value) ? value : Infinity);

/** Brent's method: the minimum of g on [a, b], combining golden sections with parabolic steps. */
export function brent(g: (x: number) => number, a: number, b: number, tolerance = 1e-11): { x: number; fx: number } {
  let x = a + GOLDEN * (b - a);
  let w = x;
  let v = x;
  let fx = safe(g(x));
  let fw = fx;
  let fv = fx;
  let d = 0;
  let e = 0;
  for (let iteration = 0; iteration < 120; iteration++) {
    const middle = 0.5 * (a + b);
    const tol1 = tolerance * Math.abs(x) + 1e-13;
    const tol2 = 2 * tol1;
    if (Math.abs(x - middle) <= tol2 - 0.5 * (b - a)) break;

    let golden = true;
    if (Math.abs(e) > tol1) {
      const r = (x - w) * (fx - fv);
      let q = (x - v) * (fx - fw);
      let p = (x - v) * q - (x - w) * r;
      q = 2 * (q - r);
      if (q > 0) p = -p;
      else q = -q;
      const previous = e;
      e = d;
      if (Math.abs(p) < Math.abs(0.5 * q * previous) && p > q * (a - x) && p < q * (b - x)) {
        d = p / q;
        const u = x + d;
        if (u - a < tol2 || b - u < tol2) d = x < middle ? tol1 : -tol1;
        golden = false;
      }
    }
    if (golden) {
      e = (x < middle ? b : a) - x;
      d = GOLDEN * e;
    }

    const u = Math.abs(d) >= tol1 ? x + d : x + (d > 0 ? tol1 : -tol1);
    const fu = safe(g(u));
    if (fu <= fx) {
      if (u < x) b = x;
      else a = x;
      v = w;
      fv = fw;
      w = x;
      fw = fx;
      x = u;
      fx = fu;
    } else {
      if (u < x) a = u;
      else b = u;
      if (fu <= fw || w === x) {
        v = w;
        fv = fw;
        w = u;
        fw = fu;
      } else if (fu <= fv || v === x || v === w) {
        v = u;
        fv = fu;
      }
    }
  }
  return { x, fx };
}

function minimize1D(g: (x: number) => number, lo: number, hi: number, hint: number | null): Optimum {
  // With a hint from a nearby search, a coarse look catches a new basin and the hint refines the old one.
  const samples = hint === null ? 160 : 32;
  let bestIndex = 0;
  let best = Infinity;
  const xs = new Float64Array(samples + 1);
  for (let i = 0; i <= samples; i++) {
    xs[i] = lo + ((hi - lo) * i) / samples;
    const value = safe(g(xs[i]!));
    if (value < best) {
      best = value;
      bestIndex = i;
    }
  }
  if (!Number.isFinite(best)) return { point: [Number.NaN], value: Number.NaN };
  const a = xs[Math.max(0, bestIndex - 1)]!;
  const b = xs[Math.min(samples, bestIndex + 1)]!;
  let result: Optimum = { point: [xs[bestIndex]!], value: best };
  const refined = brent(g, a, b);
  if (refined.fx <= result.value) result = { point: [refined.x], value: refined.fx };
  if (hint !== null && Number.isFinite(hint)) {
    const width = (hi - lo) / samples;
    const local = brent(g, Math.max(lo, hint - width), Math.min(hi, hint + width));
    if (local.fx < result.value) result = { point: [local.x], value: local.fx };
  }
  return result;
}

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

function nelderMead(g: Objective, start: readonly number[], size: readonly number[], box: readonly (readonly [number, number])[]): Optimum {
  const d = start.length;
  const project = (p: number[]): number[] => p.map((value, i) => clamp(value, box[i]![0], box[i]![1]));
  const simplex: { point: number[]; value: number }[] = [];
  const first = project([...start]);
  simplex.push({ point: first, value: safe(g(first)) });
  for (let i = 0; i < d; i++) {
    const p = [...start];
    p[i] = p[i]! + (p[i]! + size[i]! > box[i]![1] ? -size[i]! : size[i]!);
    const projected = project(p);
    simplex.push({ point: projected, value: safe(g(projected)) });
  }

  for (let iteration = 0; iteration < 400; iteration++) {
    simplex.sort((a, b) => a.value - b.value);
    const bestValue = simplex[0]!.value;
    const worst = simplex[d]!;
    if (Math.abs(worst.value - bestValue) < 1e-14 * (1 + Math.abs(bestValue))) {
      const spread = Math.max(...simplex.map((s) => Math.max(...s.point.map((c, i) => Math.abs(c - simplex[0]!.point[i]!)))));
      if (spread < 1e-12) break;
    }
    const centroid = new Array<number>(d).fill(0);
    for (let i = 0; i < d; i++) for (let k = 0; k < d; k++) centroid[k] = centroid[k]! + simplex[i]!.point[k]! / d;
    const along = (t: number): number[] => project(centroid.map((c, k) => c + t * (worst.point[k]! - c)));

    const reflected = along(-1);
    const fr = safe(g(reflected));
    if (fr < simplex[0]!.value) {
      const expanded = along(-2);
      const fe = safe(g(expanded));
      simplex[d] = fe < fr ? { point: expanded, value: fe } : { point: reflected, value: fr };
      continue;
    }
    if (fr < simplex[d - 1]!.value) {
      simplex[d] = { point: reflected, value: fr };
      continue;
    }
    const contracted = along(fr < worst.value ? -0.5 : 0.5);
    const fc = safe(g(contracted));
    if (fc < Math.min(fr, worst.value)) {
      simplex[d] = { point: contracted, value: fc };
      continue;
    }
    // Shrink everything toward the best point.
    const anchor = simplex[0]!.point;
    for (let i = 1; i <= d; i++) {
      const p = project(simplex[i]!.point.map((c, k) => anchor[k]! + 0.5 * (c - anchor[k]!)));
      simplex[i] = { point: p, value: safe(g(p)) };
    }
  }
  simplex.sort((a, b) => a.value - b.value);
  return simplex[0]!;
}

/** Brent along each coordinate in turn, holding the others fixed. */
function polish(g: Objective, start: Optimum, box: readonly (readonly [number, number])[], rounds = 3): Optimum {
  let point = [...start.point];
  let value = start.value;
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < point.length; i++) {
      const [lo, hi] = box[i]!;
      const width = (hi - lo) * (round === 0 ? 0.05 : 0.005);
      const a = Math.max(lo, point[i]! - width);
      const b = Math.min(hi, point[i]! + width);
      const line = (x: number): number => {
        const p = [...point];
        p[i] = x;
        return g(p);
      };
      const found = brent(line, a, b);
      if (found.fx < value) {
        point[i] = found.x;
        value = found.fx;
      }
    }
  }
  return { point, value };
}

function minimizeND(g: Objective, box: readonly (readonly [number, number])[], hint: readonly number[] | null): Optimum {
  const d = box.length;
  const perAxis = hint ? (d === 2 ? 10 : 6) : d === 2 ? 40 : 14;
  const cells: Optimum[] = [];
  const index = new Array<number>(d).fill(0);
  const point = new Array<number>(d).fill(0);
  const total = perAxis ** d;
  for (let n = 0; n < total; n++) {
    let rest = n;
    for (let k = 0; k < d; k++) {
      index[k] = rest % perAxis;
      rest = Math.floor(rest / perAxis);
      point[k] = box[k]![0] + ((box[k]![1] - box[k]![0]) * index[k]!) / (perAxis - 1);
    }
    cells.push({ point: [...point], value: safe(g(point)) });
  }
  cells.sort((a, b) => a.value - b.value);
  if (!Number.isFinite(cells[0]!.value)) return { point: cells[0]!.point, value: Number.NaN };

  const size = box.map(([lo, hi]) => (hi - lo) / (perAxis - 1));
  let best = cells[0]!;
  // A few distinct starts, so a narrow valley next to a wide one isn't missed.
  let starts = cells.slice(0, 12).filter((c, i, all) => all.findIndex((o) => o.point.every((v, k) => Math.abs(v - c.point[k]!) < 1.5 * size[k]!)) === i).slice(0, 4);
  if (hint && hint.every(Number.isFinite)) {
    const point = hint.map((value, k) => clamp(value, box[k]![0], box[k]![1]));
    starts = [starts[0]!, { point, value: safe(g(point)) }];
  }
  for (const start of starts) {
    const local = polish(g, nelderMead(g, start.point, size, box), box);
    if (local.value < best.value) best = local;
  }
  return best;
}

/** The minimum, or the maximum when `maximize` is set, of `f` over `box`. */
export function optimize(
  f: Objective,
  box: readonly (readonly [number, number])[],
  maximize: boolean,
  hint: readonly number[] | null = null,
): Optimum {
  const sign = maximize ? -1 : 1;
  const g: Objective = (p) => sign * f(p);
  if (box.some(([lo, hi]) => !(lo <= hi) || !Number.isFinite(lo) || !Number.isFinite(hi))) {
    return { point: box.map(() => Number.NaN), value: Number.NaN };
  }
  const found = box.length === 1 ? minimize1D((x) => g([x]), box[0]![0], box[0]![1], hint?.[0] ?? null) : minimizeND(g, box, hint);
  return { point: found.point, value: sign * found.value };
}
