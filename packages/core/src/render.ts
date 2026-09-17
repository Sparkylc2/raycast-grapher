import { type Camera2D, bounds2D } from "./camera.js";
import type { Graph } from "./classify.js";
import { compileJs } from "./compile-js.js";
import { GLYPH_HEIGHT, drawText, textHeight, textWidth } from "./font.js";
import type { Intersection } from "./intersect.js";
import type { Plot2D, Range } from "./plot.js";
import type { RasterSize } from "./raster.js";
import { type GraphTheme, type RGB, DEFAULT_THEME, hexToRgb } from "./theme.js";
import type { Typeface } from "./typeface.js";

/**
 * Antialiased colour rasteriser, the CPU twin of the viewer's fragment shader.
 *
 * It finds curves the same way the GPU does, by dividing the field value by its
 * screen-space gradient to get a distance in pixels. Here the gradient comes
 * from central differences over the sampled grid instead of dFdx/dFdy, so the
 * two paths produce the same picture and a Raycast still matches the window.
 */

export interface RenderLayer {
  readonly graph: Graph;
  /** Hex, as stored in the scene; converted once per frame. */
  readonly color: string;
}

export interface RenderOptions {
  /** Leave the ground transparent so the host surface shows through. */
  readonly transparent?: boolean;
  /**
   * Device pixels per display pixel. Line widths, label size and grid spacing
   * are all specified in display pixels and scaled by this, so a 1x draft and a
   * 2x refinement of the same view look identical apart from sharpness.
   */
  readonly pixelRatio?: number;
  /** Height of tick label figures in display pixels. */
  readonly labelSize?: number;
  /** Outline font for labels. Without one, figures fall back to the bitmap font and names are omitted. */
  readonly typeface?: Typeface;
  /** Names drawn at the positive ends of the horizontal and vertical axes. */
  readonly axisNames?: readonly [string, string] | null;
  /** Crossings to mark on the plot. */
  readonly intersections?: readonly Intersection[];
  /** Index into `intersections` to highlight with its coordinates. */
  readonly highlight?: number | null;
  /** Playback time: trajectories are drawn up to here. Null shows them whole. */
  readonly playhead?: number | null;
}

/** Theme colours resolved to channels, so the pixel loops never parse hex. */
export interface Palette {
  readonly background: RGB;
  readonly grid: RGB;
  readonly axis: RGB;
  readonly text: RGB;
  readonly series: readonly RGB[];
}

export function paletteOf(theme: GraphTheme): Palette {
  return {
    background: hexToRgb(theme.background),
    grid: hexToRgb(theme.grid),
    axis: hexToRgb(theme.axis),
    text: hexToRgb(theme.text),
    series: theme.series.map(hexToRgb),
  };
}

interface Bounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** Gridline spacing that keeps at least `targetPx` between minor lines. */
export function niceStep(span: number, pixels: number, targetPx = 70): number {
  const target = (span / Math.max(pixels, 1)) * targetPx;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const norm = target / magnitude;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude;
}

/** Formats a tick so the label never shows more precision than the step implies. */
export function formatTick(value: number, step: number): string {
  if (Math.abs(value) < step * 1e-6) return "0";
  const decimals = Math.max(0, Math.min(6, -Math.floor(Math.log10(step))));
  const text = value.toFixed(decimals);
  return Math.abs(value) >= 1e6 || (Math.abs(value) < 1e-4 && value !== 0)
    ? value.toExponential(1).replace("+", "")
    : text;
}

/** Four significant figures, the precision a coordinate readout needs. */
export function formatCoordinate(value: number): string {
  if (Math.abs(value) < 1e-10) return "0";
  if (Math.abs(value) >= 1e6 || Math.abs(value) < 1e-4) return value.toExponential(3).replace("+", "");
  return String(Number(value.toPrecision(4)));
}

export class Canvas {
  readonly data: Uint8ClampedArray;

  constructor(
    readonly width: number,
    readonly height: number,
    background: RGB | null,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
    if (!background) return;
    for (let i = 0; i < width * height; i++) {
      this.data[i * 4] = background[0];
      this.data[i * 4 + 1] = background[1];
      this.data[i * 4 + 2] = background[2];
      this.data[i * 4 + 3] = 255;
    }
  }

  /**
   * Straight-alpha "source over". Against an opaque destination this reduces to
   * a plain lerp, so one path serves both the painted and transparent grounds.
   */
  blend(x: number, y: number, color: RGB, alpha: number): void {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const a = alpha >= 1 ? 1 : alpha;
    const d = this.data;
    const i = (y * this.width + x) * 4;
    const keep = (d[i + 3]! / 255) * (1 - a);
    const out = a + keep;
    d[i] = (color[0] * a + d[i]! * keep) / out;
    d[i + 1] = (color[1] * a + d[i + 1]! * keep) / out;
    d[i + 2] = (color[2] * a + d[i + 2]! * keep) / out;
    d[i + 3] = out * 255;
  }

  /** Vertical line at a fractional pixel position, antialiased across columns. */
  vline(px: number, color: RGB, halfWidth: number, alpha: number): void {
    const from = Math.floor(px - halfWidth - 1);
    const to = Math.ceil(px + halfWidth + 1);
    for (let x = from; x <= to; x++) {
      const cover = Math.max(0, Math.min(1, halfWidth + 0.5 - Math.abs(x + 0.5 - px)));
      if (cover > 0) for (let y = 0; y < this.height; y++) this.blend(x, y, color, cover * alpha);
    }
  }

  hline(py: number, color: RGB, halfWidth: number, alpha: number): void {
    const from = Math.floor(py - halfWidth - 1);
    const to = Math.ceil(py + halfWidth + 1);
    for (let y = from; y <= to; y++) {
      const cover = Math.max(0, Math.min(1, halfWidth + 0.5 - Math.abs(y + 0.5 - py)));
      if (cover > 0) for (let x = 0; x < this.width; x++) this.blend(x, y, color, cover * alpha);
    }
  }

  /** Antialiased rounded rectangle, from its signed distance. */
  roundedRect(x: number, y: number, w: number, h: number, radius: number, color: RGB, alpha = 1): void {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const hx = w / 2 - radius;
    const hy = h / 2 - radius;
    for (let py = Math.floor(y) - 1; py <= Math.ceil(y + h) + 1; py++) {
      for (let px = Math.floor(x) - 1; px <= Math.ceil(x + w) + 1; px++) {
        const qx = Math.abs(px + 0.5 - cx) - hx;
        const qy = Math.abs(py + 0.5 - cy) - hy;
        const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
        const cover = Math.max(0, Math.min(1, 0.5 - d));
        if (cover > 0) this.blend(px, py, color, cover * alpha);
      }
    }
  }

  /** Antialiased filled circle. */
  disc(cx: number, cy: number, radius: number, color: RGB, alpha = 1): void {
    const x0 = Math.floor(cx - radius - 1);
    const x1 = Math.ceil(cx + radius + 1);
    const y0 = Math.floor(cy - radius - 1);
    const y1 = Math.ceil(cy + radius + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const cover = Math.max(0, Math.min(1, radius + 0.5 - d));
        if (cover > 0) this.blend(x, y, color, cover * alpha);
      }
    }
  }
}

/**
 * Per-plot coverage, composited once. Strokes take the maximum rather than
 * blending, so a polyline's joints and overlapping samples never double up.
 */
class Coverage {
  readonly values: Float32Array;
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.values = new Float32Array(width * height);
  }

  mark(x: number, y: number, alpha: number): void {
    const i = y * this.width + x;
    if (alpha <= this.values[i]!) return;
    this.values[i] = alpha;
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
  }

  /** Antialiased segment, clipped to the canvas first so long lines stay cheap. */
  segment(x0: number, y0: number, x1: number, y1: number, halfWidth: number): void {
    const pad = halfWidth + 1.5;
    const clipped = clipSegment(x0, y0, x1, y1, -pad, -pad, this.width + pad, this.height + pad);
    if (!clipped) return;
    [x0, y0, x1, y1] = clipped;
    const left = Math.max(0, Math.floor(Math.min(x0, x1) - pad));
    const right = Math.min(this.width - 1, Math.ceil(Math.max(x0, x1) + pad));
    const top = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
    const bottom = Math.min(this.height - 1, Math.ceil(Math.max(y0, y1) + pad));
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lengthSq = dx * dx + dy * dy;
    for (let py = top; py <= bottom; py++) {
      const cy = py + 0.5;
      for (let px = left; px <= right; px++) {
        const cx = px + 0.5;
        let t = lengthSq > 0 ? ((cx - x0) * dx + (cy - y0) * dy) / lengthSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = x0 + t * dx - cx;
        const ey = y0 + t * dy - cy;
        const alpha = 1 - smoothstep(halfWidth - 1, halfWidth + 1, Math.sqrt(ex * ex + ey * ey));
        if (alpha > 0) this.mark(px, py, alpha);
      }
    }
  }

  flush(canvas: Canvas, color: RGB, alpha = 1): void {
    if (this.minX > this.maxX) return;
    for (let y = this.minY; y <= this.maxY; y++) {
      for (let x = this.minX; x <= this.maxX; x++) {
        const i = y * this.width + x;
        const value = this.values[i]!;
        if (value > 0) {
          canvas.blend(x, y, color, value * alpha);
          this.values[i] = 0;
        }
      }
    }
    this.minX = this.minY = Infinity;
    this.maxX = this.maxY = -Infinity;
  }
}

/** Liang-Barsky: the part of a segment inside a rectangle, or null. */
function clipSegment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): [number, number, number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const edges: [number, number][] = [
    [-dx, x0 - left],
    [dx, right - x0],
    [-dy, y0 - top],
    [dy, bottom - y0],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

/*
 * Compiled closures are cached per graph object. Building a fresh function every
 * frame discarded V8's optimised code just as it warmed up, which starts to cost
 * real time once frames arrive at animation rates. Callers that keep graph
 * objects stable between frames get the benefit.
 */
const fieldCache = new WeakMap<Graph, (x: number, y: number) => number>();
const curveCache = new WeakMap<Graph, (x: number) => number>();

function fieldOf(graph: Graph): (x: number, y: number) => number {
  let field = fieldCache.get(graph);
  if (!field) {
    const f = compileJs(graph.type === "explicit2d" || graph.type === "surface3d" ? graph.fn : graph.field);
    field = graph.type === "explicit2d" ? (x, y) => y - f(x, 0, 0) : (x, y) => f(x, y, 0);
    fieldCache.set(graph, field);
  }
  return field;
}

function curveOf(graph: Graph & { type: "explicit2d" }): (x: number) => number {
  let curve = curveCache.get(graph);
  if (!curve) {
    const f = compileJs(graph.fn);
    curve = (x) => f(x, 0, 0);
    curveCache.set(graph, curve);
  }
  return curve;
}

/** Converts single-graph layers, the original render input, into plots. */
function layerToPlot(layer: RenderLayer): Plot2D {
  const { graph, color } = layer;
  if (graph.type === "explicit2d") {
    return { kind: "explicit", color, f: curveOf(graph), domain: null, clip: null };
  }
  return {
    kind: "field",
    color,
    F: fieldOf(graph),
    region: graph.type === "inequality2d" ? { strict: graph.strict } : null,
    clipH: null,
    clipV: null,
  };
}

/** Renders single-graph layers. Kept for the original callers; new code uses `renderPlots`. */
export function renderScene(
  layers: readonly RenderLayer[],
  camera: Camera2D,
  size: RasterSize,
  theme: GraphTheme = DEFAULT_THEME,
  options: RenderOptions = {},
): Uint8ClampedArray {
  return renderPlots(layers.map(layerToPlot), camera, size, theme, options);
}

export function renderPlots(
  plots: readonly Plot2D[],
  camera: Camera2D,
  size: RasterSize,
  theme: GraphTheme = DEFAULT_THEME,
  options: RenderOptions = {},
): Uint8ClampedArray {
  const { width, height } = size;
  const ratio = options.pixelRatio ?? 1;
  const palette = paletteOf(theme);
  const canvas = new Canvas(width, height, options.transparent ? null : palette.background);
  const b = bounds2D(camera, width / height);
  const toPxX = (x: number): number => ((x - b.minX) / (b.maxX - b.minX)) * width;
  const toPxY = (y: number): number => ((b.maxY - y) / (b.maxY - b.minY)) * height;

  // Heatmaps sit under the grid so gridlines stay readable across them.
  for (const plot of plots) if (plot.kind === "heatmap") drawHeatmap(canvas, plot, b, palette);

  const step = niceStep(b.maxY - b.minY, height / ratio, 45);
  for (let g = Math.ceil(b.minX / step) * step; g <= b.maxX; g += step) {
    canvas.vline(toPxX(g), palette.grid, 0.5 * ratio, isMajor(g, step) ? 0.55 : 0.3);
  }
  for (let g = Math.ceil(b.minY / step) * step; g <= b.maxY; g += step) {
    canvas.hline(toPxY(g), palette.grid, 0.5 * ratio, isMajor(g, step) ? 0.55 : 0.3);
  }
  if (b.minX <= 0 && b.maxX >= 0) canvas.vline(toPxX(0), palette.axis, 0.6 * ratio, 0.9);
  if (b.minY <= 0 && b.maxY >= 0) canvas.hline(toPxY(0), palette.axis, 0.6 * ratio, 0.9);

  const halfWidth = 1.2 * ratio;
  const coverage = new Coverage(width, height);
  const playhead = options.playhead ?? null;

  // Regions first, then direction fields, then curves on top of both.
  for (const plot of plots) {
    if (plot.kind === "field") drawField(canvas, plot, hexToRgb(plot.color), b, halfWidth);
  }
  for (const plot of plots) {
    if (plot.kind === "slopes") drawSlopes(canvas, coverage, plot, b, step, ratio, toPxX, toPxY);
    if (plot.kind === "vectors") drawVectors(canvas, coverage, plot, b, ratio, toPxX, toPxY);
  }
  for (const plot of plots) {
    const color = hexToRgb(plot.color);
    switch (plot.kind) {
      case "explicit":
        drawCurve(canvas, plot, color, b, halfWidth);
        break;
      case "parametric":
        drawParametric(canvas, coverage, plot, color, toPxX, toPxY, halfWidth);
        break;
      case "trajectory":
        drawTrajectory(canvas, coverage, plot, color, toPxX, toPxY, halfWidth, ratio, playhead, palette);
        break;
      case "arrow":
        drawArrow(canvas, coverage, plot, color, toPxX, toPxY, halfWidth, ratio);
        break;
      case "orbit":
        drawOrbit(canvas, coverage, plot, color, toPxX, toPxY, halfWidth, ratio, playhead, palette);
        break;
      case "equilibrium":
        canvas.disc(toPxX(plot.x), toPxY(plot.y), 5.5 * ratio, palette.background, 0.9);
        canvas.disc(toPxX(plot.x), toPxY(plot.y), 4.5 * ratio, color);
        if (!plot.stable) canvas.disc(toPxX(plot.x), toPxY(plot.y), 2.6 * ratio, palette.background);
        break;
      case "point":
        canvas.disc(toPxX(plot.x), toPxY(plot.y), 5 * ratio, palette.background, 0.9);
        canvas.disc(toPxX(plot.x), toPxY(plot.y), 4 * ratio, color);
        break;
      default:
        break;
    }
  }

  const intersections = options.intersections ?? [];
  const highlight = options.highlight ?? null;
  intersections.forEach((point, i) => {
    if (i === highlight) return;
    const px = toPxX(point.x);
    const py = toPxY(point.y);
    canvas.disc(px, py, 4 * ratio, palette.text, 0.9);
    canvas.disc(px, py, 2.4 * ratio, palette.background, 0.95);
  });

  const ink = makeInk(canvas, options.typeface, (options.labelSize ?? 12) * ratio, ratio, palette);
  const widestYLabel = drawTicks(canvas, b, step, ratio, ink, toPxX, toPxY);
  if (options.axisNames && options.typeface) {
    drawAxisNames(canvas, options.axisNames, ratio, ink, toPxX, toPxY, widestYLabel);
  }

  const chosen = highlight !== null ? intersections[highlight] : undefined;
  if (chosen) {
    const px = toPxX(chosen.x);
    const py = toPxY(chosen.y);
    canvas.disc(px, py, 6.5 * ratio, palette.background, 0.9);
    canvas.disc(px, py, 5 * ratio, palette.text);
    const label = `(${formatCoordinate(chosen.x)}, ${formatCoordinate(chosen.y)})`;
    const gap = 9 * ratio;
    const labelWidth = ink.width(label);
    const x = px + gap + labelWidth < width - 4 * ratio ? px + gap : px - gap - labelWidth;
    const top = Math.min(Math.max(py - gap - ink.height, 4 * ratio), height - ink.height - 4 * ratio);
    // A solid backing: the glyph knockout alone let tick labels show through the digits.
    const padX = 5 * ratio;
    const padY = 4 * ratio;
    canvas.roundedRect(x - padX, top - padY, labelWidth + 2 * padX, ink.height + 2 * padY, 4 * ratio, palette.background, 0.9);
    ink.stamp(label, x, top);
  }
  return canvas.data;
}

const isMajor = (g: number, step: number): boolean =>
  Math.abs(g / (step * 5) - Math.round(g / (step * 5))) < 1e-6;

/** How labels get onto the canvas, independent of which font draws them. */
export interface LabelInk {
  /** Visual height of figures, used to centre and space labels. */
  readonly height: number;
  width(text: string): number;
  /** Draws `text` with the top of its figures at `top`, on a knockout in the ground colour. */
  stamp(text: string, x: number, top: number): void;
}

export function makeInk(
  canvas: Canvas,
  typeface: Typeface | undefined,
  figureHeight: number,
  ratio: number,
  palette: Palette,
): LabelInk {
  if (typeface) {
    // Size the font so its cap height, which figures share, lands on the requested height.
    const size = figureHeight / typeface.capHeight(1);
    const cap = typeface.capHeight(size);
    const halo = Math.max(1, Math.round(1.5 * ratio));
    return {
      height: cap,
      width: (text) => typeface.measure(typeface.shape(text), size),
      stamp: (text, x, top) => {
        const shaped = typeface.shape(text);
        const baseline = top + cap;
        // On a transparent frame the knockout matches the Raycast background
        // behind it, so a curve or gridline passing under the figures reads as a gap.
        typeface.draw(shaped, x, baseline, size, (px, py, c) => canvas.blend(px, py, palette.background, 0.9 * c), halo);
        typeface.draw(shaped, x, baseline, size, (px, py, c) => canvas.blend(px, py, palette.text, c));
      },
    };
  }
  // Bitmap glyphs scale by whole pixels, so round to the nearest multiple of the cell.
  const scale = Math.max(1, Math.round(figureHeight / GLYPH_HEIGHT));
  const halo = Math.max(1, Math.round(ratio));
  return {
    height: textHeight(scale),
    width: (text) => textWidth(text, scale),
    stamp: (text, x, top) => {
      drawText(text, x, top, scale, (px, py) => {
        for (let dy = -halo; dy <= halo; dy++) {
          for (let dx = -halo; dx <= halo; dx++) canvas.blend(px + dx, py + dy, palette.background, 0.85);
        }
      });
      drawText(text, x, top, scale, (px, py) => canvas.blend(px, py, palette.text, 1));
    },
  };
}

/** Smallest multiple of the grid step whose labels will not touch their neighbours. */
function labelStepFor(step: number, pxPerUnit: number, needPx: number): number {
  for (const m of [1, 2, 5, 10, 20, 50]) {
    if (step * m * pxPerUnit >= needPx) return step * m;
  }
  return step * 100;
}

function drawTicks(
  canvas: Canvas,
  b: Bounds,
  step: number,
  ratio: number,
  ink: LabelInk,
  toPxX: (x: number) => number,
  toPxY: (y: number) => number,
): number {
  const pad = 4 * ratio;
  const gap = 10 * ratio;
  const pxPerUnitX = canvas.width / (b.maxX - b.minX);
  const pxPerUnitY = canvas.height / (b.maxY - b.minY);

  // Labels hug the axis when it is on screen, otherwise they pin to the edge.
  const baseY = Math.min(Math.max(toPxY(0) + pad, pad), canvas.height - ink.height - pad);
  const baseX = Math.min(Math.max(toPxX(0) + pad, pad), canvas.width - pad);

  const widest = Math.max(ink.width(formatTick(b.minX, step)), ink.width(formatTick(b.maxX, step)));
  const xStep = labelStepFor(step, pxPerUnitX, widest + gap);
  for (let g = Math.ceil(b.minX / xStep) * xStep; g <= b.maxX; g += xStep) {
    if (Math.abs(g) < xStep * 1e-6) continue;
    const label = formatTick(g, xStep);
    ink.stamp(label, toPxX(g) - ink.width(label) / 2, baseY);
  }

  const yStep = labelStepFor(step, pxPerUnitY, ink.height + gap);
  let widestY = 0;
  for (let g = Math.ceil(b.minY / yStep) * yStep; g <= b.maxY; g += yStep) {
    if (Math.abs(g) < yStep * 1e-6) continue;
    const label = formatTick(g, yStep);
    widestY = Math.max(widestY, ink.width(label));
    // Keep y labels on canvas when the axis sits at the right edge.
    const x = Math.min(baseX, canvas.width - ink.width(label) - pad);
    ink.stamp(label, x, toPxY(g) - ink.height / 2);
  }
  return widestY;
}

/** Axis names at the positive ends, so a {q, p} plot says which is which. */
function drawAxisNames(
  canvas: Canvas,
  names: readonly [string, string],
  ratio: number,
  ink: LabelInk,
  toPxX: (x: number) => number,
  toPxY: (y: number) => number,
  widestYLabel: number,
): void {
  const pad = 6 * ratio;
  const axisY = Math.min(Math.max(toPxY(0), pad + ink.height), canvas.height - pad);
  ink.stamp(names[0], canvas.width - ink.width(names[0]) - pad, axisY - ink.height - pad);

  // The vertical name goes beside the tick labels, which sit just right of the
  // axis; drawn over them it read as "4t". Left of the axis when there's no room.
  const tickPad = 4 * ratio;
  const labelsLeft = Math.min(Math.max(toPxX(0) + tickPad, tickPad), canvas.width - tickPad);
  const width = ink.width(names[1]);
  let x = labelsLeft + widestYLabel + pad;
  if (x + width > canvas.width - pad) x = Math.min(toPxX(0), canvas.width) - pad - width;
  ink.stamp(names[1], Math.max(pad, x), pad);
}

const inRange = (value: number, range: Range | null): boolean =>
  range === null || (value >= range.lo && value <= range.hi);

/**
 * Fast path for y = f(x). The field y - f(x) has the same value and gradient
 * as the general path computes, but f only needs evaluating once per column,
 * and only the rows within reach of the curve need touching.
 */
function drawCurve(canvas: Canvas, plot: Plot2D & { kind: "explicit" }, color: RGB, b: Bounds, halfWidth: number): void {
  const { width, height } = canvas;
  const { f, domain, clip } = plot;
  const fx = new Float64Array(width);
  const xs = new Float64Array(width);
  for (let col = 0; col < width; col++) {
    xs[col] = b.minX + ((col + 0.5) / width) * (b.maxX - b.minX);
    fx[col] = f(xs[col]!);
  }

  const unitsPerRow = (b.maxY - b.minY) / height;
  const reach = halfWidth + 1;

  for (let col = 0; col < width; col++) {
    if (!inRange(xs[col]!, domain)) continue;
    const v0 = fx[col]!;
    if (!Number.isFinite(v0)) continue;

    // Same central difference as the general path, one-sided at the borders.
    const l = col > 0 ? fx[col - 1]! : v0;
    const r = col + 1 < width ? fx[col + 1]! : v0;
    const gx = (r - l) / (col > 0 && col + 1 < width ? 2 : 1);
    const grad = Math.sqrt(gx * gx + unitsPerRow * unitsPerRow);
    if (!Number.isFinite(grad) || grad < 1e-300) continue;

    // Rows where |y - f(x)| / grad < reach.
    const band = reach * grad;
    const rowLo = Math.max(0, Math.floor((b.maxY - (v0 + band)) / unitsPerRow - 0.5));
    const rowHi = Math.min(height - 1, Math.ceil((b.maxY - (v0 - band)) / unitsPerRow - 0.5));

    for (let row = rowLo; row <= rowHi; row++) {
      const y = b.maxY - (row + 0.5) * unitsPerRow;
      if (!inRange(y, clip)) continue;
      const alpha = 1 - smoothstep(halfWidth - 1, halfWidth + 1, Math.abs(y - v0) / grad);
      canvas.blend(col, row, color, alpha);
    }
  }
}

function drawField(canvas: Canvas, plot: Plot2D & { kind: "field" }, color: RGB, b: Bounds, halfWidth: number): void {
  const { width, height } = canvas;
  const { F, region, clipH, clipV } = plot;
  const values = new Float64Array(width * height);
  const xs = Float64Array.from({ length: width }, (_, col) => b.minX + ((col + 0.5) / width) * (b.maxX - b.minX));

  for (let row = 0; row < height; row++) {
    const y = b.maxY - ((row + 0.5) / height) * (b.maxY - b.minY);
    for (let col = 0; col < width; col++) values[row * width + col] = F(xs[col]!, y);
  }

  const strict = region?.strict ?? false;
  for (let row = 0; row < height; row++) {
    const y = b.maxY - ((row + 0.5) / height) * (b.maxY - b.minY);
    if (!inRange(y, clipV)) continue;
    for (let col = 0; col < width; col++) {
      if (!inRange(xs[col]!, clipH)) continue;
      const i = row * width + col;
      const v = values[i]!;
      if (!Number.isFinite(v)) continue;

      // Central differences, falling back to one-sided at the borders.
      const gx =
        (values[i + (col + 1 < width ? 1 : 0)]! - values[i - (col > 0 ? 1 : 0)]!) /
        (col > 0 && col + 1 < width ? 2 : 1);
      const gy =
        (values[i + (row + 1 < height ? width : 0)]! - values[i - (row > 0 ? width : 0)]!) /
        (row > 0 && row + 1 < height ? 2 : 1);
      // Math.hypot guards against overflow that cannot arise here, and it is
      // several times slower than the direct form on this hot path.
      const grad = Math.sqrt(gx * gx + gy * gy);
      if (!Number.isFinite(grad) || grad < 1e-300) continue;

      const signed = v / grad;
      if (region) {
        const inside = 1 - smoothstep(-1, 1, signed);
        const edge = strict ? 0 : 1 - smoothstep(halfWidth - 1, halfWidth + 1, Math.abs(signed));
        canvas.blend(col, row, color, Math.max(inside * 0.22, edge));
      } else {
        const alpha = 1 - smoothstep(halfWidth - 1, halfWidth + 1, Math.abs(signed));
        canvas.blend(col, row, color, alpha);
      }
    }
  }
}

/** Short strokes on a world-anchored grid, so the field doesn't swim while panning. */
function drawSlopes(
  canvas: Canvas,
  coverage: Coverage,
  plot: Plot2D & { kind: "slopes" },
  b: Bounds,
  gridStep: number,
  ratio: number,
  toPxX: (x: number) => number,
  toPxY: (y: number) => number,
): void {
  const spacing = niceStep(b.maxY - b.minY, canvas.height / ratio, 26);
  void gridStep;
  const unitX = canvas.width / (b.maxX - b.minX);
  const unitY = canvas.height / (b.maxY - b.minY);
  const half = 6.5 * ratio;
  const slopes: number[] = [];
  for (let gy = Math.ceil(b.minY / spacing) * spacing; gy <= b.maxY; gy += spacing) {
    if (!inRange(gy, plot.clipV)) continue;
    for (let gx = Math.ceil(b.minX / spacing) * spacing; gx <= b.maxX; gx += spacing) {
      if (!inRange(gx, plot.clipH)) continue;
      plot.slopes(gx, gy, slopes);
      const px = toPxX(gx);
      const py = toPxY(gy);
      for (const m of slopes) {
        // Direction in pixels: one unit right is unitX px, m units up is -m·unitY px.
        const dx = unitX;
        const dy = -m * unitY;
        const length = Math.hypot(dx, dy);
        if (!(length > 0)) continue;
        const ux = (dx / length) * half;
        const uy = (dy / length) * half;
        coverage.segment(px - ux, py - uy, px + ux, py + uy, 0.75 * ratio);
      }
    }
  }
  coverage.flush(canvas, hexToRgb(plot.color), 0.45);
}

/**
 * Parametric curves sampled adaptively in pixel space: intervals subdivide
 * until neighbouring samples are within two pixels, and a gap that will not
 * close is treated as a discontinuity rather than drawn across.
 */
function drawParametric(
  canvas: Canvas,
  coverage: Coverage,
  plot: Plot2D & { kind: "parametric" },
  color: RGB,
  toPxX: (x: number) => number,
  toPxY: (y: number) => number,
  halfWidth: number,
): void {
  const { width, height } = canvas;
  const { range } = plot;
  let budget = 40000;
  const at = (t: number): [number, number] => {
    budget--;
    return [toPxX(plot.x(t)), toPxY(plot.y(t))];
  };
  const finite = (p: [number, number]): boolean => Number.isFinite(p[0]) && Number.isFinite(p[1]);
  const offscreenTogether = (a: [number, number], c: [number, number]): boolean =>
    (a[0] < -width && c[0] < -width) ||
    (a[0] > 2 * width && c[0] > 2 * width) ||
    (a[1] < -height && c[1] < -height) ||
    (a[1] > 2 * height && c[1] > 2 * height);

  const walk = (ta: number, pa: [number, number], tb: number, pb: [number, number], depth: number): void => {
    const fa = finite(pa);
    const fb = finite(pb);
    if (!fa && !fb) return;
    if (fa && fb) {
      const distance = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
      if (distance <= 2 || budget <= 0 || offscreenTogether(pa, pb)) {
        coverage.segment(pa[0], pa[1], pb[0], pb[1], halfWidth);
        return;
      }
      if (depth >= 10) {
        // Still far apart after ten halvings: a jump, not a steep stretch.
        if (distance < 24) coverage.segment(pa[0], pa[1], pb[0], pb[1], halfWidth);
        return;
      }
    } else if (depth >= 10 || budget <= 0) {
      return;
    }
    const tm = 0.5 * (ta + tb);
    const pm = at(tm);
    walk(ta, pa, tm, pm, depth + 1);
    walk(tm, pm, tb, pb, depth + 1);
  };

  const samples = 384;
  let t0 = range.lo;
  let p0 = at(t0);
  for (let i = 1; i <= samples; i++) {
    const t1 = range.lo + ((range.hi - range.lo) * i) / samples;
    const p1 = at(t1);
    walk(t0, p0, t1, p1, 0);
    t0 = t1;
    p0 = p1;
  }
  coverage.flush(canvas, color);
}

function drawTrajectory(
  canvas: Canvas,
  coverage: Coverage,
  plot: Plot2D & { kind: "trajectory" },
  color: RGB,
  toPxX: (x: number) => number,
  toPxY: (y: number) => number,
  halfWidth: number,
  ratio: number,
  playhead: number | null,
  palette: Palette,
): void {
  const { h, v } = plot;
  const n = h.length;
  if (n === 0) return;
  // Samples are in ascending time, so the playhead splits them with a binary search.
  let last = n - 1;
  if (playhead !== null) {
    let lo = 0;
    let hi = n - 1;
    if (playhead < h[0]!) return;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (h[mid]! <= playhead) lo = mid;
      else hi = mid - 1;
    }
    last = lo;
  }
  for (let i = 1; i <= last; i++) {
    coverage.segment(toPxX(h[i - 1]!), toPxY(v[i - 1]!), toPxX(h[i]!), toPxY(v[i]!), halfWidth);
  }
  coverage.flush(canvas, color);

  // The starting value, always marked, so it is clear where the solution was pinned.
  if (playhead === null || plot.t0 <= playhead) {
    canvas.disc(toPxX(plot.t0), toPxY(plot.v0), 3.6 * ratio, color);
    canvas.disc(toPxX(plot.t0), toPxY(plot.v0), 2 * ratio, palette.background);
  }
  if (playhead !== null && last < n - 1) {
    const w = (playhead - h[last]!) / (h[last + 1]! - h[last]!);
    const hx = h[last]! + (h[last + 1]! - h[last]!) * w;
    const vy = v[last]! + (v[last + 1]! - v[last]!) * w;
    if (Number.isFinite(vy)) {
      canvas.disc(toPxX(hx), toPxY(vy), 5.5 * ratio, palette.background, 0.9);
      canvas.disc(toPxX(hx), toPxY(vy), 4.2 * ratio, color);
    }
  }
}

/**
 * Arrows on a grid, pointing along a system's rate. Lengths grow with the
 * square root of the speed, so slow regions still show their direction.
 */
function drawVectors(
  canvas: Canvas,
  coverage: Coverage,
  plot: Plot2D & { kind: "vectors" },
  b: Bounds,
  ratio: number,
  toPxX: (x: number) => number,
  toPxY: (y: number) => number,
): void {
  const spacing = niceStep(b.maxY - b.minY, canvas.height / ratio, 30);
  const unitX = canvas.width / (b.maxX - b.minX);
  const unitY = canvas.height / (b.maxY - b.minY);
  const out: number[] = [0, 0];
  const samples: number[] = [];
  let peak = 0;
  for (let gy = Math.ceil(b.minY / spacing) * spacing; gy <= b.maxY; gy += spacing) {
    if (!inRange(gy, plot.clipV)) continue;
    for (let gx = Math.ceil(b.minX / spacing) * spacing; gx <= b.maxX; gx += spacing) {
      if (!inRange(gx, plot.clipH)) continue;
      plot.field(gx, gy, out);
      const dx = out[0]! * unitX;
      const dy = -out[1]! * unitY;
      const speed = Math.hypot(dx, dy);
      if (!(speed > 0) || !Number.isFinite(speed)) continue;
      samples.push(toPxX(gx), toPxY(gy), dx / speed, dy / speed, speed);
      peak = Math.max(peak, speed);
    }
  }
  const longest = 0.8 * spacing * Math.min(unitX, unitY);
  for (let i = 0; i < samples.length; i += 5) {
    const [px, py, ux, uy, speed] = samples.slice(i, i + 5) as [number, number, number, number, number];
    const length = longest * (0.3 + 0.7 * Math.sqrt(speed / peak));
    const x1 = px + (ux * length) / 2;
    const y1 = py + (uy * length) / 2;
    coverage.segment(px - (ux * length) / 2, py - (uy * length) / 2, x1, y1, 0.7 * ratio);
    const head = Math.min(4.5 * ratio, 0.45 * length);
    for (const side of [1, -1]) {
      const c = Math.cos(2.6);
      const s = Math.sin(2.6) * side;
      coverage.segment(x1, y1, x1 + (ux * c - uy * s) * head, y1 + (ux * s + uy * c) * head, 0.7 * ratio);
    }
  }
  coverage.flush(canvas, hexToRgb(plot.color), 0.5);
}

function drawOrbit(
  canvas: Canvas,
  coverage: Coverage,
  plot: Plot2D & { kind: "orbit" },
  color: RGB,
  toPxX: (x: number) => number,
  toPxY: (y: number) => number,
  halfWidth: number,
  ratio: number,
  playhead: number | null,
  palette: Palette,
): void {
  const { h, v, t } = plot;
  const n = t.length;
  if (n === 0) return;
  let last = n - 1;
  if (playhead !== null) {
    if (playhead < t[0]!) return;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t[mid]! <= playhead) lo = mid;
      else hi = mid - 1;
    }
    last = lo;
  }
  for (let i = 1; i <= last; i++) {
    coverage.segment(toPxX(h[i - 1]!), toPxY(v[i - 1]!), toPxX(h[i]!), toPxY(v[i]!), halfWidth);
  }
  coverage.flush(canvas, color);
  canvas.disc(toPxX(plot.h0), toPxY(plot.v0), 3.6 * ratio, color);
  canvas.disc(toPxX(plot.h0), toPxY(plot.v0), 2 * ratio, palette.background);
  if (playhead !== null && last < n - 1) {
    const w = (playhead - t[last]!) / (t[last + 1]! - t[last]!);
    const x = h[last]! + (h[last + 1]! - h[last]!) * w;
    const y = v[last]! + (v[last + 1]! - v[last]!) * w;
    canvas.disc(toPxX(x), toPxY(y), 5.5 * ratio, palette.background, 0.9);
    canvas.disc(toPxX(x), toPxY(y), 4.2 * ratio, color);
  }
}

/** A shaft and a filled head, antialiased through the shared coverage buffer. */
function drawArrow(
  canvas: Canvas,
  coverage: Coverage,
  plot: Plot2D & { kind: "arrow" },
  color: RGB,
  toPxX: (x: number) => number,
  toPxY: (y: number) => number,
  halfWidth: number,
  ratio: number,
): void {
  const x0 = toPxX(plot.x0);
  const y0 = toPxY(plot.y0);
  const x1 = toPxX(plot.x1);
  const y1 = toPxY(plot.y1);
  const length = Math.hypot(x1 - x0, y1 - y0);
  if (!Number.isFinite(length)) return;
  if (length < 1) {
    canvas.disc(x1, y1, 3 * ratio, color);
    return;
  }
  const ux = (x1 - x0) / length;
  const uy = (y1 - y0) / length;
  const head = Math.min(13 * ratio, 0.45 * length);
  const baseX = x1 - ux * head;
  const baseY = y1 - uy * head;
  coverage.segment(x0, y0, baseX + ux * 0.5, baseY + uy * 0.5, halfWidth);

  // The head is a triangle filled by distance to its three edges.
  const spread = head * 0.42;
  const corners: [number, number][] = [
    [x1, y1],
    [baseX - uy * spread, baseY + ux * spread],
    [baseX + uy * spread, baseY - ux * spread],
  ];
  const area = (corners[1]![0] - corners[0]![0]) * (corners[2]![1] - corners[0]![1]) - (corners[1]![1] - corners[0]![1]) * (corners[2]![0] - corners[0]![0]);
  const orientation = area > 0 ? 1 : -1;
  const left = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0])) - 1));
  const right = Math.min(canvas.width - 1, Math.ceil(Math.max(...corners.map((c) => c[0])) + 1));
  const top = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1])) - 1));
  const bottom = Math.min(canvas.height - 1, Math.ceil(Math.max(...corners.map((c) => c[1])) + 1));
  for (let py = top; py <= bottom; py++) {
    for (let px = left; px <= right; px++) {
      let inside = Infinity;
      for (let k = 0; k < 3; k++) {
        const [ax, ay] = corners[k]!;
        const [bx, by] = corners[(k + 1) % 3]!;
        const ex = bx - ax;
        const ey = by - ay;
        const edge = Math.hypot(ex, ey) || 1;
        const distance = (orientation * ((px + 0.5 - ax) * ey - (py + 0.5 - ay) * ex)) / edge;
        inside = Math.min(inside, -distance);
      }
      const alpha = Math.max(0, Math.min(1, inside + 0.5));
      if (alpha > 0) coverage.mark(px, py, alpha);
    }
  }
  coverage.flush(canvas, color);
}

/**
 * Values coloured from the ground toward the plot's colour, or diverging
 * through the ground between blue and red when they straddle zero.
 */
function drawHeatmap(canvas: Canvas, plot: Plot2D & { kind: "heatmap" }, b: Bounds, palette: Palette): void {
  const { width, height } = canvas;
  const { cols, rows, values, h, v, min, max } = plot;
  const base = palette.background;
  const own = hexToRgb(plot.color);
  const negative = palette.series[0] ?? own;
  const positive = palette.series[1] ?? own;
  const diverging = min < 0 && max > 0;
  const extent = diverging ? Math.max(-min, max) : max - min || 1;
  const mix = (target: RGB, t: number): RGB => [
    base[0] + (target[0] - base[0]) * t,
    base[1] + (target[1] - base[1]) * t,
    base[2] + (target[2] - base[2]) * t,
  ];

  for (let row = 0; row < height; row++) {
    const y = b.maxY - ((row + 0.5) / height) * (b.maxY - b.minY);
    if (y < v.lo || y > v.hi) continue;
    const fy = ((y - v.lo) / (v.hi - v.lo)) * (rows - 1);
    const r0 = Math.min(rows - 2, Math.floor(fy));
    const wy = fy - r0;
    for (let col = 0; col < width; col++) {
      const x = b.minX + ((col + 0.5) / width) * (b.maxX - b.minX);
      if (x < h.lo || x > h.hi) continue;
      const fx = ((x - h.lo) / (h.hi - h.lo)) * (cols - 1);
      const c0 = Math.min(cols - 2, Math.floor(fx));
      const wx = fx - c0;
      const value =
        (values[r0 * cols + c0]! * (1 - wx) + values[r0 * cols + c0 + 1]! * wx) * (1 - wy) +
        (values[(r0 + 1) * cols + c0]! * (1 - wx) + values[(r0 + 1) * cols + c0 + 1]! * wx) * wy;
      if (!Number.isFinite(value)) continue;
      let color: RGB;
      if (diverging) {
        const t = Math.min(1, Math.abs(value) / extent);
        color = mix(value < 0 ? negative : positive, Math.pow(t, 0.8));
      } else {
        color = mix(own, Math.pow(Math.min(1, Math.max(0, (value - min) / extent)), 0.8));
      }
      canvas.blend(col, row, color, 1);
    }
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
