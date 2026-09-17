import { type Camera2D, bounds2D } from "./camera.js";
import type { Plot2D, Range } from "./plot.js";
import type { RasterSize } from "./raster.js";

/**
 * Where visible curves cross.
 *
 * Every curve is reduced to line segments sampled at about two pixels, pairs
 * of curves are intersected through a coarse spatial hash, and each crossing
 * is polished with Newton's method whenever both curves have a field to
 * polish against. Parametric curves and solution trajectories have no field,
 * so their crossings stay at segment precision, well under a pixel.
 */

export interface Intersection {
  readonly x: number;
  readonly y: number;
}

interface Curve {
  /** Segments as x0, y0, x1, y1 in world coordinates. */
  readonly segments: Float64Array;
  readonly count: number;
  /** A field that is zero on the curve, for Newton refinement. */
  readonly field: ((x: number, y: number) => number) | null;
}

interface View {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly cols: number;
  readonly rows: number;
}

const inRange = (value: number, range: Range | null): boolean =>
  range === null || (value >= range.lo && value <= range.hi);

class SegmentList {
  private data = new Float64Array(4096);
  count = 0;

  push(x0: number, y0: number, x1: number, y1: number): void {
    if (this.count * 4 + 4 > this.data.length) {
      const grown = new Float64Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const i = this.count * 4;
    this.data[i] = x0;
    this.data[i + 1] = y0;
    this.data[i + 2] = x1;
    this.data[i + 3] = y1;
    this.count++;
  }

  get segments(): Float64Array {
    return this.data;
  }
}

function explicitCurve(plot: Plot2D & { kind: "explicit" }, view: View): Curve {
  const list = new SegmentList();
  const spanY = view.maxY - view.minY;
  let px = Number.NaN;
  let py = Number.NaN;
  for (let c = 0; c <= view.cols; c++) {
    const x = view.minX + ((view.maxX - view.minX) * c) / view.cols;
    const y = inRange(x, plot.domain) ? plot.f(x) : Number.NaN;
    // Joining across a jump would invent a crossing at every asymptote.
    if (Number.isFinite(px) && Number.isFinite(y) && Number.isFinite(py) && Math.abs(y - py) < spanY) {
      const visible = !(py > view.maxY + spanY && y > view.maxY + spanY) && !(py < view.minY - spanY && y < view.minY - spanY);
      if (visible) list.push(px, py, x, y);
    }
    px = x;
    py = y;
  }
  const f = plot.f;
  return { segments: list.segments, count: list.count, field: (x, y) => y - f(x) };
}

/** Marching squares over the field, one or two segments per cell. */
function fieldCurve(plot: Plot2D & { kind: "field" }, view: View): Curve {
  const { cols, rows } = view;
  const values = new Float64Array((cols + 1) * (rows + 1));
  const xs = Float64Array.from({ length: cols + 1 }, (_, c) => view.minX + ((view.maxX - view.minX) * c) / cols);
  const ys = Float64Array.from({ length: rows + 1 }, (_, r) => view.minY + ((view.maxY - view.minY) * r) / rows);
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) values[r * (cols + 1) + c] = plot.F(xs[c]!, ys[r]!);
  }

  const list = new SegmentList();
  const cross = (xa: number, ya: number, va: number, xb: number, yb: number, vb: number): [number, number] => {
    const t = va / (va - vb);
    return [xa + (xb - xa) * t, ya + (yb - ya) * t];
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = xs[c]!;
      const x1 = xs[c + 1]!;
      const y0 = ys[r]!;
      const y1 = ys[r + 1]!;
      if (!inRange(x0, plot.clipH) || !inRange(y0, plot.clipV)) continue;
      const a = values[r * (cols + 1) + c]!;
      const b = values[r * (cols + 1) + c + 1]!;
      const d = values[(r + 1) * (cols + 1) + c]!;
      const e = values[(r + 1) * (cols + 1) + c + 1]!;
      if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(d) && Number.isFinite(e))) continue;

      const points: [number, number][] = [];
      if (a < 0 !== b < 0) points.push(cross(x0, y0, a, x1, y0, b));
      if (b < 0 !== e < 0) points.push(cross(x1, y0, b, x1, y1, e));
      if (e < 0 !== d < 0) points.push(cross(x1, y1, e, x0, y1, d));
      if (d < 0 !== a < 0) points.push(cross(x0, y1, d, x0, y0, a));
      if (points.length === 2) {
        list.push(points[0]![0], points[0]![1], points[1]![0], points[1]![1]);
      } else if (points.length === 4) {
        // Saddle: pair the crossings according to the value at the centre.
        const centre = (a + b + d + e) / 4;
        const [p0, p1, p2, p3] = points as [[number, number], [number, number], [number, number], [number, number]];
        if (centre < 0 === a < 0) {
          list.push(p0[0], p0[1], p1[0], p1[1]);
          list.push(p2[0], p2[1], p3[0], p3[1]);
        } else {
          list.push(p0[0], p0[1], p3[0], p3[1]);
          list.push(p1[0], p1[1], p2[0], p2[1]);
        }
      }
    }
  }
  return { segments: list.segments, count: list.count, field: plot.F };
}

function sampledCurve(xs: ArrayLike<number>, ys: ArrayLike<number>, count: number, view: View): Curve {
  const list = new SegmentList();
  const jump = Math.max(view.maxX - view.minX, view.maxY - view.minY);
  for (let i = 1; i < count; i++) {
    const x0 = xs[i - 1]!;
    const y0 = ys[i - 1]!;
    const x1 = xs[i]!;
    const y1 = ys[i]!;
    if (!(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1))) continue;
    if (Math.abs(x1 - x0) > jump || Math.abs(y1 - y0) > jump) continue;
    list.push(x0, y0, x1, y1);
  }
  return { segments: list.segments, count: list.count, field: null };
}

function curveOf(plot: Plot2D, view: View): Curve | null {
  switch (plot.kind) {
    case "explicit":
      return explicitCurve(plot, view);
    case "field":
      return plot.region ? null : fieldCurve(plot, view);
    case "parametric": {
      const n = 2048;
      const xs = new Float64Array(n + 1);
      const ys = new Float64Array(n + 1);
      for (let i = 0; i <= n; i++) {
        const t = plot.range.lo + ((plot.range.hi - plot.range.lo) * i) / n;
        xs[i] = plot.x(t);
        ys[i] = plot.y(t);
      }
      return sampledCurve(xs, ys, n + 1, view);
    }
    case "trajectory":
    case "orbit":
      return sampledCurve(plot.h, plot.v, plot.h.length, view);
    default:
      return null;
  }
}

/** Solves A(x, y) = B(x, y) = 0 by Newton's method with a finite-difference Jacobian. */
function refine(
  A: (x: number, y: number) => number,
  B: (x: number, y: number) => number,
  x: number,
  y: number,
  scale: number,
): [number, number] | null {
  const h = scale * 1e-7;
  for (let i = 0; i < 12; i++) {
    const a = A(x, y);
    const b = B(x, y);
    const ax = (A(x + h, y) - A(x - h, y)) / (2 * h);
    const ay = (A(x, y + h) - A(x, y - h)) / (2 * h);
    const bx = (B(x + h, y) - B(x - h, y)) / (2 * h);
    const by = (B(x, y + h) - B(x, y - h)) / (2 * h);
    const det = ax * by - ay * bx;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
    const dx = (a * by - b * ay) / det;
    const dy = (ax * b - bx * a) / det;
    x -= dx;
    y -= dy;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (Math.abs(dx) + Math.abs(dy) < scale * 1e-12) break;
  }
  return [x, y];
}

export interface IntersectionOptions {
  /** Upper bound on points returned. */
  readonly max?: number;
}

export function findIntersections(
  plots: readonly Plot2D[],
  camera: Camera2D,
  size: RasterSize,
  options: IntersectionOptions = {},
): Intersection[] {
  const b = bounds2D(camera, size.width / size.height);
  const view: View = {
    ...b,
    cols: Math.max(16, Math.round(size.width / 2)),
    rows: Math.max(16, Math.round(size.height / 2)),
  };
  const curves = plots.map((p) => curveOf(p, view)).filter((c): c is Curve => c !== null && c.count > 0);
  if (curves.length < 2) return [];

  // Coarse spatial hash over the view; segments are registered in every bucket they touch.
  const bucketsX = 48;
  const bucketsY = 36;
  const bw = (b.maxX - b.minX) / bucketsX;
  const bh = (b.maxY - b.minY) / bucketsY;
  const bucketRange = (lo: number, hi: number, min: number, size: number, count: number): [number, number] => [
    Math.max(0, Math.floor((lo - min) / size)),
    Math.min(count - 1, Math.floor((hi - min) / size)),
  ];
  const hashes = curves.map((curve) => {
    const buckets = new Map<number, number[]>();
    for (let s = 0; s < curve.count; s++) {
      const i = s * 4;
      const [x0, x1] = bucketRange(
        Math.min(curve.segments[i]!, curve.segments[i + 2]!),
        Math.max(curve.segments[i]!, curve.segments[i + 2]!),
        b.minX,
        bw,
        bucketsX,
      );
      const [y0, y1] = bucketRange(
        Math.min(curve.segments[i + 1]!, curve.segments[i + 3]!),
        Math.max(curve.segments[i + 1]!, curve.segments[i + 3]!),
        b.minY,
        bh,
        bucketsY,
      );
      for (let by = y0; by <= y1; by++) {
        for (let bx = x0; bx <= x1; bx++) {
          const key = by * bucketsX + bx;
          const list = buckets.get(key);
          if (list) list.push(s);
          else buckets.set(key, [s]);
        }
      }
    }
    return buckets;
  });

  const scale = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const pixel = (b.maxX - b.minX) / size.width;
  const found: Intersection[] = [];
  const max = options.max ?? 256;

  for (let ia = 0; ia < curves.length; ia++) {
    for (let ib = ia + 1; ib < curves.length; ib++) {
      const A = curves[ia]!;
      const B = curves[ib]!;
      const tested = new Set<number>();
      for (const [key, listA] of hashes[ia]!) {
        const listB = hashes[ib]!.get(key);
        if (!listB) continue;
        for (const sa of listA) {
          for (const sb of listB) {
            const pair = sa * 1048576 + sb;
            if (tested.has(pair)) continue;
            tested.add(pair);

            const i = sa * 4;
            const j = sb * 4;
            const x1 = A.segments[i]!;
            const y1 = A.segments[i + 1]!;
            const x2 = A.segments[i + 2]!;
            const y2 = A.segments[i + 3]!;
            const x3 = B.segments[j]!;
            const y3 = B.segments[j + 1]!;
            const x4 = B.segments[j + 2]!;
            const y4 = B.segments[j + 3]!;
            const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
            if (Math.abs(den) < 1e-300) continue;
            const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
            const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
            if (t < 0 || t > 1 || u < 0 || u > 1) continue;

            let x = x1 + t * (x2 - x1);
            let y = y1 + t * (y2 - y1);
            if (A.field && B.field) {
              const polished = refine(A.field, B.field, x, y, scale);
              // Only accept a polish that stays near the crossing it started from.
              if (polished && Math.hypot(polished[0] - x, polished[1] - y) < 3 * pixel) [x, y] = polished;
            }
            if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
            if (found.some((p) => Math.abs(p.x - x) < 3 * pixel && Math.abs(p.y - y) < 3 * pixel)) continue;
            found.push({ x, y });
            if (found.length >= max) return sortPoints(found);
          }
        }
      }
    }
  }
  return sortPoints(found);
}

const sortPoints = (points: Intersection[]): Intersection[] => points.sort((a, b) => a.x - b.x || a.y - b.y);
