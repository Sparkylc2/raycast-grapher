import type { Plot2D, Range } from "./plot.js";

/**
 * Which line a click lands on: the one whose drawing passes nearest the point,
 * within a radius in data units. Curves measure true distance, using the slope
 * or gradient; a click inside a shaded region counts, but loses to any curve.
 */

export interface PickTarget {
  readonly id: string;
  readonly plots: readonly Plot2D[];
}

const inside = (value: number, range: Range | null): boolean => !range || (value >= range.lo && value <= range.hi);

function toSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = dx * dx + dy * dy;
  const t = length > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / length)) : 0;
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

function toPolyline(px: number, py: number, xs: ArrayLike<number>, ys: ArrayLike<number>, count: number): number {
  let best = Infinity;
  const stride = Math.max(1, Math.floor(count / 2000));
  for (let i = stride; i < count; i += stride) {
    const d = toSegment(px, py, xs[i - stride]!, ys[i - stride]!, xs[i]!, ys[i]!);
    if (d < best) best = d;
  }
  return best;
}

function distance(plot: Plot2D, x: number, y: number, radius: number): number {
  const h = radius * 1e-3;
  switch (plot.kind) {
    case "explicit": {
      if (!inside(x, plot.domain)) return Infinity;
      const fx = plot.f(x);
      if (!Number.isFinite(fx) || !inside(fx, plot.clip)) return Infinity;
      const slope = (plot.f(x + h) - plot.f(x - h)) / (2 * h);
      return Math.abs(fx - y) / Math.sqrt(1 + (Number.isFinite(slope) ? slope * slope : 0));
    }
    case "field": {
      if (!inside(x, plot.clipH) || !inside(y, plot.clipV)) return Infinity;
      const value = plot.F(x, y);
      if (plot.region) return value <= 0 ? radius * 0.95 : Infinity;
      const gx = (plot.F(x + h, y) - plot.F(x - h, y)) / (2 * h);
      const gy = (plot.F(x, y + h) - plot.F(x, y - h)) / (2 * h);
      const gradient = Math.hypot(gx, gy);
      return gradient > 0 ? Math.abs(value) / gradient : Infinity;
    }
    case "parametric": {
      const n = 600;
      const xs = new Float64Array(n + 1);
      const ys = new Float64Array(n + 1);
      for (let i = 0; i <= n; i++) {
        const t = plot.range.lo + ((plot.range.hi - plot.range.lo) * i) / n;
        xs[i] = plot.x(t);
        ys[i] = plot.y(t);
      }
      return toPolyline(x, y, xs, ys, n + 1);
    }
    case "trajectory":
    case "orbit":
      return toPolyline(x, y, plot.h, plot.v, plot.h.length);
    case "point":
    case "equilibrium":
      return Math.hypot(plot.x - x, plot.y - y);
    case "arrow":
      return toSegment(x, y, plot.x0, plot.y0, plot.x1, plot.y1);
    default:
      return Infinity;
  }
}

/** The id of the nearest target within `radius`, or null. */
export function pickPlot(targets: readonly PickTarget[], x: number, y: number, radius: number): string | null {
  let best: string | null = null;
  let nearest = radius;
  for (const target of targets) {
    for (const plot of target.plots) {
      const d = distance(plot, x, y, radius);
      if (d < nearest) {
        nearest = d;
        best = target.id;
      }
    }
  }
  return best;
}
